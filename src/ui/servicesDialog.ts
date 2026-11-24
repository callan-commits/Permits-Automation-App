/** "Services" table: confirm or correct each layer's service type, owner and overhead flag. */
import type { CadDrawing } from '../cad/types';
import { OWNERS, SERVICE_TYPES } from '../services/dictionary';
import type { InfoSource, LayerSummary, ServiceRegister } from '../services/register';
import { esc } from './panels';

const SOURCE_LABEL: Record<InfoSource, string> = {
  edit: 'your edit',
  'layer-edit': 'your edit',
  data: 'from object data',
  'layer-name': 'guessed from layer name',
  owner: 'implied by owner',
  none: '',
};

export class ServicesDialog {
  private dialog: HTMLDialogElement;
  private onlyIncomplete = false;

  constructor(
    private register: ServiceRegister,
    private getDrawing: () => CadDrawing | null,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'services-dialog';
    this.dialog.innerHTML = `
      <form method="dialog" class="dlg-head">
        <h2>Services in this drawing</h2>
        <button class="btn small" value="close" aria-label="Close">✕</button>
      </form>
      <p class="muted dlg-intro">Check what each layer is and who owns it. Values come from object data where present, otherwise they're
      guessed from the layer name. <b class="needs">Highlighted</b> rows need your input. Your edits are remembered in this browser for any
      drawing that uses the same layer names. Owner or type data on an individual object overrides the layer.</p>
      <label class="check"><input type="checkbox" class="only-incomplete" /> Only show layers needing input</label>
      <div class="dlg-body"></div>
      <datalist id="service-type-options">${SERVICE_TYPES.map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>
      <datalist id="owner-options">${OWNERS.map((o) => `<option value="${esc(o.name)}">`).join('')}</datalist>`;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector<HTMLInputElement>('.only-incomplete')!.addEventListener('change', (e) => {
      this.onlyIncomplete = (e.target as HTMLInputElement).checked;
      this.render();
    });
    register.onChange(() => {
      if (this.dialog.open) this.render();
    });
  }

  open(onlyIncomplete = false): void {
    this.onlyIncomplete = onlyIncomplete;
    this.dialog.querySelector<HTMLInputElement>('.only-incomplete')!.checked = onlyIncomplete;
    this.render();
    this.dialog.showModal();
  }

  render(): void {
    const body = this.dialog.querySelector('.dlg-body')!;
    const drawing = this.getDrawing();
    if (!drawing) {
      body.innerHTML = '<p class="muted">Open a drawing first.</p>';
      return;
    }
    const rows = this.register.summarise(drawing).filter((r) => !this.onlyIncomplete || r.incomplete);
    const layerColour = new Map(drawing.layers.map((l) => [l.name, l.color]));
    body.innerHTML = rows.length
      ? `<table class="svc-table">
          <thead><tr><th>Layer</th><th>Service type</th><th>Owner</th><th title="Overhead services go on the overheads plan">Overhead</th><th></th></tr></thead>
          <tbody>${rows.map((r) => this.row(r, layerColour.get(r.layer) ?? '#fff')).join('')}</tbody>
        </table>`
      : '<p class="muted">Nothing needs input. 👍</p>';
    body.querySelectorAll<HTMLTableRowElement>('tr[data-layer]').forEach((tr) => {
      const layer = tr.dataset.layer!;
      tr.querySelector<HTMLInputElement>('input.svc-type')!.addEventListener('change', (e) =>
        this.register.setLayer(layer, { type: (e.target as HTMLInputElement).value.trim() }),
      );
      tr.querySelector<HTMLInputElement>('input.svc-owner')!.addEventListener('change', (e) =>
        this.register.setLayer(layer, { owner: (e.target as HTMLInputElement).value.trim() }),
      );
      tr.querySelector<HTMLInputElement>('input.svc-oh')!.addEventListener('change', (e) =>
        this.register.setLayer(layer, { overhead: (e.target as HTMLInputElement).checked }),
      );
      tr.querySelector<HTMLButtonElement>('button.svc-reset')?.addEventListener('click', () => this.register.resetLayer(layer));
    });
  }

  private row(r: LayerSummary, colour: string): string {
    const mixed = (m: Map<string, number>) =>
      m.size > 1 ? `<div class="mixed">Varies by object: ${[...m].map(([k, n]) => `${esc(k)} (${n})`).join(', ')}</div>` : '';
    const field = (cls: string, list: string, value: string | null, placeholder: string, src: InfoSource, extra: string) => `
      <td class="${value ? '' : 'needs-input'}">
        <input class="${cls}" list="${list}" value="${esc(value ?? '')}" placeholder="${placeholder}" />
        <div class="src">${SOURCE_LABEL[src]}</div>${extra}
      </td>`;
    const edited = Object.keys(r.setting).length > 0;
    return `<tr data-layer="${esc(r.layer)}" class="${r.incomplete ? 'incomplete' : ''}">
      <td class="layer-cell"><span class="swatch" style="background:${colour}"></span>${esc(r.layer)}<div class="src">${r.featureCount} object${r.featureCount === 1 ? '' : 's'}</div></td>
      ${field('svc-type', 'service-type-options', r.type, 'Unknown: fill in', r.source.type, mixed(r.dataTypes))}
      ${field('svc-owner', 'owner-options', r.owner, 'Unknown: fill in', r.source.owner, mixed(r.dataOwners))}
      <td class="oh-cell"><input type="checkbox" class="svc-oh" ${r.overhead ? 'checked' : ''} /><div class="src">${SOURCE_LABEL[r.source.overhead]}</div></td>
      <td>${edited ? '<button type="button" class="btn small svc-reset" title="Forget your edits for this layer">Reset</button>' : ''}</td>
    </tr>`;
  }
}
