import { describe, expect, it } from 'vitest';
import { ScheduleEngine, formatRl } from '../src/analysis/schedule';
import type { CadDrawing, CadFeature, XY } from '../src/cad/types';

// 10 x 10 m box at a realistic MGA location
const E0 = 327900;
const N0 = 5805900;
const P = (x: number, y: number): XY => [E0 + x, N0 + y];
const BOX: XY[] = [P(0, 0), P(10, 0), P(10, 10), P(0, 10), P(0, 0)];

let h = 0;
const line = (layer: string, coords: XY[], extra: Partial<CadFeature> = {}): CadFeature =>
  ({ kind: 'line', layer, color: '#fff', entityType: 'LWPOLYLINE', handle: `H${++h}`, coords, ...extra }) as CadFeature;
const text = (t: string, at: XY, layer = 'LABELS'): CadFeature =>
  ({ kind: 'text', layer, color: '#fff', entityType: 'TEXT', handle: `H${++h}`, coord: at, text: t, height: 0.5, rotation: 0, hAlign: 'left', vAlign: 'baseline' }) as CadFeature;
const drawing = (features: CadFeature[]): CadDrawing => ({
  fileName: 't',
  layers: [],
  features,
  extent: [E0 - 50, N0 - 50, E0 + 60, N0 + 60],
  focusExtent: [E0 - 50, N0 - 50, E0 + 60, N0 + 60],
  skipped: {},
  warnings: [],
});

