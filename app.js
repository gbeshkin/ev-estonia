const DATA_URL = "./data/chargers.json";

let allStations = [];
let filteredStations = [];
let markersLayer = null;
let userLocation = null;
let userMarker = null;
let nearbyHighlightId = null;

const els = {
  cityFilter: document.getElementById("cityFilter"),
  cityOptions: document.getElementById("cityOptions"),
  operatorFilter: document.getElementById("operatorFilter"),
  powerTypeFilter: document.getElementById("powerTypeFilter"),
  searchFilter: document.getElementById("searchFilter"),
  sortBy: document.getElementById("sortBy"),
  pricedOnlyFilter: document.getElementById("pricedOnlyFilter"),
  consumptionInput: document.getElementById("consumptionInput"),
  radiusInput: document.getElementById("radiusInput"),
  locateBtn: document.getElementById("locateBtn"),
  resetBtn: document.getElementById("resetBtn"),
  stats: document.getElementById("stats"),
  nearbyResult: document.getElementById("nearbyResult"),
  summaryCards: document.getElementById("summaryCards"),
  tableBody: document.getElementById("tableBody"),
  tableCount: document.getElementById("tableCount")
};

const map = L.map("map", { zoomControl: true }).setView([58.7, 25.0], 8);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19
}).addTo(map);
markersLayer = L.layerGroup().addTo(map);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatPrice(price) {
  return typeof price === "number" ? `${price.toFixed(3)} €/kWh` : "—";
}

function getConsumption() {
  const value = Number(els.consumptionInput.value);
  return Number.isFinite(value) && value > 0 ? value : 18;
}

function costPer100Km(item) {
  if (typeof item.price_eur_kwh !== "number") return null;
  return item.price_eur_kwh * getConsumption();
}

