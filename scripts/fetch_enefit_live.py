import os
import json
import time
import requests
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE = "https://account.enefitvolt.com/stationFacade"
OUT_FILE = Path("data/chargers.json")

HEADERS = {
    "User-Agent": os.getenv(
        "ENEFIT_USER_AGENT",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/144.0.0.0 Safari/537.36",
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json;charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://account.enefitvolt.com",
    "Referer": os.getenv(
        "ENEFIT_REFERER",
        "https://account.enefitvolt.com/findCharger?lang=en",
    ),
}

csrf = os.getenv("ENEFIT_CSRF_TOKEN", "").strip()
cookie = os.getenv("ENEFIT_COOKIE", "").strip()

if csrf:
    HEADERS["x-csrf-token"] = csrf

if cookie:
    HEADERS["Cookie"] = cookie


def build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(HEADERS)
    return session


def post_json(session: requests.Session, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    url = f"{BASE}/{path}"
    response = session.post(
        url,
        data=json.dumps(payload),
        timeout=45,
    )
    response.raise_for_status()
    return response.json()


def get_json(
    session: requests.Session,
    path: str,
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    url = f"{BASE}/{path}"
    response = session.get(
        url,
        params=params,
        timeout=45,
    )
    response.raise_for_status()
    return response.json()


def safe_list_data(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    data = payload.get("data")
    if isinstance(data, list):
        if len(data) > 1 and isinstance(data[1], list):
            return data[1]
        if len(data) > 0 and isinstance(data[0], list):
            return data[0]
    if isinstance(data, list):
        return data
    return []


def safe_object_data(payload: Dict[str, Any]) -> Dict[str, Any]:
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                return item
    return {}


def find_sites_in_bounds(session: requests.Session) -> List[Dict[str, Any]]:
    payload = {
        "filterByIsManaged": True,
        "filterByBounds": {
            "northEastLat": 59.90,
            "northEastLng": 28.30,
            "southWestLat": 57.45,
            "southWestLng": 21.70,
        },
    }

    result = post_json(session, "findSitesInBounds", payload)
    return safe_list_data(result)


def find_stations_by_site_id(session: requests.Session, site_id: str) -> List[Dict[str, Any]]:
    payload = {
        "filterByIsManaged": True,
        "filterBySiteId": str(site_id),
    }

    result = post_json(session, "findStationsBySiteId", payload)
    return safe_list_data(result)


def find_station_by_id(session: requests.Session, station_id: str) -> Dict[str, Any]:
    result = get_json(session, "findStationById", {"stationId": str(station_id)})
    return safe_object_data(result)


def extract_socket_price(socket_obj: Dict[str, Any]) -> Optional[float]:
    prices = socket_obj.get("socketPrices") or []
    values: List[float] = []

    for price_item in prices:
        value = price_item.get("kwhPrice")
        if isinstance(value, (int, float)):
            values.append(float(value))

    if not values:
        return None

    return min(values)


def extract_station_price(sockets: List[Dict[str, Any]]) -> Optional[float]:
    values: List[float] = []

    for socket_obj in sockets:
        value = extract_socket_price(socket_obj)
        if isinstance(value, (int, float)):
            values.append(float(value))

    if not values:
        return None

    return min(values)


def extract_max_power(sockets: List[Dict[str, Any]]) -> Optional[float]:
    values: List[float] = []

    for socket_obj in sockets:
        value = socket_obj.get("maximumPower")
        if isinstance(value, (int, float)):
            values.append(float(value))

    if not values:
        return None

    return max(values)


def power_type_from_kw(power_kw: Optional[float]) -> str:
    if power_kw is None:
        return "AC"
    if power_kw > 50:
        return "HPC"
    if power_kw >= 25:
        return "DC"
    return "AC"


def normalize_station(detail: Dict[str, Any]) -> Dict[str, Any]:
    sockets = detail.get("stationSockets") or []
    price = extract_station_price(sockets)
    max_power = extract_max_power(sockets)

    address_parts = [
        detail.get("addressAddress1") or "",
        detail.get("addressZipCode") or "",
        detail.get("addressCity") or "",
    ]
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
        "station_id": detail.get("id"),
        "operator": "Enefit Volt",
        "station_name": detail.get("siteDisplayName") or detail.get("caption") or "Unnamed station",
        "city": detail.get("addressCity") or "",
        "address": address,
        "lat": detail.get("latitude"),
        "lng": detail.get("longitude"),
        "power_type": power_type_from_kw(max_power),
        "power_kw": max_power,
        "price_eur_kwh": price,
        "price_source": "live_station_api",
        "status_id": detail.get("stationStatusId"),
        "owner": detail.get("stationOwnerName"),
        "site_id": detail.get("siteId"),
        "sockets": socket_items,
    }


def dedupe_stations(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    result = []

    for item in items:
        key = item.get("station_id")
        if key in seen:
            continue
        seen.add(key)
        result.append(item)

    return result


def main() -> None:
    session = build_session()

    try:
        sites = find_sites_in_bounds(session)
        print(f"Sites found: {len(sites)}")
    except requests.HTTPError as e:
        print(f"HTTP error in findSitesInBounds: {e}")
        raise
    except Exception as e:
        print(f"Unexpected error in findSitesInBounds: {e}")
        raise

    all_station_ids: List[str] = []

    for idx, site in enumerate(sites, start=1):
        site_id = site.get("id")
        if not site_id:
            continue

        try:
            stations = find_stations_by_site_id(session, str(site_id))
            print(f"[{idx}/{len(sites)}] site {site_id}: stations {len(stations)}")
        except requests.HTTPError as e:
            print(f"HTTP error in findStationsBySiteId for site {site_id}: {e}")
            continue
        except Exception as e:
            print(f"Unexpected error in findStationsBySiteId for site {site_id}: {e}")
            continue

        for station in stations:
            station_id = station.get("id")
            if station_id:
                all_station_ids.append(str(station_id))

        time.sleep(0.15)

    unique_station_ids = sorted(set(all_station_ids))
    print(f"Unique station IDs found: {len(unique_station_ids)}")

    chargers: List[Dict[str, Any]] = []

    for idx, station_id in enumerate(unique_station_ids, start=1):
        try:
            detail = find_station_by_id(session, station_id)
            if not detail:
                print(f"[{idx}/{len(unique_station_ids)}] station {station_id}: empty detail")
                continue

            charger = normalize_station(detail)
            chargers.append(charger)

            price = charger.get("price_eur_kwh")
            print(
                f"[{idx}/{len(unique_station_ids)}] station {station_id}: "
                f"{charger.get('station_name')} | price={price}"
            )
        except requests.HTTPError as e:
            print(f"HTTP error in findStationById for station {station_id}: {e}")
        except Exception as e:
            print(f"Unexpected error in findStationById for station {station_id}: {e}")

        time.sleep(0.15)

    chargers = dedupe_stations(chargers)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(
        json.dumps(chargers, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    priced = sum(1 for item in chargers if isinstance(item.get("price_eur_kwh"), (int, float)))

    print(f"Saved {len(chargers)} stations to {OUT_FILE}")
    print(f"Stations with price: {priced}")


if __name__ == "__main__":
    main()
