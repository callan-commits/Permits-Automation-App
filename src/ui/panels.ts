/** Sidebar panels (plain DOM). */
import { boxDimensions } from '../analysis/geometry';
import { SCHEDULE_RADIUS } from '../analysis/schedule';
import { type ScheduleRow, describeService, rlText } from '../services/scheduleModel';
import type { CadDrawing, CadFeature } from '../cad/types';
import type { BoxTool } from '../map/boxTool';
import type { UtilityLayers } from '../map/utilityLayer';
import type { ServiceInfo } from '../services/register';
import type { PermitCheck } from '../permits/evaluate';

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (n: number, dp = 2) => n.toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp });


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

/** Rows shown on a box card before "Open schedule". */
const CARD_ROWS = 8;

export function renderBoxList(
  el: HTMLElement,
  countEl: HTMLElement,
  tool: BoxTool,
  rowsFor: (ring: [number, number][]) => ScheduleRow[] | null,
  permitsFor: (ring: [number, number][]) => PermitCheck | null,
  ruleCount: number,
  onOpenSchedule: (boxId: number) => void,
  onOpenRules: () => void,
  toast: (m: string) => void,
): void {
  const boxes = tool.boxes();
  countEl.textContent = boxes.length ? String(boxes.length) : '';
  if (!boxes.length) {
    el.className = 'muted';
    el.innerHTML = 'Use <b>▭ Box</b>, <b>⟋ Rotated box</b> or <b>⬠ Free-form</b> to mark the work area.';
    return;
  }
  el.className = '';
  el.innerHTML = '';
  const selected = tool.selectedId;
  for (const box of boxes) {
    const d = boxDimensions(box.ring);
    const card = document.createElement('div');
    card.className = `box-card${box.id === selected ? ' selected' : ''}`;
    const rows = rowsFor(box.ring)?.filter((r) => !r.excluded) ?? null;
    const needing = rows?.filter((r) => r.needs.type || r.needs.owner || r.needs.rl).length ?? 0;
    const permits = rows ? permitsFor(box.ring) : null;
    const corners = box.ring.slice(0, -1);
    card.innerHTML = `
      <div class="box-head">
        <input type="text" value="${esc(box.name)}" aria-label="Box name" />
        <button class="btn small" data-act="zoom" title="Zoom to box">⌖</button>
        <button class="btn small danger" data-act="delete" title="Delete box (Del)">✕</button>
      </div>
      <dl class="kv">
        <dt>Area</dt><dd>${fmt(d.area, 1)} m² · perimeter ${fmt(d.perimeter, 1)} m</dd>
        <dt>Extents</dt><dd>${fmt(d.length)} m × ${fmt(d.width)} m</dd>
        <dt>Bearing</dt><dd>${fmt(d.bearing, 1)}° (long side, grid)</dd>
        <dt>Centre</dt><dd class="mono">E ${fmt(d.centre[0], 2)}<br>N ${fmt(d.centre[1], 2)}</dd>
      </dl>
      <details>
        <summary>Corners (${corners.length})</summary>
        <table class="mono"><tr><th>#</th><th class="num">Easting</th><th class="num">Northing</th></tr>
        ${corners.map((c, i) => `<tr><td>${i + 1}</td><td class="num">${fmt(c[0], 3)}</td><td class="num">${fmt(c[1], 3)}</td></tr>`).join('')}
        </table>
      </details>
      ${rows ? permitSummary(permits, ruleCount) : ''}
      <details ${rows?.length ? 'open' : ''}>
        <summary>Services within ${SCHEDULE_RADIUS} m (${rows?.length ?? 0})${needing ? ` · <span class="svc-unknown">${needing} need input</span>` : ''}</summary>
        ${
          rows
            ? rows.length
              ? `<table class="card-sched">${rows
                  .slice(0, CARD_ROWS)
                  .map((r) => {
                    const desc = describeService(r.info);
                    const unknown = r.needs.type || r.needs.owner;
                    const rl = rlText(r);
                    return `<tr><td class="mono">${r.id}</td>
                      <td class="${unknown ? 'svc-unknown' : ''}">${esc(desc)}</td>
                      <td class="num">${r.entry.distance === 0 ? '<b>in box</b>' : `${fmt(r.entry.distance)} m`}</td>
                      <td class="num mono ${r.needs.rl ? 'svc-unknown' : ''}" title="RL">${rl ? esc(rl) : 'no RL'}</td></tr>`;
                  })
                  .join('')}</table>${rows.length > CARD_ROWS ? `<div class="muted">…and ${rows.length - CARD_ROWS} more</div>` : ''}`
              : '<div class="muted">None</div>'
            : '<div class="muted">Load a drawing to check.</div>'
        }
      </details>
      <div class="box-actions">
        ${rows ? '<button class="btn small primary" data-act="schedule">Open schedule</button>' : ''}
        <button class="btn small" data-act="copy">Copy corners</button>
      </div>
      ${box.id === selected ? '<div class="muted" style="margin-top:6px">Drag the box to move it · drag a corner to reshape · click an edge to add a corner · Alt+click a corner to remove it</div>' : ''}
      <div>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'delete') tool.remove(box.id);
      else if (act === 'schedule') onOpenSchedule(box.id);
      else if (act === 'rules') onOpenRules();
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

function permitSummary(check: PermitCheck | null, ruleCount: number): string {
  if (!ruleCount) {
    return `<div class="permit-box none">No permit rules loaded. <button class="btn small" data-act="rules">Import cheat sheet</button></div>`;
  }
  if (!check) return '';
  const chips = check.required.map((p) => `<span class="permit-chip" title="${esc(permitReason(p.triggers))}">${esc(p.permit)}</span>`).join('');
  const unknown = check.unknownOwners.length
    ? `<div class="svc-unknown" style="margin-top:4px">⚠ ${check.unknownOwners.length} service${check.unknownOwners.length === 1 ? '' : 's'} of unknown owner nearby: a permit may be needed. Fill in the owner in the schedule.</div>`
    : '';
  return `<div class="permit-box"><b>Permits:</b> ${chips || '<span class="muted">none required</span>'}${unknown}</div>`;
}

export function permitReason(triggers: PermitCheck['required'][number]['triggers']): string {
  return triggers
    .map((t) => `${t.owner}${t.type ? ` ${t.type}` : ''} ${t.distance === 0 ? 'in/crossing the box' : `${fmt(t.distance)} m away`} (within ${t.rule.distance} m)`)
    .join('; ');
}

export function renderFeatureInfo(el: HTMLElement, cad: CadFeature | null, info?: ServiceInfo): void {
  if (!cad) {
    el.className = 'muted';
    el.textContent = 'Click a utility on the map to inspect it.';
    return;
  }
  el.className = '';
  const meta = cad.meta;
  const unknown = '<span class="svc-unknown">Unknown: set in Services</span>';
  const rows: [string, string][] = [];
  if (info) {
    rows.push(
      ['Service', info.type ? esc(info.type) : unknown],
      ['Owner', info.owner ? esc(info.owner) : unknown],
      ['Overhead', info.overhead ? 'Yes' : 'No'],
    );
    if (info.ql) rows.push(['Quality', `QL${info.ql}`]);
    if (info.description) rows.push(['Details', esc(info.description)]);
  }
  rows.push(
    ['Layer', `<span class="swatch" style="display:inline-block;background:${cad.color};margin-right:6px"></span>${esc(cad.layer)}`],
    ['Object', esc(cad.entityType)],
    ['Handle', `<span class="mono">${esc(meta?.insertHandle ?? cad.handle)}</span>`],
  );
  if (cad.block) rows.push(['Block', esc(cad.block)]);
  if (cad.kind === 'text') rows.push(['Text', esc(cad.text).replace(/\n/g, '<br>')], ['Height', `${fmt(cad.height)} m`]);
  if (cad.kind === 'line') {
    let len = 0;
    for (let i = 1; i < cad.coords.length; i++) len += Math.hypot(cad.coords[i][0] - cad.coords[i - 1][0], cad.coords[i][1] - cad.coords[i - 1][1]);
    rows.push(['Length', `${fmt(len)} m (2D)`]);
    if (cad.z?.length) {
      const lo = Math.min(...cad.z);
      const hi = Math.max(...cad.z);
      rows.push(['Levels', lo === hi ? `RL ${fmt(lo, 3)}` : `RL ${fmt(lo, 3)} – ${fmt(hi, 3)}`]);
    }
  }
  if (meta?.elevation !== undefined) rows.push([cad.block ? 'Insert RL' : 'Elevation', `RL ${fmt(meta.elevation, 3)}`]);
  if (meta?.lineType) rows.push(['Linetype', esc(meta.lineType)]);

  const table = (title: string, data: Record<string, string>) =>
    `<div class="meta-title">${title}</div><table class="meta-table">${Object.entries(data)
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v) || '<span class="muted">(blank)</span>'}</td></tr>`)
      .join('')}</table>`;
  const raw = (data: Record<string, (string | number)[]>) =>
    Object.entries(data)
      .map(([k, vals]) => `<div class="mono"><b>${esc(k)}</b>: ${vals.map((v) => esc(String(v))).join(' · ')}</div>`)
      .join('');

  let extra = '';
  if (meta?.attributes) extra += table('Block attributes', meta.attributes);
  if (meta?.fields) extra += table('Data fields', meta.fields);
  if (meta?.xdata || meta?.records) {
    extra += `<details class="meta-raw"><summary>Raw extended data</summary>${meta.xdata ? `<div class="meta-title">XDATA</div>${raw(meta.xdata)}` : ''}${
      meta.records ? `<div class="meta-title">Records</div>${raw(meta.records)}` : ''
    }</details>`;
  }
  if (!extra) extra = '<div class="muted" style="margin-top:6px">No attributes or extended data on this object.</div>';
  el.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${extra}`;
}
