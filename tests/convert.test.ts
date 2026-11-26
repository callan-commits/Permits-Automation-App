import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
import { bulgeSegment, cleanMText, convertDatabase } from '../src/cad/convert';
import { aciToHex } from '../src/cad/aci';
import type { CadDrawing, CadLine, CadText } from '../src/cad/types';

const SAMPLE = resolve(__dirname, './data/sample-utility-survey.dxf');
// Same construction as scripts/make_sample_dxf.py
const ORIGIN = [327842.9, 5805970.5];
const B = (135 * Math.PI) / 180;
const U = [Math.sin(B), Math.cos(B)];
const N = [-U[1], U[0]];
const p = (s: number, o = 0) => [ORIGIN[0] + s * U[0] + o * N[0], ORIGIN[1] + s * U[1] + o * N[1]];

let lib: Awaited<ReturnType<typeof LibreDwg.create>>;
let drawing: CadDrawing;

beforeAll(async () => {
  lib = await LibreDwg.create(resolve(__dirname, '../node_modules/@mlightcad/libredwg-web/wasm'));
  const ptr = lib.dwg_read_data(readFileSync(SAMPLE, 'utf8'), Dwg_File_Type.DXF);
  drawing = convertDatabase(lib.convert(ptr!), 'sample.dxf');
  lib.dwg_free(ptr!);
});

describe('ACI colours', () => {
  it('maps standard indices', () => {
    expect(aciToHex(1)).toBe('#ff0000');
    expect(aciToHex(5)).toBe('#0000ff');
    expect(aciToHex(10)).toBe('#ff0000');
    expect(aciToHex(11)).toBe('#ff8080');
    expect(aciToHex(30)).toBe('#ff8000');
  });
});

describe('bulge segments', () => {
  it('a bulge of 1 is a semicircle', () => {
    const pts = bulgeSegment([0, 0], [10, 0], 1);
    for (const [x, y] of pts) expect(Math.hypot(x - 5, y)).toBeCloseTo(5, 6);
    // positive bulge = counter-clockwise from p1 to p2, so the arc dips below the chord
    // (within the 1 cm chord tolerance used for tessellation)
    expect(Math.abs(Math.min(...pts.map((q) => q[1])) + 5)).toBeLessThanOrEqual(0.0101);
  });
});

describe('MTEXT cleaning', () => {
  it('strips formatting', () => {
    expect(cleanMText('{\\fArial|b1;DN300}\\PWATER\\~MAIN')).toBe('DN300\nWATER MAIN');
  });
});

