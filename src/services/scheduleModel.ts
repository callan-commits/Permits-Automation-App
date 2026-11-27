/** Schedule rows for a work area: geometry (ScheduleEngine) + service info (register) + user edits. */
import type { SurfaceModel, SurfaceResult } from '../analysis/surface';
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
  /** Ground surface entered by hand for the called-out point (e.g. where the survey has none). */
  surface?: string;
}

export interface RowPoint {
  text: string | null;
  source: RlSource | 'edit' | null;
  at: XY;
  /** Ground surface at the point: undefined when depths aren't being worked out (no feature survey). */
  surface?: { value: number | null; method: SurfaceResult['method'] | 'edit'; detail: string };
  /** Depth of the service below the surface, m (surface − RL); null if either is unknown. */
  depth?: number | null;
}

export interface ScheduleRow {
  /** Label used on the plan and in the schedule, e.g. "S3". */
  id: string;
  key: string;
  entry: ScheduleEntry;
  info: ServiceInfo;
  /**
   * Per point: RL text (formatted, with "~" when approximate) or null where unknown; and, when a feature
   * survey is loaded (or a surface was entered), the ground surface there and the depth (surface − RL).
   */
  rls: RowPoint[];
  excluded: boolean;
  /** What still needs the user's input. */
  needs: { type: boolean; owner: boolean; rl: boolean; surface: boolean };
  /**
   * The one point the printout calls out (index into rls): the shallowest crossing, i.e. the smallest
   * known depth (or, without depths, the highest known RL); the first point if neither is known.
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
  /** The feature survey's surface, when one is loaded: gives surface levels and depths. */
  surface: SurfaceModel | null = null,
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
    const rls: RowPoint[] = edit.rl
      ? [{ text: edit.rl, source: 'edit' as const, at: entry.points[0].at }]
      : entry.points.map((p) => ({ text: p.rl ? formatRl(p.rl.value, info.ql) : null, source: p.rl?.source ?? null, at: p.at }));
    const excluded = Boolean(edit.excluded);
    // Depths: underground services only (an overhead wire's level is above the ground).
    const manual = edit.surface !== undefined && Number.isFinite(parseFloat(edit.surface)) ? parseFloat(edit.surface) : null;
    if (!info.overhead && (surface || manual !== null)) {
      for (const p of rls) {
        const s = surface ? surface.at(p.at) : { value: null, method: 'none' as const, detail: 'No feature survey loaded' };
        p.surface = { value: s.value, method: s.method, detail: s.detail };
        p.depth = depthOf(p);
      }
    }
    let calloutIndex = shallowest(rls);
    if (manual !== null && rls[calloutIndex]) {
      const p = rls[calloutIndex];
      p.surface = { value: manual, method: 'edit', detail: 'Entered by hand' };
      p.depth = depthOf(p);
      calloutIndex = shallowest(rls);
    }
    const called = rls[calloutIndex];
    return {
      id: excluded ? '–' : `S${++n}`,
      key: entry.run.key,
      entry,
      info,
      rls,
      excluded,
      needs: {
        type: !info.type,
        owner: !info.owner,
        rl: rls.some((r) => r.text === null),
        surface: Boolean(called?.surface && (called.surface.value === null || (called.depth ?? 0) < 0)),
      },
      calloutIndex,
      joinedPieces: entry.run.pieces?.length ?? 1,
      splitFrom: entry.run.parentKey ?? null,
    };
  });
}

/** Numeric value of an RL text ("~32.088" → 32.088), or NaN. */
export function rlValue(text: string | null): number {
  return text === null ? NaN : parseFloat(text.replace(/[^0-9.\-]/g, ''));
}

function depthOf(p: RowPoint): number | null {
  const rl = rlValue(p.text);
  return p.surface?.value != null && Number.isFinite(rl) ? p.surface.value - rl : null;
}

/**
 * Index of the shallowest point: the smallest known depth; without depths, the highest known RL;
 * 0 if neither is known.
 */
export function shallowest(rls: { text: string | null; depth?: number | null }[]): number {
  const withDepth = rls.map((r, i) => [r.depth, i] as const).filter(([d]) => typeof d === 'number' && Number.isFinite(d));
  if (withDepth.length) return withDepth.reduce((a, b) => (b[0]! < a[0]! ? b : a))[1];
  let best = 0;
  let bestValue = -Infinity;
  rls.forEach((r, i) => {
    const v = rlValue(r.text);
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
