/**
 * Build the printout PDF: the map image at exact scale, plus editable annotations.
 *
 * Callouts are standard PDF FreeText "callout" annotations (as created by Bluebeam / Acrobat):
 * white box, coloured border and leader with an open arrow, text in /Contents and rich text.
 * Each carries an appearance stream so it displays the same in every viewer, and can be moved,
 * resized or re-worded in a PDF editor. The work area is an editable Polygon annotation.
 * The page is calibrated (/VP measure) so PDF measuring tools read metres at the map scale.
 */
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, type PDFFont, type PDFRef, StandardFonts, rgb } from 'pdf-lib';
import type { XY } from '../cad/types';
import { CALLOUT_FONT_SIZE, CALLOUT_LEADING, CALLOUT_PAD, type PlacedCallout } from './callouts';
import type { Frame } from './sheet';

export interface PrintoutInput {
  frame: Frame;
  /** Map image layers, drawn in order to fill the frame (e.g. imagery JPEG, then linework PNG). */
  images: { bytes: Uint8Array; type: 'jpg' | 'png' }[];
  callouts: PlacedCallout[];
  /** Work area outline in page points (closed ring). */
  workArea: XY[];
  workAreaName: string;
  /** Unit vector (page) pointing to grid north. */
  north: XY;
  title: string;
  /** Footer lines (left block). */
  subtitle: string;
  datum: string;
  printedAt: Date;
  author?: string;
}

const AUTHOR = 'Calvillo';
const fmtNum = (n: number) => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(3).replace(/\.?0+$/, ''));
const pdfDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
};
const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const hex = (c: [number, number, number]) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
let nmCounter = 0;
const uid = () => `pa-${Date.now().toString(36)}-${(nmCounter++).toString(36)}`;

/** Every callout is highlighted yellow: each one must be checked and completed by the engineer. */
export const FILL_CALLOUT: [number, number, number] = [1, 0.94, 0.4];

