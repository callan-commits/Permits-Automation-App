# Permits-Automation-App

An app intended to automate the civil engineering ground penetration permit process on rail jobs.

**Open the app:** https://callan-commits.github.io/Permits-Automation-App/

## Current status (prototype v0.1)

Working:

- **Open utility survey drawings**: `.dwg` (via [LibreDWG](https://www.gnu.org/software/libredwg/) compiled to WebAssembly) and ASCII `.dxf`. Open from the toolbar or drag onto the map.
- **Display over aerial imagery**: the map runs in the survey's own grid (MGA2020 Zone 54/55/56, or MGA94 for older surveys). Free imagery (Esri World Imagery) or OpenStreetMap is reprojected to fit. Drawing coordinates are never altered.
- **Layers panel**: colours follow the CAD layer colours, with toggles, a filter and a feature count. Layers that are off or frozen in the drawing start hidden.
- **CAD objects drawn**: lines, polylines (including arcs and bulges, and 3D polylines with levels), arcs, circles, ellipses, splines, points, text/MTEXT, block inserts with attributes (nested), hatches, solids and dimensions.
- **Draw work areas ("boxes")**:
  - **▭ Box** draws a rectangle square to the screen (click two corners).
  - **⟋ Rotated box**: two clicks along one edge, then a third click to set the width.
  - **⬠ Free-form** draws any shape. Click each corner, then finish by clicking the first corner, double-clicking or pressing Enter. Backspace undoes a corner.
  - Select a box to edit it: drag inside to move it, drag a corner to reshape it, click an edge to add a corner, and Alt+click a corner to remove it. Shapes whose edges cross are rejected.
  - The sidebar shows area, perimeter, extents, bearing, centre and every corner in MGA (with **Copy corners**).
- **Rotate the map**: use the rotation box (type degrees, or ±15° buttons), **North up**, **Align to box** (puts the selected box's long side left to right), Alt+Shift+drag, or a two-finger twist. The north arrow always shows grid north.
- **Inspect**: click any utility to see its layer, object type, handle, block, length and levels, plus all its non-graphical data (see below).
- **Utility metadata is kept** with every object:
  - **Block attributes by tag** (e.g. `OWNER`, `PIT_ID`, `RL_LID`), including invisible ones. They're attached to the symbol's geometry and labels, so clicking a pit shows them all.
  - **Extended entity data (XDATA)**, with `KEY=VALUE` strings split into fields.
  - **Extension dictionary records (XRECORD)**.
  - **Levels**: 3D polyline and line vertex levels, plus the elevation of polylines, points, circles and block insertion points.
  - **Linetype**, when it's set on the object itself.
- **Privacy**: everything runs in the browser, so survey files are never uploaded anywhere.

## Running it

The live site above is rebuilt automatically whenever `main` changes (see `.github/workflows/deploy-pages.yml`; progress is shown in the repo's **Actions** tab).

To run it locally instead (e.g. while developing), you need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev        # then open http://localhost:5173
```

Click **Load sample** for a synthetic test survey near Caulfield. It is invented geometry and does not represent real assets.

Other commands:

```bash
npm test           # unit tests (CAD conversion, geometry, coordinate transforms)
npm run build      # static production build in dist/ (this is what gets published)
npm run sample     # regenerate the sample DXF (needs: pip install ezdxf)
```

To run the tests against your own DWG files, put them in `tests/fixtures/`. That folder is git-ignored, so client data stays out of the repo.

## How it fits together

```
src/
  cad/
    worker.ts      Web Worker: LibreDWG (WASM) reads DWG/DXF off the main thread
    convert.ts     CAD entities -> simple lines/polygons/points/text in drawing coordinates
    aci.ts         AutoCAD colour index -> hex
    loader.ts      Main-thread wrapper around the worker
  geo/crs.ts       MGA2020 / MGA94 definitions, GDA94->GDA2020 transform, sanity checks
  map/
    basemaps.ts    Imagery sources (swap in Nearmap/Vicmap here later)
    utilityLayer.ts  Styling, layer visibility, CAD-scaled text labels
    boxTool.ts     Draw / select / move / delete boxes
  analysis/geometry.ts  Box dimensions, polygon-to-line distances, nearby utilities
  ui/panels.ts     Sidebar panels
  main.ts          App wiring
```

## Large drawings

Surveys with 100,000+ objects stay responsive:

- **Merged drawing.** Geometry is merged into a few thousand map objects (by layer, colour and area) and drawn as one image that slides while you pan.
- **Level of detail.** Small symbols, such as survey points, pits and hatches, appear once they're a couple of pixels across. Ordinary lines are always drawn.
- **Labels on demand.** Text labels are created only for the area in view, once they're big enough to read (up to 4,000 at a time, largest first).
- **Spatial index.** Clicks and offset checks look only at nearby objects.

Benchmark: on a synthetic survey with 104,000 objects (`python3 scripts/make_stress_dxf.py`), panning takes about 1–3 ms per frame, with a 0.05–0.2 s redraw after each move. Most of the load time is the DWG/DXF parsing, which runs in the background with progress shown.

## Notes and limitations

- **Accuracy**: boxes and distances are calculated in MGA grid coordinates, straight from the survey, so they are not affected by imagery alignment. Free imagery is only accurate to a few metres. GDA2020 is treated as WGS84, a difference of under 0.5 m. Use the imagery for context, not for measuring.
- **DWG support**: LibreDWG reads most DWG versions, but some drawings may fail or lose objects. If a file won't open, save it as DXF from Civil 3D/AutoCAD. Not yet drawn: 3D solids, MLINE, tolerances, raster images and xrefs.
- **Local site grids**: if the coordinates don't look like MGA, the app warns. A site-grid transformation would need adding.
- **Licensing**: LibreDWG is GPL-3.0. That is fine for internal use, but distributing the app to others would require it to be released under the GPL (or the DWG reader swapped for a commercial one).
- **Imagery**: Esri World Imagery is used for development under Esri's terms. For production, use a licensed source (e.g. Nearmap or Vicmap Basemaps).

## Roadmap

1. ✅ Display DWG utility data on imagery, and draw excavation boxes
2. Load several drawings at once (e.g. a separate BYDA response per owner)
3. Map layers to utility owners and types (configurable)
4. Permit rules: offset distances per owner, then the list of permits required
5. PDF markup of the box and nearby utilities in the standard format
6. Pre-filled permit documents
