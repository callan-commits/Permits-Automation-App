import 'ol/ol.css';
import './styles.css';
import Map from 'ol/Map';
import View from 'ol/View';
import { Rotate, ScaleLine, defaults as defaultControls } from 'ol/control';
import type TileLayer from 'ol/layer/Tile';
import { loadCadFile } from './cad/loader';
import type { CadDrawing, CadFeature } from './cad/types';
import { CRS_OPTIONS, DEFAULT_CRS, checkExtentLooksLikeMga, projection, registerCrs } from './geo/crs';
import { BASEMAPS, type BasemapId, createBasemapLayer } from './map/basemaps';
import { BoxTool, type DrawMode } from './map/boxTool';
import { UtilityLayers } from './map/utilityLayer';
import { boxDimensions } from './analysis/geometry';
import { ScheduleEngine } from './analysis/schedule';
import { ScheduleLayer } from './map/scheduleLayer';
import { ServiceRegister } from './services/register';
import { ScheduleEdits, type ScheduleRow, scheduleRows } from './services/scheduleModel';
import { ScheduleDialog } from './ui/scheduleDialog';
import { checkPermits } from './permits/evaluate';
import { PermitRules } from './permits/rules';
import { RulesDialog } from './ui/rulesDialog';
import { ServicesDialog } from './ui/servicesDialog';
import { renderBoxList, renderDrawingInfo, renderFeatureInfo, renderLayerList } from './ui/panels';
import proj4 from 'proj4';

registerCrs();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const rotInput = $<HTMLInputElement>('rot-input');

