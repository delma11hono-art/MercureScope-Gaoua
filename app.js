"use strict";

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

/* ================= Configuration ================= */
const CONFIG = {
  weights: { geology: 7.51, soil: 36.45, slope: 38.47, hydro: 17.57 },
  labels: { geology: "Géologie", soil: "Pédologie", slope: "Pente", hydro: "Hydrographie" },
  landcover: { 1: "Végétation", 2: "Sol nu", 3: "Habitat", 4: "Eau", 5: "Culture" },
  susceptibility: { 1: "Faible", 2: "Moyenne", 3: "Forte" },
  colors: { low: "#2f855a", medium: "#d97706", high: "#b42318" },
  center: [10.285, -3.205],
  // ⚠ À vérifier : remplacez par les couleurs réelles de vos fichiers overlay_*.png
  legends: {
    "Risque du terrain": [["Faible", "#2f855a"], ["Moyenne", "#d97706"], ["Forte", "#b42318"]],
    "Occupation du sol": [["Végétation", "#2f855a"], ["Sol nu", "#c2a36b"], ["Habitat", "#b42318"], ["Eau", "#2563eb"], ["Culture", "#d9f99d"]],
  },
};
const LEVEL_SYMBOL = { high: "▲", medium: "◆", low: "●" };
const CLASS_KEY = { 1: "low", 2: "medium", 3: "high" };

const state = {
  data: null, selected: null, weights: { ...CONFIG.weights },
  scores: {}, originalScores: {}, markers: new Map(), buffers: new Map(),
  importedLayer: null, mode: false, radius: 2000, grids: null,
  point: null,   // dernier point diagnostiqué : { latlng, name }
  lot: [], updateLog: [],
};

/* ================= Carte ================= */
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(CONFIG.center, 11);
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; contributeurs OpenStreetMap" }).addTo(map);
const sitesLayer = L.layerGroup().addTo(map);
const buffersLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const lotLayer = L.layerGroup().addTo(map);

/* ================= Utilitaires ================= */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fr = (v, d = 1) => Number(v).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = v => String(v).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const features = () => state.data.features;
const findSite = name => features().find(f => f.properties.name === name);

function downloadCsv(rows, filename) {
  const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}

/* ================= Calculs ================= */
function weightsFrom(raw) {
  const total = Object.values(raw).reduce((a, b) => a + Number(b), 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v) / total]));
}
const normalisedWeights = () => weightsFrom(state.weights);
function suscFrom(values, weights = normalisedWeights()) {
  return Object.keys(weights).reduce((s, k) => s + weights[k] * Number(values[k] || 0), 0);
}
const susceptibility = f => suscFrom(state.scores[f.properties.name]);
function socialUrgency(f) {
  const p = f.properties;
  return 0.45 * (100 - p.ica) + 0.35 * (100 - p.knowledge_danger_pct) + 0.20 * (100 - p.sensitized_pct);
}
const physicalPct = s => ((s - 1) / 4) * 100;
state.social = 0.35;   // part du contexte social dans la priorité (0,35 par défaut)
const priority = f => clamp((1 - state.social) * physicalPct(susceptibility(f)) + state.social * socialUrgency(f), 0, 100);
const priorityBase = f => clamp(0.65 * physicalPct(suscFrom(state.originalScores[f.properties.name], weightsFrom(CONFIG.weights))) + 0.35 * socialUrgency(f), 0, 100);
function level(score) {
  if (score >= 60) return { key: "high", label: "Élevée" };
  if (score >= 40) return { key: "medium", label: "Modérée" };
  return { key: "low", label: "Faible" };
}
function rankMap(fn) {
  const m = new Map();
  [...features()].sort((a, b) => fn(b) - fn(a)).forEach((f, i) => m.set(f.properties.name, i + 1));
  return m;
}

function recommendation(f) {
  const p = f.properties, lv = level(priority(f));
  if (lv.key === "high" && p.sensitized_pct < 10)
    return ["Vérifier sur le terrain et sensibiliser", "Programmer une mission de contrôle, documenter les usages de l’eau et lancer une sensibilisation de proximité. Le risque du terrain n’est pas une mesure de contamination."];
  if (p.ica < 35)
    return ["Renforcer la capacité à se protéger", "Prioriser une source d’eau de remplacement, des relais communautaires et des pratiques sans mercure, puis suivre les indicateurs dans le temps."];
  return ["Surveiller", "Maintenir une veille, actualiser les couches physiques et contrôler les indicateurs sociaux avant toute décision restrictive."];
}

