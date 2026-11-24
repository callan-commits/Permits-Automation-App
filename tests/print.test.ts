import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { calloutLines, calloutSpecs, countCrossings, countLeadersUnderBoxes, layoutCallouts, spreadInOrder, CALLOUT_FONT_SIZE } from '../src/print/callouts';
import { buildPrintoutPdf } from '../src/print/pdf';
import { calloutColour, rowsForPlan } from '../src/print/planRules';
import { A3_LANDSCAPE_1_300, PT_PER_MM, extentOnSheet, frameFor, pixelToPage, printCentre, sheetAxes } from '../src/print/sheet';
import type { ScheduleRow } from '../src/services/scheduleModel';
import type { XY } from '../src/cad/types';

describe('sheet geometry', () => {
  const f = frameFor(A3_LANDSCAPE_1_300);
  it('is A3 landscape', () => {
    expect(f.spec.pageW / PT_PER_MM).toBeCloseTo(420, 9);
    expect(f.spec.pageH / PT_PER_MM).toBeCloseTo(297, 9);
  });
  it('is exactly 1:300 in both directions', () => {
    // 1 mm on paper = 0.3 m on the ground
    expect(f.mPerPt * PT_PER_MM).toBeCloseTo(0.3, 12);
    expect(f.groundW).toBeCloseTo(126, 9); // 420 mm x 300
    expect((f.frameW / PT_PER_MM) * 0.3).toBeCloseTo(f.groundW, 9);
    expect((f.frameH / PT_PER_MM) * 0.3).toBeCloseTo(f.groundH, 9);
    // square pixels: same ground size per pixel across and down
    expect(f.groundW / f.widthPx).toBeCloseTo(f.groundH / f.heightPx, 12);
    expect(f.widthPx).toBe(2480); // 150 dpi
  });
  it('maps image pixels to the page with the frame at the top', () => {
    expect(pixelToPage(f, [0, 0])).toEqual([0, f.spec.pageH]);
    const bottomRight = pixelToPage(f, [f.widthPx, f.heightPx]);
    expect(bottomRight[0]).toBeCloseTo(f.frameW, 9);
    expect(bottomRight[1]).toBeCloseTo(f.spec.pageH - f.frameH, 9);
    expect(f.spec.pageH - f.frameH).toBeGreaterThan(14 * PT_PER_MM); // footer strip ~16 mm
  });
  it('has rotation axes that put north to the right at +90°', () => {
    const [right, up] = sheetAxes(Math.PI / 2);
    expect(right[0]).toBeCloseTo(0, 12);
    expect(right[1]).toBeCloseTo(1, 12); // north
    expect(up[0]).toBeCloseTo(-1, 12); // west
  });
  it('centres on the box extent as seen on the sheet', () => {
    const ring: XY[] = [[0, 0], [10, 0], [10, 2], [0, 2], [0, 0]];
    expect(printCentre(ring, 0)).toEqual([5, 1]);
    const c = printCentre(ring, Math.PI / 4);
    expect(c[0]).toBeCloseTo(5, 9);
    expect(c[1]).toBeCloseTo(1, 9);
    const e = extentOnSheet(ring, Math.PI / 2);
    expect(e.w).toBeCloseTo(2, 9);
    expect(e.h).toBeCloseTo(10, 9);
  });
});

const row = (over: Omit<Partial<ScheduleRow>, 'info'> & { info?: Partial<ScheduleRow['info']> }): ScheduleRow =>
  ({
    id: 'S1',
    key: 'k',
    excluded: false,
    needs: { type: false, owner: false, rl: false },
    rls: [{ text: '~32.088', source: '3D line', at: [0, 0] }],
    entry: { run: { primary: { color: '#ff8000' } }, relation: 'near', distance: 1, points: [] },
    ...over,
    info: { type: 'Comms', owner: 'VicTrack', overhead: false, ql: 'B', description: null, source: {}, ...over.info },
  }) as unknown as ScheduleRow;

