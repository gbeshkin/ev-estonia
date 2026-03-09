#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
OUT_FILE = DATA_DIR / "chargers.json"

OCM_URL = "https://api.openchargemap.io/v3/poi/"
COUNTRY_CODE = "EE"
MAX_RESULTS = 100000
TIMEOUT = 60

PRICE_RULES = {
    "enefit volt": {
        "AC": 0.37,
        "DC": 0.37,
        "HPC": 0.50,
    },
    "alexela": {
        "AC": 0.32,
        "DC": 0.39,
        "HPC": 0.49,
    },
    "eleport": {
        "AC": 0.29,
        "DC": 0.32,
        "HPC": 0.42,
    },
}


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    api_key = os.getenv("OCM_API_KEY", "ocm-demo")

    stations = fetch_ocm_estonia(api_key)
    normalized = [normalize_station(item) for item in stations]
    normalized = [item for item in normalized if item is not None]

    with OUT_FILE.open("w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(normalized)} stations to {OUT_FILE}")
    return 0


def fetch_ocm_estonia(api_key: str) -> List[Dict[str, Any]]:
    params = {
        "output": "json",
        "countrycode": COUNTRY_CODE,
        "maxresults": MAX_RESULTS,
        "compact": "true",
        "verbose": "false",
    }
    headers = {
        "X-API-Key": api_key,
        "User-Agent": "ev-estonia-site/1.0",
    }

    response = requests.get(OCM_URL, params=params, headers=headers, timeout=TIMEOUT)
    response.raise_for_status()

    data = response.json()
    if not isinstance(data, list):
        raise RuntimeError("Unexpected Open Charge Map response format")
    return data


def normalize_station(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    address_info = raw.get("AddressInfo") or {}
    connections = raw.get("Connections") or []
    operator_info = raw.get("OperatorInfo") or {}

    lat = address_info.get("Latitude")
    lng = address_info.get("Longitude")
    if lat is None or lng is None:
        return None

    operator = operator_info.get("Title") or "Other operator"
    city = first_non_empty(
        address_info.get("Town"),
        address_info.get("StateOrProvince"),
        address_info.get("AddressLine2"),
    )

    power_kw = best_power_kw(connections)
    power_type = classify_power_type(power_kw)
    price = infer_price(operator, power_type)

    return {
        "id": str(raw.get("ID") or build_id(operator, address_info.get("Title"), lat, lng)),
        "operator": operator,
        "station_name": address_info.get("Title") or f"{operator} station",
        "city": city,
        "address": build_address(address_info),
        "lat": lat,
        "lng": lng,
        "power_type": power_type,
        "power_kw": power_kw,
        "connectors": summarize_connectors(connections),
        "price_eur_kwh": price,
        "data_source": "Open Charge Map + public tariff rules",
    }


def first_non_empty(*values: Any) -> str:
    for value in values:
        if value:
            return str(value)
    return "Unknown"


def build_id(operator: str, title: Optional[str], lat: Any, lng: Any) -> str:
    base = f"{operator}-{title or 'station'}-{lat}-{lng}".lower()
    return "".join(ch if ch.isalnum() else "-" for ch in base)


def build_address(address_info: Dict[str, Any]) -> str:
    parts = [
        address_info.get("AddressLine1"),
        address_info.get("Town"),
        address_info.get("StateOrProvince"),
        address_info.get("Postcode"),
    ]
    return ", ".join(str(p) for p in parts if p)


def best_power_kw(connections: Iterable[Dict[str, Any]]) -> Optional[int]:
    values: List[float] = []
    for connection in connections:
        power = connection.get("PowerKW")
        if isinstance(power, (int, float)):
            values.append(float(power))
    if not values:
        return None
    return int(round(max(values)))


def classify_power_type(power_kw: Optional[int]) -> str:
    if power_kw is None:
        return "AC"
    if power_kw <= 22:
        return "AC"
    if power_kw <= 100:
        return "DC"
    return "HPC"


def summarize_connectors(connections: Iterable[Dict[str, Any]]) -> str:
    names = []
    for connection in connections:
        type_info = connection.get("ConnectionType") or {}
        title = type_info.get("Title")
        if title:
            names.append(str(title))
    unique = []
    seen = set()
    for name in names:
        if name not in seen:
            unique.append(name)
            seen.add(name)
    return ", ".join(unique[:4])


def infer_price(operator: str, power_type: str) -> Optional[float]:
    key = operator.strip().lower()
    rules = PRICE_RULES.get(key)
    if not rules:
        return None
    return rules.get(power_type)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except requests.HTTPError as exc:
        print(f"HTTP error: {exc}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:  # noqa: BLE001
        print(f"Failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
