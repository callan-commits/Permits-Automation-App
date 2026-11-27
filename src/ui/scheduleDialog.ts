/**
 * Full, editable schedule of services near a work area.
 *
 * Shown in a floating panel that leaves the map usable: drag it by its title bar, resize it from the
 * bottom-right corner (position and size are remembered). "Pop out" moves it into its own browser
 * window, e.g. on a second screen; the map and the window stay in step.
 */
import { SCHEDULE_RADIUS } from '../analysis/schedule';
import { OWNERS, SERVICE_TYPES } from '../services/dictionary';
import { type ScheduleEdits, type ScheduleRow, rlText } from '../services/scheduleModel';
import type { PermitCheck } from '../permits/evaluate';
import { esc, permitReason } from './panels';

const RL_SOURCE: Record<string, string> = {
  '3D line': 'from the line’s 3D levels',
  elevation: 'from the object’s elevation',
  attribute: 'from an RL attribute',
  label: 'from a nearby RL label',
  edit: 'your edit',
};
const WHERE: Record<string, string> = { crosses: 'Crosses box', inside: 'Inside box', near: 'Near' };

const GEOMETRY_KEY = 'calvillo.schedulePanel.v1';
const POPUP_NAME = 'calvillo-schedule';

interface Geometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class ScheduleDialog {
  /** The floating in-page panel (a non-modal dialog, so the map stays usable). */
  private panel: HTMLDialogElement;
  /** The separate browser window, when popped out. */
  private popup: Window | null = null;
  private boxId: number | null = null;
  private geometry: Geometry | null = loadGeometry();

  constructor(
    private edits: ScheduleEdits,
    private getRows: (boxId: number) => { name: string; rows: ScheduleRow[]; permits: PermitCheck | null; ruleCount: number } | null,
    private onShowRow: (row: ScheduleRow) => void,
    /** Called when the schedule opens, closes or changes box. */
    private onChange: () => void = () => {},
    private toast: (m: string, isError?: boolean) => void = () => {},
  ) {
    this.panel = document.createElement('dialog');
    this.panel.className = 'services-dialog schedule-dialog schedule-panel';
    document.body.appendChild(this.panel);
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    new ResizeObserver(() => {
      if (!this.panel.open) return;
      const r = this.panel.getBoundingClientRect();
      if (r.width && r.height) this.saveGeometry({ left: r.left, top: r.top, width: r.width, height: r.height });
    }).observe(this.panel);
    window.addEventListener('resize', () => {
      if (this.panel.open) this.place();
    });
    // Don't leave an orphaned window behind when the app is closed or reloaded.
    window.addEventListener('pagehide', () => this.popup?.close());
  }

  /** The box whose schedule is showing, if any. */
  get openBoxId(): number | null {
    return this.boxId;
  }

  /** Where the in-page panel is on screen, when it is showing. */
  get panelRect(): DOMRect | null {
    return this.panel.open ? this.panel.getBoundingClientRect() : null;
  }

  get isPoppedOut(): boolean {
    return !!this.popup && !this.popup.closed;
  }

  open(boxId: number): void {
    this.boxId = boxId;
    if (this.isPoppedOut) {
      this.render();
      this.popup!.focus();
    } else {
      if (!this.panel.open) {
        this.panel.show();
        this.place();
      }
      this.render();
    }
    this.onChange();
  }

  /** Re-render if open (after edits, register changes or box changes). */
  refresh(): void {
    if (this.boxId !== null && (this.panel.open || this.isPoppedOut)) this.render();
  }

  close(): void {
    this.boxId = null;
    if (this.panel.open) this.panel.close();
    if (this.popup && !this.popup.closed) this.popup.close();
    this.popup = null;
    this.onChange();
  }

