/**
 * Render the map off-screen at an exact scale for a printout: same imagery, utility styling and
 * rotation as on screen, centred on a point, at `frame.resolution` metres per pixel.
 */
import Map from 'ol/Map';
import View from 'ol/View';
import type BaseLayer from 'ol/layer/Base';
import type TileSource from 'ol/source/Tile';
import type { XY } from '../cad/types';
import { projection } from '../geo/crs';
import { type BasemapId, createBasemapLayer } from '../map/basemaps';
import type { Frame } from './sheet';

export interface RenderedMap {
  /** Background imagery (opaque): best stored as JPEG. */
  base: HTMLCanvasElement;
  /** Utility linework and labels on a transparent background: stored as PNG to keep colours exact. */
  overlay: HTMLCanvasElement;
  /** Ground coordinate -> image pixel (origin top-left). */
  toPixel: (c: XY) => XY;
  /** Imagery tiles that failed to load (0 = all loaded). */
  tilesFailed: number;
  timedOut: boolean;
}

export async function renderMapImage(opts: {
  frame: Frame;
  crs: string;
  centre: XY;
  rotation: number;
  basemap: BasemapId;
  layers: BaseLayer[];
  background: string;
  timeoutMs?: number;
}): Promise<RenderedMap> {
  const { frame } = opts;
  const div = document.createElement('div');
  // Off-screen but laid out at full size, so OpenLayers renders every pixel.
  Object.assign(div.style, { position: 'fixed', left: '-100000px', top: '0', width: `${frame.widthPx}px`, height: `${frame.heightPx}px` });
  document.body.appendChild(div);
  // The basemap gets its own class so OpenLayers doesn't share its canvas with the vector layers.
  const basemap = createBasemapLayer(opts.basemap, 'pa-base');
  let tilesFailed = 0;
  if (basemap) (basemap.getSource() as TileSource).on('tileloaderror', () => tilesFailed++);
  const map = new Map({
    target: div,
    pixelRatio: 1,
    controls: [],
    interactions: [],
    layers: [...(basemap ? [basemap] : []), ...opts.layers],
    view: new View({ projection: projection(opts.crs), center: opts.centre, resolution: opts.frame.resolution, rotation: opts.rotation }),
  });
  try {
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, opts.timeoutMs ?? 90000);
      map.once('rendercomplete', () => {
        clearTimeout(timer);
        resolve();
      });
      map.renderSync();
    });
    // Compose the layer canvases (OpenLayers' standard export technique): imagery and vectors separately.
    const make = () => {
      const c = document.createElement('canvas');
      c.width = frame.widthPx;
      c.height = frame.heightPx;
      return c;
    };
    const base = make();
    const overlay = make();
    const baseCtx = base.getContext('2d')!;
    baseCtx.fillStyle = opts.background;
    baseCtx.fillRect(0, 0, base.width, base.height);
    compose(map.getViewport()!.querySelectorAll<HTMLCanvasElement>('.pa-base canvas, canvas.pa-base'), baseCtx);
    compose(map.getViewport()!.querySelectorAll<HTMLCanvasElement>('.ol-layer canvas, canvas.ol-layer'), overlay.getContext('2d')!);
    // Affine ground -> pixel mapping, taken from the map itself (so rotation sign is never guessed).
    const o = map.getPixelFromCoordinate(opts.centre) as XY;
    const ex = map.getPixelFromCoordinate([opts.centre[0] + 100, opts.centre[1]]) as XY;
    const ny = map.getPixelFromCoordinate([opts.centre[0], opts.centre[1] + 100]) as XY;
    const a: XY = [(ex[0] - o[0]) / 100, (ex[1] - o[1]) / 100];
    const b: XY = [(ny[0] - o[0]) / 100, (ny[1] - o[1]) / 100];
    const toPixel = (c: XY): XY => {
      const dx = c[0] - opts.centre[0];
      const dy = c[1] - opts.centre[1];
      return [o[0] + a[0] * dx + b[0] * dy, o[1] + a[1] * dx + b[1] * dy];
    };
    return { base, overlay, toPixel, tilesFailed, timedOut };
  } finally {
    map.setTarget(undefined);
    div.remove();
  }
}

function compose(canvases: NodeListOf<HTMLCanvasElement>, ctx: CanvasRenderingContext2D) {
  for (const canvas of canvases) {
    if (!canvas.width) continue;
    const parent = canvas.parentElement as HTMLElement;
    const opacity = parent?.style.opacity || canvas.style.opacity;
    ctx.globalAlpha = opacity === '' ? 1 : Number(opacity);
    const m = /^matrix\(([^(]*)\)$/.exec(canvas.style.transform);
    const matrix = m?.[1]
      ? m[1].split(',').map(Number)
      : [parseFloat(canvas.style.width) / canvas.width, 0, 0, parseFloat(canvas.style.height) / canvas.height, 0, 0];
    ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    const bg = parent?.style.backgroundColor;
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(canvas, 0, 0);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

/** Canvas -> image bytes. Throws a clear error if the imagery provider blocks export (CORS). */
export async function canvasBytes(canvas: HTMLCanvasElement, type: 'jpg' | 'png', quality = 0.92): Promise<Uint8Array> {
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type === 'jpg' ? 'image/jpeg' : 'image/png', quality));
  } catch (err) {
    throw new Error(`The imagery provider doesn't allow its tiles to be exported (${(err as Error).message}). Try another background.`);
  }
  if (!blob) throw new Error('Could not encode the map image.');
  return new Uint8Array(await blob.arrayBuffer());
}
