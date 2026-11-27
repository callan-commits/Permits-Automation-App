import { describe, expect, it } from 'vitest';
import { BRANCH_MAX_TURN, JOINT_TOLERANCE, ScheduleEngine, joinRuns, buildRuns } from '../src/analysis/schedule';
import type { CadDrawing, CadFeature, XY } from '../src/cad/types';
import { calloutSpecs } from '../src/print/callouts';
import { ServiceRegister } from '../src/services/register';
import { ScheduleEdits, scheduleRows, shallowest } from '../src/services/scheduleModel';

let n = 0;
/** A survey line with levels, on a layer, with optional object data. */
function line(layer: string, coords: XY[], z?: number[], attributes: Record<string, string> = {}): CadFeature {
  return { kind: 'line', layer, color: '#ff0000', entityType: '12D_SUPER', handle: `h${++n}`, coords, z, meta: { attributes } };
}
function drawing(features: CadFeature[]): CadDrawing {
  return { fileName: 't', layers: [], features, extent: [-100, -100, 100, 100], focusExtent: [-100, -100, 100, 100], skipped: {}, warnings: [] };
}
const BOX: XY[] = [[0, 0], [10, 0], [10, 4], [0, 4], [0, 0]];
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const runsOf = (fs: CadFeature[]) => joinRuns(buildRuns(drawing(fs)));
const VT = { OWNER: 'VicTrack', TYPE: 'Communications', QUALITY_LEVEL: 'QL-B' };

describe('joining pieces of one service', () => {
  it('joins pieces that meet end to end on the same layer with the same owner, type and QL', () => {
    const runs = runsOf([
      line('Comms', [[-5, 2], [3, 2]], [30, 31], VT),
      line('Comms', [[3, 2], [8, 2]], [31, 32], VT),
      line('Comms', [[8, 2], [15, 2]], [32, 33], VT),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].pieces).toHaveLength(3);
    expect(runs[0].key.startsWith('J:')).toBe(true);
  });

  it('keeps pieces apart when the QL, owner, type or layer changes', () => {
    const a = line('Comms', [[-5, 2], [3, 2]], [30, 31], VT);
    expect(runsOf([a, line('Comms', [[3, 2], [15, 2]], [31, 32], { ...VT, QUALITY_LEVEL: 'QL-A' })])).toHaveLength(2);
    expect(runsOf([a, line('Comms', [[3, 2], [15, 2]], [31, 32], { ...VT, OWNER: 'Telstra' })])).toHaveLength(2);
    expect(runsOf([a, line('Comms', [[3, 2], [15, 2]], [31, 32], { ...VT, TYPE: 'Electricity' })])).toHaveLength(2);
    expect(runsOf([a, line('Comms QL A', [[3, 2], [15, 2]], [31, 32], VT)])).toHaveLength(2);
  });

  it(`only joins ends within ${JOINT_TOLERANCE * 100} cm`, () => {
    const a = line('Comms', [[-5, 2], [3, 2]], [30, 31], VT);
    expect(runsOf([a, line('Comms', [[3.005, 2], [15, 2]], [31, 32], VT)])).toHaveLength(1);
    expect(runsOf([a, line('Comms', [[3.02, 2], [15, 2]], [31, 32], VT)])).toHaveLength(2);
  });

  it('joins round corners and pieces drawn in opposite directions', () => {
    const runs = runsOf([line('Comms', [[-5, 2], [3, 2]], [30, 31], VT), line('Comms', [[3, -8], [3, 2]], [33, 31], VT)]);
    expect(runs).toHaveLength(1);
    expect(runs[0].reversed).toEqual([false, true]);
  });

  it(`at a branch, joins only the pair that carries straight on (turn under ${BRANCH_MAX_TURN}°)`, () => {
    const runs = runsOf([
      line('Comms', [[-5, 2], [3, 2]], [30, 31], VT),
      line('Comms', [[3, 2], [15, 2]], [31, 32], VT),
      line('Comms', [[3, 2], [3, 9]], [31, 31], VT), // branch off at 90°
    ]);
    expect(runs).toHaveLength(2);
    const joined = runs.find((r) => r.pieces)!;
    expect(joined.features.map((f) => (f as CadFeature & { coords: XY[] }).coords)).toEqual([[[-5, 2], [3, 2]], [[3, 2], [15, 2]]]);
  });

  it('a different service ending at the same point does not stop the join', () => {
    const runs = runsOf([
      line('Comms', [[-5, 2], [3, 2]], [30, 31], VT),
      line('Comms', [[3, 2], [3, -9]], [31, 30], VT), // corner, same service
      line('Gas', [[3, 2], [3, 9]], [29, 29], { OWNER: 'Multinet', TYPE: 'Gas' }),
    ]);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.pieces)!.pieces).toHaveLength(2);
  });

  it('never joins closed outlines (pits)', () => {
    const pit: XY[] = [[3, 2], [4, 2], [4, 3], [3, 3], [3, 2]];
    expect(runsOf([line('Comms', [[-5, 2], [3, 2]], [30, 31], VT), line('Comms', pit, [31, 31, 31, 31, 31], VT)])).toHaveLength(2);
  });
});

