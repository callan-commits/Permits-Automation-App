import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strToU8 } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
import { ScheduleEngine } from '../src/analysis/schedule';
import { AREA_RADIUS, DIRECT_RADIUS, type SurfaceLevel, SurfaceModel, extractLevels } from '../src/analysis/surface';
import { convertDatabase } from '../src/cad/convert';
import { parse12d } from '../src/cad/twelveD';
import type { CadDrawing, CadFeature, XY } from '../src/cad/types';
import { calloutLines, calloutSpecs, needsSurface } from '../src/print/callouts';
import { ServiceRegister } from '../src/services/register';
import { ScheduleEdits, scheduleRows, shallowest } from '../src/services/scheduleModel';

// The synthetic feature survey: a plane z = 32 + 0.02 (x - cx) - 0.01 (y - cy), with a 16 m gap.
const CX = 327842.5;
const CY = 5805975.0;
const plane = (x: number, y: number) => 32 + 0.02 * (x - CX) - 0.01 * (y - CY);
const GAP_CENTRE: XY = [CX + 25, CY];

let feature: CadDrawing;
beforeAll(async () => {
  const lib = await LibreDwg.create(resolve(__dirname, '../node_modules/@mlightcad/libredwg-web/wasm'));
  const ptr = lib.dwg_read_data(readFileSync(resolve(__dirname, './data/sample-feature-survey.dxf'), 'utf8'), Dwg_File_Type.DXF);
  feature = convertDatabase(lib.convert(ptr!), 'sample-feature-survey.dxf');
  lib.dwg_free(ptr!);
});

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const groundOnly = (levels: SurfaceLevel[]) => levels.filter((l) => !/INV|OHW/.test(l.layer));

describe('levels from a feature survey', () => {
  it('collects 3D points, spot-height blocks (level from the RL attribute), and 3D line vertices', () => {
    const { levels, layers } = extractLevels(feature);
    const by = (layer: string) => levels.filter((l) => l.layer === layer);
    expect(by('SPOT HEIGHTS').length).toBeGreaterThan(600);
    expect(by('SPOT HEIGHTS').every((l) => l.source === 'point' && Math.abs(l.z - plane(l.x, l.y)) < 1e-6)).toBe(true);
    // blocks: one level per insert, at the insertion point, from the RL attribute (insertion z is 0)
    expect(by('LEVELS').length).toBeGreaterThan(150);
    expect(by('LEVELS').every((l) => l.source === 'block' && Math.abs(l.z - plane(l.x, l.y)) < 0.0006)).toBe(true);
    expect(by('KERB')).toHaveLength(14);
    expect(by('KERB').every((l) => Math.abs(l.z - plane(l.x, l.y) - 0.15) < 1e-6)).toBe(true);
    // text labels aren't used when there are plenty of 3D levels
    expect(by('TEXT LEVELS')).toHaveLength(0);
    // pit inverts and overhead wires are found but marked as not ground
    expect(layers.find((l) => l.layer === 'PIT INV')).toMatchObject({ count: 6, notGround: true });
    expect(layers.find((l) => l.layer === 'OHW')).toMatchObject({ count: 2, notGround: true });
    expect(layers.find((l) => l.layer === 'SPOT HEIGHTS')!.notGround).toBe(false);
    // nothing in the gap
    expect(levels.some((l) => Math.abs(l.x - GAP_CENTRE[0]) < 7.9 && Math.abs(l.y - GAP_CENTRE[1]) < 7.9 && l.layer !== 'KERB')).toBe(false);
  });

  it('uses level text only when a drawing has hardly any 3D levels', () => {
    const t = (text: string, layer: string, at: XY): CadFeature => ({ kind: 'text', layer, color: '#fff', entityType: 'TEXT', handle: text, coord: at, text, height: 0.2, rotation: 0, hAlign: 'left', vAlign: 'baseline' });
    const d: CadDrawing = {
      fileName: 'flat.dxf',
      layers: [],
      features: [t('RL 35.566', 'ANNO', [0, 0]), t('35.120', 'SPOT LEVELS', [5, 0]), t('35.120', 'PIT NUMBERS', [10, 0]), t('RL 36.0', 'ANNO', [0, 5])],
      extent: null,
      focusExtent: null,
      skipped: {},
      warnings: [],
    };
    expect(extractLevels(d).levels.map((l) => [l.z, l.layer])).toEqual([
      [35.566, 'ANNO'],
      [35.12, 'SPOT LEVELS'],
      [36, 'ANNO'],
    ]);
  });
});

