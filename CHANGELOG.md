# Changelog

The version shows at the bottom right of the app (hover over it for the build number and date).

- **Numbering:** versions are numbered `MAJOR.MINOR.PATCH`. While Calvillo is a prototype, MAJOR stays 0: MINOR goes up for a tranche of new features, PATCH for fixes only.
- **Known good:** a version marked ✅ has been tested end to end and is safe to go back to. Each has a git tag and a GitHub Release of the same name.

## Going back to a known-good version

1. **Look at it:** on GitHub, open **Releases** (or **Tags**), choose the version, then **Browse files**. **Source code (zip)** downloads that exact version.
2. **Put the live app back to it:** run `git revert` on the commits made since the tag, or ask Claude to "revert to v0.5.0". This is done through a pull request, as usual, so nothing is lost and it can be undone.

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
