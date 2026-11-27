"""Generate a SYNTHETIC feature survey (ground levels) for testing depths.

Coordinates are MGA2020 Zone 55 (EPSG:7855), metres, around a centre point. The ground is a gently
sloping plane, so any interpolated level can be checked exactly:

    z = Z0 + SLOPE_X * (x - cx) + SLOPE_Y * (y - cy)

Contents (invented; does not represent real ground):
  - "SPOT HEIGHTS": POINT entities at 3D positions on a 3 m grid, with a 16 m square gap
    (centred 25 m east of the centre) where there are no levels at all;
  - "LEVELS": spot-height blocks (a small cross) with an RL attribute, insertion z = 0, so the level
    has to come from the attribute;
  - "KERB": a 3D polyline with a level at each vertex;
  - "TEXT LEVELS": "RL n.nnn" text beside some points (ignored: the survey has plenty of 3D levels);
  - "PIT INV": points 1.5 m below the ground (not ground: left out by default);
  - "OHW": an overhead wire 6 m above the ground (not ground: left out by default).

Usage:  python3 scripts/make_feature_survey_dxf.py OUT.dxf [cx cy [z0]]
        (default centre: the synthetic sample surveys near Caulfield)
"""

import sys

import ezdxf

out = sys.argv[1]
cx = float(sys.argv[2]) if len(sys.argv) > 3 else 327842.5
cy = float(sys.argv[3]) if len(sys.argv) > 3 else 5805975.0
Z0 = float(sys.argv[4]) if len(sys.argv) > 4 else 32.0
SLOPE_X, SLOPE_Y = 0.02, -0.01
HALF = 45  # survey covers the centre ± 45 m
GAP = (cx + 25 - 8, cy - 8, cx + 25 + 8, cy + 8)  # no levels in here


def ground(x: float, y: float) -> float:
    return Z0 + SLOPE_X * (x - cx) + SLOPE_Y * (y - cy)


def in_gap(x: float, y: float) -> bool:
    return GAP[0] <= x <= GAP[2] and GAP[1] <= y <= GAP[3]


doc = ezdxf.new("R2018")
for name, colour in [("SPOT HEIGHTS", 7), ("LEVELS", 3), ("KERB", 2), ("TEXT LEVELS", 8), ("PIT INV", 5), ("OHW", 1)]:
    doc.layers.add(name, color=colour)
msp = doc.modelspace()

spot = doc.blocks.new("SPOT")
spot.add_line((-0.2, 0), (0.2, 0))
spot.add_line((0, -0.2), (0, 0.2))
spot.add_attdef("RL", (0.3, 0.1), dxfattribs={"height": 0.25})

i = 0
y = cy - HALF
while y <= cy + HALF + 1e-6:
    x = cx - HALF
    while x <= cx + HALF + 1e-6:
        if not in_gap(x, y):
            i += 1
            if i % 5 == 0:
                # every fifth level as a spot-height block, its level only in the RL attribute
                ins = msp.add_blockref("SPOT", (x, y, 0), dxfattribs={"layer": "LEVELS"})
                ins.add_auto_attribs({"RL": f"{ground(x, y):.3f}"})
            else:
                msp.add_point((x, y, ground(x, y)), dxfattribs={"layer": "SPOT HEIGHTS"})
            if i % 7 == 0:
                msp.add_text(f"RL {ground(x, y):.3f}", dxfattribs={"layer": "TEXT LEVELS", "height": 0.25, "insert": (x + 0.3, y + 0.3)})
        x += 3
    y += 3

# A kerb line across the site (3D polyline, levels at each vertex, 0.15 m above the plane: top of kerb)
kerb = [(cx - HALF + k * 6.5, cy - 20 + k * 0.4) for k in range(14)]
msp.add_polyline3d([(x, y, ground(x, y) + 0.15) for x, y in kerb], dxfattribs={"layer": "KERB"})

# Not ground: pit inverts and an overhead wire
for k in range(6):
    x, y = cx - 30 + k * 10, cy + 10
    msp.add_point((x, y, ground(x, y) - 1.5), dxfattribs={"layer": "PIT INV"})
msp.add_polyline3d([(cx - HALF, cy + 30, ground(cx - HALF, cy + 30) + 6), (cx + HALF, cy + 30, ground(cx + HALF, cy + 30) + 6)], dxfattribs={"layer": "OHW"})

doc.saveas(out)
print(f"wrote {out}: {i} ground levels, gap {GAP}")
