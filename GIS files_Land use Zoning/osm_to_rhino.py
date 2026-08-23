"""
osm_to_rhino.py — import an OpenStreetMap .osm extract into Rhino as
categorised, georeferenced curves.

WHY THIS EXISTS
    Elk 2 reads .osm files but emits raw point trees in its own local frame.
    This script instead projects OSM lat/long into ESRI:102690 (NAD83 /
    StatePlane Michigan South FIPS 2113, US survey feet) so the result lands
    in the SAME coordinate frame as Detroit GPKG/QGIS data (zoning, land use).
    That is what lets OSM context and GIS parcel data overlay without a
    post-hoc transform.

HOW TO RUN
    Rhino 8 : ScriptEditor  ->  New Python 3  ->  paste  ->  Run
    Grasshopper : Python 3 component. Delete the `__rhino_doc__` line below and
              use `scriptcontext.doc` instead, or keep baking as-is.

REQUIREMENTS
    Rhino 8. No external packages — stdlib + RhinoCommon only.
    Get an .osm extract for your site from openstreetmap.org (Export tab) or:
    https://api.openstreetmap.org/api/0.6/map?bbox=<W>,<S>,<E>,<N>

NOTE ON EXTENTS
    The OSM API returns COMPLETE ways that cross your bbox, so long streets
    drag in nodes far outside the site. Expect geometry beyond your study
    area; the OSM_Other layer collects the worst offenders.
"""

import math
import xml.etree.ElementTree as ET

import Rhino
import System.Drawing as SD

# ---------------------------------------------------------------- config ---

OSM_FILE = r"C:\Users\pearl\Downloads\Riff\GIS files_Land use Zoning\detroit_study_area.osm"

# Recentring origin, in EPSG:102690 feet. Rhino's tolerance degrades badly at
# 13,000,000 units from origin, so we subtract the study-area centroid and
# model near 0,0. Keep this value — it is the offset back to true StatePlane.
ORIGIN_X = 13481400.425
ORIGIN_Y = 344364.485

LAYERS = [
    ("OSM_Buildings", (120, 120, 130)),
    ("OSM_Roads",     ( 40,  40,  40)),
    ("OSM_Landuse",   ( 90, 150,  90)),
    ("OSM_Water",     ( 70, 130, 190)),
    ("OSM_Other",     (190, 190, 190)),
]

# ------------------------------------------- ESRI:102690 forward transform ---
# Lambert Conformal Conic, 2 standard parallels, GRS80 / NAD83.

_A = 6378137.0
_F = 1.0 / 298.257222101
_E = math.sqrt(2 * _F - _F * _F)
_SURVEY_FT = 1200.0 / 3937.0

_LAT1 = math.radians(42.0 + 6.0 / 60.0)     # first standard parallel
_LAT2 = math.radians(43.0 + 40.0 / 60.0)    # second standard parallel
_LAT0 = math.radians(41.5)                  # latitude of origin
_LON0 = math.radians(-(84.0 + 22.0 / 60.0)) # central meridian
_FE = 4000000.0                             # false easting, metres
_FN = 0.0


def _m(phi):
    return math.cos(phi) / math.sqrt(1.0 - _E * _E * math.sin(phi) ** 2)


def _t(phi):
    s = _E * math.sin(phi)
    return math.tan(math.pi / 4.0 - phi / 2.0) / ((1.0 - s) / (1.0 + s)) ** (_E / 2.0)


_N = (math.log(_m(_LAT1)) - math.log(_m(_LAT2))) / (math.log(_t(_LAT1)) - math.log(_t(_LAT2)))
_BIGF = _m(_LAT1) / (_N * _t(_LAT1) ** _N)
_RHO0 = _A * _BIGF * _t(_LAT0) ** _N


def project(lat, lon):
    """WGS84 degrees -> EPSG:102690 US survey feet."""
    phi = math.radians(lat)
    lam = math.radians(lon)
    rho = _A * _BIGF * _t(phi) ** _N
    theta = _N * (lam - _LON0)
    x = (_FE + rho * math.sin(theta)) / _SURVEY_FT
    y = (_FN + _RHO0 - rho * math.cos(theta)) / _SURVEY_FT
    return x, y


# ------------------------------------------------------------ classifier ---

def classify(tags):
    """Map an OSM tag dict to a target layer name."""
    if "building" in tags or "building:part" in tags:
        return "OSM_Buildings"
    if "highway" in tags:
        return "OSM_Roads"
    if tags.get("natural") == "water" or "waterway" in tags:
        return "OSM_Water"
    if "landuse" in tags or "leisure" in tags or "amenity" in tags:
        return "OSM_Landuse"
    return "OSM_Other"


# ------------------------------------------------------------------ main ---

def ensure_layers(doc):
    index = {}
    for name, rgb in LAYERS:
        existing = doc.Layers.FindName(name, 0)
        if existing is not None:
            index[name] = existing.Index
            continue
        layer = Rhino.DocObjects.Layer()
        layer.Name = name
        layer.Color = SD.Color.FromArgb(*rgb)
        index[name] = doc.Layers.Add(layer)
    return index


def run(doc, osm_file=OSM_FILE):
    root = ET.parse(osm_file).getroot()

    nodes = {}
    for nd in root.findall("node"):
        x, y = project(float(nd.get("lat")), float(nd.get("lon")))
        nodes[nd.get("id")] = (x - ORIGIN_X, y - ORIGIN_Y)

    layer_index = ensure_layers(doc)
    counts = {}

    for way in root.findall("way"):
        pts = [nodes[r.get("ref")] for r in way.findall("nd") if r.get("ref") in nodes]
        if len(pts) < 2:
            continue

        tags = {t.get("k"): t.get("v") for t in way.findall("tag")}
        target = classify(tags)

        polyline = Rhino.Geometry.Polyline(
            [Rhino.Geometry.Point3d(px, py, 0.0) for px, py in pts]
        )

        attrs = Rhino.DocObjects.ObjectAttributes()
        attrs.LayerIndex = layer_index[target]
        if tags.get("name"):
            attrs.Name = tags["name"]

        # Carry provenance through to the object so downstream steps (e.g.
        # osm_heights.py) can key off it. osm_id in particular is what makes
        # synthetic heights reproducible — a GUID would change every run.
        attrs.SetUserString("osm_id", way.get("id") or "")
        if target == "OSM_Buildings":
            attrs.SetUserString("building_type", tags.get("building") or "yes")
        if tags.get("highway"):
            attrs.SetUserString("highway", tags["highway"])
        if tags.get("landuse"):
            attrs.SetUserString("landuse", tags["landuse"])

        doc.Objects.AddPolyline(polyline, attrs)
        counts[target] = counts.get(target, 0) + 1

    doc.Views.Redraw()
    return counts


if __name__ == "__main__":
    _doc = __rhino_doc__          # Rhino ScriptEditor / MCP injects this
    _counts = run(_doc)
    for _layer in sorted(_counts):
        print("%-16s %d" % (_layer, _counts[_layer]))
    print("total curves:", sum(_counts.values()))