// ---- persisted settings (best effort) ----
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`permits.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`permits.${key}`, value);
    } catch {
      /* storage unavailable */
    }
  },
};

let crsCode = CRS_OPTIONS.some((c) => c.code === store.get('crs')) ? store.get('crs')! : DEFAULT_CRS;
let basemapId = (BASEMAPS.some((b) => b.id === store.get('basemap')) ? store.get('basemap') : 'esri-imagery') as BasemapId;
let drawing: CadDrawing | null = null;

// ---- map ----
const MELBOURNE_LONLAT = [144.9631, -37.8136];
function makeView(code: string, center?: number[], resolution?: number, rotation = 0): View {
  return new View({
    rotation,
    projection: projection(code),
    center: center ?? proj4('EPSG:4326', code, MELBOURNE_LONLAT),
    resolution: resolution ?? 20,
    maxResolution: 2000,
    minResolution: 0.005,
    constrainResolution: false,
  });
}

const utilities = new UtilityLayers();
const register = new ServiceRegister();
utilities.setOverheadTest((layer) => register.isOverhead(layer));
let inspected: CadFeature | null = null;
let engine: ScheduleEngine | null = null;
const edits = new ScheduleEdits();
const rules = new PermitRules();
const scheduleLayer = new ScheduleLayer();
const map = new Map({
  target: 'map',
  controls: defaultControls({ rotate: false, attributionOptions: { collapsible: true, collapsed: false } }).extend([
    new ScaleLine({ units: 'metric' }),
    // Always-visible north arrow; click to return to north up.
    new Rotate({ autoHide: false, label: northArrow(), tipLabel: 'Grid north (click for north up)' }),
  ]),
  view: makeView(crsCode),
  layers: [utilities.geometryLayer, utilities.textLayer, utilities.highlightLayer, scheduleLayer.layer],
});
const boxes = new BoxTool(map, (m) => toast(m, true));

let basemapLayer: TileLayer | null = null;
function setBasemap(id: BasemapId) {
  if (basemapLayer) map.removeLayer(basemapLayer);
  basemapLayer = createBasemapLayer(id);
  if (basemapLayer) {
    basemapLayer.setZIndex(-1);
    map.getLayers().insertAt(0, basemapLayer);
  }
  basemapId = id;
  store.set('basemap', id);
}
setBasemap(basemapId);

function setCrs(code: string) {
  // Drawing and box coordinates are interpreted in the chosen grid, so they keep their numbers;
  // only the view (and therefore where the imagery lands) changes.
  const v = map.getView();
  map.setView(makeView(code, v.getCenter(), v.getResolution(), v.getRotation()));
  watchRotation();
  crsCode = code;
  store.set('crs', code);
  $('status-crs').textContent = CRS_OPTIONS.find((c) => c.code === code)!.label.split(' (')[0];
  boxes.refresh();
  if (drawing) renderDrawingInfo($('drawing-info'), drawing, checkExtentLooksLikeMga(drawing.focusExtent));
}

// ---- toolbar ----
const crsSelect = $<HTMLSelectElement>('crs-select');
crsSelect.innerHTML = CRS_OPTIONS.map((c) => `<option value="${c.code}">${c.label}</option>`).join('');
crsSelect.value = crsCode;
crsSelect.addEventListener('change', () => setCrs(crsSelect.value));
setCrs(crsCode);

const basemapSelect = $<HTMLSelectElement>('basemap-select');
basemapSelect.innerHTML = BASEMAPS.map((b) => `<option value="${b.id}">${b.label}</option>`).join('');
basemapSelect.value = basemapId;
basemapSelect.addEventListener('change', () => setBasemap(basemapSelect.value as BasemapId));

const drawButtons: Record<Exclude<DrawMode, 'none'>, HTMLButtonElement> = {
  rect: $<HTMLButtonElement>('draw-rect'),
  rotated: $<HTMLButtonElement>('draw-rotated'),
  polygon: $<HTMLButtonElement>('draw-polygon'),
};
const HINTS: Record<DrawMode, string> = {
  none: '',
  rect: 'Click two opposite corners (or click-drag). Esc to cancel.',
  rotated: 'Click two points along one edge, then a third to set the width. Esc to cancel.',
  polygon: 'Click each corner. Finish: click the first corner, double-click or press Enter. Backspace undoes a corner, Esc cancels.',
};
for (const [mode, btn] of Object.entries(drawButtons) as [Exclude<DrawMode, 'none'>, HTMLButtonElement][]) {
  btn.addEventListener('click', () => boxes.setMode(boxes.currentMode === mode ? 'none' : mode));
}
boxes.onModeChange((mode) => {
  for (const [m, btn] of Object.entries(drawButtons)) btn.classList.toggle('active', m === mode);
  const hint = $('draw-hint');
  hint.hidden = mode === 'none';
  hint.textContent = HINTS[mode];
  $('map').style.cursor = mode === 'none' ? '' : 'crosshair';
});

// ---- map rotation ----
function northArrow(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'north-arrow';
  el.innerHTML = '<b>▲</b>N';
  return el;
}
/** View rotation in degrees, clockwise, normalised to (-180, 180]. */
function toDegrees(rad: number): number {
  let d = ((rad * 180) / Math.PI) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return Math.round(d * 10) / 10;
}
function setRotationDegrees(deg: number) {
  map.getView().animate({ rotation: (deg * Math.PI) / 180, duration: 250 });
}
function watchRotation() {
  const view = map.getView();
  const show = () => {
    if (document.activeElement !== rotInput) rotInput.value = String(toDegrees(view.getRotation()));
  };
  view.on('change:rotation', show);
  show();
}
watchRotation();
rotInput.addEventListener('change', () => {
  const v = parseFloat(rotInput.value);
  if (Number.isFinite(v)) setRotationDegrees(v);
});
$('rot-cw').addEventListener('click', () => setRotationDegrees(toDegrees(map.getView().getRotation()) + 15));
$('rot-ccw').addEventListener('click', () => setRotationDegrees(toDegrees(map.getView().getRotation()) - 15));
$('rot-north').addEventListener('click', () => setRotationDegrees(0));
$('rot-box').addEventListener('click', () => {
  const list = boxes.boxes();
  const box = list.find((b) => b.id === boxes.selectedId) ?? (list.length === 1 ? list[0] : undefined);
  if (!box) return toast(list.length ? 'Select a box first (click it on the map).' : 'Draw a box first.', true);
  // OpenLayers rotation is clockwise. A direction with grid bearing b shows at screen bearing b + r;
  // r = 90° - b puts the box's long side left-to-right.
  const d = boxDimensions(box.ring);
  setRotationDegrees(90 - d.bearing);
  map.getView().animate({ center: d.centre, duration: 250 });
});

// ---- feedback ----
let toastTimer: number | undefined;
function toast(message: string, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), isError ? 8000 : 3000);
}
function busy(text: string | null) {
  $('busy').hidden = text === null;
  if (text) $('busy-text').textContent = text;
}

// ---- loading drawings ----
async function openFile(name: string, buffer: ArrayBuffer) {
  busy(`Reading ${name}…`);
  try {
    const started = performance.now();
    const d = await loadCadFile(name, buffer, (stage) => busy(stage));
    busy('Preparing map…');
    await new Promise((r) => setTimeout(r, 0)); // let the message paint before the heavy step
    showDrawing(d);
    toast(`Loaded ${name}: ${d.features.length.toLocaleString()} objects in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  } catch (err) {
    console.error(err);
    toast((err as Error).message, true);
  } finally {
    busy(null);
  }
}

