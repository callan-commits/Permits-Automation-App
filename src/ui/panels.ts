/** Sidebar panels (plain DOM). */
import { boxDimensions, nearbyByLayer } from '../analysis/geometry';
import type { CadDrawing, CadFeature } from '../cad/types';
import type { BoxTool } from '../map/boxTool';
import type { UtilityLayers } from '../map/utilityLayer';

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (n: number, dp = 2) => n.toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Distance (m) used for the preliminary "nearby utilities" list. Permit rules will replace this. */
export const NEARBY_RADIUS = 10;

export function renderDrawingInfo(el: HTMLElement, drawing: CadDrawing, crsWarning: string | null): void {
  const total = drawing.features.length;
  const skipped = Object.entries(drawing.skipped);
  const ext = drawing.extent;
  el.classList.remove('muted');
  el.innerHTML = `
    <dl class="kv">
      <dt>File</dt><dd>${esc(drawing.fileName)}</dd>
      <dt>Objects</dt><dd>${total.toLocaleString()} on ${drawing.layers.length} layers</dd>
      ${ext ? `<dt>Extent</dt><dd class="mono">E ${fmt(ext[0], 0)}–${fmt(ext[2], 0)}<br>N ${fmt(ext[1], 0)}–${fmt(ext[3], 0)}</dd>` : ''}
    </dl>
    ${crsWarning ? `<div class="warn">⚠ ${esc(crsWarning)}</div>` : ''}
    ${drawing.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
    ${
      skipped.length
        ? `<div class="muted" style="margin-top:6px" title="These object types are not drawn yet">Not drawn: ${skipped
            .map(([t, n]) => `${esc(t)} (${n})`)
            .join(', ')}</div>`
        : ''
    }`;
}