  /** Move the schedule into its own browser window. */
  popOut(): void {
    const g = this.panel.getBoundingClientRect();
    const w = window.open('', POPUP_NAME, `popup=yes,width=${Math.round(Math.max(900, g.width))},height=${Math.round(Math.max(500, g.height))}`);
    if (!w) {
      this.toast('The browser blocked the pop-out window. Allow pop-ups for this site and try again.', true);
      return;
    }
    const doc = w.document;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body class="schedule-popout-body"></body></html>');
    doc.close();
    // Same styles as the app (absolute URLs, so they load from the blank window).
    for (const node of document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')) {
      const copy = node.cloneNode(true) as HTMLLinkElement | HTMLStyleElement;
      if (node.tagName === 'LINK') (copy as HTMLLinkElement).href = (node as HTMLLinkElement).href;
      doc.head.appendChild(doc.adoptNode(copy));
    }
    const root = doc.createElement('div');
    root.className = 'services-dialog schedule-dialog schedule-popout';
    doc.body.appendChild(root);
    w.addEventListener('pagehide', () => {
      // The user closed the window: the schedule is closed too.
      if (this.popup === w) {
        this.popup = null;
        this.boxId = null;
        this.onChange();
      }
    });
    this.popup = w;
    if (this.panel.open) this.panel.close();
    this.render();
    w.focus();
  }

  /** Bring the schedule back into the app window. */
  dock(): void {
    const w = this.popup;
    this.popup = null;
    w?.close();
    if (this.boxId === null) return;
    this.panel.show();
    this.place();
    this.render();
  }

  private root(): HTMLElement | null {
    if (this.isPoppedOut) return this.popup!.document.querySelector<HTMLElement>('.schedule-popout');
    return this.panel.open ? this.panel : null;
  }