/* ================= Marqueurs et popups ================= */
function markerIcon(lv, selected, rank) {
  const size = selected ? 28 : 23;
  return L.divIcon({
    className: "",
    html: `<div class="site-marker ${lv}" style="width:${size}px;height:${size}px;background:${CONFIG.colors[lv]};">${rank}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -10],
  });
}
function popup(f) {
  const p = f.properties, s = priority(f), lv = level(s);
  return `<h3 class="popup-title">${esc(p.name)}</h3><div class="popup-kpis">
    <span>Priorité<strong style="color:${CONFIG.colors[lv.key]}">${fr(s)} / 100</strong></span>
    <span>Risque du terrain<strong>${fr(susceptibility(f), 2)} / 5</strong></span>
    <span>Classe sur la carte<strong>${esc(p.susceptibility_label)}</strong></span>
    <span>Occupation au point<strong>${esc(p.landcover_label)}</strong></span>
    <span>Connaissance du danger<strong>${fr(p.iprm)} / 100</strong></span>
    <span>Capacité à se protéger<strong>${fr(p.ica)} / 100</strong></span></div>`;
}

/* ================= Réglages (onglet Scénario) ================= */
function buildControls() {
  for (const key of Object.keys(CONFIG.weights)) {
    $("weightControls").insertAdjacentHTML("beforeend", `<div class="range-row">
      <div class="range-label"><span>${CONFIG.labels[key]}</span><strong id="weightValue-${key}">${fr(normalisedWeights()[key] * 100)} %</strong></div>
      <input type="range" min="1" max="70" step="0.5" value="${state.weights[key]}" data-weight="${key}" aria-label="Importance : ${CONFIG.labels[key]}"></div>`);
    $("scoreControls").insertAdjacentHTML("beforeend", `<div class="range-row">
      <div class="range-label"><span>${CONFIG.labels[key]}</span><strong id="scoreValue-${key}">—</strong></div>
      <input type="range" min="1" max="5" step="0.5" value="3" data-score="${key}" aria-label="Note : ${CONFIG.labels[key]}"></div>`);
  }
  $("weightControls").addEventListener("input", e => {
    if (!e.target.dataset.weight) return;
    state.weights[e.target.dataset.weight] = Number(e.target.value);
    updateWeightLabels(); render(); refreshPoint();
  });
  $("scoreControls").addEventListener("input", e => {
    if (!e.target.dataset.score || !state.selected) return;
    state.scores[state.selected][e.target.dataset.score] = Number(e.target.value);
    $(`scoreValue-${e.target.dataset.score}`).textContent = fr(e.target.value);
    render();
  });
}
function updateWeightLabels() {
  for (const [k, v] of Object.entries(normalisedWeights())) $(`weightValue-${k}`).textContent = `${fr(v * 100)} %`;
}
function updateScoreControls(name) {
  document.querySelectorAll("[data-score]").forEach(input => {
    input.value = state.scores[name][input.dataset.score];
    $(`scoreValue-${input.dataset.score}`).textContent = fr(input.value);
  });
}
function selectSite(name, pan = true) {
  state.selected = name;
  $("siteSelect").value = name;
  updateScoreControls(name);
  const f = findSite(name);
  if (pan) map.panTo([f.geometry.coordinates[1], f.geometry.coordinates[0]]);
  render();
}

/* ================= Affichage ================= */
function renderMap() {
  const hideLow = $("filterToggle").checked, ranks = rankMap(priority);
  for (const f of features()) {
    const name = f.properties.name, lv = level(priority(f)), marker = state.markers.get(name);
    marker.setIcon(markerIcon(lv.key, name === state.selected, ranks.get(name)));
    marker.bindPopup(popup(f));
    const show = !(hideLow && lv.key === "low");
    if (show && !sitesLayer.hasLayer(marker)) sitesLayer.addLayer(marker);
    if (!show && sitesLayer.hasLayer(marker)) sitesLayer.removeLayer(marker);
    const b = state.buffers.get(name);
    b.setRadius(state.radius); b.setStyle({ color: CONFIG.colors[lv.key], fillColor: CONFIG.colors[lv.key] });
  }
}

function renderSummary() {
  const ranked = [...features()].sort((a, b) => priority(b) - priority(a));
  const top = ranked[0], p = top.properties;
  const nbHigh = ranked.filter(f => level(priority(f)).key === "high").length;
  $("summaryText").innerHTML = `Sur ${ranked.length} sites, <strong>${nbHigh}</strong> sont de priorité élevée. Le plus urgent est <strong>${esc(p.name)}</strong> (${fr(priority(top))}/100) : seuls ${fr(p.sensitized_pct, 0)} % des habitants sont informés du risque.`;
}

function renderExplain(f) {
  const p = f.properties, w = normalisedWeights(), s = state.scores[p.name];
  const lv = level(priority(f));
  const cPhys = (1 - state.social) * physicalPct(susceptibility(f)), cSoc = state.social * socialUrgency(f), total = (cPhys + cSoc) || 1;
  const terrain = Object.keys(w).map(k => ({ k, c: w[k] * (s[k] - 1) })).sort((a, b) => b.c - a.c).slice(0, 2)
    .map(x => CONFIG.labels[x.k].toLowerCase()).join(" et ");
  const social = [
    ["une faible capacité à se protéger", 0.45 * (100 - p.ica)],
    ["une faible connaissance du danger", 0.35 * (100 - p.knowledge_danger_pct)],
    ["un faible niveau d’information", 0.20 * (100 - p.sensitized_pct)],
  ].sort((a, b) => b[1] - a[1])[0][0];
  const delta = priority(f) - priorityBase(f);
  const r0 = rankMap(priorityBase).get(p.name), r1 = rankMap(priority).get(p.name);
  const deltaTxt = Math.abs(delta) < 0.05 ? "" :
    ` <span class="delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "▲ +" : "▼ "}${fr(delta)} pt vs scénario de base${r0 !== r1 ? `, rang ${r0} → ${r1}` : ""}.</span>`;
  $("explainText").innerHTML = `<strong>${esc(p.name)}</strong> est de priorité ${lv.label.toLowerCase()}. Le terrain pèse pour ${fr(cPhys / total * 100, 0)} % (facteurs dominants : ${terrain}) et le contexte social pour ${fr(cSoc / total * 100, 0)} %, surtout à cause de ${social}.${deltaTxt}`;
  $("barPhys").style.width = `${cPhys / total * 100}%`;
  $("barSocial").style.width = `${cSoc / total * 100}%`;
}

function renderSelected() {
  const f = findSite(state.selected), p = f.properties, score = priority(f), lv = level(score);
  const [title, text] = recommendation(f);
  $("resultSite").textContent = p.name;
  $("priorityBadge").textContent = `Priorité ${lv.label.toLowerCase()}`;
  $("priorityBadge").className = `priority-badge ${lv.key}`;
  $("priorityScore").textContent = fr(score);
  $("gaugeValue").textContent = fr(score, 0);
  $("gauge").style.setProperty("--score", score);
  $("susceptibilityScore").textContent = fr(susceptibility(f), 2);
  $("susceptibilityNote").textContent = `sur 5 · ${p.susceptibility_label.toLowerCase()} · ${p.landcover_label.toLowerCase()}`;
  $("iprmScore").textContent = fr(p.iprm);
  $("icaScore").textContent = fr(p.ica);
  $("sensitizedScore").textContent = `${fr(p.sensitized_pct)} %`;
  const n = Number(p.n ?? p.n_respondents ?? p.respondents ?? p.effectif);
  if (n > 0) {
    const q = p.sensitized_pct / 100, z = 1.96, d = 1 + z * z / n;
    const c = (q + z * z / (2 * n)) / d, h = z * Math.sqrt(q * (1 - q) / n + z * z / (4 * n * n)) / d;
    $("sensitizedNote").textContent = `% des répondants · IC 95 % : ${fr((c - h) * 100, 0)} à ${fr((c + h) * 100, 0)} % (n = ${n})`;
  } else $("sensitizedNote").textContent = "% des répondants · effectif par site non fourni dans les données";
  $("recommendationTitle").textContent = title;
  $("recommendationText").textContent = text;
  renderExplain(f);
}

function renderRanking() {
  const base = rankMap(priorityBase);
  const ranked = [...features()].sort((a, b) => priority(b) - priority(a));
  $("rankingBody").innerHTML = ranked.map((f, i) => {
    const name = f.properties.name, s = priority(f), lv = level(s), move = base.get(name) - (i + 1);
    const arrow = move > 0 ? `<span class="rank-move up">▲${move}</span>` : move < 0 ? `<span class="rank-move down">▼${-move}</span>` : "";
    return `<tr data-site="${esc(name)}" class="${name === state.selected ? "selected" : ""}">
      <td>${i + 1}${arrow}</td><td>${esc(name)}</td>
      <td><strong>${fr(s)}</strong><span class="rank-bar"><i style="width:${s}%"></i></span></td>
      <td class="level-cell ${lv.key}">${LEVEL_SYMBOL[lv.key]} ${lv.label}</td></tr>`;
  }).join("");
}

function renderDecisionSignals() {
  const fs = features(), by = (fn) => [...fs].sort(fn)[0];
  const least = by((a, b) => a.properties.sensitized_pct - b.properties.sensitized_pct);
  const noWater = by((a, b) => a.properties.alternative_water_pct - b.properties.alternative_water_pct);
  const top = by((a, b) => priority(b) - priority(a));
  const combo = fs.filter(f => f.properties.susceptibility_class === 3).sort((a, b) => a.properties.ica - b.properties.ica)[0];
  $("decisionSignals").innerHTML = `
    <article><span>Priorité la plus élevée</span><strong>${esc(top.properties.name)}</strong><small>${fr(priority(top))}/100</small></article>
    <article><span>Moins d’habitants informés</span><strong>${esc(least.properties.name)}</strong><small>${fr(least.properties.sensitized_pct)} %</small></article>
    <article><span>Moins d’eau alternative</span><strong>${esc(noWater.properties.name)}</strong><small>${fr(noWater.properties.alternative_water_pct)} %</small></article>
    <article><span>Terrain à fort risque + faible protection</span><strong>${combo ? esc(combo.properties.name) : "Aucun site"}</strong><small>${combo ? `ICA ${fr(combo.properties.ica)}/100` : "—"}</small></article>`;
}
function renderUpdateLog() {
  $("updateLog").innerHTML = state.updateLog.map(i => `<div class="update-row"><strong>${esc(i.dataset)}</strong><span>${esc(i.date)} · ${esc(i.responsible)}</span><small>${esc(i.action)}</small></div>`).join("");
}
function render() {
  if (!state.data || !state.selected) return;
  renderMap(); renderSummary(); renderSelected(); renderRanking(); renderDecisionSignals(); renderRobust();
}

/* ================= Grille 30 m ================= */
function haversine(a, b) {
  const rad = v => v * Math.PI / 180, R = 6371;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}
function latLonToUtm30(lat, lon) {
  const a = 6378137.0, e2 = 0.00669438, k0 = 0.9996;
  const lr = lat * Math.PI / 180, lo = lon * Math.PI / 180, l0 = -3 * Math.PI / 180, ep2 = e2 / (1 - e2);
  const N = a / Math.sqrt(1 - e2 * Math.sin(lr) ** 2), T = Math.tan(lr) ** 2, C = ep2 * Math.cos(lr) ** 2, A = Math.cos(lr) * (lo - l0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * lr - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * lr) + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * lr) - (35 * e2 ** 3 / 3072) * Math.sin(6 * lr));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let y = k0 * (M + N * Math.tan(lr) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24 + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) y += 10000000;
  return [x, y];
}
function loadImageData(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => reject(new Error(`Impossible de charger ${url}`));
    img.src = url;
  });
}
function sampleGrid(latlng) {
  if (!state.grids) return null;
  const { meta, scoresA, scoresB, distanceA, distanceB } = state.grids;
  const [x, y] = latLonToUtm30(latlng.lat, latlng.lng);
  const [a, , c, , e, f] = meta.transform;
  const col = Math.floor((x - c) / a), row = Math.floor((y - f) / e);
  if (row < 0 || col < 0 || row >= meta.height || col >= meta.width) return null;
  const i = (row * meta.width + col) * 4;
  const factors = { geology: scoresA.data[i], soil: scoresA.data[i + 1], slope: scoresA.data[i + 2], hydro: scoresB.data[i] };
  if (Object.values(factors).some(v => v < 1 || v > 5)) return null;
  const dec = v => v === meta.distance_nodata ? null : v * meta.distance_unit_m;
  return {
    factors, susceptibilityClass: scoresB.data[i + 1], landcoverClass: scoresB.data[i + 2],
    distances: { "Végétation": dec(distanceA.data[i]), "Sol nu": dec(distanceA.data[i + 1]), "Habitat": dec(distanceA.data[i + 2]), "Eau": dec(distanceB.data[i]), "Culture": dec(distanceB.data[i + 1]) },
  };
}

