/** Schedule rows for a work area: geometry (ScheduleEngine) + service info (register) + user edits. */
import type { RlSource, ScheduleEngine, ScheduleEntry } from '../analysis/schedule';
import { SCHEDULE_RADIUS, formatRl } from '../analysis/schedule';
import type { XY } from '../cad/types';
import { type ServiceInfo, type ServiceRegister, normaliseOwner, normaliseType } from './register';

export interface RowEdit {
  type?: string;
  owner?: string;
  /** Free text replacing the computed RL(s), e.g. "32.10, 32.15". */
  rl?: string;
  /** Left out of the schedule, callouts and permits. */
  excluded?: boolean;
  /** For a service joined from several pieces: schedule the pieces separately instead. */
  split?: boolean;
}

export interface ScheduleRow {
  /** Label used on the plan and in the schedule, e.g. "S3". */
  id: string;
  key: string;
  entry: ScheduleEntry;
  info: ServiceInfo;
  /** RL text per point (formatted, with "~" when approximate) or null where unknown. */
  rls: { text: string | null; source: RlSource | 'edit' | null; at: XY }[];
  excluded: boolean;
  /** What still needs the user's input. */
  needs: { type: boolean; owner: boolean; rl: boolean };
  /**
   * The one point the printout calls out (index into rls): the shallowest crossing, i.e. the highest
   * known RL; the first point if no RL is known.
   */
  calloutIndex: number;
  /** A service joined from several pieces: how many (shown so the join can be checked or split). */
  joinedPieces: number;
  /** A piece of a joined service that was split apart: the joined service's key, to re-join it. */
  splitFrom: string | null;
}

/** Edits to schedule rows, remembered per drawing in the browser. */
export class ScheduleEdits {
  private edits: Record<string, RowEdit> = {};
  private storageKey: string | null = null;
  private listeners: (() => void)[] = [];

  /** Switch to the edits for a drawing (identified by file name and object count). */
  useDrawing(id: string | null): void {
    this.storageKey = id ? `permits.scheduleEdits.v1:${id}` : null;
    this.edits = {};
    try {
      const raw = this.storageKey ? localStorage.getItem(this.storageKey) : null;
      if (raw) this.edits = JSON.parse(raw) ?? {};
    } catch {
      this.edits = {};
    }
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  get(key: string): RowEdit {
    return this.edits[key] ?? {};
  }

  set(key: string, patch: RowEdit): void {
    const next: RowEdit = { ...this.edits[key], ...patch };
    if (next.owner) next.owner = normaliseOwner(next.owner);
    if (next.type) next.type = normaliseType(next.type);
    for (const k of Object.keys(next) as (keyof RowEdit)[]) {
      if (next[k] === undefined || next[k] === '' || next[k] === false) delete next[k];
    }
    if (Object.keys(next).length) this.edits[key] = next;
    else delete this.edits[key];
    try {
      if (this.storageKey) localStorage.setItem(this.storageKey, JSON.stringify(this.edits));
    } catch {
      /* session only */
    }
    this.listeners.forEach((fn) => fn());
  }
}

export function scheduleRows(
  engine: ScheduleEngine,
  register: ServiceRegister,
  edits: ScheduleEdits,
  ring: XY[],
  radius = SCHEDULE_RADIUS,
): ScheduleRow[] {
  const entries = engine.compute(
    ring,
    radius,
    (run) => register.isService(run.layer),
    (key) => Boolean(edits.get(key).split),
  );
  let n = 0;
  return entries.map((entry) => {
    const edit = edits.get(entry.run.key);
    const info = register.resolve(entry.run.primary, { type: edit.type, owner: edit.owner });
    const rls = edit.rl
      ? [{ text: edit.rl, source: 'edit' as const, at: entry.points[0].at }]
      : entry.points.map((p) => ({ text: p.rl ? formatRl(p.rl.value, info.ql) : null, source: p.rl?.source ?? null, at: p.at }));
    const excluded = Boolean(edit.excluded);
    return {
      id: excluded ? '–' : `S${++n}`,
      key: entry.run.key,
      entry,
      info,
      rls,
      excluded,
      needs: { type: !info.type, owner: !info.owner, rl: rls.some((r) => r.text === null) },
      calloutIndex: shallowest(rls),
      joinedPieces: entry.run.pieces?.length ?? 1,
      splitFrom: entry.run.parentKey ?? null,
    };
  });
}

/** Index of the highest known RL (the shallowest point), or 0 if none is known. */
export function shallowest(rls: { text: string | null }[]): number {
  let best = 0;
  let bestValue = -Infinity;
  rls.forEach((r, i) => {
    const v = r.text === null ? NaN : parseFloat(r.text.replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(v) && v > bestValue) [best, bestValue] = [i, v];
  });
  return best;
}

/** RLs as one editable string: "~32.311, ~32.256"; "?" marks a missing one; empty if none are known. */
export function rlText(row: ScheduleRow): string {
  return row.rls.some((r) => r.text) ? row.rls.map((r) => r.text ?? '?').join(', ') : '';
}

/** One-line description for lists: "Telstra Comms" / "Unknown Gas" / "Unknown". */
export function describeService(info: ServiceInfo): string {
  if (!info.owner && !info.type) return 'Unknown';
  return [info.owner ?? 'Unknown', info.type].filter(Boolean).join(' ');
}
