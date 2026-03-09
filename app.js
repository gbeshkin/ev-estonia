const DATA_URL = "./data/chargers.json";

let allStations = [];
let filteredStations = [];
let markersLayer = null;
let userMarker = null;
let userLocation = null;

const els = {
  cityFilter: document.getElementById("cityFilter"),
  cityOptions: document.getElementById("cityOptions"),
  operatorFilter: document.getElementById("operatorFilter"),
  powerTypeFilter: document.getElementById("powerTypeFilter"),
  searchFilter: document.getElementById("searchFilter"),
  sortBy: document.getElementById("sortBy"),
  onlyWithPrice: document.getElementById("onlyWithPrice"),
  consumptionInput: document.getElementById("consumptionInput"),
  stats: document.getElementById("stats"),
  tableBody: document.getElementById("tableBody"),
  tableCount: document.getElementById("tableCount"),
  resetBtn: document.getElementById("resetBtn"),
  cheapestNearby: document.getElementById("cheapestNearby"),
  avgPriceCard: document.getElementById("avgPriceCard"),
  cheapestPriceCard: document.getElementById("cheapestPriceCard"),
  expensivePriceCard: document.getElementById("expensivePriceCard"),
  cost100kmCard: document.getElementById("cost100kmCard"),
};

const map = L.map("map", {
  zoomControl: true,
}).setView([58.7, 25.0], 8);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

markersLayer = L.layerGroup().addTo(map);

debugMissingElements();

function debugMissingElements() {
  Object.entries(els).forEach(([key, value]) => {
    if (!value) {
      console.warn(`Missing DOM element: ${key}`);
    }
  });
}

