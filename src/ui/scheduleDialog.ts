/** Full, editable schedule of services near a work area. */
import { SCHEDULE_RADIUS } from '../analysis/schedule';
import { OWNERS, SERVICE_TYPES } from '../services/dictionary';
import { type ScheduleEdits, type ScheduleRow, rlText } from '../services/scheduleModel';
import { esc } from './panels';

const RL_SOURCE: Record<string, string> = {
  '3D line': 'from the line’s 3D levels',
  elevation: 'from the object’s elevation',
  attribute: 'from an RL attribute',
  label: 'from a nearby RL label',
  edit: 'your edit',
};
const WHERE: Record<string, string> = { crosses: 'Crosses box', inside: 'Inside box', near: 'Near' };

export class ScheduleDialog {
  private dialog: HTMLDialogElement;
  private boxId: number | null = null;

  constructor(
    private edits: ScheduleEdits,
    private getRows: (boxId: number) => { name: string; rows: ScheduleRow[] } | null,
    private onShowRow: (row: ScheduleRow) => void,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'services-dialog schedule-dialog';
    document.body.appendChild(this.dialog);
    this.dialog.addEventListener('close', () => (this.boxId = null));
  }

  get openBoxId(): number | null {
    return this.boxId;
  }

  open(boxId: number): void {
    this.boxId = boxId;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Re-render if open (after edits, register changes or box changes). */
  refresh(): void {
    if (this.boxId !== null && this.dialog.open) this.render();
  }

  private render(): void {
    const data = this.boxId !== null ? this.getRows(this.boxId) : null;
    if (!data) {
      this.dialog.close();
      return;
    }
    const { name, rows } = data;
    const needing = rows.filter((r) => !r.excluded && (r.needs.type || r.needs.owner || r.needs.rl)).length;
    const scrollTop = this.dialog.querySelector('.dlg-body')?.scrollTop ?? 0;
    this.dialog.innerHTML = `
      <form method="dialog" class="dlg-head">
        <h2>${esc(name)}: services within ${SCHEDULE_RADIUS} m</h2>
        <button class="btn small" value="close" aria-label="Close">✕</button>
      </form>
      <p class="muted dlg-intro">RLs are given where each service crosses the box outline, or at its closest point if it doesn't cross.
      “~” marks a level not surveyed to QL-A. <b class="needs">Highlighted</b> cells need your input. Type over any value to correct it.
      Untick <i>Include</i> to leave a service off the plan. Click a row's ID to show it on the map.
      ${needing ? `<br><b class="svc-unknown">${needing} service${needing === 1 ? '' : 's'} need${needing === 1 ? 's' : ''} input.</b>` : ''}</p>
      <div class="dlg-body">${
        rows.length
          ? `<table class="svc-table sched-table">
          <thead><tr><th>ID</th><th>Service type</th><th>Owner</th><th>QL</th><th>Details / layer</th><th>Where</th><th class="num">Distance</th><th>RL</th><th>Include</th></tr></thead>
          <tbody>${rows.map((r) => this.row(r)).join('')}</tbody></table>`
          : '<p class="muted">No services within this distance of the box.</p>'
      }</div>
      <datalist id="sched-type-options">${SERVICE_TYPES.map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>
      <datalist id="sched-owner-options">${OWNERS.map((o) => `<option value="${esc(o.name)}">`).join('')}</datalist>`;
    const body = this.dialog.querySelector('.dlg-body')!;
    body.scrollTop = scrollTop;
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
