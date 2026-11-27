# Calvillo

*Prototype app for preparing ground-penetration permits on rail jobs. The repository is named Permits-Automation-App.*

An app intended to automate the civil engineering ground penetration permit process on rail jobs.

**Open the app:** https://callan-commits.github.io/Permits-Automation-App/

**Version:** shown at the bottom right of the app. See [CHANGELOG.md](CHANGELOG.md) for what each version contains and which are marked known good (✅). Each known-good version is kept on a `known-good/vX.Y.Z` branch.

The live app asks search engines not to index it (`noindex`), even though the repository is public.
## Current status (prototype v0.1)

Working:

- **Open utility surveys**: `.dwg` (via [LibreDWG](https://www.gnu.org/software/libredwg/) compiled to WebAssembly), ASCII `.dxf`, and 12d Model `.12daz` / `.12da`. Open from the toolbar or drag onto the map.
  - **12d files:**
    - Each 12d model becomes a layer, and each string's attributes become its object data. Owner, service type and QL are read from `OWNER` / `TYPE` / `QUALITY_LEVEL`, or VicTrack's `VT_UTL_OWNER` etc.
    - Lines keep their 3D levels, and arcs, circles and single-point strings are drawn. A positive 12d radius is a clockwise arc.
    - Per-vertex survey attributes are skipped, so even very large exports open quickly. They're streamed: unzipped and decoded in the background, a piece at a time.
- **Display over aerial imagery**: the map runs in MGA2020 Zone 55 (EPSG:7855), the only grid the app uses; there is no grid selector. Free imagery (Esri World Imagery) or OpenStreetMap is reprojected to fit. Drawing coordinates are never altered.
- **Layers panel**: colours follow the CAD layer colours, with toggles, a filter and a feature count. Layers that are off or frozen in the drawing start hidden.
- **CAD objects drawn**: lines, polylines (including arcs and bulges, and 3D polylines with levels), arcs, circles, ellipses, splines, points, text/MTEXT, block inserts with attributes (nested), hatches, solids and dimensions.
- **Draw work areas ("boxes")**:
  - **▭ Box** draws a rectangle square to the screen (click two corners).
  - **⟋ Rotated box**: two clicks along one edge, then a third click to set the width.
  - **⬠ Free-form** draws any shape. Click each corner, then finish by clicking the first corner, double-clicking or pressing Enter. Backspace undoes a corner.
  - Work areas show bright green with a 40% fill (a white dashed edge when selected).
  - Select a box to edit it: drag inside to move it, drag a corner to reshape it, click an edge to add a corner, and Alt+click a corner to remove it. Shapes whose edges cross are rejected.
  - The sidebar shows area, perimeter, extents, bearing, centre and every corner in MGA (with **Copy corners**).
- **Rotate the map**: use the rotation box (type degrees, or ±15° buttons), **North up**, **Align to box** (puts the selected box's long side left to right), Alt+Shift+drag, or a two-finger twist. The north arrow always shows grid north.
- **Service register** (**Services…** in the Layers panel): each layer's service type, owner and overhead flag.
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
  - **Joined services:** pieces of one service that meet end to end are joined into one row and one S number.
    - Pieces join when their ends meet within 1 cm on the same layer, with the same owner, type and QL; a QL change keeps them apart.
    - At a branch, only the straight-on pair is joined.
    - Nothing is moved: RLs still come from each piece's own levels.
    - **Split** / **Re-join** in the schedule undo or redo a join.
  - **Drain obverts:** an obvert running along an invert (80% of its length within 0.3 m) is left out, and the invert is used.
  - Map markers (S1, S2…) show where each RL applies, with a dashed line showing the gap for services that don't cross. While a schedule is open, the markers are for that box.
  - **The schedule opens in a floating panel**, so the map stays usable alongside it. The map shifts so the box isn't hidden behind the panel. Drag the panel by its title bar and resize it from the bottom-right corner; it reopens where you left it. **⧉ Pop out** moves it into its own browser window (e.g. on a second screen). Edits and **Show on map** clicks there update the app, and **Back to app** docks it again. The browser must allow pop-ups for the site.
  - Layers can be marked **not a service** in the Services table (survey points, fences, contours…).
- **Depths** (**Open feature survey**):
  - **What it reads:** a feature survey DWG/DXF (or 12d) with levels across the site. Levels come from 3D points, spot-height blocks (RL/LEVEL attribute or insertion level) and 3D string vertices. Level text is used only if there are hardly any 3D levels.
  - **Layers:** layers named like inverts, pipes, cables, overhead wires or roofs are left out by default. Every layer can be ticked or unticked in the **Feature survey** panel.
  - **Surface at a callout point:**
    1. a surveyed level within 0.30 m;
    2. otherwise linear interpolation on the TIN, if the triangle's 3 points are all within 5 m;
    3. otherwise an inverse-distance-weighted average of the nearest ≤6 levels within 5 m, if there are at least 3;
    4. otherwise flagged "[find manually]".
  - **Depth** = surface − RL. Callouts read owner/type, RL, Surface and Depth, and go at the crossing with the smallest depth.
  - **By hand:** a surface can be typed into the schedule.
  - **Map:** levels show when zoomed in.
  - Logic in `src/analysis/surface.ts`; test data from `scripts/make_feature_survey_dxf.py`.
- **Permits** (**Permit rules** in the toolbar): the permit cheat sheet is built into the app (`src/permits/builtInRules.ts`); there is no spreadsheet import. Rules can be edited in the app, kept in that browser only, with **Reset to built-in rules**. To change a rule for everyone, edit `builtInRules.ts`.
  - A permit is required when a box is within the trigger distance (horizontally, inclusive) of any asset of that owner. Crossing or inside counts as 0 m.
  - Every service counts, including overhead ones.
  - Alternative owner names are separated by "/" (e.g. `MTM/Metro Trains Melbourne`), and known abbreviations match.
  - Each box card shows the required permits. The schedule explains each trigger (owner, distance, rule, ID) and lists every rule with its nearest asset.
- **A3 printout at 1:300** (**A3 printout** on a box card): a PDF centred on the box, using the map's rotation, imagery and visible layers.
  - **Editable callouts**: standard PDF callout annotations, like those made in Bluebeam or Acrobat, with a coloured leader and an open arrow. There is one per service: at its shallowest crossing (highest RL) if it crosses the box, otherwise at its closest point. Each callout reads "[owner] [asset type]", e.g. "VicTrack Comms", then "RL: ~45.100 QLB" (or "RL: [insert RL]"). The owner and type come from the survey, or from what was entered in the box's schedule against each S number.
    - Services with no owner read "[insert service]".
    - Callouts still to complete are highlighted yellow; the rest are white.
  - **Callout layout**: callouts sit on a ring (an ellipse) around the work area, in the same clock order as their arrow tips, so leaders don't cross. Busy areas first enlarge the ring, then use a second ring out to the sheet edge. A final pass swaps or nudges callouts to remove any remaining crossings, and any leader running under another box. Boxes never overlap each other, the work area, another arrow tip, the legend, the north arrow or the scale bar.
  - The work area is an editable polygon: bright green, filled, at 40% opacity (the same as on the map).
  - **Legend** (top right, left of the north arrow): an editable text box with a bold "Legend" title, and below it an editable "[insert excavation]" box with a swatch in the work area's colour.
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

Open a DWG, DXF or 12d file (.12daz / .12da) with **Open survey**, or drag it onto the map. A synthetic test survey (invented geometry near Caulfield) is kept in `tests/data/` for the automated tests; it is not published with the app.

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
    worker.ts      Web Worker: LibreDWG (WASM) reads DWG/DXF off the main thread; 12d files go to twelveD.ts
    twelveD.ts     12d ASCII reader (.12da / .12daz): streamed unzip + UTF-16/UTF-8 decode, line parser
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
5. ✅ Permits from the cheat sheet (built in)
6. ✅ A3 PDF markup at 1:300 with editable callouts, plus an overheads plan
7. Methodology prompt and pre-filled permit documents (waiting on blank forms)
8. Later: depths (surface levels), several drawings at once, saving and reopening a job
