"""Generate a LARGE synthetic survey for performance testing (roughly a 5-8 MB DWG's worth of content).

Usage:  python3 scripts/make_stress_dxf.py /tmp/stress-survey.dxf
Requires: pip install ezdxf
"""

import math
import random
import sys

import ezdxf

random.seed(1)
X0, Y0 = 327600.0, 5805600.0  # MGA2020 z55, near Caulfield
W, H = 800.0, 500.0


def main(out: str) -> None:
    doc = ezdxf.new("R2018", setup=True)
    doc.units = ezdxf.units.M
    util_layers = [f"UTIL-{kind}-{n}" for kind in ("COMMS", "ELEC", "GAS", "WATER", "SEWER") for n in range(5)]
    colours = [30, 1, 2, 5, 34]
    for i, name in enumerate(util_layers):
        doc.layers.add(name, color=colours[i // 5] + (i % 5) * 10)
    for name, col in (("SURVEY-PTS", 7), ("SURVEY-TEXT", 7), ("CONTOUR-MAJOR", 52), ("CONTOUR-MINOR", 42), ("HATCH-PAVEMENT", 8), ("LABELS", 3), ("POLES", 1)):
        doc.layers.add(name, color=col)

    # Survey point block: cross + circle, with point number / RL / code attributes
    blk = doc.blocks.new("SPT")
    blk.add_circle((0, 0), 0.1)
    blk.add_line((-0.15, 0), (0.15, 0))
    blk.add_line((0, -0.15), (0, 0.15))
    blk.add_attdef("PNO", (0.2, 0.1), dxfattribs={"height": 0.15})
    blk.add_attdef("RL", (0.2, -0.1), dxfattribs={"height": 0.15})
    blk.add_attdef("CODE", (0.2, -0.3), dxfattribs={"height": 0.15})

    msp = doc.modelspace()
    codes = ["NS", "TOK", "BOK", "FP", "PIT", "LP", "TREE", "FH", "SV", "MH"]
    for i in range(15000):
        x, y = X0 + random.random() * W, Y0 + random.random() * H
        msp.add_auto_blockref(
            "SPT",
            (x, y),
            {"PNO": str(1000 + i), "RL": f"{40 + random.random() * 8:.3f}", "CODE": random.choice(codes)},
            dxfattribs={"layer": "SURVEY-PTS"},
        )

    # Contours: 400 polylines x 400 vertices
    for c in range(400):
        layer = "CONTOUR-MAJOR" if c % 5 == 0 else "CONTOUR-MINOR"
        y = Y0 + c * (H / 400)
        pts = [(X0 + k * (W / 399), y + 3 * math.sin(k / 15 + c / 7)) for k in range(400)]
        msp.add_lwpolyline(pts, dxfattribs={"layer": layer})

    # Utilities: 3000 polylines x 20 vertices across 25 layers
    for u in range(3000):
        x, y = X0 + random.random() * W, Y0 + random.random() * H
        ang = random.random() * math.pi
        pts = []
        for k in range(20):
            x += 5 * math.cos(ang) + random.uniform(-0.5, 0.5)
            y += 5 * math.sin(ang) + random.uniform(-0.5, 0.5)
            pts.append((x, y))
        msp.add_lwpolyline(pts, dxfattribs={"layer": random.choice(util_layers)})

    # Labels
    for t in range(8000):
        msp.add_text(
            f"{random.choice(['TELSTRA', 'NBN', 'GAS 110PE', 'DN150', 'HV', 'LV'])} {t}",
            height=0.5,
            dxfattribs={"layer": "LABELS", "insert": (X0 + random.random() * W, Y0 + random.random() * H), "rotation": random.random() * 360},
        )

    # Poles
    for p in range(2000):
        msp.add_circle((X0 + random.random() * W, Y0 + random.random() * H), 0.2, dxfattribs={"layer": "POLES"})

    # Pavement hatches
    for h in range(300):
        x, y = X0 + random.random() * W, Y0 + random.random() * H
        hatch = msp.add_hatch(color=8, dxfattribs={"layer": "HATCH-PAVEMENT"})
        hatch.paths.add_polyline_path([(x, y), (x + 10, y), (x + 10, y + 4), (x, y + 4)], is_closed=True)

    doc.saveas(out)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/stress-survey.dxf")