describe('callout text', () => {
  it('always leaves the service for the engineer, with the RL from the survey', () => {
    expect(calloutLines(row({}), 0)).toEqual(['[insert service]', 'RL: ~32.088 QLB']);
    expect(calloutLines(row({ info: { ql: 'A' }, rls: [{ text: '31.889', source: '3D line', at: [0, 0] }] }), 0)).toEqual(['[insert service]', 'RL: 31.889 QLA']);
    // even a fully identified service says [insert service]: the engineer confirms it
    expect(calloutLines(row({ info: { owner: 'Multinet Gas', type: 'Gas', description: '150 PE' } }), 0)[0]).toBe('[insert service]');
  });
  it('says [insert RL] where the survey has no level', () => {
    expect(calloutLines(row({ info: { ql: null }, rls: [{ text: null, source: null, at: [0, 0] }] }), 0)).toEqual(['[insert service]', 'RL: [insert RL]']);
    expect(calloutLines(row({ rls: [{ text: null, source: null, at: [0, 0] }] }), 0)[1]).toBe('RL: [insert RL] QLB');
  });
  it('makes one callout per RL point, flags missing RLs, skips excluded rows', () => {
    const specs = calloutSpecs(
      [
        row({ rls: [{ text: '~1.000', source: '3D line', at: [1, 1] }, { text: null, source: null, at: [2, 2] }] }),
        row({ key: 'x', excluded: true }),
        row({ key: 'u', needs: { type: false, owner: true, rl: false }, info: { owner: null } }),
      ],
      (g) => [g[0] * 10, g[1] * 10],
      () => '#ff0000',
    );
    expect(specs.map((s) => [s.key, s.anchor, s.missingRl])).toEqual([
      ['k#0', [10, 10], false],
      ['k#1', [20, 20], true],
      ['u#0', [0, 0], false],
    ]);
    expect(specs[0].color).toEqual([1, 0, 0]);
  });
  it('darkens pale colours so the border shows on a white box', () => {
    expect(calloutColour('#ffffff')).toBe('#333333');
    expect(calloutColour('#ff8000')).toBe('#ff8000');
  });
  it('splits rows between the services and overheads plans', () => {
    const rows = [row({ key: 'a' }), row({ key: 'b', info: { overhead: true } }), row({ key: 'c', excluded: true })];
    expect(rowsForPlan(rows, 'services').map((r) => r.key)).toEqual(['a']);
    expect(rowsForPlan(rows, 'overheads').map((r) => r.key)).toEqual(['b']);
  });
});

