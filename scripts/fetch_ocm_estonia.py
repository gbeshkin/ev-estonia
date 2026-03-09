import os
import json
import requests
from pathlib import Path

API_URL = "https://api.openchargemap.io/v3/poi/"
OUT_FILE = Path("data/chargers.json")

def fetch_ocm_estonia():
    api_key = os.getenv("OCM_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OCM_API_KEY is not set")

    params = {
        "output": "json",
        "countrycode": "EE",
        "maxresults": 5000,
        "compact": "true",
        "verbose": "false",
    }

    headers = {
        "X-API-Key": api_key,
        "User-Agent": "ev-estonia-site/1.0 (GitHub Actions)",
        "Accept": "application/json",
    }

    resp = requests.get(API_URL, params=params, headers=headers, timeout=60)
    resp.raise_for_status()
    return resp.json()

def map_power_type(power_kw: float | None) -> str:
    if power_kw is None:
        return "AC"
    if power_kw >= 100:
        return "HPC"
    if power_kw >= 25:
        return "DC"
    return "AC"

def pick_price(operator: str, power_kw: float | None) -> float | None:
    name = (operator or "").lower()

    if "enefit" in name:
        return 0.47 if (power_kw or 0) > 100 else 0.33
    if "alexela" in name:
        if (power_kw or 0) >= 300:
            return 0.59
        if (power_kw or 0) >= 100:
            return 0.49
        if (power_kw or 0) >= 25:
            return 0.39
        return 0.32
    if "eleport" in name:
        if (power_kw or 0) >= 100:
            return 0.42
        if (power_kw or 0) >= 25:
            return 0.32
        return 0.29

    return None

def transform(items):
    result = []

    for item in items:
        addr = item.get("AddressInfo") or {}
        connections = item.get("Connections") or []

        power_values = []
        for c in connections:
            p = c.get("PowerKW")
            if isinstance(p, (int, float)):
                power_values.append(float(p))

        max_power = max(power_values) if power_values else None
        operator = (
            (item.get("OperatorInfo") or {}).get("Title")
            or item.get("DataProvider")
            or "Unknown"
        )

        result.append({
            "operator": operator,
            "station_name": addr.get("Title") or "Unnamed station",
            "city": addr.get("Town") or addr.get("StateOrProvince") or "",
            "address": addr.get("AddressLine1") or "",
            "lat": addr.get("Latitude"),
            "lng": addr.get("Longitude"),
            "power_type": map_power_type(max_power),
            "power_kw": max_power,
            "price_eur_kwh": pick_price(operator, max_power),
        })

    return result

def main():
    items = fetch_ocm_estonia()
    stations = transform(items)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(
        json.dumps(stations, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print(f"Saved {len(stations)} stations to {OUT_FILE}")

if __name__ == "__main__":
    main()
