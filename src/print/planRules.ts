/** Light printout helpers (no PDF library), usable before the printout code is loaded. */
import type { XY } from '../cad/types';
import type { ScheduleRow } from '../services/scheduleModel';
import { A3_LANDSCAPE_1_300, extentOnSheet, frameFor } from './sheet';

export type PlanKind = 'services' | 'overheads';

/** Does the box fit on the sheet at 1:300 with the current rotation? */
export function fitsOnSheet(ring: XY[], rotation: number): { fits: boolean; boxW: number; boxH: number; sheetW: number; sheetH: number } {
  const frame = frameFor(A3_LANDSCAPE_1_300);
  const { w, h } = extentOnSheet(ring, rotation);
  return { fits: w <= frame.groundW && h <= frame.groundH, boxW: w, boxH: h, sheetW: frame.groundW, sheetH: frame.groundH };
}

/** Rows that belong on a plan: services plan = not overhead; overheads plan = overhead. */
export function rowsForPlan(rows: ScheduleRow[], kind: PlanKind): ScheduleRow[] {
  return rows.filter((r) => !r.excluded && (kind === 'overheads' ? r.info.overhead : !r.info.overhead));
}

/** Callout border colour: the service's map colour, darkened if too pale to see on a white box. */
export function calloutColour(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.8 ? '#333333' : hex;
}