describe('callout layout (ring around the work area)', () => {
  const width = (t: string) => t.length * CALLOUT_FONT_SIZE * 0.5;
  const frame = { x: 0, y: 45, w: 1190, h: 796 };
  const area: XY[] = [[500, 350], [700, 350], [700, 500], [500, 500], [500, 350]];
  const spec = (k: string, at: XY) => ({ key: k, lines: ['[insert service]', 'RL: ~45.100 QLB'], anchor: at, color: [1, 0, 0] as [number, number, number], missingRl: false });
  const noOverlaps = (placed: ReturnType<typeof layoutCallouts>) => {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i].box;
        const b = placed[j].box;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return false;
      }
    }
    return true;
  };
  const insideFrame = (p: ReturnType<typeof layoutCallouts>[number]) =>
    p.box.x >= frame.x && p.box.y >= frame.y && p.box.x + p.box.w <= frame.x + frame.w && p.box.y + p.box.h <= frame.y + frame.h;
  const clearOfArea = (p: ReturnType<typeof layoutCallouts>[number]) => p.box.x > 700 || p.box.x + p.box.w < 500 || p.box.y > 500 || p.box.y + p.box.h < 350;

  it('spreads points in order with minimum gaps, moving them as little as possible', () => {
    expect(spreadInOrder([0, 10, 20], [5, 5])).toEqual([0, 10, 20]); // already fine
    expect(spreadInOrder([10, 10, 10], [4, 4])).toEqual([6, 10, 14]); // pushed apart symmetrically
    const x = spreadInOrder([0, 1, 2, 50], [10, 10, 10]);
    expect(x[1] - x[0]).toBeCloseTo(10);
    expect(x[2] - x[1]).toBeCloseTo(10);
    expect(x[3]).toBe(50);
  });

  it('typical case: services crossing the box edges get one tidy ring with no crossing leaders', () => {
    // 14 crossing points along the top and bottom edges of the work area
    const anchors: XY[] = [];
    for (let i = 0; i < 7; i++) anchors.push([510 + i * 30, 350], [510 + i * 30, 500]);
    const placed = layoutCallouts(anchors.map((a, i) => spec(`s${i}`, a)), frame, area, width);
    expect(placed).toHaveLength(14);
    expect(noOverlaps(placed)).toBe(true);
    expect(placed.every(insideFrame)).toBe(true);
    expect(placed.every(clearOfArea)).toBe(true);
    expect(placed.every((p) => !p.crowded)).toBe(true);
    expect(countCrossings(placed)).toBe(0);
    // leader ends at the middle of a side of its box
    for (const p of placed) {
      const { x, y, w, h } = p.box;
      const mids: XY[] = [[x, y + h / 2], [x + w, y + h / 2], [x + w / 2, y], [x + w / 2, y + h]];
      expect(mids.some((m) => Math.hypot(m[0] - p.attach[0], m[1] - p.attach[1]) < 1e-9)).toBe(true);
    }
  });

  it('keeps callouts in the same clockwise order as the points they label', () => {
    const anchors: XY[] = [[600, 350], [700, 425], [600, 500], [500, 425], [650, 350], [700, 480]];
    const placed = layoutCallouts(anchors.map((a, i) => spec(`s${i}`, a)), frame, area, width);
    const angle = (p: XY) => Math.atan2(p[1] - 425, p[0] - 600);
    const byAnchor = [...placed].sort((a, b) => angle(a.anchor) - angle(b.anchor)).map((p) => p.key);
    const centre = (p: (typeof placed)[number]): XY => [p.box.x + p.box.w / 2, p.box.y + p.box.h / 2];
    const byBox = [...placed].sort((a, b) => angle(centre(a)) - angle(centre(b))).map((p) => p.key);
    // same cyclic order
    const rot = byBox.indexOf(byAnchor[0]);
    expect([...byBox.slice(rot), ...byBox.slice(0, rot)]).toEqual(byAnchor);
    expect(countCrossings(placed)).toBe(0);
  });

  it('busy realistic case: 45 crossings and nearby services, spread round the sheet with no crossings', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const anchors: XY[] = [];
    // crossing points on the box outline...
    for (let i = 0; i < 25; i++) {
      const t = rnd();
      const side = Math.floor(rnd() * 4);
      anchors.push(side === 0 ? [500 + t * 200, 350] : side === 1 ? [700, 350 + t * 150] : side === 2 ? [500 + t * 200, 500] : [500, 350 + t * 150]);
    }
    // ...and closest points of services up to 10 m (94 pt) outside it
    for (let i = 0; i < 20; i++) {
      const ang = rnd() * 2 * Math.PI;
      const d = 10 + rnd() * 84;
      anchors.push([600 + Math.cos(ang) * (100 + d), 425 + Math.sin(ang) * (75 + d)]);
    }
    const placed = layoutCallouts(anchors.map((a, i) => spec(`s${i}`, a)), frame, area, width);
    expect(placed).toHaveLength(45);
    expect(noOverlaps(placed)).toBe(true);
    expect(placed.every(insideFrame)).toBe(true);
    expect(placed.every(clearOfArea)).toBe(true);
    expect(countCrossings(placed)).toBe(0);
    expect(countLeadersUnderBoxes(placed)).toBeLessThanOrEqual(8);
  });

  it('extreme case: 45 random points packed in and around the box still never overlap and stay on the sheet', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const anchors: XY[] = [];
    for (let i = 0; i < 45; i++) anchors.push([470 + rnd() * 260, 320 + rnd() * 210]);
    const placed = layoutCallouts(anchors.map((a, i) => spec(`s${i}`, a)), frame, area, width);
    expect(placed).toHaveLength(45);
    expect(noOverlaps(placed)).toBe(true);
    expect(placed.every(insideFrame)).toBe(true);
    expect(placed.every(clearOfArea)).toBe(true);
  });
});