describe('surface level at a point', () => {
  let model: SurfaceModel;
  beforeAll(() => {
    model = new SurfaceModel(groundOnly(extractLevels(feature).levels).filter((l) => l.layer !== 'KERB'));
  });

  it(`uses a surveyed point within ${DIRECT_RADIUS * 100} cm directly`, () => {
    const r = model.at([CX + 0.2, CY + 0.1]); // grid point at (CX, CY) is 0.22 m away
    expect(r.method).toBe('point');
    expect(r.value).toBeCloseTo(plane(CX, CY), 9);
    expect(r.detail).toMatch(/22 cm away/);
  });

  it('otherwise interpolates on the triangulated surface (exact on a plane)', () => {
    const p: XY = [CX + 1.4, CY - 1.3]; // nearest grid point 1.9 m away
    const r = model.at(p);
    expect(r.method).toBe('tin');
    expect(r.value).toBeCloseTo(plane(...p), 6);
  });

  it(`at the edge of the survey, averages the nearest levels within ${AREA_RADIUS} m`, () => {
    const r = model.at([CX + 46.5, CY]); // 1.5 m outside the survey's east edge
    expect(r.method).toBe('average');
    expect(r.value).not.toBeNull();
    expect(Math.abs(r.value! - plane(CX + 45, CY))).toBeLessThan(0.05);
    expect(r.detail).toMatch(/^Weighted average of 4 surveyed points within 4\.\d m$/); // 2 columns of the 3 m grid in range
  });

  it(`flags the surface to find manually when there are fewer than 3 levels within ${AREA_RADIUS} m`, () => {
    const r = model.at(GAP_CENTRE);
    expect(r).toMatchObject({ value: null, method: 'none' });
    expect(r.detail).toMatch(/No surveyed points within 5 m: find the surface manually/);
  });

  it("won't interpolate across a triangle whose corners are more than 5 m away", () => {
    const sparse = new SurfaceModel([
      { x: 0, y: 0, z: 10, layer: 'L', source: 'point' },
      { x: 12, y: 0, z: 10, layer: 'L', source: 'point' },
      { x: 0, y: 12, z: 10, layer: 'L', source: 'point' },
    ]);
    expect(sparse.at([3, 3]).method).toBe('none');
  });
});

