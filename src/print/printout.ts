/** Make a printout PDF for one work area: services plan or overheads plan. */
import type { XY } from '../cad/types';
import type { BasemapId } from '../map/basemaps';
import type { ExcavationBox } from '../map/boxTool';
import type { UtilityLayers } from '../map/utilityLayer';
import type { ServiceRegister } from '../services/register';
import type { ScheduleRow } from '../services/scheduleModel';
import { type PlacedCallout, calloutSpecs, layoutCallouts, CALLOUT_FONT_SIZE } from './callouts';
import { buildPrintoutPdf, sheetFurniture } from './pdf';
import { canvasBytes, renderMapImage } from './renderMap';
import { A3_LANDSCAPE_1_300, frameFor, pixelToPage, printCentre, sheetAxes } from './sheet';
import { calloutColour, rowsForPlan } from './planRules';
export { calloutColour, fitsOnSheet, rowsForPlan } from './planRules';
import { StandardFonts, PDFDocument } from 'pdf-lib';

export type { PlanKind } from './planRules';
import type { PlanKind } from './planRules';

export interface PrintoutResult {
  bytes: Uint8Array;
  fileName: string;
  callouts: PlacedCallout[];
  tilesFailed: number;
  timedOut: boolean;
}

let measureFont: Promise<(t: string) => number> | null = null;
/** Text width in pt for the callout font (Helvetica), using the same metrics as the PDF. */
function textMeasurer(): Promise<(t: string) => number> {
  measureFont ??= PDFDocument.create()
    .then((d) => d.embedFont(StandardFonts.Helvetica))
    .then((f) => (t: string) => f.widthOfTextAtSize(t, CALLOUT_FONT_SIZE));
  return measureFont;
}

export async function makePrintout(opts: {
  kind: PlanKind;
  box: ExcavationBox;
  rows: ScheduleRow[];
  utilities: UtilityLayers;
  register: ServiceRegister;
  crs: string;
  datum: string;
  rotation: number;
  basemap: BasemapId;
  sourceName: string;
  onStage?: (s: string) => void;
}): Promise<PrintoutResult> {
  const frame = frameFor(A3_LANDSCAPE_1_300);
  const centre = printCentre(opts.box.ring, opts.rotation);
  const { register } = opts;
  // Context layers (not services) appear on both plans; services only on their own plan.
  const include = (layer: string) =>
    !register.isService(layer) || (opts.kind === 'overheads' ? register.isOverhead(layer) : !register.isOverhead(layer));
  const [right, up] = sheetAxes(opts.rotation);
  const half = [frame.groundW / 2, frame.groundH / 2];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [
    centre[0] + i * half[0] * right[0] + j * half[1] * up[0],
    centre[1] + i * half[0] * right[1] + j * half[1] * up[1],
  ]);
  const extent = [
    Math.min(...corners.map((c) => c[0])),
    Math.min(...corners.map((c) => c[1])),
    Math.max(...corners.map((c) => c[0])),
    Math.max(...corners.map((c) => c[1])),
  ];
  opts.onStage?.('Rendering the map at 1:300 (waiting for imagery)…');
  const rendered = await renderMapImage({
    frame,
    crs: opts.crs,
    centre,
    rotation: opts.rotation,
    basemap: opts.basemap,
    layers: opts.utilities.createExportLayers(include, extent, frame.resolution, opts.rotation),
    background: '#0b0d10',
  });
  const toPage = (g: XY) => pixelToPage(frame, rendered.toPixel(g));
  opts.onStage?.('Placing callouts…');
  const planRows = rowsForPlan(opts.rows, opts.kind);
  const specs = calloutSpecs(planRows, toPage, (row) => calloutColour(row.entry.run.primary.color));
  const workArea = opts.box.ring.map(toPage);
  const frameRect = { x: 0, y: frame.spec.pageH - frame.frameH, w: frame.frameW, h: frame.frameH };
  const callouts = layoutCallouts(specs, frameRect, workArea, await textMeasurer(), sheetFurniture(frame).keepClear);
  const n0 = toPage(centre);
  const n1 = toPage([centre[0], centre[1] + 10]);
  opts.onStage?.('Building the PDF…');
  const bytes = await buildPrintoutPdf({
    frame,
    images: [
      { bytes: await canvasBytes(rendered.base, 'jpg'), type: 'jpg' },
      { bytes: await canvasBytes(rendered.overlay, 'png'), type: 'png' },
    ],
    callouts,
    workArea,
    workAreaName: opts.box.name,
    north: [n1[0] - n0[0], n1[1] - n0[1]],
    title: `${opts.kind === 'overheads' ? 'OVERHEAD SERVICES' : 'SERVICES'} – ${opts.box.name}`,
    subtitle: `${opts.sourceName} · services within 10 m · RL at crossing or closest point`,
    datum: opts.datum,
    printedAt: new Date(),
  });
  const safe = opts.box.name.replace(/[^\w .-]+/g, '_');
  return {
    bytes,
    fileName: `${safe} - ${opts.kind === 'overheads' ? 'Overheads' : 'Services'} plan 1-300 A3.pdf`,
    callouts,
    tilesFailed: rendered.tilesFailed,
    timedOut: rendered.timedOut,
  };
}
