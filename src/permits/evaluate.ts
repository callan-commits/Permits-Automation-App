/**
 * Which permits a work area needs: a rule applies when any asset of its owner is within the
 * rule's distance of the area (horizontal, inclusive; crossing or inside = 0 m).
 *
 * Every service is checked, including overhead ones and rows left off the plan. Services whose
 * owner is unknown are reported separately, because one of them could trigger a permit.
 */
import type { ScheduleEngine } from '../analysis/schedule';
import type { XY } from '../cad/types';
import type { ServiceRegister } from '../services/register';
import type { ScheduleEdits } from '../services/scheduleModel';
import { type PermitRule, ownerMatchesRule } from './rules';

export interface PermitTrigger {
  runKey: string;
  layer: string;
  owner: string;
  type: string | null;
  distance: number;
  rule: PermitRule;
  overhead: boolean;
}

export interface RequiredPermit {
  permit: string;
  /** Closest asset triggering each rule that requires this permit, nearest first. */
  triggers: PermitTrigger[];
}

export interface PermitCheck {
  required: RequiredPermit[];
  /** For every rule: its nearest matching asset (or null if none within the search radius). */
  byRule: { rule: PermitRule; nearest: PermitTrigger | null; required: boolean }[];
  /** Services within the largest rule distance whose owner is unknown. */
  unknownOwners: { runKey: string; layer: string; distance: number; type: string | null }[];
}

export function checkPermits(engine: ScheduleEngine, register: ServiceRegister, edits: ScheduleEdits, ring: XY[], allRules: PermitRule[]): PermitCheck {
  // Half-filled rules (no owner or permit name yet) are ignored.
  const rules = allRules.filter((r) => r.owner.trim() && r.permit.trim() && Number.isFinite(r.distance));
  const maxDist = rules.reduce((m, r) => Math.max(m, r.distance), 0);
  // Search a little beyond the largest rule so "nearest" can be reported for rules not triggered.
  const entries = engine.compute(ring, Math.max(maxDist, 10) + 10, (run) => register.isService(run.layer));
  const byRule = rules.map((rule) => ({ rule, nearest: null as PermitTrigger | null, required: false }));
  const unknownOwners: PermitCheck['unknownOwners'] = [];
  for (const entry of entries) {
    const edit = edits.get(entry.run.key);
    const info = register.resolve(entry.run.primary, { type: edit.type, owner: edit.owner });
    if (!info.owner) {
      if (entry.distance <= maxDist + 1e-9) unknownOwners.push({ runKey: entry.run.key, layer: entry.run.layer, distance: entry.distance, type: info.type });
      continue;
    }
    for (const slot of byRule) {
      if (!ownerMatchesRule(info.owner, slot.rule)) continue;
      if (!slot.nearest || entry.distance < slot.nearest.distance) {
        slot.nearest = {
          runKey: entry.run.key,
          layer: entry.run.layer,
          owner: info.owner,
          type: info.type,
          distance: entry.distance,
          rule: slot.rule,
          overhead: info.overhead,
        };
      }
    }
  }
  const required = new Map<string, RequiredPermit>();
  for (const slot of byRule) {
    // Inclusive, with a tolerance far below survey precision so 6.4 m exactly counts as "within 6.4 m".
    slot.required = Boolean(slot.nearest && slot.nearest.distance <= slot.rule.distance + 1e-6);
    if (!slot.required) continue;
    const key = slot.rule.permit.trim();
    const p = required.get(key) ?? { permit: key, triggers: [] };
    p.triggers.push(slot.nearest!);
    required.set(key, p);
  }
  const list = [...required.values()];
  list.forEach((p) => p.triggers.sort((a, b) => a.distance - b.distance));
  return { required: list.sort((a, b) => a.permit.localeCompare(b.permit)), byRule, unknownOwners: unknownOwners.sort((a, b) => a.distance - b.distance) };
}
