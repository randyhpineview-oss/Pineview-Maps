from __future__ import annotations

import io
import json
import math
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Iterable

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _find_text(element: ET.Element, path: str) -> str | None:
    found = element.find(path, KML_NS)
    if found is None or found.text is None:
        return None
    return _clean(found.text)


def _parse_extended_data(placemark: ET.Element) -> dict[str, str]:
    results: dict[str, str] = {}
    for data_node in placemark.findall("kml:ExtendedData/kml:Data", KML_NS):
        name = data_node.attrib.get("name", "")
        value = _find_text(data_node, "kml:value")
        if name and value:
            results[name.strip().lower()] = value
    for simple_data in placemark.findall(".//kml:SchemaData/kml:SimpleData", KML_NS):
        name = simple_data.attrib.get("name", "")
        value = _clean(simple_data.text)
        if name and value:
            results[name.strip().lower()] = value
    return results


def _pick_value(data: dict[str, str], keys: Iterable[str]) -> str | None:
    for key in keys:
        if key.lower() in data and data[key.lower()]:
            return data[key.lower()]
    return None


def _parse_description_fields(description: str | None) -> dict[str, str]:
    if not description:
        return {}
    results: dict[str, str] = {}
    for raw_line in description.splitlines():
        line = raw_line.strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        cleaned_key = _clean(key)
        cleaned_value = _clean(value)
        if cleaned_key and cleaned_value:
            results[cleaned_key.lower()] = cleaned_value
    return results


def _iter_placemarks(element: ET.Element, folder_path: tuple[str, ...] = ()) -> Iterable[tuple[ET.Element, tuple[str, ...]]]:
    for child in element:
        tag_name = child.tag.rsplit("}", 1)[-1]
        if tag_name == "Folder":
            folder_name = _find_text(child, "kml:name")
            next_path = folder_path + ((folder_name,) if folder_name else ())
            yield from _iter_placemarks(child, next_path)
        elif tag_name == "Placemark":
            yield child, folder_path
        else:
            yield from _iter_placemarks(child, folder_path)


def _parse_coordinates_text(text: str) -> list[list[float]]:
    """Parse KML coordinate string into [[lat, lng], ...] pairs."""
    coords = []
    for chunk in text.strip().split():
        parts = [p.strip() for p in chunk.split(",") if p.strip()]
        if len(parts) >= 2:
            lng = float(parts[0])
            lat = float(parts[1])
            coords.append([lat, lng])
    return coords


def _extract_linestrings(placemark: ET.Element) -> list[list[list[float]]]:
    """Extract all LineString coordinate arrays from a placemark."""
    lines = []
    # Direct LineString
    for ls in placemark.findall(".//kml:LineString/kml:coordinates", KML_NS):
        if ls.text:
            coords = _parse_coordinates_text(ls.text)
            if len(coords) >= 2:
                lines.append(coords)
    return lines


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calculate distance between two lat/lng points in kilometers."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _total_length_km(coords: list[list[float]]) -> float:
    """Calculate total polyline length in km."""
    total = 0.0
    for i in range(1, len(coords)):
        total += _haversine_km(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
    return round(total, 3)


def _perpendicular_distance(point: list[float], line_start: list[float], line_end: list[float]) -> float:
    """Calculate perpendicular distance from point to line segment (in degrees, approximate)."""
    dx = line_end[0] - line_start[0]
    dy = line_end[1] - line_start[1]
    if dx == 0 and dy == 0:
        return math.sqrt((point[0] - line_start[0]) ** 2 + (point[1] - line_start[1]) ** 2)
    t = max(0, min(1, ((point[0] - line_start[0]) * dx + (point[1] - line_start[1]) * dy) / (dx * dx + dy * dy)))
    proj_x = line_start[0] + t * dx
    proj_y = line_start[1] + t * dy
    return math.sqrt((point[0] - proj_x) ** 2 + (point[1] - proj_y) ** 2)


def _douglas_peucker(coords: list[list[float]], tolerance: float) -> list[list[float]]:
    """Simplify a polyline using the Douglas-Peucker algorithm."""
    if len(coords) <= 2:
        return coords

    max_dist = 0.0
    max_idx = 0
    for i in range(1, len(coords) - 1):
        dist = _perpendicular_distance(coords[i], coords[0], coords[-1])
        if dist > max_dist:
            max_dist = dist
            max_idx = i

    if max_dist > tolerance:
        left = _douglas_peucker(coords[: max_idx + 1], tolerance)
        right = _douglas_peucker(coords[max_idx:], tolerance)
        return left[:-1] + right
    else:
        return [coords[0], coords[-1]]


def simplify_coordinates(coords: list[list[float]], tolerance: float = 0.00005) -> list[list[float]]:
    """Simplify coordinates using Douglas-Peucker. Tolerance in degrees (~5m at equator)."""
    if len(coords) <= 2:
        return coords
    simplified = _douglas_peucker(coords, tolerance)
    # Round to 6 decimal places
    return [[round(c[0], 6), round(c[1], 6)] for c in simplified]


def _extract_kml_bytes(contents: bytes) -> bytes:
    """If contents is a KMZ (zip), extract the .kml file inside. Otherwise return as-is."""
    if contents[:4] == b'PK\x03\x04':
        # It's a zip/KMZ file
        with zipfile.ZipFile(io.BytesIO(contents)) as zf:
            for name in zf.namelist():
                if name.lower().endswith('.kml'):
                    return zf.read(name)
            raise ValueError("KMZ file does not contain a .kml file")
    return contents


def parse_pipeline_kml(contents: bytes, source_name: str) -> list[dict]:
    """Parse a KML/KMZ file and extract pipeline LineStrings."""
    kml_bytes = _extract_kml_bytes(contents)
    root = ET.fromstring(kml_bytes)
    imported_pipelines: list[dict] = []

    for placemark, folder_path in _iter_placemarks(root):
        linestrings = _extract_linestrings(placemark)
        if not linestrings:
            continue

        extended_data = _parse_extended_data(placemark)
        name = _find_text(placemark, "kml:name")
        description = _find_text(placemark, "kml:description")
        description_fields = _parse_description_fields(description)

        folder_client = folder_path[0] if len(folder_path) >= 1 else None
        folder_area = folder_path[1] if len(folder_path) >= 2 else None

        client = (
            _pick_value(extended_data, ["client", "company", "customer", "operator"])
            or folder_client
            or _pick_value(description_fields, ["client", "company", "customer", "operator"])
        )
        area = (
            _pick_value(extended_data, ["area", "region", "field"])
            or folder_area
            or _pick_value(description_fields, ["area", "region", "field"])
        )

        raw_metadata = dict(extended_data)
        if description_fields:
            raw_metadata["description_fields"] = description_fields
        if folder_path:
            raw_metadata["folder_path"] = list(folder_path)

        # Handle multiple linestrings in one placemark (merge them)
        for idx, raw_coords in enumerate(linestrings):
            original_count = len(raw_coords)
            simplified = simplify_coordinates(raw_coords)
            length_km = _total_length_km(raw_coords)

            pipeline_name = name
            if len(linestrings) > 1 and name:
                pipeline_name = f"{name} (segment {idx + 1})"

            imported_pipelines.append({
                "name": pipeline_name,
                "client": client,
                "area": area,
                "coordinates": simplified,
                "original_point_count": original_count,
                "simplified_point_count": len(simplified),
                "total_length_km": length_km,
                "source": "imported",
                "source_name": source_name,
                "metadata": json.dumps(raw_metadata, ensure_ascii=False) if raw_metadata else None,
            })

    return imported_pipelines
