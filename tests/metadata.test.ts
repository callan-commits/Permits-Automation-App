import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
import { convertDatabase } from '../src/cad/convert';
import type { CadDrawing, CadLine } from '../src/cad/types';

let lib: Awaited<ReturnType<typeof LibreDwg.create>>;
const load = (path: string): CadDrawing => {
  const ptr = lib.dwg_read_data(readFileSync(resolve(__dirname, path), 'utf8'), Dwg_File_Type.DXF);
  const d = convertDatabase(lib.convert(ptr!), path);
  lib.dwg_free(ptr!);
  return d;
};

let meta: CadDrawing;
let sample: CadDrawing;
beforeAll(async () => {
  lib = await LibreDwg.create(resolve(__dirname, '../node_modules/@mlightcad/libredwg-web/wasm'));
  meta = load('data/metadata.dxf');
  sample = load('../public/samples/sample-utility-survey.dxf');
});

describe('utility metadata is preserved', () => {
  it('keeps block attributes by tag on the symbol geometry and its labels', () => {
    const pit = meta.features.filter((f) => f.block === 'PIT');
    expect(pit.length).toBeGreaterThan(1);
    for (const f of pit) {
      expect(f.meta?.attributes).toEqual({ OWNER: 'Telstra', PIT_ID: 'P12', RL_LID: '45.210', DEPTH: '0.9' });
      expect(f.meta?.elevation).toBeCloseTo(45.21);
    }
  });

  it('keeps invisible attributes even though they are not drawn', () => {
    const pits = sample.features.filter((f) => f.block === 'PIT' && f.kind === 'line');
    expect(pits[0].meta?.attributes?.RL_LID).toBe('45.200');
    expect(pits[0].meta?.attributes?.COVER).toBe('P6 class B');
    const labels = sample.features.filter((f) => f.kind === 'text' && f.entityType === 'ATTRIB').map((f) => (f.kind === 'text' ? f.text : ''));
    expect(labels).toContain('P101');
    expect(labels).not.toContain('P6 class B'); // hidden attribute not drawn
  });

  it('keeps XDATA and splits KEY=VALUE fields', () => {
    const pl = meta.features.find((f) => f.entityType === 'LWPOLYLINE')!;
    expect(Object.values(pl.meta!.xdata!)[0]).toEqual(['OWNER=Telstra', 'SIZE=2xP50', 'QL=B', 44.3]);
    expect(pl.meta?.fields).toEqual({ OWNER: 'Telstra', SIZE: '2xP50', QL: 'B' });
  });

  it('keeps extension dictionary records', () => {
    const pl = meta.features.find((f) => f.entityType === 'LWPOLYLINE')!;
    expect(pl.meta?.records).toEqual({ SURVEY_ATTRIBUTES: ['Surveyed 2026-10-01', 1.25] });
  });

  it('keeps linetype and elevations', () => {
    const pl = meta.features.find((f) => f.entityType === 'LWPOLYLINE')!;
    expect(pl.meta?.lineType).toBe('DASHED');
    expect(pl.meta?.elevation).toBeCloseTo(44.3);
    const line = meta.features.find((f) => f.entityType === 'LINE') as CadLine;
    expect(line.z).toEqual([43.1, 43.6]);
    expect(meta.features.find((f) => f.entityType === 'POINT')?.meta?.elevation).toBeCloseTo(42.75);
    expect((meta.features.find((f) => f.entityType === 'POLYLINE3D') as CadLine).z).toEqual([41, 41.5]);
  });

  it('sample survey carries owner data on its utilities', () => {
    const gas = sample.features.find((f) => f.layer === 'GAS-MULTINET' && f.kind === 'line')!;
    expect(gas.meta?.fields).toMatchObject({ OWNER: 'Multinet Gas', SIZE: '150 PE', QL: 'A' });
    const tel = sample.features.find((f) => f.layer === 'COMMS-TELSTRA' && f.entityType === 'LWPOLYLINE' && !f.block)!;
    expect(tel.meta?.fields?.OWNER).toBe('Telstra');
    expect(tel.meta?.elevation).toBeCloseTo(44.6);
  });
});

describe('attribute labels', () => {
  it('follow the block insert layer when defined on layer 0', () => {
    const labels = sample.features.filter((f) => f.entityType === 'ATTRIB');
    expect(labels.length).toBe(8);
    expect(labels.every((f) => f.layer === 'COMMS-TELSTRA')).toBe(true);
    expect(sample.layers.map((l) => l.name)).not.toContain('0');
  });
});
