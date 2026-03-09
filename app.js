const DATA_URL = "./data/chargers.json";

let allStations = [];
let filteredStations = [];
let markersLayer;
let userLocation = null;
let userMarker = null;

const els = {
  cityFilter: document.getElementById("cityFilter"),
  cityOptions: document.getElementById("cityOptions"),
  operatorFilter: document.getElementById("operatorFilter"),
  powerTypeFilter: document.getElementById("powerTypeFilter"),
  searchFilter: document.getElementById("searchFilter"),
  sortBy: document.getElementById("sortBy"),
  resetBtn: document.getElementById("resetBtn"),
  stats: document.getElementById("stats"),
  tableBody: document.getElementById("tableBody"),
  tableCount: document.getElementById("tableCount"),
  cheapestNearby: document.getElementById("cheapestNearby"),
};

const map = L.map("map", {
  zoomControl: true,
}).setView([58.7, 25.0], 8);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

markersLayer = L.layerGroup().addTo(map);

async function loadData() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load data: ${res.status}`);
  }
  const json = await res.json();
  allStations = Array.isArray(json) ? json : [];
  initFilters(allStations);
  applyFilters();
}

function initFilters(data) {
  const cities = [...new Set(data.map((x) => x.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const operators = [...new Set(data.map((x) => x.operator).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  els.cityOptions.innerHTML = cities
    .map((city) => `<option value="${escapeHtml(city)}"></option>`)
    .join("");

  els.operatorFilter.innerHTML =
    `<option value="">All operators</option>` +
    operators.map((op) => `<option value="${escapeHtml(op)}">${escapeHtml(op)}</option>`).join("");
}

function applyFilters() {
  const city = els.cityFilter.value.trim().toLowerCase();
  const operator = els.operatorFilter.value.trim().toLowerCase();
  const powerType = els.powerTypeFilter.value.trim().toLowerCase();
  const search = els.searchFilter.value.trim().toLowerCase();
  const sortBy = els.sortBy.value;
  const onlyPriced = els.onlyPricedFilter.checked;

  filteredStations = allStations.filter((item) => {
    const matchesCity = !city || (item.city || "").toLowerCase().includes(city);
    const matchesOperator = !operator || (item.operator || "").toLowerCase() === operator;
    const matchesPowerType = !powerType || (item.power_type || "").toLowerCase() === powerType;
    const haystack = [item.station_name, item.address, item.city, item.operator].join(" ").toLowerCase();
    const matchesSearch = !search || haystack.includes(search);
    const matchesPrice = !onlyPriced || typeof item.price_eur_kwh === "number";

    return matchesCity && matchesOperator && matchesPowerType && matchesSearch && matchesPrice;
  });

  filteredStations.sort((a, b) => sortStations(a, b, sortBy));

  renderMap(filteredStations);
  renderTable(filteredStations);
  renderStats(filteredStations);
  updateCheapestNearbyCard();
}

function sortStations(a, b, mode) {
  if (mode === "priceAsc") return safePrice(a) - safePrice(b);
  if (mode === "priceDesc") return safePrice(b) - safePrice(a);
  if (mode === "cityAsc") return (a.city || "").localeCompare(b.city || "");
  if (mode === "operatorAsc") return (a.operator || "").localeCompare(b.operator || "");
  if (mode === "distanceAsc") {
    if (!userLocation) return 0;
    const da = getDistanceForStation(a);
    const db = getDistanceForStation(b);
    return da - db;
  }
  return 0;
}

function safePrice(item) {
  return typeof item.price_eur_kwh === "number" ? item.price_eur_kwh : Number.MAX_SAFE_INTEGER;
}

function renderMap(data) {
  markersLayer.clearLayers();

  if (!data.length) return;

  const bounds = [];

  data.forEach((item) => {
    if (typeof item.lat !== "number" || typeof item.lng !== "number") return;

    const marker = L.marker([item.lat, item.lng]);
    const distanceText = userLocation ? `${getDistanceForStation(item).toFixed(1)} km` : "—";
    marker.bindPopup(`
      <div class="popupTitle">${escapeHtml(item.station_name || "Unnamed station")}</div>
      <div class="popupMeta"><strong>Operator:</strong> ${escapeHtml(item.operator || "—")}</div>
      <div class="popupMeta"><strong>City:</strong> ${escapeHtml(item.city || "—")}</div>
      <div class="popupMeta"><strong>Type:</strong> ${escapeHtml(item.power_type || "—")}</div>
      <div class="popupMeta"><strong>Power:</strong> ${escapeHtml(item.power_kw ? `${item.power_kw} kW` : "—")}</div>
      <div class="popupMeta"><strong>Price:</strong> ${formatPrice(item.price_eur_kwh)}</div>
      <div class="popupMeta"><strong>Cost / 100 km:</strong> ${formatCost100(item.price_eur_kwh)}</div>
      <div class="popupMeta"><strong>Distance:</strong> ${distanceText}</div>
      <div class="popupMeta"><strong>Source:</strong> ${formatPriceSource(item.price_source)}</div>
      <div class="popupMeta"><strong>Address:</strong> ${escapeHtml(item.address || "—")}</div>
    `);

    marker.addTo(markersLayer);
    bounds.push([item.lat, item.lng]);
  });

  if (userMarker) bounds.push(userMarker.getLatLng());
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
}

function renderTable(data) {
  els.tableBody.innerHTML = data.map((item) => `
    <tr>
      <td>${escapeHtml(item.operator || "—")}</td>
      <td>${escapeHtml(item.station_name || "—")}</td>
      <td>${escapeHtml(item.city || "—")}</td>
      <td>${renderPowerType(item.power_type)}</td>
      <td>${escapeHtml(item.power_kw ? `${item.power_kw} kW` : "—")}</td>
      <td>${formatPrice(item.price_eur_kwh)}</td>
      <td>${escapeHtml(formatPriceSource(item.price_source))}</td>
      <td>${formatCost100(item.price_eur_kwh)}</td>
      <td>${escapeHtml(item.address || "—")}</td>
    </tr>
  `).join("");

  els.tableCount.textContent = `Found: ${data.length}`;
}

function renderStats(data) {
  const withPrice = data.filter((x) => typeof x.price_eur_kwh === "number");
  const avg = withPrice.length
    ? withPrice.reduce((sum, x) => sum + x.price_eur_kwh, 0) / withPrice.length
    : null;
  const min = withPrice.length ? Math.min(...withPrice.map((x) => x.price_eur_kwh)) : null;
  const consumption = getConsumption();
  const cost100 = avg !== null ? avg * consumption : null;

  els.stats.textContent = `Stations: ${data.length} · With price: ${withPrice.length} · Consumption: ${consumption.toFixed(1)} kWh/100 km`;
  els.metricStations.textContent = String(data.length);
  els.metricAvg.textContent = avg !== null ? `${avg.toFixed(3)} €/kWh` : "—";
  els.metricMin.textContent = min !== null ? `${min.toFixed(3)} €/kWh` : "—";
  els.metricCost100.textContent = cost100 !== null ? `${cost100.toFixed(2)} €` : "—";
}

function getConsumption() {
  const value = Number(els.consumptionInput.value);
  return Number.isFinite(value) && value > 0 ? value : 20;
}

function formatPrice(value) {
  return typeof value === "number" ? `${value.toFixed(3)} €/kWh` : "—";
}

function formatCost100(price) {
  return typeof price === "number" ? `${(price * getConsumption()).toFixed(2)} €` : "—";
}

function formatPriceSource(value) {
  if (!value) return "—";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function renderPowerType(value) {
  const type = value || "—";
  const icon = type === "AC" ? "⚡" : type === "DC" ? "⚡⚡" : type === "HPC" ? "⚡⚡⚡" : "⚡";
  return `<span class="powerBadge">${icon} ${escapeHtml(type)}</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function getDistanceForStation(station) {
  if (!userLocation || typeof station.lat !== "number" || typeof station.lng !== "number") {
    return Number.MAX_SAFE_INTEGER;
  }
  return haversineKm(userLocation.lat, userLocation.lng, station.lat, station.lng);
}