export function renderLayerList(list: HTMLElement, drawing: CadDrawing | null, utilities: UtilityLayers, filter: string): void {
  list.innerHTML = '';
  if (!drawing) return;
  const q = filter.trim().toLowerCase();
  for (const layer of drawing.layers) {
    if (q && !layer.name.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.innerHTML = `<label title="${esc(layer.name)}${layer.hiddenInDrawing ? ' (off/frozen in the drawing)' : ''}">
      <input type="checkbox" ${utilities.isLayerVisible(layer.name) ? 'checked' : ''} />
      <span class="swatch" style="background:${layer.color}"></span>
      <span class="layer-name">${esc(layer.name)}${layer.hiddenInDrawing ? ' <span class="muted">(off)</span>' : ''}</span>
      <span class="layer-n">${layer.featureCount}</span>
    </label>`;
    li.querySelector('input')!.addEventListener('change', (e) => {
      utilities.setLayerVisible(layer.name, (e.target as HTMLInputElement).checked);
    });
    list.appendChild(li);
  }
}

export function renderBoxList(el: HTMLElement, countEl: HTMLElement, tool: BoxTool, drawing: CadDrawing | null, utilities: UtilityLayers, toast: (m: string) => void): void {
  const boxes = tool.boxes();
  countEl.textContent = boxes.length ? String(boxes.length) : '';
  if (!boxes.length) {
    el.className = 'muted';
    el.innerHTML = 'Use <b>▭ Box</b> or <b>⟋ Rotated box</b> to mark the excavation area.';
    return;
  }
  el.className = '';
  el.innerHTML = '';
  const selected = tool.selectedId;
  for (const box of boxes) {
    const d = boxDimensions(box.ring);
    const card = document.createElement('div');
    card.className = `box-card${box.id === selected ? ' selected' : ''}`;
    const nearby = drawing ? nearbyByLayer(box.ring, drawing.features, NEARBY_RADIUS, utilities.hiddenLayers()) : [];
    const corners = box.ring.slice(0, 4);
    card.innerHTML = `
      <div class="box-head">
        <input type="text" value="${esc(box.name)}" aria-label="Box name" />
        <button class="btn small" data-act="zoom" title="Zoom to box">⌖</button>
        <button class="btn small danger" data-act="delete" title="Delete box (Del)">✕</button>
      </div>
      <dl class="kv">
        <dt>Size</dt><dd>${fmt(d.length)} m × ${fmt(d.width)} m (${fmt(d.area, 1)} m²)</dd>
        <dt>Bearing</dt><dd>${fmt(d.bearing, 1)}° (long side, grid)</dd>
        <dt>Centre</dt><dd class="mono">E ${fmt(d.centre[0], 2)}<br>N ${fmt(d.centre[1], 2)}</dd>
      </dl>
      <details>
        <summary>Corners</summary>
        <table class="mono"><tr><th>#</th><th class="num">Easting</th><th class="num">Northing</th></tr>
        ${corners.map((c, i) => `<tr><td>${i + 1}</td><td class="num">${fmt(c[0], 3)}</td><td class="num">${fmt(c[1], 3)}</td></tr>`).join('')}
        </table>
      </details>
      <details ${nearby.length ? 'open' : ''}>
        <summary>Visible layers within ${NEARBY_RADIUS} m (${nearby.length})</summary>
        ${
          drawing
            ? nearby.length
              ? `<table><tr><th>Layer</th><th class="num">Closest</th></tr>${nearby
                  .map(
                    (n) =>
                      `<tr><td><span class="swatch" style="display:inline-block;background:${n.color};margin-right:6px"></span>${esc(n.layer)}</td>
                       <td class="num">${n.minDistance === 0 ? '<b>in box</b>' : `${fmt(n.minDistance)} m`}</td></tr>`,
                  )
                  .join('')}</table>`
              : '<div class="muted">None</div>'
            : '<div class="muted">Load a drawing to check.</div>'
        }
      </details>
      <div class="box-actions">
        <button class="btn small" data-act="copy">Copy corners</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'delete') tool.remove(box.id);
      else if (act === 'zoom') tool.zoomTo(box.id);
      else if (act === 'copy') {
        const text = ['Corner\tEasting\tNorthing', ...corners.map((c, i) => `${i + 1}\t${c[0].toFixed(3)}\t${c[1].toFixed(3)}`)].join('\n');
        navigator.clipboard?.writeText(text).then(
          () => toast(`${box.name} corners copied`),
          () => toast('Could not access the clipboard'),
        );
      } else if (!(e.target as HTMLElement).closest('input, summary, details') && tool.selectedId !== box.id) tool.selectBox(box.id);
    });
    const input = card.querySelector('input')!;
    input.addEventListener('change', () => tool.rename(box.id, input.value.trim()));
    el.appendChild(card);
  }
}

export function renderFeatureInfo(el: HTMLElement, cad: CadFeature | null): void {
  if (!cad) {
    el.className = 'muted';
    el.textContent = 'Click a utility on the map to inspect it.';
    return;
  }
  el.className = '';
  const rows: [string, string][] = [
    ['Layer', `<span class="swatch" style="display:inline-block;background:${cad.color};margin-right:6px"></span>${esc(cad.layer)}`],
    ['Object', esc(cad.entityType)],
    ['Handle', `<span class="mono">${esc(cad.handle)}</span>`],
  ];
  if (cad.block) rows.push(['Block', esc(cad.block)]);
  if (cad.kind === 'text') rows.push(['Text', esc(cad.text).replace(/\n/g, '<br>')], ['Height', `${fmt(cad.height)} m`]);
  if (cad.kind === 'line') {
    let len = 0;
    for (let i = 1; i < cad.coords.length; i++) len += Math.hypot(cad.coords[i][0] - cad.coords[i - 1][0], cad.coords[i][1] - cad.coords[i - 1][1]);
    rows.push(['Length', `${fmt(len)} m (2D)`]);
    if (cad.z?.length) rows.push(['Levels', `${fmt(Math.min(...cad.z))} – ${fmt(Math.max(...cad.z))}`]);
  }
  el.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}