/* ================= Diagnostic d'un point (un seul à la fois) ================= */
function diagnose(latlng) {
  const d = sampleGrid(latlng);
  if (!d) return null;
  const inside = Object.entries(d.distances).filter(([, v]) => v !== null && v <= state.radius).sort((a, b) => a[1] - b[1]);
  return {
    d, score: suscFrom(d.factors), inside,
    outside: Object.entries(d.distances).filter(([, v]) => v === null || v > state.radius).map(([k]) => k),
    niveau: CONFIG.susceptibility[d.susceptibilityClass] || "Non classée",
    key: CLASS_KEY[d.susceptibilityClass] || "medium",
    occupation: CONFIG.landcover[d.landcoverClass] || "Non classée",
  };
}

function showPoint(latlng, name = "") {
  pointLayer.clearLayers();                      // remplace toujours le point précédent
  $("dangerAlert").hidden = true;
  state.point = { latlng, name };
  const box = $("pointResult");
  box.hidden = false;
  const r = diagnose(latlng);
  L.circleMarker(latlng, { radius: 7, color: "#17221f", weight: 2, fillColor: r ? CONFIG.colors[r.key] : "#999", fillOpacity: 1 }).addTo(pointLayer);
  if (name) L.tooltip({ permanent: true, direction: "top", offset: [0, -8] }).setContent(esc(name)).setLatLng(latlng).addTo(pointLayer);
  if (!r) { box.innerHTML = "<strong>Point hors emprise</strong>Aucune valeur valide sur la grille physique transmise."; return; }
  L.circle(latlng, { radius: state.radius, color: "#17221f", dashArray: "5 5", weight: 1.2, fillOpacity: 0.025 }).addTo(pointLayer);
  const nearest = features().map(f => ({ f, km: haversine([latlng.lat, latlng.lng], [f.geometry.coordinates[1], f.geometry.coordinates[0]]) })).sort((a, b) => a.km - b.km);
  const nbSites = nearest.filter(n => n.km * 1000 <= state.radius).length;
  // Alerte : terrain classé « Forte » au point, ou site connu de priorité élevée dans le rayon
  const highNear = nearest.filter(n => n.km * 1000 <= state.radius && level(priority(n.f)).key === "high");
  const reasons = [];
  if (r.key === "high") reasons.push("le terrain à ce point est classé à risque <b style=\"display:inline;font-size:inherit\">fort</b>");
  if (highNear.length) reasons.push(`un site de priorité élevée est dans le rayon (${highNear.map(n => esc(n.f.properties.name)).join(", ")})`);
  if (reasons.length) {
    $("dangerAlert").innerHTML = `<b>⚠ ALERTE : ZONE À FORT RISQUE</b>${reasons.join(" ; ")}.<small>Risque plausible, pas contamination prouvée : vérification sur le terrain recommandée.</small>`;
    $("dangerAlert").hidden = false;
    L.marker(latlng, { icon: L.divIcon({ className: "", html: '<div class="pulse"></div>', iconSize: [40, 40], iconAnchor: [20, 20] }), interactive: false, keyboard: false }).addTo(pointLayer);
  }
  const rows = r.inside.length ? r.inside.map(([k, v]) => `<span>${k}<b>${v === 0 ? "sur le point" : `à ${fr(v, 0)} m`}</b></span>`).join("") : "<span>Aucune classe dans le rayon</span>";
  box.innerHTML = `<strong>${name ? esc(name) : "Diagnostic du point"}</strong>
    <div class="point-kpis">
      <span>Risque du terrain<b style="color:#fff">${fr(r.score, 2)} / 5</b></span>
      <span>Classe sur la carte<b>${r.niveau}</b></span>
      <span>Occupation au point<b>${r.occupation}</b></span>
      <span>Sites connus dans ${fr(state.radius, 0)} m<b>${nbSites}</b></span></div>
    <div class="distance-list"><em>Occupation du sol dans ${fr(state.radius, 0)} m</em>${rows}</div>
    ${r.outside.length ? `<small>Hors rayon : ${r.outside.join(", ")}</small>` : ""}
    <p>Site connu le plus proche : <b>${esc(nearest[0].f.properties.name)}</b> à ${fr(nearest[0].km, 2)} km.</p>
    <small>Diagnostic à 30 m à partir de quatre facteurs. Ce n’est pas une mesure de mercure et la présence dans le rayon ne prouve pas une contamination.</small>`;
}
function refreshPoint() { if (state.point) showPoint(state.point.latlng, state.point.name); }

