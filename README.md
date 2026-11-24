# Calvillo

*Utility markup & permits for rail ground-penetration works. Prototype; the repository is named Permits-Automation-App.*

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
- **Service register** (**Services…** / **Review** in the Layers panel): each layer's service type, owner and overhead flag.
  - Values come from object data where present (OWNER / SERVICE / QL attributes or `KEY=VALUE` XDATA), otherwise they're guessed from the layer name (e.g. `GAS-MULTINET` → Gas, Multinet Gas; `OH`, `OVERHEAD`, `AERIAL` → overhead).
  - Unknowns are highlighted for you to fill in. Edits are remembered in the browser for any drawing using the same layer names.
  - Owner abbreviations are recognised (MTM → Metro Trains Melbourne, UE → United Energy, SEW → South East Water…).
  - Overhead services are drawn dashed.
- **Box schedule**: for each box, every service within 10 m (box card summary, plus **Open schedule** for the full table):
  - **Where it is**: crosses the box (RL at each crossing point), inside it, or near it (RL at its closest point, and the horizontal distance from the box outline).
  - **RLs**, best source first: the line's own 3D levels interpolated at that exact point, the object's elevation, an RL attribute, then a nearby "RL 12.345" text label. The source is shown, and a level of exactly 0 counts as not set.
  - "~" marks levels not surveyed to QL-A, as on existing markups.
  - Pits and other block symbols are treated as one item.
  - Unknown owner, type or RL is highlighted. Type over any value to correct it, or untick to leave a service off. Edits are remembered per drawing.
  - Map markers (S1, S2…) show where each RL applies, with a dashed line showing the gap for services that don't cross.
  - Layers can be marked **not a service** in the Services table (survey points, fences, contours…).
- **Permits** (**Permit rules** in the toolbar): import your permit cheat sheet (.xlsx with Owner / Distance / Permit columns, anywhere on the sheet) or edit the rules in the app. Rules are stored in the browser only.
  - A permit is required when a box is within the trigger distance (horizontally, inclusive) of any asset of that owner. Crossing or inside counts as 0 m.
  - Every service counts, including overhead ones.
  - Alternative owner names are separated by "/" (e.g. `MTM/Metro Trains Melbourne`), and known abbreviations match.
  - Each box card shows the required permits. The schedule explains each trigger (owner, distance, rule, ID) and lists every rule with its nearest asset.
  - Services of unknown owner within the largest trigger distance are flagged, because one could need a permit.
- **A3 printout at 1:300** (**A3 printout** on a box card): a PDF centred on the box, using the map's rotation, imagery and visible layers.
  - **Editable callouts**: standard PDF callout annotations, like those made in Bluebeam or Acrobat. Each has owner and type, then "RL: ~45.100 QLB", with a coloured leader and an open arrow. There is one per crossing or closest point.
  - Unknown owner, type or RL gets a yellow fill. Callouts are placed outside the work area without overlapping.
  - The work area is an editable polygon.
  - The page is calibrated, so PDF measuring tools read metres at 1:300.
  - North arrow, scale bar and footer (source, datum, scale, date).
  - Imagery is stored as JPEG and linework as PNG, so line colours stay exact.
  - **Overheads plan**: a separate PDF with just the overhead services. The services plan leaves them out.
  - Text labels stay upright at any map rotation.
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

1. ✅ Display DWG utility data on imagery, and draw work areas (rectangle, rotated, free-form)
2. ✅ Map rotation
3. ✅ Service register: owner, type and overhead per layer, unknowns highlighted
4. ✅ Box schedule: services within 10 m, with RLs at crossings / closest points
5. ✅ Permits from the cheat sheet
6. ✅ A3 PDF markup at 1:300 with editable callouts, plus an overheads plan
7. Methodology prompt and pre-filled permit documents (waiting on blank forms)
8. Later: depths (surface levels), several drawings at once, saving and reopening a job
