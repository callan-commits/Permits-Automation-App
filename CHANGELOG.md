# Changelog

The version shows at the bottom right of the app (hover over it for the build number and date).

- **Numbering:** versions are numbered `MAJOR.MINOR.PATCH`. While Calvillo is a prototype, MAJOR stays 0: MINOR goes up for a tranche of new features, PATCH for fixes only.
- **Known good:** a version marked ✅ has been tested end to end and is safe to go back to. Each is kept on its own branch, named `known-good/vX.Y.Z`, which is never changed or deleted.

## Going back to a known-good version

1. **Look at it:** on GitHub, pick `known-good/v0.5.0` in the branch list. **Code → Download ZIP** gets that exact version.
2. **Put the live app back to it:** ask Claude to "revert to v0.5.0", or run `git revert` on the commits made since. This is done through a pull request, as usual, so nothing is lost and it can be undone.

## v0.6.0 (27 Nov 2026)

- **12d surveys:** opens 12d Model files (.12daz, and plain .12da) as well as DWG and DXF.
  - Each 12d model becomes a layer. Each string's own attributes become its object data, so owner, service type and quality level come straight from the survey (`OWNER` / `TYPE` / `QUALITY_LEVEL`, or VicTrack's `VT_UTL_…` fields).
  - Levels come from the strings' 3D points, so RLs at crossings are interpolated as for 3D polylines.
  - Arcs (rounded pit outlines), circles and single-point strings are drawn.
  - Abandoned and removed utilities are shown like any other layer.
  - Large exports are read in pieces in the background: a 33 MB .12daz (about 690 MB unzipped, 30,695 strings) opens in about 14 s.
- **Owner values:** values meaning "not known" ("Unknown", "NA", "TBC"…) count as no owner, so those services are highlighted for input (DWG too). More owner spellings are recognised: ARTC, Mobil/ExxonMobil, FibreconX, Victrack, Vline.
- **Layer names:** long names such as 12d model paths show their last part first in the layer list and the Services table (full name on hover).
- **Open button:** the button is now **Open survey**.

## ✅ v0.5.0 (27 Nov 2026), known good

The first numbered version, covering everything built so far (pull requests #1–#12, plus this one).

- **Viewer:** opens DWG/DXF utility surveys over aerial imagery, in MGA2020 Zone 55 only.
  - Fast with large surveys.
  - Object data is kept (owner, service, QL, RLs).
- **Work areas:** box, rotated box or free-form shape. Corners can be edited, and the map can be rotated.
  - Shown bright green with a 40% fill.
- **Services:** service type, owner and overhead flag for each layer, from object data or the layer name.
  - Editable in **Services…**.
  - Layers can be marked "not a service".
- **Schedule:** every service within 10 m of a box, with the RL where it crosses the box or at its closest point.
  - Opens in a floating, movable, resizable panel that can pop out into its own window.
  - S1, S2… markers show each service on the map.
- **Permits:** worked out from the built-in permit cheat sheet (MTM, VicTrack, Jemena, Zinfra, Melbourne Water). Rules can be edited in the browser.
- **A3 1:300 PDF printout,** centred on the box and following the map's rotation:
  - aerial imagery;
  - editable yellow callouts ("[insert service]" / "RL: …"), arranged around the work area without crossing;
  - an editable legend;
  - a north arrow and scale bar.
  - A separate overheads plan is also produced.
- **Hidden from search engines** (no-index).