function clearPoint() {
  pointLayer.clearLayers(); state.point = null; $("dangerAlert").hidden = true;
  $("pointResult").hidden = true; $("pointResult").innerHTML = "";
  ["orName", "orLat", "orLng"].forEach(id => $(id).value = "");
  $("orError").hidden = true;
}
function clearLot() { lotLayer.clearLayers(); state.lot = []; $("lotResult").innerHTML = ""; }

function parseCoord(text) {
  const s = String(text ?? "").trim();
  const nums = (s.match(/\d+(?:[.,]\d+)?/g) || []).map(n => parseFloat(n.replace(",", ".")));
  if (!nums.length) return NaN;
  const [d, m = 0, sec = 0] = nums;
  let v = d + m / 60 + sec / 3600;
  if (s.startsWith("-") || /[SWO]\s*$/i.test(s)) v = -v;
  return v;
}

/* Saisie manuelle */
$("orBtn").addEventListener("click", () => {
  const err = $("orError");
  if (!state.grids) { err.textContent = "Les données ne sont pas encore chargées."; err.hidden = false; return; }
  const lat = parseCoord($("orLat").value), lng = parseCoord($("orLng").value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    err.textContent = "Coordonnées invalides. Exemple : latitude 10.285 et longitude -3.205."; err.hidden = false; return;
  }
  if (lng > 0 && lat > 0 && lng < 10) { err.textContent = "Vérifiez la longitude : elle est négative à l’ouest de Greenwich, donc au Burkina (ex. -3.205)."; err.hidden = false; return; }
  err.hidden = true;
  const ll = L.latLng(lat, lng);
  showPoint(ll, $("orName").value.trim());
  map.setView(ll, Math.max(map.getZoom(), 13));
});
$("orClearBtn").addEventListener("click", clearPoint);
$("clearPointBtn").addEventListener("click", clearPoint);

