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
  point: null,
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

// Classe physique calculée pour les cinq sites à partir de leur score WLC.
// Seuil opérationnel : score >= 3/5 = Forte ; score < 3/5 = Moyenne.
// Cette classe de site est distincte de la classe de la grille raster affichée en fond.
function physicalSiteClass(f) {
  const score = susceptibility(f);
  return score >= 3
    ? { key: "high", label: "Forte" }
    : { key: "medium", label: "Moyenne" };
}

function socialUrgency(f) {
  const p = f.properties;
  return 0.45 * (100 - p.ica) + 0.35 * (100 - p.knowledge_danger_pct) + 0.20 * (100 - p.sensitized_pct);
}
const physicalPct = s => ((s - 1) / 4) * 100;
state.social = 0.35;
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
    <span>Classe physique du site<strong>${physicalSiteClass(f).label}</strong></span>
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
    b.setRadius(state.radius);
    b.setStyle({ color: CONFIG.colors[lv.key], fillColor: CONFIG.colors[lv.key] });
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
  $("susceptibilityNote").textContent = `sur 5 · classe physique ${physicalSiteClass(f).label.toLowerCase()} · ${p.landcover_label.toLowerCase()}`;
  $("iprmScore").textContent = fr(p.iprm);
  $("icaScore").textContent = fr(p.ica);
  $("sensitizedScore").textContent = `${fr(p.sensitized_pct)} %`;
  const n = Number(p.n ?? p.n_respondents ?? p.respondents ?? p.effectif);