describe('schedule with joined services', () => {
  // One cable broken into four pieces, three joints inside the 10 m zone; one with a level step.
  const pieces = () => [
    line('Comms', [[-8, 2], [-1, 2]], [30.0, 30.2], VT),
    line('Comms', [[-1, 2], [4, 2]], [30.2, 30.5], VT),
    line('Comms', [[4, 2], [12, 2]], [30.6, 31.0], VT), // 100 mm step at the joint: kept, not smoothed
    line('Comms', [[12, 2], [18, 2]], [31.0, 31.2], VT),
  ];

  it('one row per service, with the crossings in order and RLs from each piece', () => {
    const engine = new ScheduleEngine(drawing(pieces()));
    expect(engine.stats).toEqual({ joined: 4, services: 1, obvertsCovered: 0 });
    const entries = engine.compute(BOX);
    expect(entries).toHaveLength(1);
    expect(entries[0].relation).toBe('crosses');
    expect(entries[0].points.map((p) => p.at)).toEqual([[0, 2], [10, 2]]);
    // x=0 on piece 2 (30.2 → 30.5 over 5 m): 30.2 + 0.3 * 1/5 = 30.26; x=10 on piece 3: 30.6 + 0.4 * 6/8 = 30.9
    expect(entries[0].points.map((p) => p.rl!.value)).toEqual([expect.closeTo(30.26, 9), expect.closeTo(30.9, 9)]);
  });

  it('crossings are ordered along the service even when pieces are drawn backwards', () => {
    const fs = pieces();
    fs[2] = line('Comms', [[12, 2], [4, 2]], [31.0, 30.6], VT);
    const entries = new ScheduleEngine(drawing(fs)).compute(BOX);
    expect(entries).toHaveLength(1);
    expect(entries[0].points.map((p) => p.at[0])).toEqual([0, 10]);
    expect(entries[0].points[1].rl!.value).toBeCloseTo(30.9, 9);
  });

  it('one callout per service, at the shallowest crossing (highest RL)', () => {
    const engine = new ScheduleEngine(drawing(pieces()));
    const rows = scheduleRows(engine, new ServiceRegister(memory()), new ScheduleEdits(), BOX);
    expect(rows).toHaveLength(1);
    expect(rows[0].joinedPieces).toBe(4);
    expect(rows[0].rls.map((r) => r.text)).toEqual(['~30.260', '~30.900']);
    expect(rows[0].calloutIndex).toBe(1);
    const specs = calloutSpecs(rows, (g) => g, () => '#ff0000');
    expect(specs).toHaveLength(1);
    expect(specs[0].anchor).toEqual([10, 2]);
    expect(specs[0].lines).toEqual(['VicTrack Comms', 'RL: ~30.900 QLB']);
  });

  it('a QL change along the cable gives one callout for each part', () => {
    const fs = pieces();
    fs[2] = line('Comms', [[4, 2], [12, 2]], [30.6, 31.0], { ...VT, QUALITY_LEVEL: 'QL-A' });
    fs[3] = line('Comms', [[12, 2], [18, 2]], [31.0, 31.2], { ...VT, QUALITY_LEVEL: 'QL-A' });
    const rows = scheduleRows(new ScheduleEngine(drawing(fs)), new ServiceRegister(memory()), new ScheduleEdits(), BOX);
    expect(rows.map((r) => [r.info.ql, r.joinedPieces])).toEqual([['B', 2], ['A', 2]]);
    expect(calloutSpecs(rows, (g) => g, () => '#ff0000').map((s) => s.lines[1])).toEqual(['RL: ~30.260 QLB', 'RL: 30.900 QLA']);
  });

  it('a joined service can be split back into its pieces, and re-joined', () => {
    const engine = new ScheduleEngine(drawing(pieces()));
    const edits = new ScheduleEdits();
    const reg = new ServiceRegister(memory());
    const key = scheduleRows(engine, reg, edits, BOX)[0].key;
    edits.set(key, { split: true });
    const split = scheduleRows(engine, reg, edits, BOX);
    expect(split.map((r) => [r.entry.relation, r.splitFrom])).toEqual([
      ['crosses', key],
      ['crosses', key],
      ['near', key],
      ['near', key],
    ]);
    edits.set(key, { split: undefined });
    expect(scheduleRows(engine, reg, edits, BOX)).toHaveLength(1);
  });

  it('a service that only passes nearby gets one closest-point callout, not one per piece', () => {
    const fs = pieces().map((f) => ({ ...f, coords: (f as CadFeature & { coords: XY[] }).coords.map(([x, y]) => [x, y + 5] as XY) }) as CadFeature);
    const entries = new ScheduleEngine(drawing(fs)).compute(BOX);
    expect(entries).toHaveLength(1);
    expect(entries[0].relation).toBe('near');
    expect(entries[0].points).toHaveLength(1);
  });

  it('shallowest picks the highest known RL, else the first point', () => {
    expect(shallowest([{ text: '~30.1' }, { text: '~31.2' }, { text: null }])).toBe(1);
    expect(shallowest([{ text: null }, { text: '29.5' }])).toBe(1);
    expect(shallowest([{ text: null }, { text: null }])).toBe(0);
  });
});