function formatCost100(item) {
  const value = costPer100Km(item);
  return typeof value === "number" ? `${value.toFixed(2)} €` : "—";
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = x => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function withDistance(item) {
  if (!userLocation || typeof item.lat !== "number" || typeof item.lng !== "number") {
    return { ...item, distance_km: null };
  }
  return {
    ...item,
    distance_km: haversineKm(userLocation.lat, userLocation.lng, item.lat, item.lng)
  };
}

async function loadData() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load data: ${res.status}`);
  const json = await res.json();
  allStations = Array.isArray(json) ? json.map(normalizeStation) : [];
  initFilters(allStations);
  applyFilters();
}

function normalizeStation(raw, idx) {
  const station = { ...raw };
  station.id = raw.id || `${raw.operator || "operator"}-${raw.station_name || "station"}-${idx}`;
  if (station.power_type) station.power_type = String(station.power_type).toUpperCase();
  return station;
}

function initFilters(data) {
  const cities = [...new Set(data.map(x => x.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const operators = [...new Set(data.map(x => x.operator).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  els.cityOptions.innerHTML = cities.map(city => `<option value="${escapeHtml(city)}"></option>`).join("");
  els.operatorFilter.innerHTML = '<option value="">All operators</option>' +
    operators.map(op => `<option value="${escapeHtml(op)}">${escapeHtml(op)}</option>`).join("");
}

function applyFilters() {
  const city = els.cityFilter.value.trim().toLowerCase();
  const operator = els.operatorFilter.value.trim().toLowerCase();
  const powerType = els.powerTypeFilter.value.trim().toLowerCase();
  const search = els.searchFilter.value.trim().toLowerCase();
  const pricedOnly = els.pricedOnlyFilter.value === "priced";
  const sortBy = els.sortBy.value;

  filteredStations = allStations
    .map(withDistance)
    .filter(item => {
      const haystack = [item.station_name, item.address, item.city, item.operator].join(" ").toLowerCase();
      const matchesCity = !city || (item.city || "").toLowerCase().includes(city);
      const matchesOperator = !operator || (item.operator || "").toLowerCase() === operator;
      const matchesType = !powerType || (item.power_type || "").toLowerCase() === powerType;
      const matchesSearch = !search || haystack.includes(search);
      const matchesPrice = !pricedOnly || typeof item.price_eur_kwh === "number";
      return matchesCity && matchesOperator && matchesType && matchesSearch && matchesPrice;
    })
    .sort((a, b) => sortStations(a, b, sortBy));

  renderSummary(filteredStations);
  renderStats(filteredStations);
  renderMap(filteredStations);
  renderTable(filteredStations);
}

function sortStations(a, b, mode) {
  if (mode === "priceAsc") return safePrice(a) - safePrice(b);
  if (mode === "priceDesc") return safePrice(b) - safePrice(a);
  if (mode === "distanceAsc") return safeDistance(a) - safeDistance(b);
  if (mode === "cityAsc") return (a.city || "").localeCompare(b.city || "");
  if (mode === "operatorAsc") return (a.operator || "").localeCompare(b.operator || "");
  return 0;
}

function safePrice(item) {
  return typeof item.price_eur_kwh === "number" ? item.price_eur_kwh : Number.MAX_SAFE_INTEGER;
}

function safeDistance(item) {
  return typeof item.distance_km === "number" ? item.distance_km : Number.MAX_SAFE_INTEGER;
}

function renderSummary(data) {
  const priced = data.filter(x => typeof x.price_eur_kwh === "number");
  const cheapest = priced.length ? priced.reduce((a, b) => a.price_eur_kwh <= b.price_eur_kwh ? a : b) : null;
  const avgPrice = priced.length ? priced.reduce((sum, x) => sum + x.price_eur_kwh, 0) / priced.length : null;
  const avgCost = priced.length ? priced.reduce((sum, x) => sum + costPer100Km(x), 0) / priced.length : null;
  const hpcCount = data.filter(x => x.power_type === "HPC").length;

  els.summaryCards.innerHTML = [
    summaryCard("Visible stations", String(data.length), `${priced.length} with price`),
    summaryCard("Average price", avgPrice != null ? `${avgPrice.toFixed(3)} €/kWh` : "—", `Based on visible priced stations`),
    summaryCard("Avg. cost / 100 km", avgCost != null ? `${avgCost.toFixed(2)} €` : "—", `${getConsumption().toFixed(1)} kWh / 100 km`),
    summaryCard("HPC visible", String(hpcCount), cheapest ? `Cheapest: ${escapeHtml(cheapest.operator)} ${escapeHtml(cheapest.city || "")}` : "No price data")
  ].join("");
}

function summaryCard(label, value, sub) {
  return `
    <div class="summary-card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="sub">${escapeHtml(sub)}</div>
    </div>
  `;
}

function renderStats(data) {
  const priced = data.filter(x => typeof x.price_eur_kwh === "number");
  const min = priced.length ? Math.min(...priced.map(x => x.price_eur_kwh)) : null;
  const max = priced.length ? Math.max(...priced.map(x => x.price_eur_kwh)) : null;
  const avg = priced.length ? priced.reduce((sum, x) => sum + x.price_eur_kwh, 0) / priced.length : null;

  const parts = [
    `Stations: ${data.length}`,
    `With price: ${priced.length}`,
    `Average: ${avg != null ? avg.toFixed(3) + ' €/kWh' : '—'}`,
    `Min: ${min != null ? min.toFixed(3) + ' €/kWh' : '—'}`,
    `Max: ${max != null ? max.toFixed(3) + ' €/kWh' : '—'}`
  ];

  if (userLocation) parts.push(`Location enabled`);
  els.stats.textContent = parts.join(" · ");
}

function renderMap(data) {
  markersLayer.clearLayers();
  const bounds = [];

  if (userMarker) {
    markersLayer.addLayer(userMarker);
    bounds.push([userLocation.lat, userLocation.lng]);
  }

  data.forEach(item => {
    if (typeof item.lat !== "number" || typeof item.lng !== "number") return;

    const marker = L.marker([item.lat, item.lng]);
    const icon = getTypeIcon(item.power_type);
    marker.bindPopup(`
      <div class="popup-title">${icon} ${escapeHtml(item.station_name || 'Unnamed station')}</div>
      <div class="popup-line"><strong>Operator:</strong> ${escapeHtml(item.operator || '—')}</div>
      <div class="popup-line"><strong>City:</strong> ${escapeHtml(item.city || '—')}</div>
      <div class="popup-line"><strong>Power:</strong> ${escapeHtml(item.power_kw ? item.power_kw + ' kW' : '—')}</div>
      <div class="popup-line"><strong>Price:</strong> ${formatPrice(item.price_eur_kwh)}</div>
      <div class="popup-line"><strong>Cost / 100 km:</strong> ${formatCost100(item)}</div>
      <div class="popup-line"><strong>Address:</strong> ${escapeHtml(item.address || '—')}</div>
      <div class="popup-line"><strong>Source:</strong> ${escapeHtml(item.data_source || '—')}</div>
    `);

    if (nearbyHighlightId && item.id === nearbyHighlightId) {
      marker.openPopup();
    }

    marker.addTo(markersLayer);
    bounds.push([item.lat, item.lng]);
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
  }
}

function getTypeIcon(type) {
  if (type === "AC") return "⚡";
  if (type === "DC") return "⚡⚡";
  if (type === "HPC") return "⚡⚡⚡";
  return "⚡";
}

function renderTable(data) {
  els.tableBody.innerHTML = data.map(item => `
    <tr>
      <td>${renderTypePill(item)}</td>
      <td>${escapeHtml(item.operator || '—')}</td>
      <td>${escapeHtml(item.station_name || '—')}</td>
      <td>${escapeHtml(item.city || '—')}</td>
      <td>${escapeHtml(item.power_kw ? item.power_kw + ' kW' : '—')}</td>
      <td>${formatPrice(item.price_eur_kwh)}</td>
      <td>${formatCost100(item)}</td>
      <td>${item.distance_km != null ? item.distance_km.toFixed(1) + ' km' : '<span class="dim">—</span>'}</td>
      <td>${escapeHtml(item.address || '—')}</td>
    </tr>
  `).join("");

  els.tableCount.textContent = `Found: ${data.length}`;
}

function renderTypePill(item) {
  const type = escapeHtml(item.power_type || '—');
  return `<span class="type-pill">${getTypeIcon(item.power_type)} <span>${type}</span> <small>${escapeHtml(item.connectors || '')}</small></span>`;
}

function attachEvents() {
  [els.cityFilter, els.searchFilter, els.consumptionInput, els.radiusInput].forEach(el => {
    el.addEventListener("input", applyFilters);
  });

  [els.operatorFilter, els.powerTypeFilter, els.sortBy, els.pricedOnlyFilter].forEach(el => {
    el.addEventListener("change", applyFilters);
  });

  els.resetBtn.addEventListener("click", () => {
    els.cityFilter.value = "";
    els.operatorFilter.value = "";
    els.powerTypeFilter.value = "";
    els.searchFilter.value = "";
    els.sortBy.value = "priceAsc";
    els.pricedOnlyFilter.value = "";
    els.consumptionInput.value = "18";
    els.radiusInput.value = "20";
    nearbyHighlightId = null;
    hideNearby();
    applyFilters();
  });

  els.locateBtn.addEventListener("click", findCheapestNearby);
}

function hideNearby() {
  els.nearbyResult.classList.add("hidden");
  els.nearbyResult.innerHTML = "";
}

function showNearby(html) {
  els.nearbyResult.classList.remove("hidden");
  els.nearbyResult.innerHTML = html;
}

function ensureUserMarker() {
  if (!userLocation) return;
  if (userMarker) markersLayer.removeLayer(userMarker);
  userMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
    radius: 9,
    weight: 2,
    fillOpacity: 0.95
  }).bindPopup("You are here");
}

function findCheapestNearby() {
  if (!navigator.geolocation) {
    showNearby('<span class="warn">Geolocation is not supported in this browser.</span>');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    position => {
      userLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };
      ensureUserMarker();
      applyFilters();

      const radiusKm = Number(els.radiusInput.value) || 20;
      const nearby = filteredStations
        .filter(x => typeof x.price_eur_kwh === "number" && typeof x.distance_km === "number" && x.distance_km <= radiusKm)
        .sort((a, b) => a.price_eur_kwh - b.price_eur_kwh || a.distance_km - b.distance_km);

      if (!nearby.length) {
        nearbyHighlightId = null;
        showNearby(`No priced chargers found within ${radiusKm} km.`);
        return;
      }

      const best = nearby[0];
      nearbyHighlightId = best.id;
      applyFilters();

      showNearby(`
        <strong>Cheapest nearby charger:</strong> ${escapeHtml(best.station_name)} (${escapeHtml(best.operator)})<br />
        <strong>Type:</strong> ${getTypeIcon(best.power_type)} ${escapeHtml(best.power_type)} · ${escapeHtml(best.power_kw ? best.power_kw + ' kW' : '—')}<br />
        <strong>Price:</strong> ${formatPrice(best.price_eur_kwh)} · <strong>Cost / 100 km:</strong> ${formatCost100(best)}<br />
        <strong>Distance:</strong> ${best.distance_km.toFixed(1)} km · <strong>City:</strong> ${escapeHtml(best.city || '—')}<br />
        <strong>Address:</strong> ${escapeHtml(best.address || '—')}
      `);
    },
    () => {
      showNearby('<span class="warn">Location permission was denied or unavailable.</span>');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

attachEvents();
loadData().catch(error => {
  console.error(error);
  els.stats.textContent = "Could not load station data.";
});
