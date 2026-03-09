import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

API_URL = "https://api.openchargemap.io/v3/poi/"
OUT_FILE = Path("data/chargers.json")
TARIFFS_FILE = Path("data/tariffs.json")


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

    response = requests.get(API_URL, params=params, headers=headers, timeout=90)
    response.raise_for_status()
    return response.json()


def load_tariffs():
    return json.loads(TARIFFS_FILE.read_text(encoding="utf-8"))


def normalize_text(value: str) -> str:
    return (value or "").strip().lower()


def normalize_operator(value: str) -> str:
    text = normalize_text(value)
    if "enefit" in text or "volt" in text:
        return "enefit"
    if "eleport" in text:
        return "eleport"
    if "alexela" in text:
        return "alexela"
    return text


def map_power_type(power_kw):
    if power_kw is None:
        return "AC"
    if power_kw > 50:
        return "HPC"
    if power_kw >= 25:
        return "DC"
    return "AC"


def get_session_mode():
    return os.getenv("SESSION_MODE", "day").strip().lower()


def get_user_type():
    return os.getenv("USER_TYPE", "registered").strip().lower()


def find_eleport_override(overrides, station_name: str, address: str, city: str):
    haystack = " ".join([station_name or "", address or "", city or ""]).lower()
    for item in overrides:
        if item["match"] in haystack:
            return item["price"]
    return None


def match_rule(rules, power_kw):
    kw = power_kw or 0
    for rule in rules:
        min_kw = rule.get("power_min_kw", float("-inf"))
        max_kw = rule.get("power_max_kw", float("inf"))
        if min_kw <= kw <= max_kw:
            return rule
    return None


def pick_price(tariffs, operator_key, station_name, address, city, power_kw):
    tariff = tariffs["tariffs"].get(operator_key)
    if not tariff:
        return None, None

    rule = match_rule(tariff.get("rules", []), power_kw)
    if not rule:
        return None, None

    session_mode = get_session_mode()
    user_type = get_user_type()

    if operator_key == "enefit":
        if user_type == "guest":
            return rule.get("guest"), "official_operator_tariff"
        if session_mode == "night":
            return rule.get("registered_night"), "official_operator_tariff"
        return rule.get("registered_day"), "official_operator_tariff"

    if operator_key == "eleport":
        override_price = find_eleport_override(
            tariff.get("station_overrides", []),
            station_name,
            address,
            city,
        )
        if override_price is not None:
            return override_price, "official_operator_tariff_override"
        return rule.get("default"), "official_operator_tariff"

    if operator_key == "alexela":
        return rule.get("default"), "official_operator_tariff_dynamic_estimate"

    return rule.get("default"), "official_operator_tariff"


def transform(items, tariffs):
    result = []

    for item in items:
        addr = item.get("AddressInfo") or {}
        connections = item.get("Connections") or []

        power_values = []
        for connection in connections:
            power = connection.get("PowerKW")
            if isinstance(power, (int, float)):
                power_values.append(float(power))

        max_power = max(power_values) if power_values else None

        operator_title = ((item.get("OperatorInfo") or {}).get("Title") or "").strip()
        station_name = addr.get("Title") or "Unnamed station"
        address = addr.get("AddressLine1") or ""
        city = addr.get("Town") or addr.get("StateOrProvince") or ""

        operator_key = normalize_operator(operator_title)
        price, price_source = pick_price(
            tariffs,
            operator_key,
            station_name,
            address,
            city,
            max_power,
        )

        result.append(
            {
                "operator": operator_title or "Unknown",
                "operator_key": operator_key or "unknown",
                "station_name": station_name,
                "city": city,
                "address": address,
                "lat": addr.get("Latitude"),
                "lng": addr.get("Longitude"),
                "power_type": map_power_type(max_power),
                "power_kw": max_power,
                "price_eur_kwh": price,
                "price_source": price_source,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        )

    return result


def main():
    tariffs = load_tariffs()
    items = fetch_ocm_estonia()
    stations = transform(items, tariffs)

    operators = sorted({(s.get("operator") or "").strip() for s in stations if s.get("operator")})
    print("Operators found:")
    for operator in operators[:200]:
        print("-", operator)

    total = len(stations)
    priced = sum(1 for s in stations if s.get("price_eur_kwh") is not None)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(stations, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Saved {total} stations to {OUT_FILE}")
    print(f"Stations with price: {priced}/{total}")


if __name__ == "__main__":
    main()
