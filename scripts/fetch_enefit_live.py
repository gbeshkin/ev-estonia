import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

BASE = "https://account.enefitvolt.com/stationFacade"
OUT_FILE = Path("data/chargers.json")


def env_required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def build_headers() -> Dict[str, str]:
    return {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json",
        "origin": "https://account.enefitvolt.com",
        "referer": os.getenv("ENEFIT_REFERER", "https://account.enefitvolt.com/findCharger"),
        "user-agent": os.getenv(
            "ENEFIT_USER_AGENT",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/144.0.0.0 Safari/537.36",
        ),
        "x-app-type": "WEB",
        "x-csrf-token": env_required("ENEFIT_CSRF_TOKEN"),
        "x-json-types": "None",
        "x-requested-with": "XMLHttpRequest",
    }


def build_cookies() -> Dict[str, str]:
    return {
        "CookieConsent": os.getenv("ENEFIT_COOKIECONSENT", ""),
        "JSESSIONID": env_required("ENEFIT_JSESSIONID"),
    }


def post_sites(session: requests.Session) -> List[Dict[str, Any]]:
    payload = {
        "filterByIsManaged": True,
        "filterByBounds": {
            "northEastLat": float(os.getenv("ENEFIT_NE_LAT", "59.992055582206284")),
            "northEastLng": float(os.getenv("ENEFIT_NE_LNG", "36.90604928286816")),
            "southWestLat": float(os.getenv("ENEFIT_SW_LAT", "57.98910906186832")),
            "southWestLng": float(os.getenv("ENEFIT_SW_LNG", "15.812299282868159")),
        },
    }
    r = session.post(f"{BASE}/findSitesInBounds", json=payload, timeout=45)
    r.raise_for_status()
    payload = r.json()
    data = payload.get("data", [])
    if not isinstance(data, list):
        return []
    return data


def get_station(session: requests.Session, station_id: int) -> Optional[Dict[str, Any]]:
    r = session.get(f"{BASE}/findStationById", params={"stationId": station_id}, timeout=45)
    r.raise_for_status()
    payload = r.json()
    data = payload.get("data")
    return data if isinstance(data, dict) else None


def extract_socket_price(socket_obj: Dict[str, Any]) -> Optional[float]:
    values: List[float] = []
    for item in socket_obj.get("socketPrices", []) or []:
        value = item.get("kwhPrice")
        if isinstance(value, (int, float)):
            values.append(float(value))
    return min(values) if values else None


def extract_station_price(sockets: List[Dict[str, Any]]) -> Optional[float]:
    values: List[float] = []
    for socket_obj in sockets:
        value = extract_socket_price(socket_obj)
        if isinstance(value, (int, float)):
            values.append(value)
    return min(values) if values else None


def extract_max_power(sockets: List[Dict[str, Any]]) -> Optional[float]:
    values: List[float] = []
    for socket_obj in sockets:
        value = socket_obj.get("maximumPower")
        if isinstance(value, (int, float)):
            values.append(float(value))
    return max(values) if values else None


def power_type_from_kw(power_kw: Optional[float], fallback_speed: str = "") -> str:
    if isinstance(power_kw, (int, float)):
        if power_kw > 50:
            return "HPC"
        if power_kw >= 25:
            return "DC"
        return "AC"
    speed = (fallback_speed or "").upper()
    if "ULTRA" in speed:
        return "HPC"
    if "FAST" in speed:
        return "DC"
    return "AC"


def normalize_station(site: Dict[str, Any], detail: Dict[str, Any]) -> Dict[str, Any]:
    sockets = detail.get("stationSockets") or []
    max_power = extract_max_power(sockets)
    price = extract_station_price(sockets)
    city = detail.get("addressCity") or ""
    address_parts = [detail.get("addressAddress1") or "", detail.get("addressZipCode") or "", city]
    address = ", ".join(part for part in address_parts if part)

    socket_items = []
    for socket_obj in sockets:
        socket_items.append(
            {
                "name": socket_obj.get("name"),
                "maximum_power": socket_obj.get("maximumPower"),
                "status_id": socket_obj.get("socketStatusId"),
                "price_eur_kwh": extract_socket_price(socket_obj),
            }
        )

    return {
        "station_id": detail.get("id") or site.get("id"),
        "site_id": detail.get("siteId") or site.get("siteId") or site.get("id"),
        "operator": "Enefit Volt",
        "station_name": detail.get("siteDisplayName") or detail.get("caption") or site.get("dn") or "Unnamed station",
        "city": city,
        "address": address,
        "lat": detail.get("latitude") or site.get("latitude"),
        "lng": detail.get("longitude") or site.get("longitude"),
        "speed": site.get("scs") or "",
        "power_type": power_type_from_kw(max_power, site.get("scs") or ""),
        "power_kw": max_power,
        "price_eur_kwh": price,
        "price_source": "live_station_api",
        "status_id": detail.get("stationStatusId") or site.get("ss"),
        "sockets": socket_items,
    }


def main() -> None:
    session = requests.Session()
    session.headers.update(build_headers())
    session.cookies.update(build_cookies())

    sites = post_sites(session)
    print(f"Sites found: {len(sites)}")

    chargers: List[Dict[str, Any]] = []

    for idx, site in enumerate(sites, start=1):
        station_id = site.get("id")
        if not station_id:
            continue
        try:
            detail = get_station(session, int(station_id))
            if not detail:
                print(f"[{idx}/{len(sites)}] station {station_id}: no detail data")
                continue
            charger = normalize_station(site, detail)
            chargers.append(charger)
            print(f"[{idx}/{len(sites)}] {charger['station_name']} | {charger.get('price_eur_kwh')}")
        except requests.HTTPError as e:
            print(f"[{idx}/{len(sites)}] station {station_id}: HTTP error {e}")
        except Exception as e:
            print(f"[{idx}/{len(sites)}] station {station_id}: error {e}")
        time.sleep(0.15)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(chargers, ensure_ascii=False, indent=2), encoding="utf-8")

    priced = sum(1 for x in chargers if isinstance(x.get("price_eur_kwh"), (int, float)))
    print(f"Saved {len(chargers)} stations to {OUT_FILE}")
    print(f"Stations with price: {priced}")


if __name__ == "__main__":
    main()
