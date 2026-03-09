import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import requests

BASE = "https://account.enefitvolt.com/stationFacade"
OUT_FILE = Path("data/chargers-enefit.json")
TIMEOUT = 30
SLEEP_SECONDS = 0.15

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json;charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://account.enefitvolt.com",
    "Referer": "https://account.enefitvolt.com/findCharger",
}

# Wide bounds that cover Estonia and nearby edge cases.
BOUNDS_PAYLOAD = {
    "filterByIsManaged": True,
    "filterByBounds": {
        "northEastLat": 60.75,
        "northEastLng": 35.34,
        "southWestLat": 55.78,
        "southWestLng": 14.26,
    },
}


def post_json(session: requests.Session, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    response = session.post(
        f"{BASE}/{path}",
        data=json.dumps(payload),
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    return response.json()



def get_json(session: requests.Session, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    response = session.get(
        f"{BASE}/{path}",
        params=params,
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    return response.json()



def unwrap_data_list(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    data = payload.get("data")
    if isinstance(data, list):
        for item in reversed(data):
            if isinstance(item, list):
                return item
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list):
                return value
    return []



def fetch_site_ids(session: requests.Session) -> List[int]:
    payload = post_json(session, "findSitesInBounds", BOUNDS_PAYLOAD)
    sites = unwrap_data_list(payload)
    ids: List[int] = []
    for site in sites:
        site_id = site.get("id")
        if isinstance(site_id, int):
            ids.append(site_id)
        elif isinstance(site_id, str) and site_id.isdigit():
            ids.append(int(site_id))
    return sorted(set(ids))



def fetch_station_ids_for_site(session: requests.Session, site_id: int) -> List[int]:
    payload = {
        "filterByIsManaged": True,
        "filterBySiteId": str(site_id),
    }
    response = post_json(session, "findStationsBySiteId", payload)
    stations = unwrap_data_list(response)
    ids: List[int] = []
    for station in stations:
        station_id = station.get("id")
        if isinstance(station_id, int):
            ids.append(station_id)
        elif isinstance(station_id, str) and station_id.isdigit():
            ids.append(int(station_id))
    return sorted(set(ids))



def safe_float(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return None
    return None



def map_power_type(power_kw: Optional[float]) -> str:
    if power_kw is None:
        return "AC"
    if power_kw > 50:
        return "HPC"
    if power_kw >= 25:
        return "DC"
    return "AC"



def pick_station_price(sockets: List[Dict[str, Any]]) -> Optional[float]:
    prices = [s["price_eur_kwh"] for s in sockets if isinstance(s.get("price_eur_kwh"), (int, float))]
    if not prices:
        return None
    return min(prices)



def transform_station_details(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not payload.get("success"):
        return None

    data = payload.get("data") or {}
    station_id = data.get("id")
    if station_id is None:
        return None

    sockets: List[Dict[str, Any]] = []
    socket_items = data.get("stationSockets") or []

    for socket in socket_items:
        prices = socket.get("socketPrices") or []
        kwh_price = None
        if prices and isinstance(prices[0], dict):
            kwh_price = safe_float(prices[0].get("kwhPrice"))

        max_power = safe_float(socket.get("maximumPower"))
        sockets.append(
            {
                "socket_name": socket.get("name") or "",
                "status_id": socket.get("socketStatusId"),
                "power_kw": max_power,
                "price_eur_kwh": kwh_price,
                "socket_type_id": socket.get("stationModelSocketSocketTypeId"),
                "voltage_type": socket.get("stationModelSocketVoltageType") or "",
            }
        )

    max_power_values = [s["power_kw"] for s in sockets if isinstance(s.get("power_kw"), (int, float))]
    station_power = max(max_power_values) if max_power_values else None
    station_price = pick_station_price(sockets)

    return {
        "operator": data.get("stationOwnerName") or "Enefit Volt",
        "operator_key": "enefit",
        "station_id": station_id,
        "site_id": data.get("siteId"),
        "station_name": data.get("siteDisplayName") or data.get("caption") or f"Station {station_id}",
        "caption": data.get("caption") or "",
        "city": data.get("addressCity") or "",
        "address": data.get("addressAddress1") or "",
        "zip": data.get("addressZipCode") or "",
        "lat": safe_float(data.get("latitude")),
        "lng": safe_float(data.get("longitude")),
        "status_id": data.get("stationStatusId"),
        "charging_speed_id": data.get("chargingSpeedId"),
        "power_type": map_power_type(station_power),
        "power_kw": station_power,
        "price_eur_kwh": station_price,
        "price_source": "live_station_api",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "sockets": sockets,
    }



def fetch_station_details(session: requests.Session, station_id: int) -> Optional[Dict[str, Any]]:
    payload = get_json(session, "findStationById", {"stationId": station_id})
    return transform_station_details(payload)



def main() -> None:
    session = requests.Session()
    session.headers.update(HEADERS)

    site_ids = fetch_site_ids(session)
    print(f"Sites found: {len(site_ids)}")

    station_ids: Set[int] = set()
    for index, site_id in enumerate(site_ids, start=1):
        ids = fetch_station_ids_for_site(session, site_id)
        station_ids.update(ids)
        if index % 25 == 0:
            print(f"Processed sites: {index}/{len(site_ids)} | stations so far: {len(station_ids)}")
        time.sleep(SLEEP_SECONDS)

    print(f"Unique station ids: {len(station_ids)}")

    stations: List[Dict[str, Any]] = []
    for index, station_id in enumerate(sorted(station_ids), start=1):
        try:
            station = fetch_station_details(session, station_id)
            if station:
                stations.append(station)
        except requests.RequestException as exc:
            print(f"Failed stationId={station_id}: {exc}")
        if index % 25 == 0:
            print(f"Fetched details: {index}/{len(station_ids)}")
        time.sleep(SLEEP_SECONDS)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(stations, ensure_ascii=False, indent=2), encoding="utf-8")

    priced = sum(1 for item in stations if isinstance(item.get("price_eur_kwh"), (int, float)))
    print(f"Saved {len(stations)} stations to {OUT_FILE}")
    print(f"Stations with live price: {priced}/{len(stations)}")


if __name__ == "__main__":
    main()