// 1x1 white PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

describe('PDF', () => {
  it('has the image, editable callouts, the work area and a 1:300 calibration', async () => {
    const frame = frameFor(A3_LANDSCAPE_1_300);
    const callouts = layoutCallouts(
      [
        { key: 'a#0', lines: ['[insert service]', 'RL: ~32.088 QLB'], anchor: [550, 400], color: [1, 0.5, 0], missingRl: false },
        { key: 'b#0', lines: ['[insert service]', 'RL: [insert RL]'], anchor: [650, 450], color: [0, 0, 1], missingRl: true },
      ],
      { x: 0, y: frame.spec.pageH - frame.frameH, w: frame.frameW, h: frame.frameH },
      [[500, 350], [700, 350], [700, 500], [500, 500], [500, 350]],
      (t) => t.length * 5,
    );
    const bytes = await buildPrintoutPdf({
      frame,
      images: [{ bytes: PNG, type: 'png' }],
      callouts,
      workArea: [[500, 350], [700, 350], [700, 500], [500, 500], [500, 350]],
      workAreaName: 'Box 1',
      north: [0, 1],
      title: 'SERVICES – Box 1',
      subtitle: 'test',
      datum: 'GDA2020 / MGA zone 55',
      printedAt: new Date(2026, 10, 23, 10, 0, 0),
    });
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    expect(page.getWidth() / PT_PER_MM).toBeCloseTo(420, 6);
    expect(page.getHeight() / PT_PER_MM).toBeCloseTo(297, 6);
    const annots = page.node.Annots()!;
    const dicts = annots.asArray().map((r) => doc.context.lookup(r) as PDFDict);
    const subtypes = dicts.map((d) => d.get(PDFName.of('Subtype'))!.toString());
    expect(subtypes).toEqual(['/Polygon', '/FreeText', '/FreeText']);
    const c = dicts[1];
    expect(c.get(PDFName.of('IT'))!.toString()).toBe('/FreeTextCallout');
    expect((c.get(PDFName.of('CL')) as PDFArray).size()).toBe(6);
    expect(c.get(PDFName.of('LE'))!.toString()).toBe('/OpenArrow');
    expect((c.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('[insert service]\rRL: ~32.088 QLB');
    expect(c.get(PDFName.of('AP'))).toBeDefined();
    // every callout is filled yellow
    for (const d of [dicts[1], dicts[2]]) {
      const fill = (d.get(PDFName.of('C')) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
      expect(fill).toEqual([1, 0.94, 0.4]);
    }
    // CL starts at the anchor (arrow tip)
    const cl = (c.get(PDFName.of('CL')) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    expect([cl[0], cl[1]]).toEqual(callouts.find((x) => x.key === 'a#0')!.anchor);
    // calibration: 1 pt = 0.10583 m
    const vp = (page.node.get(PDFName.of('VP')) as PDFArray).get(0) as PDFDict;
    const measure = vp.get(PDFName.of('Measure')) as PDFDict;
    expect((measure.get(PDFName.of('R')) as PDFString).decodeText()).toBe('1 mm = 0.3 m');
    const x = ((measure.get(PDFName.of('X')) as PDFArray).get(0) as PDFDict).get(PDFName.of('C')) as PDFNumber;
    expect(x.asNumber()).toBeCloseTo(0.3 / PT_PER_MM, 9);
  });
});
