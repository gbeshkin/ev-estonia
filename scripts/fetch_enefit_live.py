import json
import os
import sys
from pathlib import Path
from typing import Any

import requests

BASE_URL = "https://account.enefitvolt.com/stationFacade"
OUT_FILE = Path("data/chargers.json")

# Estonia bounds used in the TalTech thesis scraper example.
BOUNDS_PAYLOAD = {
    "filterByIsManaged": True,
    "filterByBounds": {
        "northEastLat": 60.75,
        "northEastLng": 35.34,
        "southWestLat": 55.78,
        "southWestLng": 14.26,
    },
}


def build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": os.getenv("ENEFIT_USER_AGENT", "Mozilla/5.0"),
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": "https://account.enefitvolt.com",
            "Referer": os.getenv(
                "ENEFIT_REFERER",
                "https://account.enefitvolt.com/findCharger?59.7690375,24.5722210,6z",
            ),
        }
    )

    csrf = os.getenv("ENEFIT_CSRF_TOKEN", "").strip()
    cookie = os.getenv("ENEFIT_COOKIE", "").strip()
    if csrf:
        session.headers["x-csrf-token"] = csrf
    if cookie:
        session.headers["Cookie"] = cookie
    return session


def post_json(session: requests.Session, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = session.post(f"{BASE_URL}/{path}", json=payload, timeout=30)
    response.raise_for_status()
    return response.json()


def get_json(session: requests.Session, path: str, params: dict[str, Any]) -> dict[str, Any]:
    response = session.get(f"{BASE_URL}/{path}", params=params, timeout=30)
    response.raise_for_status()
    return response.json()


def extract_records(resp: dict[str, Any]) -> list[dict[str, Any]]:
    data = resp.get("data")
    if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list):
        return data[1]
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        return [data]
    return []


def infer_power_type(power_kw: float | None) -> str:
    if power_kw is None:
        return "AC"
    if power_kw > 50:
        return "HPC"
    if power_kw >= 25:
        return "DC"
    return "AC"


def choose_station_price(sockets: list[dict[str, Any]]) -> float | None:
    prices = [s["price_eur_kwh"] for s in sockets if isinstance(s.get("price_eur_kwh"), (int, float))]
    return min(prices) if prices else None


def transform_station(data: dict[str, Any]) -> dict[str, Any]:
    sockets = []
    for socket in data.get("stationSockets", []):
        prices = socket.get("socketPrices") or []
        price = None
        if prices and isinstance(prices[0], dict):
            price = prices[0].get("kwhPrice")
        sockets.append(
            {
                "socket_name": socket.get("name"),
                "socket_status": socket.get("socketStatusId"),
                "maximum_power_kw": socket.get("maximumPower"),
                "price_eur_kwh": price,
                "socket_type": socket.get("stationModelSocketSocketTypeId"),
                "voltage_type": socket.get("stationModelSocketVoltageType"),
            }
        )

    max_power = max(
        [s["maximum_power_kw"] for s in sockets if isinstance(s.get("maximum_power_kw"), (int, float))],
        default=None,
    )

    return {
        "station_id": data.get("id"),
        "site_id": data.get("siteId"),
        "station_name": data.get("siteDisplayName") or data.get("caption") or "Unnamed station",
        "city": data.get("addressCity") or "",
        "address": data.get("addressAddress1") or "",
        "lat": data.get("latitude"),
        "lng": data.get("longitude"),
        "power_type": infer_power_type(max_power),
        "power_kw": max_power,
        "price_eur_kwh": choose_station_price(sockets),
        "status": data.get("stationStatusId") or "UNKNOWN",
        "price_source": "live_station_price",
        "sockets": sockets,
    }


def fetch_all() -> list[dict[str, Any]]:
    session = build_session()

    sites_resp = post_json(session, "findSitesInBounds", BOUNDS_PAYLOAD)
    sites = extract_records(sites_resp)
    if not sites:
        raise RuntimeError(
            "No sites returned. Usually this means Enefit rejected the request and you need fresh ENEFIT_CSRF_TOKEN / ENEFIT_COOKIE values."
        )

    station_ids: list[int] = []
    for site in sites:
        site_id = site.get("id")
        if site_id is None:
            continue
        stations_resp = post_json(
            session,
            "findStationsBySiteId",
            {"filterByIsManaged": True, "filterBySiteId": str(site_id)},
        )
        stations = extract_records(stations_resp)
        for station in stations:
            station_id = station.get("id")
            if isinstance(station_id, int):
                station_ids.append(station_id)

    station_ids = sorted(set(station_ids))
    if not station_ids:
        raise RuntimeError("No station ids returned from findStationsBySiteId.")

    output: list[dict[str, Any]] = []
    for station_id in station_ids:
        station_resp = get_json(session, "findStationById", {"stationId": station_id})
        station_data = station_resp.get("data")
        if isinstance(station_data, dict):
            output.append(transform_station(station_data))

    return output


def main() -> int:
    try:
        stations = fetch_all()
    except requests.HTTPError as exc:
        print(f"HTTP error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(stations, ensure_ascii=False, indent=2), encoding="utf-8")
    priced = sum(1 for s in stations if isinstance(s.get("price_eur_kwh"), (int, float)))
    print(f"Saved {len(stations)} stations to {OUT_FILE}")
    print(f"Stations with price: {priced}/{len(stations)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