$("orExportBtn").addEventListener("click", () => {
  if (!state.point) { window.alert("Diagnostiquez d’abord un point."); return; }
  const r = diagnose(state.point.latlng);
  if (!r) { window.alert("Point hors emprise : rien à exporter."); return; }
  const dist = k => r.d.distances[k] === null ? "hors portée" : Math.round(r.d.distances[k]);
  const name = state.point.name || "point";
  downloadCsv([
    ["nom", "latitude", "longitude", "date", "rayon_m", "classe_risque_terrain", "score_1_5", "geologie", "pedologie", "pente", "hydrographie", "occupation_au_point", "classes_dans_le_rayon", "dist_vegetation_m", "dist_sol_nu_m", "dist_habitat_m", "dist_eau_m", "dist_culture_m", "avertissement"],
    [name, state.point.latlng.lat.toFixed(6), state.point.latlng.lng.toFixed(6), new Date().toLocaleString("fr-FR"), state.radius, r.niveau, r.score.toFixed(2), r.d.factors.geology, r.d.factors.soil, r.d.factors.slope, r.d.factors.hydro, r.occupation, r.inside.map(([k]) => k).join(" | ") || "aucune", dist("Végétation"), dist("Sol nu"), dist("Habitat"), dist("Eau"), dist("Culture"), "Risque du terrain à 30 m ; ne mesure pas une concentration de mercure"],
  ], `diagnostic_${name.replace(/[^\w-]+/g, "_")}.csv`);
});

/* Clic sur la carte */
$("analysePointBtn").addEventListener("click", e => {
  state.mode = !state.mode;
  e.currentTarget.classList.toggle("active", state.mode);
  map.getContainer().style.cursor = state.mode ? "crosshair" : "";
  if (state.mode && !state.point) {
    $("pointResult").hidden = false;
    $("pointResult").innerHTML = "<strong>Mode analyse activé</strong>Cliquez sur la carte pour obtenir un diagnostic du point.";
  } else if (!state.mode && !state.point) $("pointResult").hidden = true;
});
map.on("click", e => {
  if (!state.mode) return;
  $("orLat").value = e.latlng.lat.toFixed(6); $("orLng").value = e.latlng.lng.toFixed(6); $("orName").value = "";
  showPoint(e.latlng);
});

