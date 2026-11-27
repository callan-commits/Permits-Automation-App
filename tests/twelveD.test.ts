import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ScheduleEngine } from '../src/analysis/schedule';
import { arcBetween, detectEncoding, is12dFile, parse12d, splitBraces, tokens } from '../src/cad/twelveD';
import type { CadDrawing, CadLine, CadPoint, XY } from '../src/cad/types';
import { infoFromData } from '../src/services/register';

const SAMPLE = readFileSync(new URL('./data/sample-12d.12da', import.meta.url), 'utf8');

/** UTF-16LE with a byte-order mark, as 12d Model writes it. */
function utf16(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    out[2 + 2 * i] = text.charCodeAt(i) & 0xff;
    out[3 + 2 * i] = text.charCodeAt(i) >> 8;
  }
  return out;
}

const byName = (d: CadDrawing, name: string) => d.features.find((f) => f.meta?.attributes?.['12d string'] === name)!;
const area = (p: XY[]) => p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0) / 2;

describe('12d ASCII reader', () => {
  const d = parse12d(strToU8(SAMPLE), 'sample.12da');

  it('recognises 12d file names', () => {
    expect(is12dFile('A.12daz')).toBe(true);
    expect(is12dFile('a.12DA')).toBe(true);
    expect(is12dFile('a.dwg')).toBe(false);
  });

  it('reads every string, one layer per 12d model (abandoned ones included)', () => {
    expect(d.features).toHaveLength(6);
    expect(d.layers.map((l) => [l.name, l.featureCount])).toEqual([
      ['ABU Asbuilt Utility/Elec/UT Elec Pit', 3],
      ['ABU Asbuilt Utility/Elec/UT Elec UG QL A', 1],
      ['EFU Existing Utility/Abandoned/Drain/UT Drain Inv QL B', 1],
      ['EFU Existing Utility/VIDA/Comms/UT Comms UG QL B', 1],
    ]);
    expect(d.warnings).toEqual([]);
    expect(d.focusExtent).not.toBeNull();
  });

  it('takes owner, type and QL from the string attributes, not from per-vertex survey data', () => {
    const elec = byName(d, 'ABU-UT-Elec-UG-QL A');
    expect(infoFromData(elec.meta)).toMatchObject({ owner: 'Jemena', type: 'Elec', ql: 'A' });
    // an empty OWNER in a later group doesn't wipe out the first one
    expect(elec.meta!.attributes!.OWNER).toBe('Jemena');
    expect(elec.meta!.attributes!['File Name']).toBe('synthetic "test" file');
    expect(elec.color).toBe('#ff0000');
  });

  it("reads VicTrack's VT_UTL_ fields as OWNER / TYPE / QL", () => {
    const comms = byName(d, 'EFU-UT-Comms-UG-QL B');
    expect(infoFromData(comms.meta)).toMatchObject({ owner: 'Telstra', type: 'Comms', ql: 'B' });
    expect(comms.meta!.attributes!.VT_UTL_OWNER).toBe('Telstra');
  });

  it('treats "Unknown" and "NA" owners as not known, and normalises spellings', () => {
    expect(infoFromData(byName(d, 'EFU-UT-Drain-Inv-QL B').meta).owner).toBeNull();
    expect(infoFromData(byName(d, 'ABU-UT-Elec-Locator').meta).owner).toBeNull();
    expect(infoFromData(byName(d, 'ABU-UT-Elec-Pit').meta).owner).toBe('VicTrack');
    expect(infoFromData(byName(d, 'ABU-UT-Elec-Pit-Round').meta).owner).toBe('Metro Trains Melbourne');
  });

  it('keeps a level per vertex; "null" levels are missing; 2D strings take their string level', () => {
    const elec = byName(d, 'ABU-UT-Elec-UG-QL A') as CadLine;
    expect(elec.coords).toEqual([[327830, 5805975], [327860, 5805975]]);
    expect(elec.z).toEqual([30, 31]);
    const comms = byName(d, 'EFU-UT-Comms-UG-QL B') as CadLine;
    expect(comms.z![0]).toBe(29.5);
    expect(Number.isNaN(comms.z![1])).toBe(true);
    const drain = byName(d, 'EFU-UT-Drain-Inv-QL B') as CadLine;
    expect(drain.z).toEqual([28.25, 28.25]);
  });

  it('draws arcs with a positive radius clockwise, so a closed pit outline bulges outwards', () => {
    const pit = byName(d, 'ABU-UT-Elec-Pit') as CadLine;
    // closed: ends where it starts
    expect(pit.coords[0]).toEqual(pit.coords[pit.coords.length - 1]);
    // clockwise square; its east side (third segment, travelling south, 0.6 m radius) bulges east, beyond x = 327871
    const maxX = Math.max(...pit.coords.map((c) => c[0]));
    expect(maxX).toBeGreaterThan(327871.05);
    expect(Math.abs(area(pit.coords.slice(0, -1)))).toBeGreaterThan(1);
    expect(pit.z!.every((z) => z === 31.2)).toBe(true);
    // arc helper: (0,0) to (2,0) with radius +1 is a half circle, clockwise about (1,0), so it passes through (1,1)
    const half = arcBetween([0, 0], [2, 0], 1, false);
    const mid = half[Math.floor(half.length / 2)][0];
    expect(mid[0]).toBeCloseTo(1, 1);
    expect(mid[1]).toBeCloseTo(1, 1);
    const ccw = arcBetween([0, 0], [2, 0], -1, false);
    expect(ccw[Math.floor(ccw.length / 2)][0][1]).toBeCloseTo(-1, 1);
  });

  it('draws circles (negative radius is a direction, not a size) and one-point strings as points', () => {
    const round = byName(d, 'ABU-UT-Elec-Pit-Round') as CadLine;
    expect(round.kind).toBe('line');
    for (const [x, y] of round.coords) expect(Math.hypot(x - 327880, y - 5805980)).toBeCloseTo(0.25, 9);
    expect(round.meta!.elevation).toBe(31.5);
    const loc = byName(d, 'ABU-UT-Elec-Locator') as CadPoint;
    expect(loc.kind).toBe('point');
    expect(loc.coord).toEqual([327885, 5805985]);
    expect(loc.meta!.elevation).toBe(31.75);
  });

  it('reads the same file zipped and in UTF-16 (.12daz as 12d writes it)', () => {
    const zipped = zipSync({ 'MA1-SAMPLE.12da': utf16(SAMPLE) });
    const z = parse12d(zipped, 'sample.12daz');
    expect(z.features.map((f) => [f.layer, f.kind, f.meta?.attributes?.OWNER])).toEqual(d.features.map((f) => [f.layer, f.kind, f.meta?.attributes?.OWNER]));
    expect((byName(z, 'ABU-UT-Elec-UG-QL A') as CadLine).z).toEqual([30, 31]);
  });

  it('gives RLs at box crossings from the 12d levels', () => {
    // box from E 327835..327850, N 5805965..5805985: the Jemena cable crosses its west and east sides
    const box: XY[] = [[327835, 5805965], [327850, 5805965], [327850, 5805985], [327835, 5805985], [327835, 5805965]];
    const res = new ScheduleEngine(d).compute(box);
    const elec = res.find((e) => e.run.features[0].layer === 'ABU Asbuilt Utility/Elec/UT Elec UG QL A')!;
    expect(elec.relation).toBe('crosses');
    expect(elec.points.map((p) => p.rl?.value)).toEqual([30 + 5 / 30, 30 + 20 / 30].map((v) => expect.closeTo(v, 9)) as unknown as number[]);
    const drain = res.find((e) => e.run.features[0].layer.includes('Abandoned'))!;
    expect(drain.points[0].rl).toEqual({ value: 28.25, source: '3D line' });
  });

  it('copes with errors', () => {
    expect(() => parse12d(zipSync({ 'readme.txt': strToU8('hi') }), 'x.12daz')).toThrow(/does not contain a \.12da/);
    expect(() => parse12d(new Uint8Array(0), 'x.12da')).toThrow(/empty/);
  });
});

describe('12d text helpers', () => {
  it('splits words and quoted strings with escapes', () => {
    expect(tokens('text    "OWNER"   "Telstra, NBN\\"\\""')).toEqual(['text', 'OWNER', 'Telstra, NBN""']);
    expect(tokens('real "DIA" 0.063')).toEqual(['real', 'DIA', '0.063']);
    expect(tokens('text "path" "C:\\\\Users\\\\x"')).toEqual(['text', 'path', 'C:\\Users\\x']);
  });

  it('splits braces outside quotes into logical lines', () => {
    expect(splitBraces('data ".\\\\CAM.bmp"      }')).toEqual(['data ".\\\\CAM.bmp"', '}']);
    expect(splitBraces('pipe_value { diameter 0.1 }')).toEqual(['pipe_value {', 'diameter 0.1', '}']);
    expect(splitBraces('text "a" "x { y }"')).toEqual(['text "a" "x { y }"']);
  });

  it('detects the text encoding', () => {
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x6e, 0]))).toBe('utf-16le');
    expect(detectEncoding(new Uint8Array([0x6e, 0, 0x75, 0]))).toBe('utf-16le');
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x6e]))).toBe('utf-8');
    expect(detectEncoding(strToU8('model'))).toBe('utf-8');
  });
});