describe('box schedule', () => {
  it('interpolates a 3D line level exactly where it crosses each edge', () => {
    // runs west->east at y=5, from x=-5 (RL 40.000) to x=15 (RL 42.000): crosses x=0 and x=10
    const f = line('GAS', [P(-5, 5), P(15, 5)], { z: [40, 42] });
    const [e] = new ScheduleEngine(drawing([f])).compute(BOX);
    expect(e.relation).toBe('crosses');
    expect(e.distance).toBe(0);
    expect(e.points.map((p) => [p.at[0] - E0, p.at[1] - N0])).toEqual([[0, 5], [10, 5]]);
    expect(e.points[0].rl).toEqual({ value: 40.5, source: '3D line' });
    expect(e.points[1].rl!.value).toBeCloseTo(41.5, 9);
  });

  it('reports the closest point and its distance for a service that does not cross', () => {
    // parallel 3 m north of the box, flat polyline with an elevation
    const f = line('COMMS', [P(-5, 13), P(15, 13)], { meta: { elevation: 33.25 } });
    const [e] = new ScheduleEngine(drawing([f])).compute(BOX);
    expect(e.relation).toBe('near');
    expect(e.distance).toBeCloseTo(3, 9);
    expect(e.points[0].at[1] - N0).toBeCloseTo(13, 9);
    expect(e.points[0].onBox[1] - N0).toBeCloseTo(10, 9);
    expect(e.points[0].rl).toEqual({ value: 33.25, source: 'elevation' });
  });

  it('includes services at exactly 10 m and excludes those beyond', () => {
    const at10 = line('A', [P(-5, 20), P(15, 20)]);
    const at10_01 = line('B', [P(-5, 20.01), P(15, 20.01)]);
    const res = new ScheduleEngine(drawing([at10, at10_01])).compute(BOX);
    expect(res.map((e) => e.run.layer)).toEqual(['A']);
  });

  it('measures the diagonal gap to a corner', () => {
    const f = line('A', [P(13, 14), P(20, 20)]); // nearest point (13,14) to corner (10,10): 5 m
    const [e] = new ScheduleEngine(drawing([f])).compute(BOX);
    expect(e.distance).toBeCloseTo(5, 9);
  });

  it('treats a pit symbol as one item, with its RL attribute', () => {
    const meta = { insertHandle: 'PIT1', attributes: { OWNER: 'Telstra', RL_LID: '45.210' } };
    const pit = [
      line('COMMS', [P(11, 4), P(12, 4), P(12, 5), P(11, 5), P(11, 4)], { block: 'PIT', meta }),
      line('COMMS', [P(11, 4), P(12, 5)], { block: 'PIT', meta, entityType: 'LINE' }),
    ];
    const res = new ScheduleEngine(drawing(pit)).compute(BOX);
    expect(res).toHaveLength(1);
    expect(res[0].distance).toBeCloseTo(1, 9);
    expect(res[0].points[0].rl).toEqual({ value: 45.21, source: 'attribute' });
    expect(res[0].points[0].at.map((v, i) => v - [E0, N0][i])).toEqual([11.5, 4.5]);
  });

  it('falls back to a nearby "RL" label, preferring the same layer, and ignores far labels', () => {
    const f = line('ELEC', [P(-5, 5), P(15, 5)]);
    const res = new ScheduleEngine(drawing([f, text('RL 31.889', P(1, 6)), text('RL:31.500', P(0.5, 5.5), 'OTHER'), text('RL 99.000', P(9, 9))])).compute(BOX);
    // neither label is on the ELEC layer, so the nearest wins: RL:31.500 is 0.71 m away, RL 31.889 is 1.41 m away
    expect(res[0].points[0].rl).toEqual({ value: 31.5, source: 'label' });
    expect(res[0].points[1].rl).toBeNull(); // RL 99 is 4.1 m away from (10,5): too far
  });

  it('prefers a label on the same layer', () => {
    const f = line('ELEC', [P(-5, 5), P(15, 5)]);
    const res = new ScheduleEngine(drawing([f, text('RL 31.000', P(0.2, 5.2), 'OTHER'), text('RL 32.000', P(1, 6), 'ELEC')])).compute(BOX);
    expect(res[0].points[0].rl).toEqual({ value: 32, source: 'label' });
  });

  it('ignores levels of exactly zero (unlevelled CAD)', () => {
    const f = line('GAS', [P(-5, 5), P(15, 5)], { z: [0, 0] });
    const [e] = new ScheduleEngine(drawing([f])).compute(BOX);
    expect(e.points[0].rl).toBeNull();
  });

  it('reports a run wholly inside the area at its point nearest the centre', () => {
    const f = line('WATER', [P(2, 2), P(2, 8)], { z: [30, 33] });
    const [e] = new ScheduleEngine(drawing([f])).compute(BOX);
    expect(e.relation).toBe('inside');
    expect(e.points[0].at.map((v, i) => v - [E0, N0][i])).toEqual([2, 5]);
    expect(e.points[0].rl!.value).toBeCloseTo(31.5, 9);
  });

  it('lists multiple crossings in order along the service', () => {
    // U-shape dipping into the box from the north: enters at x=3, leaves at x=7
    const f = line('SEWER', [P(3, 15), P(3, 5), P(7, 5), P(7, 15)], { z: [20, 21, 22, 23] });
    const [e] = new ScheduleEngine(drawing([f])).compute(BOX);
    expect(e.points.map((p) => p.at[0] - E0)).toEqual([3, 7]);
    expect(e.points[0].rl!.value).toBeCloseTo(20.5, 9); // halfway down the first leg
    expect(e.points[1].rl!.value).toBeCloseTo(22.5, 9);
  });

  it('works for a free-form (L-shaped) area', () => {
    const L: XY[] = [P(0, 0), P(10, 0), P(10, 4), P(4, 4), P(4, 10), P(0, 10), P(0, 0)];
    // diagonal x+y=16 through the notch: nearest L points are the corners (10,4) and (4,10), each sqrt(2) m away
    const f = line('X', [P(5, 11), P(11, 5)]);
    const [e] = new ScheduleEngine(drawing([f])).compute(L);
    expect(e.relation).toBe('near');
    expect(e.distance).toBeCloseTo(Math.SQRT2, 9);
  });

  it('skips text and sorts nearest first', () => {
    const res = new ScheduleEngine(drawing([line('FAR', [P(-5, 18), P(15, 18)]), line('NEAR', [P(-5, 11), P(15, 11)]), text('RL 1.0', P(5, 5))])).compute(BOX);
    expect(res.map((e) => e.run.layer)).toEqual(['NEAR', 'FAR']);
  });
});

describe('RL formatting', () => {
  it('marks anything below QL-A as approximate', () => {
    expect(formatRl(32.0884, 'B')).toBe('~32.088');
    expect(formatRl(31.889, 'A')).toBe('31.889');
    expect(formatRl(31.889, null)).toBe('~31.889');
  });
});
