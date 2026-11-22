"""Small drawing carrying utility metadata in every common CAD form (for tests).

Usage: python3 scripts/make_metadata_dxf.py tests/data/metadata.dxf
"""
import ezdxf
doc = ezdxf.new("R2018", setup=True)
doc.layers.add("COMMS-TELSTRA", color=30).description = "Telstra comms QL-B"
doc.appids.add("UTILITY")
msp = doc.modelspace()
blk = doc.blocks.new("PIT")
blk.add_circle((0, 0), 0.5)
for tag, y in (("OWNER", 0.6), ("PIT_ID", 0.3), ("RL_LID", 0), ("DEPTH", -0.3)):
    blk.add_attdef(tag, (0.7, y), dxfattribs={"height": 0.2})
# 1. block attributes
msp.add_auto_blockref("PIT", (327900, 5805900, 45.21), {"OWNER": "Telstra", "PIT_ID": "P12", "RL_LID": "45.210", "DEPTH": "0.9"}, dxfattribs={"layer": "COMMS-TELSTRA"})
# 2. XDATA on a polyline with an elevation, and a linetype
pl = msp.add_lwpolyline([(327890, 5805890), (327950, 5805890)], dxfattribs={"layer": "COMMS-TELSTRA", "elevation": 44.3, "linetype": "DASHED"})
pl.set_xdata("UTILITY", [(1000, "OWNER=Telstra"), (1000, "SIZE=2xP50"), (1000, "QL=B"), (1040, 44.3)])
# 3. extension dictionary with an XRECORD
xd = pl.new_extension_dict()
xr = xd.add_xrecord("SURVEY_ATTRIBUTES")
xr.reset([(1, "Surveyed 2026-10-01"), (40, 1.25)])
# 4. 3D line, 3D point, 3D polyline
msp.add_line((327890, 5805880, 43.1), (327950, 5805880, 43.6), dxfattribs={"layer": "COMMS-TELSTRA"})
msp.add_point((327900, 5805870, 42.75), dxfattribs={"layer": "COMMS-TELSTRA"})
msp.add_polyline3d([(327890, 5805860, 41.0), (327950, 5805860, 41.5)], dxfattribs={"layer": "COMMS-TELSTRA"})
import sys
doc.saveas(sys.argv[1] if len(sys.argv) > 1 else "tests/data/metadata.dxf")
