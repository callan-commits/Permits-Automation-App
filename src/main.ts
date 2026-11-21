import 'ol/ol.css';
import './styles.css';
import Map from 'ol/Map';
import View from 'ol/View';
import { ScaleLine, defaults as defaultControls } from 'ol/control';
import type TileLayer from 'ol/layer/Tile';
import { loadCadFile } from './cad/loader';
import type { CadDrawing, CadFeature } from './cad/types';
import { CRS_OPTIONS, DEFAULT_CRS, checkExtentLooksLikeMga, projection, registerCrs } from './geo/crs';
import { BASEMAPS, type BasemapId, createBasemapLayer } from './map/basemaps';
import { BoxTool, type DrawMode } from './map/boxTool';
import { UtilityLayers } from './map/utilityLayer';
import { renderBoxList, renderDrawingInfo, renderFeatureInfo, renderLayerList } from './ui/panels';
import proj4 from 'proj4';

registerCrs();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

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
function makeView(code: string, center?: number[], resolution?: number): View {
  return new View({
    projection: projection(code),
    center: center ?? proj4('EPSG:4326', code, MELBOURNE_LONLAT),
    resolution: resolution ?? 20,
    maxResolution: 2000,
    minResolution: 0.005,
    constrainResolution: false,
  });
}

const utilities = new UtilityLayers();
const map = new Map({
  target: 'map',
  controls: defaultControls({ attributionOptions: { collapsible: true, collapsed: false } }).extend([new ScaleLine({ units: 'metric' })]),
  view: makeView(crsCode),
  layers: [utilities.geometryLayer, utilities.textLayer],
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
  map.setView(makeView(code, v.getCenter(), v.getResolution()));
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
};
const HINTS: Record<DrawMode, string> = {
  none: '',
  rect: 'Click two opposite corners (or click-drag). Esc to cancel.',
  rotated: 'Click two points along one edge, then a third to set the width. Esc to cancel.',
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
    const d = await loadCadFile(name, buffer);
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
  const warning = checkExtentLooksLikeMga(d.focusExtent);
  renderDrawingInfo($('drawing-info'), d, warning);
  $('layer-count').textContent = String(d.layers.length);
  refreshLayers();
  renderFeatureInfo($('feature-info'), null);
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
function renderBoxes() {
  renderBoxList($('box-list'), $('box-count'), boxes, drawing, utilities, toast);
}
boxes.onChange(renderBoxes);

// ---- feature inspection ----
map.on('singleclick', (e) => {
  if (boxes.currentMode !== 'none') return;
  if (map.forEachFeatureAtPixel(e.pixel, () => true, { layerFilter: (l) => l === boxes.layer, hitTolerance: 4 })) return;
  let hit: CadFeature | null = null;
  map.forEachFeatureAtPixel(
    e.pixel,
    (f) => {
      hit = f.get('cad') as CadFeature;
      return true;
    },
    { layerFilter: (l) => l === utilities.geometryLayer || l === utilities.textLayer, hitTolerance: 5 },
  );
  utilities.highlight(hit);
  renderFeatureInfo($('feature-info'), hit);
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
  // Approximate printed scale at 96 dpi
  $('status-scale').textContent = `≈ 1:${Math.round((res * 96) / 0.0254).toLocaleString()}`;
});

// Expose for debugging / automated tests.
(window as unknown as Record<string, unknown>).__app = { map, boxes, utilities, getDrawing: () => drawing, openFile };
