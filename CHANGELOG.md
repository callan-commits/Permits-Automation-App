# Changelog

The version shows at the bottom right of the app (hover over it for the build number and date).

- **Numbering:** versions are numbered `MAJOR.MINOR.PATCH`. While Calvillo is a prototype, MAJOR stays 0: MINOR goes up for a tranche of new features, PATCH for fixes only.
- **Known good:** a version marked ✅ has been tested end to end and is safe to go back to. Each is kept on its own branch, named `known-good/vX.Y.Z`, which is never changed or deleted.

## Going back to a known-good version

1. **Look at it:** on GitHub, pick `known-good/v0.5.0` in the branch list. **Code → Download ZIP** gets that exact version.
2. **Put the live app back to it:** ask Claude to "revert to v0.5.0", or run `git revert` on the commits made since. This is done through a pull request, as usual, so nothing is lost and it can be undone.

## v0.9.0 (27 Nov 2026)

- **Depths from a feature survey:** **Open feature survey** loads a DWG/DXF (or 12d file) with levels across the site. Each callout then reads, for example:

  ```
  Jemena Elec
  RL: ~34.564 QLB
  Surface: 35.566
  Depth: 1.002
  ```

- **Levels used:** 3D points, spot-height blocks (from an RL/LEVEL attribute or the insertion level), and the vertices of 3D strings (kerbs, edges). Level text ("RL 35.566") is only used when a drawing has hardly any 3D levels.
- **Layers left out:** layers whose names say they aren't ground (inverts, pipes, cables, overhead wires, roofs) are left out by default. The **Feature survey** panel lists every layer with levels, so any layer can be ticked or unticked.
- **Surface at a callout point:**
  1. a surveyed level within **30 cm**, used directly;
  2. otherwise, interpolated on the survey's triangulated surface (TIN), if the triangle's three points are all within **5 m**;
  3. otherwise (e.g. at the edge of the survey), a distance-weighted average of the nearest 6 levels within 5 m, if there are at least 3;
  4. otherwise **Surface: [find manually]**, highlighted yellow.
- **Depth:** surface − RL. A negative depth (service above the surface) is flagged. Overhead services get no depth.
- **Callout position:** the callout goes at the crossing with the smallest depth.
- **Schedule:** shows the surface, how it was found, and the depth. A surface can be typed in by hand, e.g. where the survey has none; this also works without a feature survey.
- **Map:** shows the survey's levels when zoomed in.
- **Printout:** the print dialog says whether depths are included and counts surfaces to find manually. The printout footer names the feature survey.

## v0.8.0 (27 Nov 2026)

- **One service, one row:** surveys often break a cable or pipe into pieces that meet end to end. These pieces are now joined into one service when the survey loads.
  - **When pieces join:** their ends meet within 1 cm, and they're on the same layer with the same owner, type and quality level. A change of QL keeps them apart.
  - **Corners and branches:** corners are fine. Where three or more pieces of one service meet, only the pair that carries straight on is joined.
  - **Never joined:** pit outlines and symbols.
  - **Accuracy:** nothing is moved. Crossing points and RLs still come from each piece's own levels.
  - **In the schedule:** a joined service shows "Joined from N pieces" with a **Split** button, and its pieces offer **Re-join**.
  - **Load message:** shows how many pieces were joined.
  - **On your surveys:** 685 pieces joined into 171 services in 0008, and 6,590 into 2,676 in 0006.
- **One callout per service:** at the shallowest crossing (highest RL) if it crosses the box more than once, otherwise at its closest point. The schedule shows which RL the printout uses.
- **Drain inverts and obverts:** where an obvert line runs along an invert (80% of its length within 0.3 m), only the invert is scheduled and called out. Obvert-only drains are kept. 22 such obverts were found in 0006.
- **Faster loading:** owner, type and QL lookups are cached, so large 12d surveys load and redraw faster (0006: 14 s → 11 s).

## v0.7.0 (27 Nov 2026)

- **Callouts name the service:** each callout now reads "[owner] [asset type]", e.g. "VicTrack Comms", then the RL and QL as before.
  - The type isn't repeated when the owner's name already includes it ("Multinet Gas", "Melbourne Water").
  - Callouts with an owner are white.
  - Services with no owner still say "[insert service]" and are highlighted yellow.
  - Services with an owner but no type say "[owner] [insert type]", also yellow.
- **Schedule entries reach the printout:** owner and type entered in the schedule against an S number are used on the callouts. The schedule and the print dialog now say so, and the print dialog counts how many callouts are still to complete.

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
