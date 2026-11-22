"""Generate a SYNTHETIC utility survey drawing for testing.

Coordinates are MGA2020 Zone 55 (EPSG:7855), metres. The geometry is invented:
it sits near Caulfield, Melbourne, but does NOT represent real assets.

Usage:  python3 scripts/make_sample_dxf.py public/samples/sample-utility-survey.dxf
Requires: pip install ezdxf
"""

import math
import sys

import ezdxf

ORIGIN = (327842.9, 5805970.5)  # approx. Caulfield station, MGA2020 z55
BEARING_DEG = 135.0  # corridor runs NW -> SE

b = math.radians(BEARING_DEG)
U = (math.sin(b), math.cos(b))  # along corridor
N = (-U[1], U[0])  # left-hand perpendicular


def p(s: float, o: float = 0.0, z: float | None = None):
    """Point at chainage s (m) and offset o (m, +ve = left of corridor)."""
    x = ORIGIN[0] + s * U[0] + o * N[0]
    y = ORIGIN[1] + s * U[1] + o * N[1]
    return (x, y) if z is None else (x, y, z)


LAYERS = {
    # name: (ACI colour, description)
    "RAIL-TRACK-CL": (8, "Track centrelines"),
    "RAIL-BOUNDARY": (9, "Rail corridor boundary"),
    "RAIL-SIGNAL-CABLE": (4, "Signalling cable route (rail operator)"),
    "COMMS-TELSTRA": (30, "Telstra communications"),
    "COMMS-NBN": (6, "NBN Co communications"),
    "ELEC-HV-UE": (1, "United Energy HV underground"),
    "ELEC-LV-UE": (11, "United Energy LV underground"),
    "ELEC-POLE": (1, "Power poles"),
    "GAS-MULTINET": (2, "Gas main"),
    "WATER-SEW": (5, "South East Water main"),
    "SEWER-SEW": (34, "Sewer main"),
    "DRAINAGE": (140, "Stormwater drainage"),
    "UTIL-TEXT": (7, "Utility labels"),
}


def main(out_path: str) -> None:
    doc = ezdxf.new("R2018", setup=True)
    doc.units = ezdxf.units.M
    for name, (color, desc) in LAYERS.items():
        doc.layers.add(name, color=color).description = desc

    # Blocks: pit and manhole symbols
    pit = doc.blocks.new("PIT")
    pit.add_lwpolyline([(-0.6, -0.3), (0.6, -0.3), (0.6, 0.3), (-0.6, 0.3)], close=True)
    pit.add_line((-0.6, -0.3), (0.6, 0.3))
    mh = doc.blocks.new("MANHOLE")
    mh.add_circle((0, 0), 0.6)
    mh.add_circle((0, 0), 0.3)

    msp = doc.modelspace()
    L = 400.0  # corridor length

    # Rail
    for off in (-2.0, 2.0):
        msp.add_lwpolyline([p(-20, off), p(L + 20, off)], dxfattribs={"layer": "RAIL-TRACK-CL"})
    for off in (-15.0, 15.0):
        msp.add_lwpolyline([p(-20, off), p(L + 20, off)], dxfattribs={"layer": "RAIL-BOUNDARY"})

    # Signal cable alongside down track, 3D polyline with depths
    msp.add_polyline3d(
        [p(s, -4.5, 45.0 - 0.6) for s in range(0, int(L) + 1, 50)],
        dxfattribs={"layer": "RAIL-SIGNAL-CABLE"},
    )

    # Telstra outside the boundary on the left, with pits
    msp.add_lwpolyline([p(s, 18.0) for s in (0, 120, 240, L)], dxfattribs={"layer": "COMMS-TELSTRA"})
    for s in (0, 120, 240, L):
        msp.add_blockref("PIT", p(s, 18.0), dxfattribs={"layer": "COMMS-TELSTRA", "rotation": BEARING_DEG - 90})
    msp.add_text(
        "TELSTRA 2x P50",
        height=1.2,
        dxfattribs={"layer": "UTIL-TEXT", "rotation": 90 - BEARING_DEG + 180, "insert": p(60, 19.5)},
    )

    # NBN, slightly further out
    msp.add_lwpolyline([p(s, 20.5) for s in (30, 200, 330)], dxfattribs={"layer": "COMMS-NBN"})

    # United Energy HV on the right with an arc deviation around a pole
    msp.add_lwpolyline(
        [(*p(0, -19.0), 0), (*p(140, -19.0), -0.5), (*p(180, -19.0), 0), (*p(L, -19.0), 0)],
        format="xyb",
        dxfattribs={"layer": "ELEC-HV-UE"},
    )
    msp.add_lwpolyline([p(s, -21.0) for s in (0, L)], dxfattribs={"layer": "ELEC-LV-UE"})
    for s in range(0, int(L) + 1, 45):
        msp.add_circle(p(s, -23.0), 0.25, dxfattribs={"layer": "ELEC-POLE"})

    # Gas main crossing the corridor (under-track crossing)
    msp.add_lwpolyline([p(95, 35), p(95, 5), p(100, -5), p(100, -35)], dxfattribs={"layer": "GAS-MULTINET"})
    msp.add_text(
        "GAS 150 PE",
        height=1.2,
        dxfattribs={"layer": "UTIL-TEXT", "rotation": 90 - BEARING_DEG + 90, "insert": p(96.5, 25)},
    )

    # Water main crossing with a curved bend
    msp.add_line(p(260, 35), p(260, 10), dxfattribs={"layer": "WATER-SEW"})
    msp.add_arc(
        center=p(270, 10),
        radius=10,
        start_angle=math.degrees(math.atan2(-N[1], -N[0])) - 90,
        end_angle=math.degrees(math.atan2(-N[1], -N[0])),
        dxfattribs={"layer": "WATER-SEW"},
    )
    msp.add_line(p(270, 0), p(270, -35), dxfattribs={"layer": "WATER-SEW"})
    mt = msp.add_mtext("DN300 DICL\\PWATER MAIN", dxfattribs={"layer": "UTIL-TEXT", "char_height": 1.0})
    mt.set_location(p(272, -28))

    # Sewer with manholes
    sew = [p(-10, 28), p(150, 28), p(330, 28)]
    msp.add_lwpolyline(sew, dxfattribs={"layer": "SEWER-SEW"})
    for pt in sew:
        msp.add_blockref("MANHOLE", pt, dxfattribs={"layer": "SEWER-SEW"})

    # Drainage spline
    msp.add_spline(
        [p(320, 40, 0), p(330, 20, 0), p(345, 0, 0), p(350, -20, 0), p(365, -40, 0)],
        dxfattribs={"layer": "DRAINAGE"},
    )

    doc.saveas(out_path)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/samples/sample-utility-survey.dxf")