describe('depths on the schedule and callouts', () => {
  // Jemena cable crossing the box, levels chosen so the crossing RL is 34.564 and the ground there 35.566.
  const BOX: XY[] = [[0, 0], [10, 0], [10, 4], [0, 4], [0, 0]];
  const J = { OWNER: 'Jemena', TYPE: 'Electricity', QUALITY_LEVEL: 'QL-B' };
  const cable = (z0: number, z1: number, layer = 'Elec'): CadFeature => ({
    kind: 'line',
    layer,
    color: '#f00',
    entityType: '12D_SUPER',
    handle: `c${layer}`,
    coords: [[-5, 2], [15, 2]],
    z: [z0, z1],
    meta: { attributes: { ...J } },
  });
  const drawing = (fs: CadFeature[]): CadDrawing => ({ fileName: 't', layers: [], features: fs, extent: [-50, -50, 50, 50], focusExtent: [-50, -50, 50, 50], skipped: {}, warnings: [] });
  const level = (x: number, y: number, z: number): SurfaceLevel => ({ x, y, z, layer: 'SPOT', source: 'point' });
  const rowsWith = (fs: CadFeature[], levels: SurfaceLevel[] | null, edits = new ScheduleEdits()) =>
    scheduleRows(new ScheduleEngine(drawing(fs)), new ServiceRegister(memory()), edits, BOX, undefined, levels ? new SurfaceModel(levels) : null);

  it('gives the callout in the requested form: owner/type, RL, surface, depth', () => {
    // RL at x=0 is 34.564 (z from 34.464 at x=-5 to 34.864 at x=15: +0.02/m); a level 10 cm from the crossing
    const rows = rowsWith([cable(34.464, 34.864)], [level(0.1, 2, 35.566), level(10, 2.1, 35.9), level(5, 8, 35.7)]);
    expect(rows).toHaveLength(1);
    const p = rows[0].rls[0];
    expect(p.surface).toMatchObject({ value: 35.566, method: 'point' });
    expect(p.depth).toBeCloseTo(1.002, 9);
    expect(calloutLines(rows[0], 0)).toEqual(['Jemena Elec', 'RL: ~34.564 QLB', 'Surface: 35.566', 'Depth: 1.002']);
  });

  it('calls out the crossing with the smallest depth (not just the highest RL)', () => {
    // crossings: x=0 RL 34.564, ground 35.566 (1.002 deep); x=10 RL 34.764, ground 36.0 (1.236 deep)
    const rows = rowsWith([cable(34.464, 34.864)], [level(0.1, 2, 35.566), level(10, 2.1, 36.0)]);
    expect(rows[0].rls.map((r) => r.depth)).toEqual([expect.closeTo(1.002, 9), expect.closeTo(1.236, 9)]);
    expect(rows[0].calloutIndex).toBe(0);
    expect(shallowest([{ text: '30.0', depth: 2 }, { text: '31.0', depth: null }, { text: '29.0', depth: 1.5 }])).toBe(2);
    expect(calloutSpecs(rows, (g) => g, () => '#f00')[0].anchor).toEqual([0, 2]);
  });

  it('flags a surface that has to be found manually, and takes one entered by hand', () => {
    const edits = new ScheduleEdits();
    let rows = rowsWith([cable(34.464, 34.864)], [level(40, 40, 30)], edits);
    expect(calloutLines(rows[0], rows[0].calloutIndex).slice(2)).toEqual(['Surface: [find manually]', 'Depth: [insert depth]']);
    expect(rows[0].needs.surface).toBe(true);
    expect(needsSurface(rows[0], rows[0].calloutIndex)).toBe(true);
    expect(calloutSpecs(rows, (g) => g, () => '#f00')[0].needsSurface).toBe(true);
    edits.set(rows[0].key, { surface: '35.8' });
    rows = rowsWith([cable(34.464, 34.864)], [level(40, 40, 30)], edits);
    const p = rows[0].rls[rows[0].calloutIndex];
    expect(p.surface).toMatchObject({ value: 35.8, method: 'edit' });
    expect(rows[0].needs.surface).toBe(false);
    expect(calloutLines(rows[0], rows[0].calloutIndex).slice(2)).toEqual(['Surface: 35.800', `Depth: ${(35.8 - Number(p.text!.replace('~', ''))).toFixed(3)}`]);
  });

  it('a surface entered by hand works without a feature survey', () => {
    const edits = new ScheduleEdits();
    const key = rowsWith([cable(34.464, 34.864)], null, edits)[0].key;
    edits.set(key, { surface: '35.566' });
    const rows = rowsWith([cable(34.464, 34.864)], null, edits);
    // without depths to compare, the callout is at the highest RL (x = 10: 34.764)
    expect(calloutLines(rows[0], rows[0].calloutIndex)).toEqual(['Jemena Elec', 'RL: ~34.764 QLB', 'Surface: 35.566', 'Depth: 0.802']);
  });

  it('without a feature survey, callouts keep the RL only', () => {
    const rows = rowsWith([cable(34.464, 34.864)], null);
    expect(rows[0].rls[0].surface).toBeUndefined();
    expect(calloutLines(rows[0], 0)).toEqual(['Jemena Elec', 'RL: ~34.564 QLB']);
  });

  it('a service above the surface is flagged; overhead services get no depth', () => {
    let rows = rowsWith([cable(36.464, 36.864)], [level(0.1, 2, 35.566), level(10, 2.1, 36.0)]);
    expect(rows[0].rls[rows[0].calloutIndex].depth!).toBeLessThan(0);
    expect(rows[0].needs.surface).toBe(true);
    rows = rowsWith([cable(40, 40, 'OHW 22kV')], [level(0.1, 2, 35.566)]);
    expect(rows[0].info.overhead).toBe(true);
    expect(rows[0].rls[0].surface).toBeUndefined();
  });

  it('works end to end with a 12d survey and the synthetic feature survey', () => {
    const d = parse12d(strToU8(readFileSync(resolve(__dirname, './data/sample-12d.12da'), 'utf8')), 'sample.12da');
    const model = new SurfaceModel(groundOnly(extractLevels(feature).levels));
    const ring: XY[] = [[327835, 5805965], [327850, 5805965], [327850, 5805985], [327835, 5805985], [327835, 5805965]];
    const rows = scheduleRows(new ScheduleEngine(d), new ServiceRegister(memory()), new ScheduleEdits(), ring, undefined, model);
    const elec = rows.find((r) => r.info.owner === 'Jemena')!;
    const p = elec.rls[elec.calloutIndex];
    // the shallower of the two crossings; the ground there from the plane (± kerb effects nowhere near)
    expect(p.surface!.value).toBeCloseTo(plane(...p.at), 3);
    expect(p.depth).toBeCloseTo(plane(...p.at) - Number(p.text!.replace('~', '')), 3);
    expect(calloutLines(elec, elec.calloutIndex)).toHaveLength(4);
  });
});
