/** Permit rules: the built-in cheat sheet, which can be edited by hand in this browser. */
import type { PermitRules } from '../permits/rules';
import { OWNERS } from '../services/dictionary';
import { esc } from './panels';

export class RulesDialog {
  private dialog: HTMLDialogElement;

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
      These are the permit cheat sheet's rules, built into Calvillo. Any changes you make here are kept in this browser only.</p>
      <div class="rules-actions">
        <button type="button" class="btn rules-add">+ Add rule</button>
        ${this.rules.isEdited ? '<span class="rules-msg">Edited in this browser.</span><button type="button" class="btn rules-reset">Reset to built-in rules</button>' : '<span class="rules-msg muted">Built-in rules.</span>'}
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
            : '<p class="needs" style="padding:8px">No rules. Use <b>Reset to built-in rules</b> to restore the cheat sheet.</p>'
        }
      </div>
      <datalist id="rule-owner-options">${OWNERS.map((o) => `<option value="${esc(o.name)}">`).join('')}</datalist>`;

    this.dialog.querySelector('.rules-add')!.addEventListener('click', () => this.rules.add({ owner: '', distance: 0, permit: '' }));
    this.dialog.querySelector('.rules-reset')?.addEventListener('click', () => {
      if (confirm('Replace your edited rules with the built-in cheat sheet?')) this.rules.resetToBuiltIn();
    });
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