describe('drain inverts and obverts', () => {
  const D = { OWNER: 'Melbourne Water', TYPE: 'Drainage' };
  it('an obvert lying along an invert is left out (the invert is used); obvert-only drains are kept', () => {
    const engine = new ScheduleEngine(
      drawing([
        line('UT Drain Inv QL A', [[-5, 2], [15, 2]], [28, 28.2], D),
        line('UT Drain Obv QL A', [[-5, 2.1], [15, 2.1]], [28.6, 28.8], D), // 10 cm off the invert: same pipe
        line('UT Drain Obv QL A', [[-5, 3.5], [15, 3.5]], [29, 29], D), // 1.5 m away: a different pipe
      ]),
    );
    expect(engine.stats.obvertsCovered).toBe(1);
    const entries = engine.compute(BOX);
    expect(entries.map((e) => [e.run.layer, e.points[0].at[1]])).toEqual([
      ['UT Drain Inv QL A', 2],
      ['UT Drain Obv QL A', 3.5],
    ]);
  });

  it('works with DWG-style layer names, and not on words that merely contain "inv"', () => {
    const engine = new ScheduleEngine(
      drawing([
        line('SW_INV', [[-5, 2], [15, 2]], [28, 28.2], D),
        line('SW_OBV', [[-5, 2], [15, 2]], [28.6, 28.8], D),
        line('INVESTIGATION', [[-5, 1], [15, 1]], [28, 28], D),
        line('SW_OBVERT', [[-5, 1], [15, 1]], [28.6, 28.6], D),
      ]),
    );
    expect(engine.stats.obvertsCovered).toBe(1);
  });
});
