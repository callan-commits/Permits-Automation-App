/**
 * Sheet geometry for printouts. Page units are PDF points (1/72 inch).
 *
 * The map frame spans the full sheet width above a footer strip. Its image is rendered at
 * `dpi` with square pixels, and the frame height is set from the whole number of image rows
 * so the scale is exactly the same horizontally and vertically.
 */
import type { XY } from '../cad/types';

export const PT_PER_MM = 72 / 25.4;

export interface SheetSpec {
  /** Page width / height, pt */
  pageW: number;
  pageH: number;
  /** Footer strip height, pt (approximate: the frame takes whole image rows). */
  footer: number;
  /** Map scale denominator, e.g. 300 for 1:300. */
  scale: number;
  /** Image resolution, dots per inch. */
  dpi: number;
}

export const A3_LANDSCAPE_1_300: SheetSpec = {
  pageW: 420 * PT_PER_MM,
  pageH: 297 * PT_PER_MM,
  footer: 16 * PT_PER_MM,
  scale: 300,
  dpi: 150,
};

export interface Frame {
  spec: SheetSpec;
  widthPx: number;
  heightPx: number;
  /** Frame size on the page, pt. The frame's top edge is the top of the page. */
  frameW: number;
  frameH: number;
  /** Ground metres per image pixel. */
  resolution: number;
  /** Ground metres per pt on paper. */
  mPerPt: number;
  /** Ground covered by the frame, m. */
  groundW: number;
  groundH: number;
}

export function frameFor(spec: SheetSpec): Frame {
  const mPerPt = (25.4 / 72 / 1000) * spec.scale;
  const frameW = spec.pageW;
  const widthPx = Math.round((frameW * spec.dpi) / 72);
  const resolution = (frameW * mPerPt) / widthPx;
  const heightPx = Math.round(((spec.pageH - spec.footer) * spec.dpi) / 72);
  const frameH = (heightPx * resolution) / mPerPt;
  return { spec, widthPx, heightPx, frameW, frameH, resolution, mPerPt, groundW: widthPx * resolution, groundH: heightPx * resolution };
}

/** Image pixel (origin top-left) -> page point (origin bottom-left). */
export function pixelToPage(frame: Frame, px: XY): XY {
  const k = frame.resolution / frame.mPerPt;
  return [px[0] * k, frame.spec.pageH - px[1] * k];
}

/**
 * Centre for a printout: the middle of the box's extent as seen in the (rotated) map,
 * so the box sits centrally on the sheet. `rotation` is OpenLayers view rotation (radians, clockwise).
 */
export function printCentre(ring: XY[], rotation: number): XY {
  const [right, up] = sheetAxes(rotation);
  const us = ring.map((p) => p[0] * right[0] + p[1] * right[1]);
  const vs = ring.map((p) => p[0] * up[0] + p[1] * up[1]);
  const u = (Math.min(...us) + Math.max(...us)) / 2;
  const v = (Math.min(...vs) + Math.max(...vs)) / 2;
  return [u * right[0] + v * up[0], u * right[1] + v * up[1]];
}

/** Size of the box's extent along the sheet's axes (m) for a given rotation. */
/**
 * Ground directions of the sheet's "right" and "up" for an OpenLayers view rotation r (radians,
 * positive = map turned clockwise). E.g. r = 90°: north points right, so right = north, up = west.
 */
export function sheetAxes(rotation: number): [XY, XY] {
  return [
    [Math.cos(rotation), Math.sin(rotation)],
    [-Math.sin(rotation), Math.cos(rotation)],
  ];
}

export function extentOnSheet(ring: XY[], rotation: number): { w: number; h: number } {
  const [right, up] = sheetAxes(rotation);
  const us = ring.map((p) => p[0] * right[0] + p[1] * right[1]);
  const vs = ring.map((p) => p[0] * up[0] + p[1] * up[1]);
  return { w: Math.max(...us) - Math.min(...us), h: Math.max(...vs) - Math.min(...vs) };
}
