/**
 * Permit rules: "work within X m of <owner>'s assets needs permit P".
 * The built-in cheat sheet is used unless the rules have been edited in the app; edits are kept in
 * this browser only, and "Reset" returns to the built-in rules.
 */
import { normaliseOwner } from '../services/register';
import { BUILT_IN_RULES } from './builtInRules';

export interface PermitRule {
  id: string;
  /** Owner as written; "A/B" lists alternative names for the same owner. */
  owner: string;
  /** Trigger distance, m: a permit is needed when the work area is within this distance (inclusive). */
  distance: number;
  permit: string;
}

/** Hand edits only. (v1 held rules imported from the cheat sheet; it is no longer read.) */
const STORAGE_KEY = 'permits.rules.v2';
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

export class PermitRules {
  private rules: PermitRule[] = builtIn();
  private edited = false;
  private listeners: (() => void)[] = [];

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeLocalStorage()) {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        this.rules = parsed.filter((r) => r && typeof r.owner === 'string' && typeof r.distance === 'number');
        this.edited = true;
      }
    } catch {
      this.rules = builtIn();
    }
  }

  /** True when the rules differ from the built-in cheat sheet because they were edited in this browser. */
  get isEdited(): boolean {
    return this.edited;
  }

  /** Go back to the built-in cheat sheet. */
  resetToBuiltIn(): void {
    this.rules = builtIn();
    this.edited = false;
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.listeners.forEach((fn) => fn());
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
    this.edited = true;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.rules));
    } catch {
      /* session only */
    }
    this.listeners.forEach((fn) => fn());
  }
}

function builtIn(): PermitRule[] {
  return BUILT_IN_RULES.map((r) => ({ ...r, id: newId() }));
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
