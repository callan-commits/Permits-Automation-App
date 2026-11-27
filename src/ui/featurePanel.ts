/** Sidebar panel for the loaded feature survey: its levels, which layers count as ground, show on map, remove. */
import { AREA_RADIUS, DIRECT_RADIUS, type LevelLayer } from '../analysis/surface';

export interface FeatureSurveyView {
  name: string;
  /** Levels used for the surface / all levels found. */
  used: number;
  total: number;
  layers: LevelLayer[];
  included: Set<string>;
  showOnMap: boolean;
  /** Share of the utility survey's area the feature survey covers, if known. */
  overlapsUtilities: boolean | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderFeaturePanel(
  el: HTMLElement,
  view: FeatureSurveyView | null,
  on: { toggleLayer: (layer: string, include: boolean) => void; showOnMap: (on: boolean) => void; remove: () => void },
): void {
  if (!view) {
    el.className = 'muted';
    el.innerHTML = 'None loaded. Open a feature survey (a DWG with levels across the site) to show the surface and depth on each callout.';
    return;
  }
  el.className = '';
  const rows = view.layers
    .map(
      (l) => `<li title="${esc(l.layer)}${l.notGround ? ' (left out by default: the name suggests it is not the ground)' : ''}">
        <label><input type="checkbox" data-layer="${esc(l.layer)}" ${view.included.has(l.layer) ? 'checked' : ''} />
        <span class="layer-name">${esc(l.layer)}</span>${l.notGround ? ' <span class="tag-warn">not ground?</span>' : ''}</label>
        <span class="count">${l.count.toLocaleString()}</span></li>`,
    )
    .join('');
  el.innerHTML = `
    <div class="feature-head"><b title="${esc(view.name)}">${esc(view.name)}</b> <button type="button" class="btn small fs-remove" title="Stop using this feature survey">Remove</button></div>
    <div class="muted">${view.used.toLocaleString()} of ${view.total.toLocaleString()} levels used for the surface.
      Surface at a point: a surveyed level within ${DIRECT_RADIUS * 100} cm, else interpolated or averaged from levels within ${AREA_RADIUS} m, else flagged to find manually.</div>
    ${view.overlapsUtilities === false ? '<div class="svc-unknown">⚠ This feature survey doesn\'t overlap the utility survey: check it is the same site and grid.</div>' : ''}
    <label class="fs-show"><input type="checkbox" class="fs-show-box" ${view.showOnMap ? 'checked' : ''} /> Show levels on the map (zoom in)</label>
    <details ${view.layers.some((l) => l.notGround) ? 'open' : ''}><summary>Layers with levels (${view.layers.length}): untick any that aren't the ground</summary>
      <ul class="fs-layers">${rows}</ul></details>`;
  el.querySelector('.fs-remove')!.addEventListener('click', () => on.remove());
  el.querySelector<HTMLInputElement>('.fs-show-box')!.addEventListener('change', (e) => on.showOnMap((e.target as HTMLInputElement).checked));
  el.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((box) =>
    box.addEventListener('change', () => on.toggleLayer(box.dataset.layer!, box.checked)),
  );
}
