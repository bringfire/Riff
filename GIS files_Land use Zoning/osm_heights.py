"""
osm_heights.py — give OSM building footprints plausible 3D massing.

THE PROBLEM
    This OSM extract has ZERO height data: no `height`, no `building:levels`,
    no `roof:height`. Checked, not assumed. So any third dimension here is
    INVENTED. Nothing below is a measurement.

THE APPROACH
    Rather than uniform random (which produces a visibly fake city), height is
    drawn from a band chosen by OSM `building` type, then nudged by footprint
    area for the 564 buildings tagged only `building=yes`. A 400 sq ft
    footprint is a house; a 40,000 sq ft one is not.

REPRODUCIBILITY
    The RNG is seeded per-building from the OSM way id, so the same building
    always gets the same height — on any machine, on any run. Re-running does
    not reshuffle the skyline, and a colleague sees the identical city.

AUDITABILITY
    Every extrusion carries user text: `height_ft`, `source=synthetic`, and
    `basis=<rule applied>`. When real height data arrives, query
    `source=synthetic` to find everything that needs replacing.

USAGE
    Run osm_to_rhino.py first (creates the 2D footprints), then this.
    Rhino 8 -> ScriptEditor -> New Python 3 -> paste -> Run.
"""

import random

import Rhino
import System.Drawing as SD

FOOTPRINT_LAYER = "OSM_Buildings"
MASSING_LAYER = "OSM_Buildings_3D"
MASSING_COLOR = (150, 145, 138)

# Height bands in FEET: (min, max). Derived from typical Detroit low-rise
# residential/industrial stock, not from the data.
BANDS = {
    "house":      (12.0, 28.0),
    "detached":   (12.0, 28.0),
    "garage":     ( 8.0, 12.0),
    "shed":       ( 7.0, 11.0),
    "roof":       (10.0, 16.0),
    "retail":     (14.0, 26.0),
    "industrial": (18.0, 40.0),
    "warehouse":  (24.0, 45.0),
    "school":     (24.0, 40.0),
}

# `building=yes` carries no type signal, so fall back to footprint area (sq ft).
AREA_BANDS = [
    (1500.0,   (12.0, 26.0), "yes/small-footprint"),
    (10000.0,  (16.0, 35.0), "yes/medium-footprint"),
    (float("inf"), (20.0, 45.0), "yes/large-footprint"),
]


def height_for(way_id, building_type, area_sqft):
    """Deterministic synthetic height in feet, plus the rule that produced it."""
    rng = random.Random("osm-height:%s" % way_id)   # seeded per building

    band = BANDS.get(building_type)
    if band is not None:
        basis = "type=%s" % building_type
    else:
        for cutoff, band, basis in AREA_BANDS:
            if area_sqft <= cutoff:
                break

    low, high = band
    # triangular favours the lower end — most stock is short, a few outliers tall
    return round(rng.triangular(low, high, low + (high - low) * 0.35), 1), basis


def run(doc):
    src = doc.Layers.FindName(FOOTPRINT_LAYER, 0)
    if src is None:
        raise RuntimeError("layer %r not found — run osm_to_rhino.py first" % FOOTPRINT_LAYER)

    dst = doc.Layers.FindName(MASSING_LAYER, 0)
    if dst is None:
        layer = Rhino.DocObjects.Layer()
        layer.Name = MASSING_LAYER
        layer.Color = SD.Color.FromArgb(*MASSING_COLOR)
        dst_index = doc.Layers.Add(layer)
    else:
        dst_index = dst.Index

    settings = Rhino.DocObjects.ObjectEnumeratorSettings()
    settings.DeletedObjects = False
    settings.HiddenObjects = True

    made, skipped, total_ft = 0, 0, 0.0
    heights = []

    for obj in doc.Objects.GetObjectList(settings):
        if obj.Attributes.LayerIndex != src.Index:
            continue
        curve = obj.Geometry
        if not isinstance(curve, Rhino.Geometry.Curve) or not curve.IsClosed:
            skipped += 1
            continue

        amp = Rhino.Geometry.AreaMassProperties.Compute(curve)
        area = amp.Area if amp else 0.0

        # object Name was set from the OSM `name` tag; type lives in user text
        btype = obj.Attributes.GetUserString("building_type") or "yes"
        way_id = obj.Attributes.GetUserString("osm_id") or str(obj.Id)

        h, basis = height_for(way_id, btype, area)

        # Extrusion.Create extrudes along the curve plane's NORMAL, and that
        # normal flips with winding direction. OSM ways come in both windings,
        # so without normalising, clockwise footprints extrude below ground.
        if curve.ClosedCurveOrientation(Rhino.Geometry.Vector3d.ZAxis) == \
                Rhino.Geometry.CurveOrientation.Clockwise:
            curve = curve.DuplicateCurve()
            curve.Reverse()

        ext = Rhino.Geometry.Extrusion.Create(curve, h, True)
        if ext is None:
            skipped += 1
            continue
        if ext.GetBoundingBox(True).Min.Z < -0.01:
            skipped += 1
            continue

        attrs = Rhino.DocObjects.ObjectAttributes()
        attrs.LayerIndex = dst_index
        if obj.Attributes.Name:
            attrs.Name = obj.Attributes.Name
        attrs.SetUserString("height_ft", str(h))
        attrs.SetUserString("source", "synthetic")
        attrs.SetUserString("basis", basis)
        attrs.SetUserString("building_type", btype)

        doc.Objects.AddExtrusion(ext, attrs)
        made += 1
        total_ft += h
        heights.append(h)

    doc.Views.Redraw()
    heights.sort()
    return {
        "made": made,
        "skipped": skipped,
        "mean_ft": round(total_ft / made, 1) if made else 0,
        "min_ft": heights[0] if heights else 0,
        "median_ft": heights[len(heights) // 2] if heights else 0,
        "max_ft": heights[-1] if heights else 0,
    }


if __name__ == "__main__":
    stats = run(__rhino_doc__)
    for k in ("made", "skipped", "min_ft", "median_ft", "mean_ft", "max_ft"):
        print("%-10s %s" % (k, stats[k]))