async function loadData() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load data: ${res.status}`);
  }

  const json = await res.json();
  allStations = Array.isArray(json) ? sanitizeStations(json) : [];

  initFilters(allStations);
  applyFilters();
}

function sanitizeStations(items) {
  return items
    .map((item) => ({
      operator: item.operator || "Unknown",
      operator_key: item.operator_key || "",
      station_name: item.station_name || "Unnamed station",
      city: item.city || "",
      address: item.address || "",
      lat: toNumberOrNull(item.lat),
      lng: toNumberOrNull(item.lng),
      power_type: item.power_type || inferPowerType(item.power_kw),
      power_kw: toNumberOrNull(item.power_kw),
      price_eur_kwh: toNumberOrNull(item.price_eur_kwh),
      price_source: item.price_source || "",
      updated_at: item.updated_at || "",
    }))
    .filter((item) => item.lat !== null && item.lng !== null);
}

function toNumberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function inferPowerType(powerKw) {
  const kw = toNumberOrNull(powerKw);
  if (kw === null) return "AC";
  if (kw > 50) return "HPC";
  if (kw >= 25) return "DC";
  return "AC";
}

function initFilters(data) {
  const cities = [...new Set(data.map((x) => x.city).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );

  const operators = [...new Set(data.map((x) => x.operator).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );

  if (els.cityOptions) {
    els.cityOptions.innerHTML = cities
      .map((city) => `<option value="${escapeHtml(city)}"></option>`)
      .join("");
  }

  if (els.operatorFilter) {
    els.operatorFilter.innerHTML =
      `<option value="">All operators</option>` +
      operators
        .map((op) => `<option value="${escapeHtml(op)}">${escapeHtml(op)}</option>`)
        .join("");
  }
}

function applyFilters() {
  const city = els.cityFilter?.value.trim().toLowerCase() || "";
  const operator = els.operatorFilter?.value.trim().toLowerCase() || "";
  const powerType = els.powerTypeFilter?.value.trim().toLowerCase() || "";
  const search = els.searchFilter?.value.trim().toLowerCase() || "";
  const sortBy = els.sortBy?.value || "priceAsc";
  const onlyWithPrice = els.onlyWithPrice?.checked ?? false;

  filteredStations = allStations.filter((item) => {
    const matchesCity = !city || (item.city || "").toLowerCase().includes(city);
    const matchesOperator = !operator || (item.operator || "").toLowerCase() === operator;
    const matchesPowerType =
      !powerType || (item.power_type || "").toLowerCase() === powerType;

    const haystack = [
      item.station_name || "",
      item.address || "",
      item.city || "",
      item.operator || "",
    ]
      .join(" ")
      .toLowerCase();

    const matchesSearch = !search || haystack.includes(search);
    const matchesPrice = !onlyWithPrice || typeof item.price_eur_kwh === "number";

    return (
      matchesCity &&
      matchesOperator &&
      matchesPowerType &&
      matchesSearch &&
      matchesPrice
    );
  });

  filteredStations.sort((a, b) => sortStations(a, b, sortBy));

  renderMap(filteredStations);
  renderTable(filteredStations);
  renderStats(filteredStations);
  renderSummaryCards(filteredStations);
  renderCheapestNearby();
}

function sortStations(a, b, mode) {
  if (mode === "priceAsc") {
    return compareNullableNumbers(a.price_eur_kwh, b.price_eur_kwh, "asc");
  }

  if (mode === "priceDesc") {
    return compareNullableNumbers(a.price_eur_kwh, b.price_eur_kwh, "desc");
  }

  if (mode === "cityAsc") {
    return (a.city || "").localeCompare(b.city || "");
  }

  if (mode === "operatorAsc") {
    return (a.operator || "").localeCompare(b.operator || "");
  }

  if (mode === "distanceAsc") {
    if (!userLocation) return 0;
    const aDist = distanceFromUser(a);
    const bDist = distanceFromUser(b);
    return compareNullableNumbers(aDist, bDist, "asc");
  }

  return 0;
}

function compareNullableNumbers(a, b, direction = "asc") {
  const aValid = typeof a === "number" && Number.isFinite(a);
  const bValid = typeof b === "number" && Number.isFinite(b);

  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;

  return direction === "desc" ? b - a : a - b;
}

function renderMap(data) {
  markersLayer.clearLayers();

  if (!data.length) {
    return;
  }

  const bounds = [];

  data.forEach((item) => {
    if (typeof item.lat !== "number" || typeof item.lng !== "number") return;

    const marker = L.marker([item.lat, item.lng]);

    const priceLabel = formatPrice(item.price_eur_kwh);
    const cost100km = calculateCostPer100Km(item.price_eur_kwh);
    const distance = distanceFromUser(item);

    marker.bindPopup(`
      <div class="popupTitle">${escapeHtml(item.station_name || "Unnamed station")}</div>
      <div class="popupMeta"><strong>Operator:</strong> ${escapeHtml(item.operator || "—")}</div>
      <div class="popupMeta"><strong>City:</strong> ${escapeHtml(item.city || "—")}</div>
      <div class="popupMeta"><strong>Type:</strong> ${powerIcon(item.power_type)} ${escapeHtml(item.power_type || "—")}</div>
      <div class="popupMeta"><strong>Power:</strong> ${escapeHtml(item.power_kw ? `${item.power_kw} kW` : "—")}</div>
      <div class="popupMeta"><strong>Price:</strong> ${priceLabel}</div>
      <div class="popupMeta"><strong>Cost per 100 km:</strong> ${cost100km}</div>
      <div class="popupMeta"><strong>Address:</strong> ${escapeHtml(item.address || "—")}</div>
      <div class="popupMeta"><strong>Price source:</strong> ${escapeHtml(item.price_source || "—")}</div>
      ${
        distance !== null
          ? `<div class="popupMeta"><strong>Distance:</strong> ${distance.toFixed(1)} km</div>`
          : ""
      }
    `);

    marker.addTo(markersLayer);
    bounds.push([item.lat, item.lng]);
  });

  if (userLocation && userMarker) {
    bounds.push([userLocation.lat, userLocation.lng]);
  }

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function renderTable(data) {
  if (!els.tableBody) return;

  els.tableBody.innerHTML = data
    .map((item) => {
      const distance = distanceFromUser(item);
      const cost100km = calculateCostPer100Km(item.price_eur_kwh);

      return `
        <tr>
          <td>${escapeHtml(item.operator || "—")}</td>
          <td>${escapeHtml(item.station_name || "—")}</td>
          <td>${escapeHtml(item.city || "—")}</td>
          <td>${powerIcon(item.power_type)} ${escapeHtml(item.power_type || "—")}</td>
          <td>${escapeHtml(item.power_kw ? `${item.power_kw} kW` : "—")}</td>
          <td>${formatPrice(item.price_eur_kwh)}</td>
          <td>${cost100km}</td>
          <td>${distance !== null ? `${distance.toFixed(1)} km` : "—"}</td>
          <td>${escapeHtml(item.address || "—")}</td>
        </tr>
      `;
    })
    .join("");

  if (els.tableCount) {
    els.tableCount.textContent = `Found: ${data.length}`;
  }
}

function renderStats(data) {
  if (!els.stats) return;

  const withPrice = data.filter((x) => typeof x.price_eur_kwh === "number");
  const avg = withPrice.length
    ? (withPrice.reduce((sum, x) => sum + x.price_eur_kwh, 0) / withPrice.length).toFixed(3)
    : "—";

  const min = withPrice.length
    ? Math.min(...withPrice.map((x) => x.price_eur_kwh)).toFixed(3)
    : "—";

  const max = withPrice.length
    ? Math.max(...withPrice.map((x) => x.price_eur_kwh)).toFixed(3)
    : "—";

  els.stats.textContent =
    `Stations: ${data.length} · ` +
    `With price: ${withPrice.length} · ` +
    `Average price: ${avg} €/kWh · ` +
    `Min: ${min} €/kWh · ` +
    `Max: ${max} €/kWh`;
}

function renderSummaryCards(data) {
  const priced = data.filter((x) => typeof x.price_eur_kwh === "number");

  const avg =
    priced.length > 0
      ? (priced.reduce((sum, x) => sum + x.price_eur_kwh, 0) / priced.length).toFixed(3) + " €/kWh"
      : "—";

  const cheapest =
    priced.length > 0
      ? `${Math.min(...priced.map((x) => x.price_eur_kwh)).toFixed(3)} €/kWh`
      : "—";

  const expensive =
    priced.length > 0
      ? `${Math.max(...priced.map((x) => x.price_eur_kwh)).toFixed(3)} €/kWh`
      : "—";

  const cheapestStation =
    priced.length > 0
      ? priced.reduce((best, current) =>
          current.price_eur_kwh < best.price_eur_kwh ? current : best
        )
      : null;

  const cost100km =
    cheapestStation && typeof cheapestStation.price_eur_kwh === "number"
      ? calculateCostPer100Km(cheapestStation.price_eur_kwh)
      : "—";

  if (els.avgPriceCard) {
    els.avgPriceCard.textContent = avg;
  }

  if (els.cheapestPriceCard) {
    els.cheapestPriceCard.textContent = cheapest;
  }

  if (els.expensivePriceCard) {
    els.expensivePriceCard.textContent = expensive;
  }

  if (els.cost100kmCard) {
    els.cost100kmCard.textContent = cost100km;
  }
}

function formatPrice(value) {
  return typeof value === "number" ? `${value.toFixed(3)} €/kWh` : "—";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function powerIcon(type) {
  const value = (type || "").toUpperCase();
  if (value === "HPC") return "⚡⚡⚡";
  if (value === "DC") return "⚡⚡";
  return "⚡";
}

function getConsumptionValue() {
  const raw = els.consumptionInput?.value;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return 20;
  }
  return num;
}

function calculateCostPer100Km(pricePerKwh) {
  if (typeof pricePerKwh !== "number") return "—";
  const consumption = getConsumptionValue();
  return `${(pricePerKwh * consumption).toFixed(2)} €`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function distanceFromUser(station) {
  if (!userLocation) return null;
  if (typeof station.lat !== "number" || typeof station.lng !== "number") return null;

  return haversineKm(userLocation.lat, userLocation.lng, station.lat, station.lng);
}

function findCheapestNearby(maxDistanceKm = 25) {
  if (!userLocation) return null;

  const candidates = filteredStations
    .filter(
      (s) =>
        typeof s.lat === "number" &&
        typeof s.lng === "number" &&
        typeof s.price_eur_kwh === "number"
    )
    .map((s) => ({
      ...s,
      distance_km: haversineKm(userLocation.lat, userLocation.lng, s.lat, s.lng),
    }))
    .filter((s) => s.distance_km <= maxDistanceKm)
    .sort((a, b) => {
      if (a.price_eur_kwh !== b.price_eur_kwh) {
        return a.price_eur_kwh - b.price_eur_kwh;
      }
      return a.distance_km - b.distance_km;
    });

  return candidates[0] || null;
}

function renderCheapestNearby() {
  if (!els.cheapestNearby) return;

  if (!userLocation) {
    els.cheapestNearby.textContent = "Enable location to find the cheapest nearby charger.";
    return;
  }

  const best = findCheapestNearby(25);

  if (!best) {
    els.cheapestNearby.textContent = "No priced charger found within 25 km.";
    return;
  }

  els.cheapestNearby.innerHTML =
    `Cheapest nearby: <strong>${escapeHtml(best.station_name)}</strong> ` +
    `(${escapeHtml(best.operator)}) · ` +
    `${best.price_eur_kwh.toFixed(3)} €/kWh · ` +
    `${best.distance_km.toFixed(1)} km · ` +
    `${calculateCostPer100Km(best.price_eur_kwh)} per 100 km`;
}

function locateAndShowCheapestNearby() {
  if (!navigator.geolocation) {
    renderCheapestNearby();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      };

      if (userMarker) {
        map.removeLayer(userMarker);
      }

      userMarker = L.marker([userLocation.lat, userLocation.lng])
        .addTo(map)
        .bindPopup("Your location");

      applyFilters();
    },
    () => {
      renderCheapestNearby();
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 300000,
    }
  );
}

function attachEvents() {
  [
    els.cityFilter,
    els.operatorFilter,
    els.powerTypeFilter,
    els.searchFilter,
    els.sortBy,
    els.onlyWithPrice,
    els.consumptionInput,
  ]
    .filter(Boolean)
    .forEach((el) => {
      el.addEventListener("input", applyFilters);
      el.addEventListener("change", applyFilters);
    });

  if (els.resetBtn) {
    els.resetBtn.addEventListener("click", () => {
      if (els.cityFilter) els.cityFilter.value = "";
      if (els.operatorFilter) els.operatorFilter.value = "";
      if (els.powerTypeFilter) els.powerTypeFilter.value = "";
      if (els.searchFilter) els.searchFilter.value = "";
      if (els.sortBy) els.sortBy.value = "priceAsc";
      if (els.onlyWithPrice) els.onlyWithPrice.checked = false;
      if (els.consumptionInput) els.consumptionInput.value = "20";
      applyFilters();
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  attachEvents();

  loadData()
    .then(() => {
      locateAndShowCheapestNearby();
    })
    .catch((err) => {
      console.error(err);
      if (els.stats) {
        els.stats.textContent = "Failed to load data.";
      }
      if (els.cheapestNearby) {
        els.cheapestNearby.textContent = "Unable to calculate the cheapest nearby charger.";
      }
    });
});