  /** Position and size the panel: as last left, else docked in the bottom-right corner of the window. */
  private place(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(this.geometry?.width ?? Math.min(900, vw * 0.55), vw - 16);
    const height = Math.min(this.geometry?.height ?? Math.min(400, vh * 0.4), vh - 16);
    const left = clamp(this.geometry?.left ?? vw - width - 16, 8 - width + 120, vw - 120);
    const top = clamp(this.geometry?.top ?? vh - height - 16, 0, vh - 44);
    Object.assign(this.panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }

  private saveGeometry(g: Geometry): void {
    this.geometry = g;
    try {
      localStorage.setItem(GEOMETRY_KEY, JSON.stringify(g));
    } catch {
      /* ignore */
    }
  }

  /** Drag the panel by its title bar. */
  private enableDrag(head: HTMLElement): void {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, a, select')) return;
      const start = this.panel.getBoundingClientRect();
      const dx = e.clientX - start.left;
      const dy = e.clientY - start.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const left = clamp(ev.clientX - dx, 8 - start.width + 120, window.innerWidth - 120);
        const top = clamp(ev.clientY - dy, 0, window.innerHeight - 44);
        this.panel.style.left = `${left}px`;
        this.panel.style.top = `${top}px`;
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        const r = this.panel.getBoundingClientRect();
        this.saveGeometry({ left: r.left, top: r.top, width: r.width, height: r.height });
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }

  private render(): void {
    const data = this.boxId !== null ? this.getRows(this.boxId) : null;
    const target = this.root();
    if (!data || !target) {
      this.close();
      return;
    }
    const popped = this.isPoppedOut;
    if (popped) this.popup!.document.title = `${data.name}: services schedule – Calvillo`;
    const { name, rows, permits, ruleCount } = data;
    const needing = rows.filter((r) => !r.excluded && (r.needs.type || r.needs.owner || r.needs.rl)).length;
    const scrollTop = target.querySelector('.dlg-body')?.scrollTop ?? 0;
    target.innerHTML = `
      <div class="dlg-head" title="${popped ? '' : 'Drag to move. Resize from the bottom-right corner.'}">
        <h2>${esc(name)}: services within ${SCHEDULE_RADIUS} m</h2>
        <span class="dlg-head-actions">
          ${
            popped
              ? '<button type="button" class="btn small sch-dock" title="Put the schedule back in the app window">↙ Back to app</button>'
              : '<button type="button" class="btn small sch-popout" title="Open the schedule in its own window (e.g. on a second screen)">⧉ Pop out</button>'
          }
          <button type="button" class="btn small sch-close" aria-label="Close">✕</button>
        </span>
      </div>
      <div class="dlg-body">
      <p class="muted dlg-intro">RLs are given where each service crosses the box outline, or at its closest point if it doesn't cross.
      “~” marks a level not surveyed to QL-A. <b class="needs">Highlighted</b> cells need your input. Type over any value to correct it.
      Untick <i>Include</i> to leave a service off the plan. Click a row's ID to show it on the map.
      The owner and type you enter here are used on the printout callouts (e.g. “VicTrack Comms”); services left without an owner print as “[insert service]”, highlighted yellow.
      ${needing ? `<br><b class="svc-unknown">${needing} service${needing === 1 ? '' : 's'} need${needing === 1 ? 's' : ''} input.</b>` : ''}</p>
      ${this.permits(permits, ruleCount, rows)}${
        rows.length
          ? `<table class="svc-table sched-table">
          <thead><tr><th>ID</th><th>Service type</th><th>Owner</th><th>QL</th><th>Details / layer</th><th>Where</th><th class="num">Distance</th><th>RL</th><th>Include</th></tr></thead>
          <tbody>${rows.map((r) => this.row(r)).join('')}</tbody></table>`
          : '<p class="muted">No services within this distance of the box.</p>'
      }</div>
      <datalist id="sched-type-options">${SERVICE_TYPES.map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>
      <datalist id="sched-owner-options">${OWNERS.map((o) => `<option value="${esc(o.name)}">`).join('')}</datalist>`;
    const body = target.querySelector<HTMLElement>('.dlg-body')!;
    body.scrollTop = scrollTop;
    target.querySelector('.sch-close')!.addEventListener('click', () => this.close());
    target.querySelector('.sch-popout')?.addEventListener('click', () => this.popOut());
    target.querySelector('.sch-dock')?.addEventListener('click', () => this.dock());
    if (!popped) this.enableDrag(target.querySelector<HTMLElement>('.dlg-head')!);
    for (const tr of body.querySelectorAll<HTMLTableRowElement>('tr[data-key]')) {
      const key = tr.dataset.key!;
      const row = rows.find((r) => r.key === key)!;
      tr.querySelector<HTMLInputElement>('.sch-type')!.addEventListener('change', (e) => {
        const v = (e.target as HTMLInputElement).value.trim();
        this.edits.set(key, { type: v || undefined });
      });
      tr.querySelector<HTMLInputElement>('.sch-owner')!.addEventListener('change', (e) => {
        const v = (e.target as HTMLInputElement).value.trim();
        this.edits.set(key, { owner: v || undefined });
      });
      tr.querySelector<HTMLInputElement>('.sch-rl')!.addEventListener('change', (e) => {
        const v = (e.target as HTMLInputElement).value.trim();
        const computed = rlText(row);
        this.edits.set(key, { rl: v && v !== computed ? v : undefined });
      });
      tr.querySelector<HTMLInputElement>('.sch-use')!.addEventListener('change', (e) =>
        this.edits.set(key, { excluded: !(e.target as HTMLInputElement).checked }),
      );
      tr.querySelector<HTMLButtonElement>('.sch-show')!.addEventListener('click', () => this.onShowRow(row));
    }
  }

  private permits(check: PermitCheck | null, ruleCount: number, rows: ScheduleRow[]): string {
    if (!ruleCount) return '<div class="permit-section"><h3>Permits</h3><span class="muted">No permit rules: open <b>Permit rules</b> in the toolbar to restore them.</span></div>';
    if (!check) return '';
    const idOf = (key: string) => rows.find((r) => r.key === key && !r.excluded)?.id;
    const ids = (key: string) => (idOf(key) ? ` (${idOf(key)})` : '');
    const required = check.required.length
      ? `<ul>${check.required
          .map((p) => `<li><span class="permit-chip">${esc(p.permit)}</span> ${esc(permitReason(p.triggers))}${p.triggers.map((t) => ids(t.runKey)).join('')}</li>`)
          .join('')}</ul>`
      : '<div class="muted">No permits required by the current rules.</div>';
    const table = `<details><summary class="muted">All rules checked</summary><table class="svc-table"><thead><tr><th>Owner</th><th class="num">Trigger</th><th>Permit</th><th>Nearest asset</th><th>Required</th></tr></thead><tbody>${check.byRule
      .map(
        (b) => `<tr><td>${esc(b.rule.owner)}</td><td class="num">${b.rule.distance} m</td><td>${esc(b.rule.permit)}</td>
          <td>${b.nearest ? `${esc(b.nearest.layer)}${ids(b.nearest.runKey)} at ${b.nearest.distance === 0 ? '0 m' : `${b.nearest.distance.toFixed(2)} m`}` : '<span class="muted">none nearby</span>'}</td>
          <td>${b.required ? '<b>Yes</b>' : 'No'}</td></tr>`,
      )
      .join('')}</tbody></table></details>`;
    return `<div class="permit-section"><h3>Permits</h3>${required}${table}</div>`;
  }

  private row(r: ScheduleRow): string {
    const i = r.info;
    const rl = rlText(r);
    const rlMissing = r.needs.rl && !r.excluded;
    const rlSrc = r.rls[0]?.source === 'edit' ? RL_SOURCE.edit : [...new Set(r.rls.map((x) => (x.source ? RL_SOURCE[x.source] : 'no RL found')))].join('; ');
    const cell = (cls: string, list: string, value: string | null, missing: boolean) =>
      `<td class="${missing && !r.excluded ? 'needs-input' : ''}"><input class="${cls}" list="${list}" value="${esc(value ?? '')}" placeholder="Unknown: fill in" /></td>`;
    const run = r.entry.run;
    return `<tr data-key="${esc(r.key)}" class="${r.excluded ? 'ignored' : ''}">
      <td><button type="button" class="btn small sch-show" title="Show on map">${esc(r.id)}</button></td>
      ${cell('sch-type', 'sched-type-options', i.type, r.needs.type)}
      ${cell('sch-owner', 'sched-owner-options', i.owner, r.needs.owner)}
      <td>${i.ql ? `QL${esc(i.ql)}` : '<span class="muted">–</span>'}</td>
      <td>${i.description ? `${esc(i.description)}<br>` : ''}<span class="src">${esc(run.layer)}${run.block ? ` · ${esc(run.block)}` : ''}${i.overhead ? ' · <b>overhead</b>' : ''}</span></td>
      <td>${WHERE[r.entry.relation]}${r.rls.length > 1 ? ` (${r.rls.length}×)` : ''}</td>
      <td class="num">${r.entry.distance === 0 ? '0.00 m' : `${r.entry.distance.toFixed(2)} m`}</td>
      <td class="${rlMissing ? 'needs-input' : ''}"><input class="sch-rl" value="${esc(rl)}" placeholder="No RL found: enter" /><div class="src">${esc(rlSrc)}</div></td>
      <td class="oh-cell"><input type="checkbox" class="sch-use" ${r.excluded ? '' : 'checked'} /></td>
    </tr>`;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function loadGeometry(): Geometry | null {
  try {
    const g = JSON.parse(localStorage.getItem(GEOMETRY_KEY) ?? 'null');
    return g && [g.left, g.top, g.width, g.height].every((n) => typeof n === 'number' && Number.isFinite(n)) ? g : null;
  } catch {
    return null;
  }
}
