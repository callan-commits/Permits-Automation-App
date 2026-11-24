/**
 * Permit rules: "work within X m of <owner>'s assets needs permit P".
 * Loaded from the user's cheat sheet (.xlsx) or edited in the app; stored in the browser only.
 */
import { normaliseOwner } from '../services/register';

export interface PermitRule {
  id: string;
  /** Owner as written; "A/B" lists alternative names for the same owner. */
  owner: string;
  /** Trigger distance, m: a permit is needed when the work area is within this distance (inclusive). */
  distance: number;
  permit: string;
}

const STORAGE_KEY = 'permits.rules.v1';
let idCounter = 0;
const newId = () => `r${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** All names a rule's owner can appear under, normalised for comparison. */
export function ruleOwnerKeys(owner: string): string[] {
  const parts = owner.split('/').map((p) => p.trim()).filter(Boolean);
  const keys = new Set<string>();
  for (const p of [owner, ...parts]) {
    keys.add(p.trim().toLowerCase());
    keys.add(normaliseOwner(p).toLowerCase());
  }
  return [...keys];
}

export function ownerMatchesRule(serviceOwner: string | null, rule: PermitRule): boolean {
  if (!serviceOwner) return false;
  const keys = ruleOwnerKeys(rule.owner);
  return keys.includes(serviceOwner.trim().toLowerCase()) || keys.includes(normaliseOwner(serviceOwner).toLowerCase());
}

type Cell = string | number | boolean | Date | null | undefined;

/**
 * Read rules from spreadsheet rows. Finds the header row containing "Owner", "Distance" and
 * "Permit" columns anywhere on the sheet and reads rows below it until a blank row.
 * Returns the rules plus any rows that couldn't be read.
 */
export function parseRuleRows(rows: Cell[][]): { rules: PermitRule[]; problems: string[] } {
  const text = (c: Cell) => (c === null || c === undefined ? '' : String(c).trim());
  let header = -1;
  let cols = { owner: -1, distance: -1, permit: -1 };
  for (let r = 0; r < rows.length && header < 0; r++) {
    const row = rows[r].map((c) => text(c).toLowerCase());
    const owner = row.findIndex((c) => /owner/.test(c));
    const distance = row.findIndex((c) => /distance|offset/.test(c));
    const permit = row.findIndex((c) => /permit/.test(c));
    if (owner >= 0 && distance >= 0 && permit >= 0) {
      header = r;
      cols = { owner, distance, permit };
    }
  }
  if (header < 0) return { rules: [], problems: ['No header row with "Owner", "Distance" and "Permit" columns was found.'] };
  const rules: PermitRule[] = [];
  const problems: string[] = [];
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r];
    const owner = text(row[cols.owner]);
    const permit = text(row[cols.permit]);
    const rawDist = row[cols.distance];
    if (!owner && !permit && (rawDist === null || rawDist === undefined || text(rawDist) === '')) {
      if (rules.length) break; // blank row ends the table
      continue;
    }
    const distance = typeof rawDist === 'number' ? rawDist : parseFloat(text(rawDist).replace(/[^0-9.]/g, ''));
    if (!owner || !permit || !Number.isFinite(distance) || distance < 0) {
      problems.push(`Row ${r + 1}: skipped (owner "${owner}", distance "${text(rawDist)}", permit "${permit}")`);
      continue;
    }
    rules.push({ id: newId(), owner, distance, permit });
  }
  return { rules, problems };
}

export class PermitRules {
  private rules: PermitRule[] = [];
  private listeners: (() => void)[] = [];

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocalStorage()) {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) this.rules = parsed.filter((r) => r && typeof r.owner === 'string' && typeof r.distance === 'number');
    } catch {
      this.rules = [];
    }
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  all(): PermitRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  get maxDistance(): number {
    return this.rules.reduce((m, r) => Math.max(m, r.distance), 0);
  }

  replaceAll(rules: Omit<PermitRule, 'id'>[]): void {
    this.rules = rules.map((r) => ({ ...r, id: newId() }));
    this.save();
  }

  add(rule: Omit<PermitRule, 'id'>): void {
    this.rules.push({ ...rule, id: newId() });
    this.save();
  }

  update(id: string, patch: Partial<Omit<PermitRule, 'id'>>): void {
    this.rules = this.rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
    this.save();
  }

  remove(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.save();
  }

  private save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.rules));
    } catch {
      /* session only */
    }
    this.listeners.forEach((fn) => fn());
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