function findCheapestNearby(maxDistanceKm = 25) {
  if (!userLocation) return null;

  const candidates = filteredStations
    .filter((s) => typeof s.lat === "number" && typeof s.lng === "number" && typeof s.price_eur_kwh === "number")
    .map((s) => ({ ...s, distance_km: getDistanceForStation(s) }))
    .filter((s) => s.distance_km <= maxDistanceKm)
    .sort((a, b) => {
      if (a.price_eur_kwh !== b.price_eur_kwh) return a.price_eur_kwh - b.price_eur_kwh;
      return a.distance_km - b.distance_km;
    });

  return candidates[0] || null;
}

function updateCheapestNearbyCard() {
  if (!userLocation) {
    els.cheapestNearby.textContent = 'Click “Find cheapest nearby” to use your location.';
    return;
  }

  const best = findCheapestNearby(25);
  if (!best) {
    els.cheapestNearby.textContent = "No priced charger found within 25 km for the current filters.";
    return;
  }

  els.cheapestNearby.innerHTML =
    `Cheapest nearby: <strong>${escapeHtml(best.station_name)}</strong> (${escapeHtml(best.operator)}) · ` +
    `${best.price_eur_kwh.toFixed(3)} €/kWh · ${best.distance_km.toFixed(1)} km · ` +
    `${formatCost100(best.price_eur_kwh)} per 100 km`;
}

function locateAndShowCheapestNearby() {
  if (!navigator.geolocation) {
    els.cheapestNearby.textContent = "Geolocation is not supported by your browser.";
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
      els.cheapestNearby.textContent = "Location access denied.";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function attachEvents() {
  [
    els.cityFilter,
    els.operatorFilter,
    els.powerTypeFilter,
    els.searchFilter,
    els.sortBy,
  ]
    .filter(Boolean)
    .forEach((el) => el.addEventListener("input", applyFilters));

  if (els.operatorFilter) {
    els.operatorFilter.addEventListener("change", applyFilters);
  }

  if (els.powerTypeFilter) {
    els.powerTypeFilter.addEventListener("change", applyFilters);
  }

  if (els.sortBy) {
    els.sortBy.addEventListener("change", applyFilters);
  }

  if (els.resetBtn) {
    els.resetBtn.addEventListener("click", () => {
      if (els.cityFilter) els.cityFilter.value = "";
      if (els.operatorFilter) els.operatorFilter.value = "";
      if (els.powerTypeFilter) els.powerTypeFilter.value = "";
      if (els.searchFilter) els.searchFilter.value = "";
      if (els.sortBy) els.sortBy.value = "priceAsc";
      applyFilters();
    });
  }
}

attachEvents();
loadData().catch((err) => {
  console.error(err);
  els.stats.textContent = "Failed to load data.";
});