function showDrawing(d: CadDrawing) {
  drawing = d;
  utilities.setDrawing(d);
  engine = new ScheduleEngine(d);
  edits.useDrawing(`${d.fileName}|${d.features.length}`);
  const warning = checkExtentLooksLikeMga(d.focusExtent);
  renderDrawingInfo($('drawing-info'), d, warning);
  $('layer-count').textContent = String(d.layers.length);
  refreshLayers();
  inspected = null;
  renderFeatureInfo($('feature-info'), null);
  updateServiceNotice();
  renderBoxes();
  if (d.focusExtent) map.getView().fit(d.focusExtent, { padding: [40, 40, 40, 40], maxZoom: 21 });
}

$<HTMLInputElement>('file-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await openFile(file.name, await file.arrayBuffer());
  input.value = '';
});

$('load-sample').addEventListener('click', async () => {
  busy('Fetching sample…');
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/sample-utility-survey.dxf`);
    if (!res.ok) throw new Error(`Sample not found (${res.status})`);
    await openFile('sample-utility-survey.dxf', await res.arrayBuffer());
  } catch (err) {
    toast((err as Error).message, true);
    busy(null);
  }
});

// Drag and drop onto the map
const mapWrap = document.querySelector('.map-wrap') as HTMLElement;
let dragDepth = 0;
mapWrap.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
mapWrap.addEventListener('dragover', (e) => e.preventDefault());
mapWrap.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('drop-overlay').hidden = true;
});
mapWrap.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/\.(dwg|dxf)$/i.test(file.name)) return toast('Please drop a .dwg or .dxf file', true);
  await openFile(file.name, await file.arrayBuffer());
});

// ---- layers panel ----
const layerFilter = $<HTMLInputElement>('layer-filter');
function refreshLayers() {
  renderLayerList($('layer-list'), drawing, utilities, layerFilter.value);
}
function visibleLayerNames() {
  const q = layerFilter.value.trim().toLowerCase();
  return (drawing?.layers ?? []).map((l) => l.name).filter((n) => !q || n.toLowerCase().includes(q));
}
layerFilter.addEventListener('input', refreshLayers);
$('layers-all').addEventListener('click', () => {
  utilities.setAllVisible(visibleLayerNames(), true);
  refreshLayers();
  renderBoxes();
});
$('layers-none').addEventListener('click', () => {
  utilities.setAllVisible(visibleLayerNames(), false);
  refreshLayers();
  renderBoxes();
});
$('layer-list').addEventListener('change', () => renderBoxes());
$<HTMLInputElement>('labels-toggle').addEventListener('change', (e) => utilities.setLabelsVisible((e.target as HTMLInputElement).checked));

// ---- boxes panel ----
// ---- schedules ----
function rowsForRing(ring: [number, number][]): ScheduleRow[] | null {
  return engine ? scheduleRows(engine, register, edits, ring) : null;
}
function permitsForRing(ring: [number, number][]) {
  return engine && rules.all().length ? checkPermits(engine, register, edits, ring, rules.all()) : null;
}
const rulesDialog = new RulesDialog(rules, toast);
$('open-rules').addEventListener('click', () => rulesDialog.open());
const scheduleDialog = new ScheduleDialog(
  edits,
  (boxId) => {
    const box = boxes.boxes().find((b) => b.id === boxId);
    const rows = box ? rowsForRing(box.ring) : null;
    return box && rows ? { name: box.name, rows, permits: permitsForRing(box.ring), ruleCount: rules.all().length } : null;
  },
  (row) => {
    // Show the service on the map: highlight it and zoom so it and the box are both visible.
    const f = row.entry.run.primary;
    utilities.highlight(f);
    inspected = f;
    renderFeatureInfo($('feature-info'), f, row.info);
    map.getView().animate({ center: row.entry.points[0].at, duration: 250 });
  },
);
function renderBoxes() {
  renderBoxList(
    $('box-list'),
    $('box-count'),
    boxes,
    rowsForRing,
    permitsForRing,
    rules.all().length,
    (id) => scheduleDialog.open(id),
    () => rulesDialog.open(),
    toast,
  );
  const list = boxes.boxes();
  const shown = list.find((b) => b.id === boxes.selectedId) ?? (list.length === 1 ? list[0] : undefined);
  scheduleLayer.show(shown ? rowsForRing(shown.ring) : null);
  scheduleDialog.refresh();
}
boxes.onChange(renderBoxes);
edits.onChange(renderBoxes);
rules.onChange(renderBoxes);

// ---- service register ----
const servicesDialog = new ServicesDialog(register, () => drawing);
function updateServiceNotice() {
  const el = $('svc-notice');
  if (!drawing) {
    el.hidden = true;
    return;
  }
  const rows = register.summarise(drawing);
  const n = rows.filter((r) => r.incomplete).length;
  el.hidden = false;
  el.classList.toggle('ok', n === 0);
  el.innerHTML =
    n > 0
      ? `<span>⚠ ${n} layer${n === 1 ? '' : 's'} with unknown owner or service type</span><button class="btn small" data-open="incomplete">Review</button>`
      : `<span>All ${rows.length} service layers identified</span><button class="btn small" data-open="all">Services…</button>`;
  el.querySelector('button')!.addEventListener('click', (e) =>
    servicesDialog.open((e.currentTarget as HTMLElement).dataset.open === 'incomplete'),
  );
}
register.onChange(() => {
  utilities.setOverheadTest((layer) => register.isOverhead(layer));
  updateServiceNotice();
  renderBoxes();
  if (inspected) renderFeatureInfo($('feature-info'), inspected, register.resolve(inspected));
});

// ---- feature inspection ----
map.on('singleclick', (e) => {
  if (boxes.currentMode !== 'none') return;
  if (map.forEachFeatureAtPixel(e.pixel, () => true, { layerFilter: (l) => l === boxes.layer, hitTolerance: 4 })) return;
  // Labels are hit-tested by OpenLayers; geometry through the spatial index.
  let hit: CadFeature | null =
    (map.forEachFeatureAtPixel(e.pixel, (f) => f.get('cad') as CadFeature, { layerFilter: (l) => l === utilities.textLayer, hitTolerance: 2 }) as
      | CadFeature
      | undefined) ?? null;
  hit ??= utilities.hitTest(e.coordinate as [number, number], map.getView().getResolution() ?? 1);
  utilities.highlight(hit);
  inspected = hit;
  renderFeatureInfo($('feature-info'), hit, hit ? register.resolve(hit) : undefined);
});

// ---- status bar ----
const coordsEl = $('status-coords');
map.on('pointermove', (e) => {
  const [x, y] = e.coordinate;
  coordsEl.textContent = `E ${x.toFixed(2)}  N ${y.toFixed(2)}`;
});
$('map').addEventListener('pointerleave', () => (coordsEl.textContent = 'E – N –'));
map.on('moveend', () => {
  const res = map.getView().getResolution() ?? 1;
  utilities.updateLabels(map.getView().calculateExtent(map.getSize()), res);
  // Approximate printed scale at 96 dpi
  $('status-scale').textContent = `≈ 1:${Math.round((res * 96) / 0.0254).toLocaleString()}`;
});

// Expose for debugging / automated tests.
(window as unknown as Record<string, unknown>).__app = { map, boxes, utilities, register, rules, getDrawing: () => drawing, openFile, renderBoxes };