describe('sample survey conversion', () => {
  it('finds the utility layers', () => {
    const names = drawing.layers.map((l) => l.name);
    for (const n of ['COMMS-TELSTRA', 'ELEC-HV-UE', 'GAS-MULTINET', 'WATER-SEW', 'SEWER-SEW', 'DRAINAGE', 'RAIL-SIGNAL-CABLE']) {
      expect(names).toContain(n);
    }
    expect(drawing.layers.find((l) => l.name === 'COMMS-TELSTRA')!.color).toBe(aciToHex(30));
  });

  it('keeps MGA coordinates unchanged', () => {
    const [minX, minY, maxX, maxY] = drawing.extent!;
    expect(minX).toBeGreaterThan(327_700);
    expect(maxX).toBeLessThan(328_200);
    expect(minY).toBeGreaterThan(5_805_600);
    expect(maxY).toBeLessThan(5_806_100);
    const gas = drawing.features.find((f) => f.layer === 'GAS-MULTINET' && f.kind === 'line') as CadLine;
    expect(gas.coords[0][0]).toBeCloseTo(p(95, 35)[0], 3);
    expect(gas.coords[0][1]).toBeCloseTo(p(95, 35)[1], 3);
  });

  it('tessellates arcs onto their true radius', () => {
    const arc = drawing.features.find((f) => f.entityType === 'ARC') as CadLine;
    const c = p(270, 10);
    for (const [x, y] of arc.coords) expect(Math.hypot(x - c[0], y - c[1])).toBeCloseTo(10, 6);
    expect(arc.coords.length).toBeGreaterThan(10);
  });

  it('expands blocks at their insertion points onto the insert layer', () => {
    const pits = drawing.features.filter((f) => f.block === 'PIT' && f.kind === 'line') as CadLine[];
    expect(pits.length).toBe(8); // 4 inserts x (outline + diagonal)
    expect(pits.every((f) => f.layer === 'COMMS-TELSTRA')).toBe(true);
    const ins = p(0, 18);
    const outline = pits.find((f) => f.entityType === 'LWPOLYLINE')!;
    for (const [x, y] of outline.coords) expect(Math.hypot(x - ins[0], y - ins[1])).toBeLessThan(0.7);
    expect(outline.coords.length).toBe(5); // closed rectangle
  });

  it('keeps 3D polyline elevations', () => {
    const sig = drawing.features.find((f) => f.entityType === 'POLYLINE3D') as CadLine;
    expect(sig.z?.[0]).toBeCloseTo(44.4, 3);
  });

  it('reads text with height and rotation', () => {
    const t = drawing.features.find((f) => f.kind === 'text' && f.entityType === 'TEXT' && f.text.includes('TELSTRA')) as CadText;
    expect(t.height).toBeCloseTo(1.2);
    expect(t.rotation).toBeCloseTo((135 * Math.PI) / 180, 4);
    const mt = drawing.features.find((f) => f.kind === 'text' && f.entityType === 'MTEXT') as CadText;
    expect(mt.text).toBe('DN300 DICL\nWATER MAIN');
  });

  it('draws splines through their fit points', () => {
    const sp = drawing.features.find((f) => f.entityType === 'SPLINE') as CadLine;
    expect(sp.coords.length).toBeGreaterThan(20);
    expect(sp.coords[0][0]).toBeCloseTo(p(320, 40)[0], 3);
  });

  it('reports nothing skipped for the sample', () => {
    expect(drawing.skipped).toEqual({});
  });
});

// Real DWG files: drop any .dwg into tests/fixtures/ (gitignored) to include it in the test run.
const fixtureDir = resolve(__dirname, 'fixtures');
const dwgFiles = existsSync(fixtureDir) ? readdirSync(fixtureDir).filter((f) => f.toLowerCase().endsWith('.dwg')) : [];
describe.skipIf(dwgFiles.length === 0)('DWG fixtures', () => {
  it.each(dwgFiles)('%s converts', (name) => {
    const buf = readFileSync(resolve(fixtureDir, name));
    const ptr = lib.dwg_read_data(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), Dwg_File_Type.DWG);
    expect(ptr).toBeTruthy();
    const d = convertDatabase(lib.convert(ptr!), name);
    lib.dwg_free(ptr!);
    expect(d.features.length).toBeGreaterThan(0);
    expect(d.extent).not.toBeNull();
  });
});

describe('focus extent', () => {
  it('ignores a stray object at the origin', async () => {
    const { computeFocusExtent } = await import('../src/cad/convert');
    const stray = { kind: 'point' as const, layer: '0', color: '#fff', entityType: 'POINT', handle: 'X', coord: [0, 0] as [number, number] };
    const e = computeFocusExtent([...drawing.features, stray])!;
    expect(e[0]).toBeGreaterThan(327_000);
    expect(e[1]).toBeGreaterThan(5_800_000);
  });
});

describe.skipIf(dwgFiles.length === 0)('DWG reader state', () => {
  it('reads DWG and DXF files in any order on one reader', async () => {
    const fresh = await LibreDwg.create(resolve(__dirname, '../node_modules/@mlightcad/libredwg-web/wasm'));
    const buf = readFileSync(resolve(fixtureDir, dwgFiles[0]));
    const dwg = () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const counts: number[] = [];
    for (const kind of ['dwg', 'dwg', 'dxf', 'dwg']) {
      const ptr = kind === 'dwg' ? fresh.dwg_read_data(dwg(), Dwg_File_Type.DWG) : fresh.dwg_read_data(readFileSync(SAMPLE, 'utf8'), Dwg_File_Type.DXF);
      counts.push(convertDatabase(fresh.convert(ptr!), kind).features.length);
      fresh.dwg_free(ptr!);
    }
    expect(counts.every((n) => n > 0)).toBe(true);
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]).toBe(counts[3]);
  });
});
