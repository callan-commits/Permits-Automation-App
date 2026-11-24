/** Printout dialog: choose services / overheads plan, generate the A3 PDFs and download them. */
import type { ExcavationBox } from '../map/boxTool';
import type { PlanKind, PrintoutResult } from '../print/printout';
import { fitsOnSheet, rowsForPlan } from '../print/planRules';
import type { ScheduleRow } from '../services/scheduleModel';
import { esc } from './panels';
import { INSERT_RL, INSERT_SERVICE } from '../print/callouts';

export class PrintDialog {
  private dialog: HTMLDialogElement;
  private urls: string[] = [];

  constructor(
    private getBox: (id: number) => { box: ExcavationBox; rows: ScheduleRow[] } | null,
    private rotation: () => number,
    private generate: (kind: PlanKind, box: ExcavationBox, rows: ScheduleRow[], stage: (s: string) => void) => Promise<PrintoutResult>,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'services-dialog print-dialog';
    document.body.appendChild(this.dialog);
    this.dialog.addEventListener('close', () => this.revoke());
  }

  open(boxId: number): void {
    const data = this.getBox(boxId);
    if (!data) return;
    const { box, rows } = data;
    const svc = rowsForPlan(rows, 'services');
    const oh = rowsForPlan(rows, 'overheads');
    const pts = (rs: ScheduleRow[]) => rs.reduce((n, r) => n + r.rls.length, 0);
    const noRl = (rs: ScheduleRow[]) => rs.reduce((n, r) => n + r.rls.filter((x) => !x.text).length, 0);
    const fit = fitsOnSheet(box.ring, this.rotation());
    const deg = Math.round(((this.rotation() * 180) / Math.PI) * 10) / 10;
    this.dialog.innerHTML = `
      <form method="dialog" class="dlg-head"><h2>A3 printout at 1:300: ${esc(box.name)}</h2><button class="btn small" value="close">✕</button></form>
      <div class="dlg-body print-body">
        <p class="muted">The sheet is centred on the box. It uses the map's current rotation (${deg}°), background imagery and visible layers.
        Callouts are editable PDF annotations: move them, resize them or change the text in Bluebeam or Acrobat.
        Every callout is yellow and says <b>${INSERT_SERVICE}</b> for the engineer to complete; RLs come from the survey.
        The page is calibrated, so PDF measuring tools read metres.</p>
        ${fit.fits ? '' : `<p class="svc-unknown">⚠ The box (${fit.boxW.toFixed(1)} × ${fit.boxH.toFixed(1)} m on the sheet) is bigger than one A3 sheet at 1:300 (${fit.sheetW.toFixed(0)} × ${fit.sheetH.toFixed(0)} m). Parts of it will be cut off. Try rotating the map (Align to box) or splitting the box.</p>`}
        <label class="check"><input type="checkbox" class="pk-services" checked /> <b>Services plan</b>: ${svc.length} service${svc.length === 1 ? '' : 's'}, ${pts(svc)} callout${pts(svc) === 1 ? '' : 's'}${noRl(svc) ? ` <span class="svc-unknown">(${noRl(svc)} without an RL)</span>` : ''}</label>
        <label class="check"><input type="checkbox" class="pk-overheads" ${oh.length ? 'checked' : 'disabled'} /> <b>Overheads plan</b>: ${
          oh.length ? `${oh.length} overhead service${oh.length === 1 ? '' : 's'}, ${pts(oh)} callout${pts(oh) === 1 ? '' : 's'}` : '<span class="muted">no overhead services within 10 m</span>'
        }</label>
        <div class="box-actions"><button type="button" class="btn primary pk-go">Create PDF${oh.length ? 's' : ''}</button></div>
        <div class="pk-status muted"></div>
        <div class="pk-results"></div>
      </div>`;
    this.dialog.querySelector('.pk-go')!.addEventListener('click', () => this.run(box, rows));
    if (!this.dialog.open) this.dialog.showModal();
  }

  private async run(box: ExcavationBox, rows: ScheduleRow[]): Promise<void> {
    const go = this.dialog.querySelector<HTMLButtonElement>('.pk-go')!;
    const status = this.dialog.querySelector<HTMLElement>('.pk-status')!;
    const results = this.dialog.querySelector<HTMLElement>('.pk-results')!;
    const kinds: PlanKind[] = [];
    if (this.dialog.querySelector<HTMLInputElement>('.pk-services')!.checked) kinds.push('services');
    if (this.dialog.querySelector<HTMLInputElement>('.pk-overheads')!.checked) kinds.push('overheads');
    if (!kinds.length) return;
    go.disabled = true;
    this.revoke();
    results.innerHTML = '';
    try {
      for (const kind of kinds) {
        const res = await this.generate(kind, box, rows, (s) => (status.textContent = `${kind === 'overheads' ? 'Overheads' : 'Services'} plan: ${s}`));
        const url = URL.createObjectURL(new Blob([res.bytes as BlobPart], { type: 'application/pdf' }));
        this.urls.push(url);
        const crowded = res.callouts.filter((c) => c.crowded).length;
        const noRl = res.callouts.filter((c) => c.missingRl).length;
        const notes = [
          `${res.callouts.length} callout${res.callouts.length === 1 ? '' : 's'}`,
          noRl ? `<span class="svc-unknown">${noRl} without an RL (shown as ${INSERT_RL})</span>` : '',
          crowded ? `<span class="svc-unknown">${crowded} placed in a crowded spot: tidy them in your PDF editor</span>` : '',
          res.tilesFailed ? `<span class="svc-unknown">${res.tilesFailed} imagery tiles failed to load</span>` : '',
          res.timedOut ? '<span class="svc-unknown">imagery was still loading when the page was made</span>' : '',
          `${(res.bytes.length / 1e6).toFixed(1)} MB`,
        ].filter(Boolean);
        results.insertAdjacentHTML(
          'beforeend',
          `<div class="pk-result"><a class="btn primary" href="${url}" download="${esc(res.fileName)}">⬇ ${esc(res.fileName)}</a>
           <a class="btn small" href="${url}" target="_blank" rel="noopener">Open</a><div class="muted">${notes.join(' · ')}</div></div>`,
        );
      }
      status.textContent = 'Done.';
    } catch (err) {
      console.error(err);
      status.innerHTML = `<span class="error">Could not create the printout: ${esc((err as Error).message)}</span>`;
    } finally {
      go.disabled = false;
    }
  }

  private revoke() {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
  }
}