/* Lot CSV */
$("lotInput").addEventListener("change", async event => {
  const box = $("lotResult"), file = event.target.files[0];
  if (!file) return;
  if (!state.grids) { box.textContent = "Les données ne sont pas encore chargées."; return; }
  const problems = [], points = [];
  if (!/\.csv$/i.test(file.name)) problems.push(`${file.name} : choisissez un fichier .csv`);
  else {
    const text = (await file.text()).replace(/^\ufeff/, "");
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      const parts = line.split(line.includes(";") ? ";" : ",").map(s => s.trim().replace(/^"|"$/g, ""));
      const lat = parseCoord(parts[1]), lng = parseCoord(parts[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { if (i > 0) problems.push(`ligne ${i + 1} : coordonnées illisibles`); return; }
      points.push({ nom: parts[0] || `Point ${points.length + 1}`, lat, lng });
    });
  }
  clearLot();
  state.lot = points.map(p => ({ ...p, r: diagnose(L.latLng(p.lat, p.lng)) }));
  state.lot.filter(p => p.r).forEach(p => L.circleMarker([p.lat, p.lng], { radius: 6, color: "#17221f", weight: 1.5, fillColor: CONFIG.colors[p.r.key], fillOpacity: 1 }).bindTooltip(`${esc(p.nom)} · ${p.r.niveau}`).addTo(lotLayer));
  const ok = state.lot.filter(p => p.r);
  if (ok.length) map.fitBounds(L.latLngBounds(ok.map(p => [p.lat, p.lng])).pad(.2));
  const lines = state.lot.map(p => p.r ? `<tr><td>${esc(p.nom)}</td><td style="color:${CONFIG.colors[p.r.key]}"><b>${p.r.niveau}</b></td><td>${fr(p.r.score, 2)}</td></tr>` : `<tr><td>${esc(p.nom)}</td><td colspan="2">hors emprise</td></tr>`).join("");
  box.innerHTML = `<b>${state.lot.length} point(s) diagnostiqué(s)</b><div style="max-height:220px;overflow:auto"><table><tr><th>Nom</th><th>Niveau</th><th>Score</th></tr>${lines}</table></div>${problems.length ? `<small>${problems.map(esc).join("<br>")}</small>` : ""}`;
  event.target.value = "";
});
$("lotClearBtn").addEventListener("click", clearLot);
$("lotExportBtn").addEventListener("click", () => {
  if (!state.lot.length) { window.alert("Importez d’abord un fichier CSV."); return; }
  downloadCsv([["nom", "latitude", "longitude", "classe_risque_terrain", "score_1_5", "occupation_au_point", "classes_dans_le_rayon", "rayon_m"],
    ...state.lot.map(p => p.r ? [p.nom, p.lat.toFixed(6), p.lng.toFixed(6), p.r.niveau, p.r.score.toFixed(2), p.r.occupation, p.r.inside.map(([k]) => k).join(" | ") || "aucune", state.radius] : [p.nom, p.lat.toFixed(6), p.lng.toFixed(6), "hors emprise", "", "", "", state.radius])],
    "diagnostic_lot.csv");
});

