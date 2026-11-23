/** Permit rules editor: import the cheat sheet (.xlsx) or edit rules by hand. */
import readXlsxFile from 'read-excel-file/browser';
import { type PermitRules, parseRuleRows } from '../permits/rules';
import { OWNERS } from '../services/dictionary';
import { esc } from './panels';

export class RulesDialog {
  private dialog: HTMLDialogElement;
  private message = '';

  constructor(
    private rules: PermitRules,
    private toast: (m: string, isError?: boolean) => void,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'services-dialog rules-dialog';
    document.body.appendChild(this.dialog);
    rules.onChange(() => {
      if (this.dialog.open) this.render();
    });
  }

  open(): void {
    this.message = '';
    this.render();
    this.dialog.showModal();
  }

  private render(): void {
    const list = this.rules.all();
    this.dialog.innerHTML = `
      <form method="dialog" class="dlg-head">
        <h2>Permit rules</h2>
        <button class="btn small" value="close" aria-label="Close">✕</button>
      </form>
      <p class="muted dlg-intro">A permit is required when a work area is within the trigger distance (horizontally, including exactly that distance)
      of any asset belonging to the owner. Separate alternative names for one owner with “/”, e.g. <i>MTM/Metro Trains Melbourne</i>.
      Rules are stored in this browser only.</p>
      <div class="rules-actions">
        <label class="btn primary">Import cheat sheet (.xlsx)<input type="file" accept=".xlsx" hidden class="rules-file" /></label>
        <button type="button" class="btn rules-add">+ Add rule</button>
        ${this.message ? `<span class="rules-msg">${this.message}</span>` : ''}
      </div>
      <div class="dlg-body">
        ${
          list.length
            ? `<table class="svc-table"><thead><tr><th>Owner</th><th class="num">Trigger distance (m)</th><th>Permit required</th><th></th></tr></thead><tbody>
          ${list
            .map(
              (r) => `<tr data-id="${esc(r.id)}">
              <td><input class="r-owner" list="rule-owner-options" value="${esc(r.owner)}" /></td>
              <td><input class="r-dist" type="number" min="0" step="0.1" value="${r.distance}" style="text-align:right" /></td>
              <td><input class="r-permit" value="${esc(r.permit)}" /></td>
              <td><button type="button" class="btn small danger r-del" title="Delete rule">✕</button></td></tr>`,
            )
            .join('')}</tbody></table>`
            : '<p class="needs" style="padding:8px">No rules yet: import your permit cheat sheet to start.</p>'
        }
      </div>
      <datalist id="rule-owner-options">${OWNERS.map((o) => `<option value="${esc(o.name)}">`).join('')}</datalist>`;

    this.dialog.querySelector<HTMLInputElement>('.rules-file')!.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try {
        const sheets = await readXlsxFile(file);
        // Use the first sheet that contains a rules table.
        for (const s of sheets) {
          const { rules, problems } = parseRuleRows(s.data as never);
          if (!rules.length) continue;
          if (list.length && !confirm(`Replace the ${list.length} current rule${list.length === 1 ? '' : 's'} with ${rules.length} from ${file.name}?`)) return;
          this.rules.replaceAll(rules);
          this.message = `Imported ${rules.length} rule${rules.length === 1 ? '' : 's'} from ${esc(file.name)} (sheet “${esc(s.sheet)}”).${
            problems.length ? ` <span class="svc-unknown">${problems.map(esc).join(' ')}</span>` : ''
          }`;
          this.render();
          return;
        }
        this.toast(`No rules table (Owner / Distance / Permit columns) found in ${file.name}.`, true);
      } catch (err) {
        this.toast(`Could not read ${file.name}: ${(err as Error).message}`, true);
      }
    });
    this.dialog.querySelector('.rules-add')!.addEventListener('click', () => this.rules.add({ owner: '', distance: 0, permit: '' }));
    for (const tr of this.dialog.querySelectorAll<HTMLTableRowElement>('tr[data-id]')) {
      const id = tr.dataset.id!;
      tr.querySelector<HTMLInputElement>('.r-owner')!.addEventListener('change', (e) => this.rules.update(id, { owner: (e.target as HTMLInputElement).value.trim() }));
      tr.querySelector<HTMLInputElement>('.r-permit')!.addEventListener('change', (e) => this.rules.update(id, { permit: (e.target as HTMLInputElement).value.trim() }));
      tr.querySelector<HTMLInputElement>('.r-dist')!.addEventListener('change', (e) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (Number.isFinite(v) && v >= 0) this.rules.update(id, { distance: v });
        else this.toast('Trigger distance must be a number of metres', true);
      });
      tr.querySelector('.r-del')!.addEventListener('click', () => this.rules.remove(id));
    }
  }
}
