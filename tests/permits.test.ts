import { describe, expect, it } from 'vitest';
import { ScheduleEngine } from '../src/analysis/schedule';
import type { CadDrawing, CadFeature, XY } from '../src/cad/types';
import { checkPermits } from '../src/permits/evaluate';
import { type PermitRule, ownerMatchesRule, parseRuleRows } from '../src/permits/rules';
import { ServiceRegister } from '../src/services/register';
import { ScheduleEdits } from '../src/services/scheduleModel';

// Illustrative rules only (not anyone's real procedure).
const RULES: PermitRule[] = [
  { id: '1', owner: 'MTM/Metro Trains Melbourne', distance: 2, permit: 'PERMIT-A' },
  { id: '2', owner: 'VicTrack', distance: 5, permit: 'PERMIT-B' },
  { id: '3', owner: 'Jemena', distance: 6.4, permit: 'PERMIT-C' },
  { id: '4', owner: 'Zinfra', distance: 6.4, permit: 'PERMIT-C' },
];

describe('reading a cheat sheet', () => {
  it('finds the table anywhere on the sheet (offset header, blank first column)', () => {
    const rows = [
      [null, null, null, null],
      [null, 'Owner', 'Distance (m)', 'Permit Required'],
      [null, 'MTM/Metro Trains Melbourne', 2, 'PERMIT-A'],
      [null, 'VicTrack', '5 m', 'PERMIT-B'],
      [null, 'Jemena', 6.4, 'PERMIT-C'],
      [null, null, null, null],
      [null, 'Notes below the table are ignored', null, null],
    ];
    const { rules, problems } = parseRuleRows(rows);
    expect(rules.map((r) => [r.owner, r.distance, r.permit])).toEqual([
      ['MTM/Metro Trains Melbourne', 2, 'PERMIT-A'],
      ['VicTrack', 5, 'PERMIT-B'],
      ['Jemena', 6.4, 'PERMIT-C'],
    ]);
    expect(problems).toEqual([]);
  });

  it('reports unreadable rows and a missing header', () => {
    expect(parseRuleRows([['Owner', 'Distance', 'Permit'], ['X', 'far', 'P']]).problems[0]).toMatch(/Row 2: skipped/);
    expect(parseRuleRows([['a', 'b']]).problems[0]).toMatch(/No header row/);
  });
});

describe('owner matching', () => {
  it('matches any of the slash-separated names and known abbreviations', () => {
    expect(ownerMatchesRule('Metro Trains Melbourne', RULES[0])).toBe(true);
    expect(ownerMatchesRule('MTM', RULES[0])).toBe(true);
    expect(ownerMatchesRule('metro', RULES[0])).toBe(true);
    expect(ownerMatchesRule('VicTrack', RULES[0])).toBe(false);
    expect(ownerMatchesRule('victrack', RULES[1])).toBe(true);
    expect(ownerMatchesRule(null, RULES[1])).toBe(false);
  });
});

// 10 x 10 m area
const E0 = 327900;
const N0 = 5805900;
const P = (x: number, y: number): XY => [E0 + x, N0 + y];
const AREA: XY[] = [P(0, 0), P(10, 0), P(10, 10), P(0, 10), P(0, 0)];
let h = 0;
/** Horizontal line `gap` m north of the area, owned (via data) by `owner`. */
const lineAt = (layer: string, gap: number, owner?: string): CadFeature =>
  ({ kind: 'line', layer, color: '#fff', entityType: 'LINE', handle: `H${++h}`, coords: [P(-5, 10 + gap), P(15, 10 + gap)], ...(owner ? { meta: { fields: { OWNER: owner } } } : {}) }) as CadFeature;
const drawing = (features: CadFeature[]): CadDrawing => ({
  fileName: 't',
  layers: [...new Set(features.map((f) => f.layer))].map((name) => ({ name, color: '#fff', hiddenInDrawing: false, featureCount: 1 })),
  features,
  extent: [E0 - 50, N0 - 50, E0 + 60, N0 + 60],
  focusExtent: [E0 - 50, N0 - 50, E0 + 60, N0 + 60],
  skipped: {},
  warnings: [],
});
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const run = (features: CadFeature[], register = new ServiceRegister(memory()), edits = new ScheduleEdits()) =>
  checkPermits(new ScheduleEngine(drawing(features)), register, edits, AREA, RULES);

describe('permit check', () => {
  it('requires a permit within the trigger distance, inclusive of the exact distance', () => {
    expect(run([lineAt('A', 1.5, 'MTM')]).required.map((p) => p.permit)).toEqual(['PERMIT-A']);
    expect(run([lineAt('A', 2.0, 'Metro Trains Melbourne')]).required.map((p) => p.permit)).toEqual(['PERMIT-A']);
    expect(run([lineAt('A', 2.01, 'MTM')]).required).toEqual([]);
  });

  it('reports the nearest asset for every rule, required or not', () => {
    const res = run([lineAt('V', 7, 'VicTrack')]);
    const v = res.byRule.find((r) => r.rule.owner === 'VicTrack')!;
    expect(v.required).toBe(false);
    expect(v.nearest!.distance).toBeCloseTo(7, 9);
    expect(res.byRule.find((r) => r.rule.owner === 'Jemena')!.nearest).toBeNull();
  });

  it('groups rules that give the same permit, nearest trigger first', () => {
    const res = run([lineAt('Z', 6.4, 'Zinfra'), lineAt('J', 3, 'Jemena')]);
    expect(res.required).toHaveLength(1);
    expect(res.required[0].permit).toBe('PERMIT-C');
    expect(res.required[0].triggers.map((t) => [t.owner, Math.round(t.distance * 10) / 10])).toEqual([
      ['Jemena', 3],
      ['Zinfra', 6.4],
    ]);
  });

  it('uses owners guessed from layer names and the user’s row edits', () => {
    expect(run([lineAt('VICTRACK COMMS', 4)]).required.map((p) => p.permit)).toEqual(['PERMIT-B']);
    const edits = new ScheduleEdits();
    const f = lineAt('UNKNOWN', 1);
    edits.set(`F:${f.handle}:LINE`, { owner: 'mtm' });
    expect(run([f], undefined, edits).required.map((p) => p.permit)).toEqual(['PERMIT-A']);
  });

  it('flags services of unknown owner within the largest rule distance', () => {
    const res = run([lineAt('MYSTERY', 6.0), lineAt('FAR MYSTERY', 6.5)]);
    expect(res.unknownOwners.map((u) => u.layer)).toEqual(['MYSTERY']);
  });

  it('ignores layers marked "not a service"', () => {
    const register = new ServiceRegister(memory());
    register.setLayer('A', { ignore: true });
    expect(run([lineAt('A', 1, 'MTM')], register).required).toEqual([]);
  });

  it('counts a service inside or crossing the area as 0 m', () => {
    const crossing = { ...lineAt('X', 0, 'VicTrack'), coords: [P(5, -5), P(5, 15)] } as CadFeature;
    const res = run([crossing]);
    expect(res.required.map((p) => p.permit)).toEqual(['PERMIT-B']);
    expect(res.required[0].triggers[0].distance).toBe(0);
  });
});