export async function buildPrintoutPdf(input: PrintoutInput): Promise<Uint8Array> {
  const { frame } = input;
  const { pageW, pageH } = frame.spec;
  const doc = await PDFDocument.create();
  doc.setTitle(input.title);
  doc.setAuthor(input.author ?? AUTHOR);
  doc.setCreator('Calvillo');
  doc.setProducer('Calvillo (pdf-lib)');
  doc.setCreationDate(input.printedAt);
  doc.setModificationDate(input.printedAt);
  const page = doc.addPage([pageW, pageH]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // --- map image, exactly filling the frame at the top of the page
  const frameY = pageH - frame.frameH;
  for (const image of input.images) {
    const img = image.type === 'jpg' ? await doc.embedJpg(image.bytes) : await doc.embedPng(image.bytes);
    page.drawImage(img, { x: 0, y: frameY, width: frame.frameW, height: frame.frameH });
  }

  // --- footer
  const footerH = frameY;
  page.drawRectangle({ x: 0, y: 0, width: pageW, height: footerH, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: 0, y: footerH }, end: { x: pageW, y: footerH }, thickness: 0.75, color: rgb(0.2, 0.2, 0.2) });
  const fy1 = footerH - 17;
  const fy2 = footerH - 31;
  const colW = pageW / 3 - 24;
  const fit = (text: string, f: PDFFont, size: number, width: number) => {
    if (f.widthOfTextAtSize(text, size) <= width) return text;
    let t = text;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
    return `${t}…`;
  };
  // left: plan title and source
  page.drawText(fit(input.title, bold, 12, colW), { x: 14, y: fy1, size: 12, font: bold });
  page.drawText(fit(input.subtitle, font, 8, colW), { x: 14, y: fy2, size: 8, font, color: rgb(0.25, 0.25, 0.25) });
  // centre: datum and scale, note
  const centre = `Datum / Projection: ${input.datum}   ·   Scale 1:${frame.spec.scale} at A3`;
  page.drawText(centre, { x: pageW / 2 - font.widthOfTextAtSize(centre, 9) / 2, y: fy1, size: 9, font });
  const note = 'Callouts are editable. Complete [insert service] and check every RL before use.';
  page.drawText(note, { x: pageW / 2 - font.widthOfTextAtSize(note, 8) / 2, y: fy2, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
  // right: printed date
  const printed = `Printed ${input.printedAt.toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  page.drawText(printed, { x: pageW - 14 - font.widthOfTextAtSize(printed, 8.5), y: fy1, size: 8.5, font, color: rgb(0.25, 0.25, 0.25) });
  const tool = 'Made with Calvillo';
  page.drawText(tool, { x: pageW - 14 - font.widthOfTextAtSize(tool, 8), y: fy2, size: 8, font, color: rgb(0.45, 0.45, 0.45) });

  // --- scale bar (bottom-left of the map): 10 m in 2 m blocks
  const ptPerM = 1 / frame.mPerPt;
  const sbX = 16;
  const sbY = frameY + 16;
  const block = 2 * ptPerM;
  page.drawRectangle({ x: sbX - 8, y: sbY - 7, width: 5 * block + 16 + 70, height: 30, color: rgb(1, 1, 1), opacity: 0.9 });
  for (let i = 0; i < 5; i++) {
    page.drawRectangle({ x: sbX + i * block, y: sbY + 4, width: block, height: 5, color: i % 2 ? rgb(1, 1, 1) : rgb(0, 0, 0), borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
  }
  for (const [m, label] of [[0, '0'], [5, '5'], [10, '10 m']] as const) {
    const x = sbX + m * ptPerM;
    page.drawText(label, { x: x - (m === 0 ? 0 : font.widthOfTextAtSize(label, 7) / 2), y: sbY + 12, size: 7, font });
  }
  page.drawText(`1:${frame.spec.scale}`, { x: sbX + 5 * block + 10, y: sbY + 4, size: 9, font: bold });

  // --- north arrow (top-right of the map), pointing to grid north
  drawNorthArrow(page, font, [pageW - 34, pageH - 34], input.north);

  // --- annotations
  const ctx = doc.context;
  const annots: PDFRef[] = [];
  const now = pdfDate(input.printedAt);
  const fontRef = font.ref;

  // Work area polygon
  if (input.workArea.length >= 3) {
    const pts = input.workArea.slice(0, -1);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const rect = [Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 3, Math.max(...ys) + 3];
    const path = pts.map((p, i) => `${fmtNum(p[0])} ${fmtNum(p[1])} ${i ? 'l' : 'm'}`).join(' ');
    const ap = ctx.stream(`q 1 J 1 j 0 0 0 RG 4 w ${path} h S 1 0.8 0 RG 2 w ${path} h S Q`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: rect,
    });
    annots.push(
      ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'Polygon',
          Rect: rect,
          Vertices: pts.flat(),
          C: [1, 0.8, 0],
          BS: { Type: 'Border', W: 2, S: 'S' },
          Contents: PDFHexString.fromText(input.workAreaName),
          Subj: PDFHexString.fromText('Work area'),
          T: PDFHexString.fromText(input.author ?? AUTHOR),
          NM: PDFHexString.fromText(uid()),
          CreationDate: PDFString.of(now),
          M: PDFString.of(now),
          F: 4,
          AP: { N: ctx.register(ap) },
        }),
      ),
    );
  }

  // Callouts
  for (const c of input.callouts) {
    annots.push(ctx.register(calloutAnnot(ctx, c, font, fontRef, now)));
  }
  page.node.set(PDFName.of('Annots'), ctx.obj(annots));

  // Scale calibration for measuring tools, over the map frame only.
  page.node.set(
    PDFName.of('VP'),
    ctx.obj([
      {
        Type: 'Viewport',
        BBox: [0, frameY, frame.frameW, pageH],
        Name: PDFHexString.fromText(`Map 1:${frame.spec.scale}`),
        Measure: {
          Type: 'Measure',
          Subtype: 'RL',
          R: PDFString.of(`1 mm = ${(frame.spec.scale / 1000).toString()} m`),
          X: [{ Type: 'NumberFormat', U: PDFString.of('m'), C: PDFNumber.of(frame.mPerPt), D: 1000 }],
          D: [{ Type: 'NumberFormat', U: PDFString.of('m'), C: 1, D: 1000 }],
          A: [{ Type: 'NumberFormat', U: PDFString.of('sq m'), C: 1, D: 100 }],
        },
      },
    ]),
  );
  return doc.save({ useObjectStreams: false });
}

function calloutAnnot(ctx: PDFDocument['context'], c: PlacedCallout, font: PDFFont, fontRef: PDFRef, now: string) {
  const { box } = c;
  const fill = FILL_CALLOUT;
  // Rect covers the box, the leader and the arrow head.
  const xs = [box.x, box.x + box.w, c.anchor[0], c.knee[0], c.attach[0]];
  const ys = [box.y, box.y + box.h, c.anchor[1], c.knee[1], c.attach[1]];
  const rect = [Math.min(...xs) - 6, Math.min(...ys) - 6, Math.max(...xs) + 6, Math.max(...ys) + 6];
  const rd = [box.x - rect[0], box.y - rect[1], rect[2] - (box.x + box.w), rect[3] - (box.y + box.h)];
  const [r, g, b] = c.color;
  const stroke = `${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} RG`;
  // Open arrow at the tip, aligned with the first leader segment.
  const dx = c.anchor[0] - c.knee[0];
  const dy = c.anchor[1] - c.knee[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const head = 7;
  const spread = 0.42; // ~24 degrees
  const wing = (s: number): XY => [
    c.anchor[0] - head * (ux * Math.cos(spread) - s * uy * Math.sin(spread)),
    c.anchor[1] - head * (uy * Math.cos(spread) + s * ux * Math.sin(spread)),
  ];
  const [w1, w2] = [wing(1), wing(-1)];
  const textOps = c.lines
    .map((line, i) => {
      const y = box.y + box.h - CALLOUT_PAD - 9 - i * CALLOUT_LEADING;
      return `BT /Helv ${CALLOUT_FONT_SIZE} Tf 0 0 0 rg 1 0 0 1 ${fmtNum(box.x + CALLOUT_PAD)} ${fmtNum(y)} Tm ${font.encodeText(line).toString()} Tj ET`;
    })
    .join('\n');
  const content = [
    'q 1 w 0 J 0 j',
    `${fmtNum(fill[0])} ${fmtNum(fill[1])} ${fmtNum(fill[2])} rg ${stroke}`,
    `${fmtNum(box.x)} ${fmtNum(box.y)} ${fmtNum(box.w)} ${fmtNum(box.h)} re B`,
    `${fmtNum(c.anchor[0])} ${fmtNum(c.anchor[1])} m ${fmtNum(c.knee[0])} ${fmtNum(c.knee[1])} l ${fmtNum(c.attach[0])} ${fmtNum(c.attach[1])} l S`,
    `${fmtNum(w1[0])} ${fmtNum(w1[1])} m ${fmtNum(c.anchor[0])} ${fmtNum(c.anchor[1])} l ${fmtNum(w2[0])} ${fmtNum(w2[1])} l S`,
    textOps,
    'Q',
  ].join('\n');
  const ap = ctx.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: rect,
    Resources: { Font: { Helv: fontRef } },
  });
  const rich =
    '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:10.1.5" xfa:spec="2.1" ' +
    `style="font-size:${CALLOUT_FONT_SIZE}pt;text-align:left;color:#000000;font-weight:normal;font-style:normal;font-family:Helvetica,Arial,sans-serif;font-stretch:normal">` +
    c.lines.map((l) => `<p dir="ltr">${xmlEsc(l)}</p>`).join('') +
    '</body>';
  return ctx.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    IT: 'FreeTextCallout',
    Rect: rect,
    RD: rd,
    CL: [c.anchor[0], c.anchor[1], c.knee[0], c.knee[1], c.attach[0], c.attach[1]],
    LE: 'OpenArrow',
    C: fill,
    BS: { Type: 'Border', W: 1, S: 'S' },
    // As in Bluebeam/Acrobat markups: the DA colour is the border/leader colour, the DS colour is the text colour.
    DA: PDFString.of(`${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg /Helv ${CALLOUT_FONT_SIZE} Tf`),
    DS: PDFString.of(`font: Helvetica,sans-serif ${CALLOUT_FONT_SIZE.toFixed(1)}pt; text-align:left; color:#000000`),
    RC: PDFHexString.fromText(rich),
    Contents: PDFHexString.fromText(c.lines.join('\r')),
    Q: 0,
    F: 4,
    T: PDFHexString.fromText(AUTHOR),
    Subj: PDFHexString.fromText('Callout'),
    NM: PDFHexString.fromText(uid()),
    CreationDate: PDFString.of(now),
    M: PDFString.of(now),
    AP: { N: ctx.register(ap) },
    // Not part of the standard: lets a later version of this app find its own callouts.
    PA_Key: PDFHexString.fromText(c.key),
    PA_Colour: PDFString.of(hex(c.color)),
  });
}

function drawNorthArrow(page: ReturnType<PDFDocument['addPage']>, font: PDFFont, centre: XY, north: XY) {
  const [cx, cy] = centre;
  page.drawCircle({ x: cx, y: cy, size: 22, color: rgb(1, 1, 1), opacity: 0.92, borderColor: rgb(0, 0, 0), borderWidth: 0.75 });
  const len = Math.hypot(north[0], north[1]) || 1;
  const ux = north[0] / len;
  const uy = north[1] / len;
  const tip: XY = [cx + ux * 15, cy + uy * 15];
  const tail: XY = [cx - ux * 9, cy - uy * 9];
  const left: XY = [cx - uy * 6 - ux * 3, cy + ux * 6 - uy * 3];
  const right: XY = [cx + uy * 6 - ux * 3, cy - ux * 6 - uy * 3];
  const path = (pts: XY[]) => `M ${pts.map((p) => `${fmtNum(p[0])} ${fmtNum(-p[1])}`).join(' L ')} Z`;
  // drawSvgPath uses a y-down coordinate system relative to (x, y): pass y = 0 and negate y values.
  page.drawSvgPath(path([tip, left, tail]), { x: 0, y: 0, color: rgb(0, 0, 0) });
  page.drawSvgPath(path([tip, right, tail]), { x: 0, y: 0, color: rgb(1, 1, 1), borderColor: rgb(0, 0, 0), borderWidth: 0.75 });
  const nx = cx + ux * 15 + ux * 2;
  const ny = cy + uy * 15 + uy * 2;
  page.drawText('N', { x: nx - 3, y: ny + (uy >= 0 ? 0 : -9), size: 9, font });
}
