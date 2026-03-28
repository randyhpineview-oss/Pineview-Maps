from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from collections.abc import Iterable

from app.models import PinType, SiteStatus


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


def _parse_style_hierarchy(style_url: str | None) -> tuple[str | None, str | None]:
    if not style_url:
        return None, None

    style_name = style_url.strip().lstrip("#")
    match = re.match(r"style_(.+?)__(.+)", style_name)
    if not match:
        return None, None

    client = _clean(match.group(1).replace("_", " "))
    area = _clean(match.group(2).replace("_", " "))
    return client, area


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


def parse_kml_file(contents: bytes, source_name: str) -> list[dict]:
    root = ET.fromstring(contents)
    imported_sites: list[dict] = []

    for placemark, folder_path in _iter_placemarks(root):
        coordinates_text = _find_text(placemark, ".//kml:Point/kml:coordinates")
        if not coordinates_text:
            continue

        parts = [part.strip() for part in coordinates_text.split(",") if part.strip()]
        if len(parts) < 2:
            continue

        longitude = float(parts[0])
        latitude = float(parts[1])

        extended_data = _parse_extended_data(placemark)
        name = _find_text(placemark, "kml:name")
        description = _find_text(placemark, "kml:description")
        description_fields = _parse_description_fields(description)
        style_client, style_area = _parse_style_hierarchy(_find_text(placemark, "kml:styleUrl"))
        folder_client = folder_path[0] if len(folder_path) >= 1 else None
        folder_area = folder_path[1] if len(folder_path) >= 2 else None

        raw_attributes = dict(extended_data)
        if description_fields:
            raw_attributes["description_fields"] = description_fields
        if folder_path:
            raw_attributes["folder_path"] = list(folder_path)

        imported_sites.append(
            {
                "pin_type": PinType.lsd,
                "lsd": _pick_value(extended_data, ["lsd", "location", "site", "lease", "lease_name"]) or name,
                "client": _pick_value(extended_data, ["client", "company", "customer"])
                or folder_client
                or _pick_value(description_fields, ["company", "client", "customer"])
                or style_client,
                "area": _pick_value(extended_data, ["area", "region", "field"])
                or folder_area
                or _pick_value(description_fields, ["area", "region", "field"])
                or style_area,
                "latitude": latitude,
                "longitude": longitude,
                "gate_code": _pick_value(extended_data, ["gate_code", "gate", "gatecode"]),
                "phone_number": _pick_value(extended_data, ["phone", "phone_number", "contact_phone"]),
                "notes": description or _pick_value(extended_data, ["notes", "note", "comments"]),
                "source": "imported",
                "source_name": source_name,
                "status": SiteStatus.not_inspected,
                "raw_attributes": json.dumps(raw_attributes, ensure_ascii=False) if raw_attributes else None,
            }
        )

    return imported_sites