/* ================= Chargement ================= */
async function loadData() {
  const [sR, mR, lR, scoresA, scoresB, distanceA, distanceB] = await Promise.all([
    fetch("data/sites_indicateurs.geojson"), fetch("data/grid_metadata.json"), fetch("data/update_log.json"),
    loadImageData("data/grid_scores_a.png"), loadImageData("data/grid_scores_b.png"), loadImageData("data/grid_distance_a.png"), loadImageData("data/grid_distance_b.png"),
  ]);
  if (!sR.ok || !mR.ok || !lR.ok) throw new Error("Échec du chargement des données locales");
  state.data = await sR.json();
  const meta = await mR.json();
  state.updateLog = await lR.json();
  state.grids = { meta, scoresA, scoresB, distanceA, distanceB };
  renderUpdateLog();

  const susc = L.imageOverlay("data/overlay_susceptibility.png", meta.wgs84_bounds, { opacity: 0.68, interactive: false }).addTo(map);
  const land = L.imageOverlay("data/overlay_landcover.png", meta.wgs84_bounds, { opacity: 0.64, interactive: false });
  L.control.layers({ "Fond OpenStreetMap": streetLayer }, {
    "Risque du terrain": susc, "Occupation du sol": land, "Zones d’attention (rayons)": buffersLayer,
  }, { collapsed: true, position: "topright" }).addTo(map);

  const active = new Set(["Risque du terrain"]), box = $("layerLegend");
  const drawLegend = () => {
    box.hidden = !active.size;
    box.innerHTML = [...active].map(n => `<strong>${n}</strong>` + CONFIG.legends[n].map(([l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")).join("");
  };
  map.on("overlayadd", e => { if (CONFIG.legends[e.name]) { active.add(e.name); drawLegend(); } });
  map.on("overlayremove", e => { active.delete(e.name); drawLegend(); });
  drawLegend();

  for (const f of features()) {
    const name = f.properties.name;
    state.originalScores[name] = { ...f.properties.factor_scores };
    state.scores[name] = { ...f.properties.factor_scores };
    $("siteSelect").insertAdjacentHTML("beforeend", `<option value="${esc(name)}">${esc(name)}</option>`);
    const ll = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
    state.markers.set(name, L.marker(ll, { icon: markerIcon("medium", false, "") }).on("click", () => selectSite(name, false)).addTo(sitesLayer));
    state.buffers.set(name, L.circle(ll, { radius: state.radius, color: CONFIG.colors.medium, weight: 1.2, fillOpacity: .06 }).addTo(buffersLayer));
  }
  state.selected = features()[0].properties.name;
  updateScoreControls(state.selected);
  map.fitBounds(L.geoJSON(state.data).getBounds().pad(.18));
  render();
}

/* ================= Interface ================= */
buildControls();
$("siteSelect").addEventListener("change", e => selectSite(e.target.value));
$("resetWeights").addEventListener("click", () => {
  state.weights = { ...CONFIG.weights };
  document.querySelectorAll("[data-weight]").forEach(i => { i.value = state.weights[i.dataset.weight]; });
  updateWeightLabels(); render(); refreshPoint();
});
$("resetScores").addEventListener("click", () => {
  if (!state.selected) return;
  state.scores[state.selected] = { ...state.originalScores[state.selected] };
  updateScoreControls(state.selected); render();
});
$("radiusInput").addEventListener("input", e => {
  state.radius = Number(e.target.value);
  $("radiusValue").textContent = `${fr(state.radius, 0)} m`;
  renderMap(); refreshPoint();
});
$("filterToggle").addEventListener("change", render);
$("fitBtn").addEventListener("click", () => map.fitBounds(L.geoJSON(state.data).getBounds().pad(.18)));
$("rankingBody").addEventListener("click", e => { const r = e.target.closest("tr[data-site]"); if (r) selectSite(r.dataset.site); });

$("exportBtn").addEventListener("click", () => {
  downloadCsv([["rang", "site", "classe_risque_terrain", "risque_terrain_1_5", "urgence_sociale_0_100", "priorite_0_100", "occupation_au_point", "niveau"],
    ...[...features()].sort((a, b) => priority(b) - priority(a)).map((f, i) => {
      const p = f.properties, s = priority(f);
      return [i + 1, p.name, p.susceptibility_label, susceptibility(f).toFixed(3), socialUrgency(f).toFixed(2), s.toFixed(2), p.landcover_label, level(s).label];
    })], "classement_priorite_gaoua.csv");
});

$("geojsonInput").addEventListener("change", event => {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (state.importedLayer) map.removeLayer(state.importedLayer);
      state.importedLayer = L.geoJSON(data, {
        style: { color: "#2563eb", weight: 2, fillOpacity: .1 },
        pointToLayer: (_, ll) => L.circleMarker(ll, { radius: 6, color: "#2563eb", fillOpacity: .8 }),
      }).addTo(map);
      map.fitBounds(state.importedLayer.getBounds().pad(.1));
    } catch (err) { window.alert(`GeoJSON invalide : ${err.message}`); }
  };
  reader.readAsText(file);
});

/* Onglets */
function showTab(name) {
  document.querySelectorAll(".controls [data-tab]").forEach(s => { s.hidden = s.dataset.tab !== name; });
  document.querySelectorAll(".tabs [data-go]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.go === name)));
}
document.querySelector(".tabs").addEventListener("click", e => { if (e.target.dataset.go) showTab(e.target.dataset.go); });

/* Guide de première visite */
let seen = false;
try { seen = !!sessionStorage.getItem("guideVu"); } catch (_) {}
$("guide").hidden = seen;
$("guideClose").addEventListener("click", () => { $("guide").hidden = true; try { sessionStorage.setItem("guideVu", "1"); } catch (_) {} });
$("helpBtn").addEventListener("click", () => { $("guide").hidden = false; });

loadData().catch(error => {
  $("pointResult").hidden = false;
  $("pointResult").textContent = `${error.message}. Lancez le dossier avec un serveur HTTP local.`;
  console.error(error);
});

/* ================= Stabilité du classement (poids variés de ±20 %) ================= */
function renderRobust() {
  const keys = Object.keys(CONFIG.weights), N = 500;
  let seed = 12345;                                   // graine fixe : le résultat ne change pas à chaque affichage
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const now = [...features()].sort((a, b) => priority(b) - priority(a));
  const topName = now[0].properties.name, selRank = now.findIndex(f => f.properties.name === state.selected);
  let topSame = 0, selSame = 0;
  for (let i = 0; i < N; i++) {
    const w = {}; keys.forEach(k => { w[k] = state.weights[k] * (0.8 + 0.4 * rnd()); });
    const nw = weightsFrom(w);
    const sc = features().map(f => ({ n: f.properties.name, s: (1 - state.social) * physicalPct(suscFrom(state.scores[f.properties.name], nw)) + state.social * socialUrgency(f) })).sort((a, b) => b.s - a.s);
    if (sc[0].n === topName) topSame++;
    if (sc.findIndex(x => x.n === state.selected) === selRank) selSame++;
  }
  const pt = Math.round(topSame / N * 100), ps = Math.round(selSame / N * 100);
  $("robustText").innerHTML = `Si l’on fait varier l’importance de chaque critère de ±20 % (${N} simulations), <strong>${esc(topName)}</strong> reste en tête dans <strong>${pt} %</strong> des cas, et le rang de <strong>${esc(state.selected)}</strong> (n° ${selRank + 1}) reste inchangé dans <strong>${ps} %</strong> des cas. ${pt >= 80 ? "Le résultat est peu sensible aux poids." : "Le résultat dépend nettement des poids : à signaler."}`;
}

/* ================= Scénarios prêts à l'emploi ================= */
const PRESETS = {
  base:  CONFIG.weights,
  slope: { geology: 8, soil: 20, slope: 60, hydro: 12 },
  soil:  { geology: 8, soil: 60, slope: 20, hydro: 12 },
  hydro: { geology: 7, soil: 20, slope: 18, hydro: 55 },
  social: CONFIG.weights,   // mêmes poids, mais le contexte social passe à 60 %
};
function showSocialNote() { $("socialNote").textContent = `Part du contexte social dans la priorité : ${fr(state.social * 100, 0)} % (35 % par défaut).`; }
$("resetWeights").addEventListener("click", () => { state.social = 0.35; showSocialNote(); render(); });
showSocialNote();
document.querySelector(".presets").addEventListener("click", e => {
  const key = e.target.dataset.preset; if (!key) return;
  state.weights = { ...PRESETS[key] };
  state.social = key === "social" ? 0.60 : 0.35;
  showSocialNote();
  document.querySelectorAll("[data-weight]").forEach(i => { i.value = state.weights[i.dataset.weight]; });
  document.querySelectorAll(".presets button").forEach(b => b.setAttribute("aria-pressed", String(b === e.target)));
  updateWeightLabels(); render(); refreshPoint();
});
document.querySelectorAll("#weightControls, #resetWeights").forEach(el => el.addEventListener(el.id === "resetWeights" ? "click" : "input", () => document.querySelectorAll(".presets button").forEach(b => b.setAttribute("aria-pressed", "false"))));

/* ================= Méthode et à propos ================= */
// ⚠ À compléter par vos soins : auteur, encadreur, sources
const ABOUT = { auteur: "À compléter : nom de l’auteur", encadreur: "À compléter : nom de l’encadreur", etablissement: "À compléter : établissement" };
$("aboutBtn").addEventListener("click", () => {
  $("aboutSources").innerHTML = state.updateLog.length ? state.updateLog.map(i => `<b>${esc(i.dataset)}</b> · ${esc(i.date)} · ${esc(i.responsible)}<br>${esc(i.action)}`).join("<br><br>") : "Journal de mise à jour non chargé.";
  $("aboutPeople").innerHTML = `${esc(ABOUT.auteur)}<br>${esc(ABOUT.encadreur)}<br>${esc(ABOUT.etablissement)}`;
  $("about").hidden = false;
});
$("aboutClose").addEventListener("click", () => { $("about").hidden = true; });

/* ================= Mode présentation ================= */
$("presentBtn").addEventListener("click", e => {
  const on = document.body.classList.toggle("present");
  e.currentTarget.textContent = on ? "Quitter la présentation" : "Mode présentation";
  setTimeout(() => { map.invalidateSize(); }, 150);
});

/* ================= Rapport imprimable du site ================= */
function miniMapSvg() {
  const fs = features(), W = 700, H = 300, m = 40;
  const xs = fs.map(f => f.geometry.coordinates[0]), ys = fs.map(f => f.geometry.coordinates[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = v => m + (x1 === x0 ? (W - 2 * m) / 2 : (v - x0) / (x1 - x0) * (W - 2 * m));
  const sy = v => H - m - (y1 === y0 ? (H - 2 * m) / 2 : (v - y0) / (y1 - y0) * (H - 2 * m));
  const ranks = rankMap(priority);
  const items = fs.map(f => {
    const n = f.properties.name, lv = level(priority(f)).key, x = sx(f.geometry.coordinates[0]), y = sy(f.geometry.coordinates[1]);
    const sel = n === state.selected, col = CONFIG.colors[lv], r = sel ? 14 : 11;
    const shape = lv === "high" ? `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" rx="2" fill="${col}"/>` : lv === "medium" ? `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" rx="${r * .6}" fill="${col}"/>` : `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`;
    return `${shape}${sel ? `<circle cx="${x}" cy="${y}" r="${r + 5}" fill="none" stroke="#17221f" stroke-width="2"/>` : ""}<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${ranks.get(n)}</text><text x="${x}" y="${y + r + 15}" text-anchor="middle" font-size="11" fill="#17221f">${esc(n)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="border:1px solid #ccc;border-radius:6px;background:#f4f7f5"><text x="10" y="18" font-size="11" fill="#555">Nord ↑ · schéma sans échelle · numéro = rang · ● faible ▪ modérée ■ élevée</text>${items}</svg>`;
}
$("reportBtn").addEventListener("click", () => {
  if (!state.data || !state.selected) return;
  const f = findSite(state.selected), p = f.properties, s = priority(f), lv = level(s), [title, text] = recommendation(f);
  const rows = [...features()].sort((a, b) => priority(b) - priority(a)).map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.properties.name)}</td><td>${fr(priority(x))}</td><td>${level(priority(x)).label}</td></tr>`).join("");
  const w = window.open("", "_blank");
  if (!w) { window.alert("Autorisez les fenêtres pop-up pour ce site, puis recommencez."); return; }
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Rapport ${esc(p.name)}</title>
  <style>body{font:14px/1.55 Arial,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#17221f}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}
  table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left}.k{display:grid;grid-template-columns:1fr 1fr;gap:8px}.k div{border:1px solid #ccc;padding:8px;border-radius:6px}.k b{display:block;font-size:18px}
  .w{background:#fff7df;border:1px solid #f7d68b;padding:8px 10px;border-radius:6px}</style></head><body>
  <h1>MercureScope Gaoua · ${esc(p.name)}</h1><p>Priorité d’intervention <b>${lv.label.toLowerCase()}</b> : <b>${fr(s)} / 100</b> · édité le ${new Date().toLocaleDateString("fr-FR")}</p>
  <h2>Pourquoi ce résultat</h2><p>${$("explainText").innerHTML}</p><p>${$("robustText").innerHTML}</p>
  <h2>Position des sites</h2>${miniMapSvg()}
  <h2>Indicateurs</h2><div class="k"><div>Risque du terrain<b>${fr(susceptibility(f), 2)} / 5</b></div><div>Connaissance du danger<b>${fr(p.iprm)} / 100</b></div><div>Capacité à se protéger<b>${fr(p.ica)} / 100</b></div><div>Habitants informés<b>${fr(p.sensitized_pct)} %</b></div></div>
  <h2>Action suggérée : ${esc(title)}</h2><p>${esc(text)}</p>
  <h2>Classement des sites</h2><table><tr><th>Rang</th><th>Site</th><th>Priorité</th><th>Niveau</th></tr>${rows}</table>
  <h2>Limites</h2><p class="w">Ce rapport indique où le risque est plausible, pas où la contamination est prouvée. Priorité = ${fr((1 - state.social) * 100, 0)} % risque du terrain + ${fr(state.social * 100, 0)} % urgence sociale. Données d’enquête 2026 (253 répondants), grille physique de 30 m.</p>
  </body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
});

/* Clignotement de l'alerte (par minuteur : indépendant des réglages d'animation du système) */
setInterval(() => {
  const a = $("dangerAlert");
  if (a.hidden) a.classList.remove("off"); else a.classList.toggle("off");
}, 500);
