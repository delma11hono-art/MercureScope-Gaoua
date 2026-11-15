
"use strict";

/* =========================================================
   MERCURESCOPE GAOUA — SCRIPT PRINCIPAL
   Données : data/sites_indicators.geojson
             data/update_log.json
   ========================================================= */

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

/* ================= CONFIGURATION ================= */

const CONFIG = {
  weights: {
    geology: 7.51,
    soil: 36.45,
    slope: 38.47,
    hydro: 17.57
  },

  labels: {
    geology: "Géologie",
    soil: "Pédologie",
    slope: "Pente",
    hydro: "Hydrographie"
  },

  landcover: {
    1: "Végétation",
    2: "Sol nu",
    3: "Habitat",
    4: "Eau",
    5: "Culture"
  },

  susceptibility: {
    1: "Faible",
    2: "Moyenne",
    3: "Forte"
  },

  colors: {
    low: "#2f855a",
    medium: "#d97706",
    high: "#b42318"
  },

  center: [10.285, -3.205],

  legends: {
    "Susceptibilité physique": [
      ["Faible", "#2f855a"],
      ["Moyenne", "#d97706"],
      ["Forte", "#b42318"]
    ],

    "Occupation du sol": [
      ["Végétation", "#2f855a"],
      ["Sol nu", "#c2a36b"],
      ["Habitat", "#b42318"],
      ["Eau", "#2563eb"],
      ["Culture", "#d9f99d"]
    ]
  }
};

const $ = id => document.getElementById(id);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const fr = (v, d = 1) =>
  Number(v || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: d,
    maximumFractionDigits: d
  });

const esc = v =>
  String(v ?? "").replace(/[&<>'"]/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  }[c]));

const setText = (id, value) => {
  if ($(id)) $(id).textContent = value;
};

const setHTML = (id, value) => {
  if ($(id)) $(id).innerHTML = value;
};

const features = () => state.data?.features || [];

const findSite = name =>
  features().find(f => f.properties.name === name);


/* ================= ÉTAT DE L'APPLICATION ================= */

const state = {
  data: null,
  selected: null,

  weights: { ...CONFIG.weights },
  scores: {},
  originalScores: {},

  markers: new Map(),
  buffers: new Map(),

  importedLayer: null,
  overlays: [],
  layerControl: null,

  social: 0.35,
  radius: 2000,

  point: null,
  lot: [],

  updateLog: []
};


/* ================= INITIALISATION DE LA CARTE ================= */

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true
}).setView(CONFIG.center, 11);

const streetLayer = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution: "&copy; contributeurs OpenStreetMap"
  }
).addTo(map);

const sitesLayer = L.layerGroup().addTo(map);
const buffersLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const lotLayer = L.layerGroup().addTo(map);


/* ================= UTILITAIRES ================= */

function downloadCsv(rows, filename) {
  const csv = rows.map(row =>
    row.map(value =>
      `"${String(value ?? "").replaceAll('"', '""')}"`
    ).join(";")
  ).join("\n");

  const blob = new Blob(
    ["\ufeff" + csv],
    { type: "text/csv;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}

function downloadJson(data, filename) {
  const blob = new Blob(
    [JSON.stringify(data, null, 2)],
    { type: "application/geo+json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}

async function loadJson(path) {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Impossible de charger ${path}`);
  }

  return response.json();
}

function getLandcoverLabel(p) {
  return p.landcover_label ||
    CONFIG.landcover[p.landcover_class] ||
    "Non renseignée";
}


/* ================= CALCULS PHYSIQUES ET SOCIAUX ================= */

function weightsFrom(raw) {
  const total =
    Object.values(raw).reduce((a, b) => a + Number(b), 0) || 1;

  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      Number(value) / total
    ])
  );
}

const normalisedWeights = () => weightsFrom(state.weights);

function suscFrom(values, weights = normalisedWeights()) {
  if (!values) return 0;

  return Object.keys(weights).reduce(
    (sum, key) =>
      sum + weights[key] * Number(values[key] || 0),
    0
  );
}

function susceptibility(f) {
  return suscFrom(state.scores[f.properties.name]);
}

function physicalSiteClass(f) {
  const score = susceptibility(f);

  if (score >= 3) {
    return { key: "high", label: "Forte" };
  }

  return { key: "medium", label: "Moyenne" };
}

function socialUrgency(f) {
  const p = f.properties;

  const ica = Number(p.ica || 0);
  const knowledge = Number(p.knowledge_danger_pct || 0);
  const sensitized = Number(p.sensitized_pct || 0);

  return (
    0.45 * (100 - ica) +
    0.35 * (100 - knowledge) +
    0.20 * (100 - sensitized)
  );
}

const physicalPct = score =>
  ((score - 1) / 4) * 100;

const priority = f =>
  clamp(
    (1 - state.social) * physicalPct(susceptibility(f)) +
    state.social * socialUrgency(f),
    0,
    100
  );

const priorityBase = f =>
  clamp(
    0.65 *
    physicalPct(
      suscFrom(
        state.originalScores[f.properties.name],
        weightsFrom(CONFIG.weights)
      )
    ) +
    0.35 * socialUrgency(f),
    0,
    100
  );

function level(score) {
  if (score >= 60) {
    return { key: "high", label: "Élevée" };
  }

  if (score >= 40) {
    return { key: "medium", label: "Modérée" };
  }

  return { key: "low", label: "Faible" };
}

function rankMap(fn) {
  const result = new Map();

  [...features()]
    .sort((a, b) => fn(b) - fn(a))
    .forEach((f, index) => {
      result.set(f.properties.name, index + 1);
    });

  return result;
}

function recommendation(f) {
  const p = f.properties;
  const lv = level(priority(f));

  if (lv.key === "high" && Number(p.sensitized_pct) < 10) {
    return [
      "Vérifier sur le terrain et sensibiliser",
      "Programmer une mission de contrôle, documenter les usages de l'eau et organiser une sensibilisation de proximité. La susceptibilité du terrain ne constitue pas une mesure de contamination."
    ];
  }

  if (Number(p.ica) < 35) {
    return [
      "Renforcer la capacité à se protéger",
      "Prioriser une source d'eau de remplacement, des relais communautaires et des pratiques sans mercure, puis suivre les indicateurs dans le temps."
    ];
  }

  return [
    "Surveiller",
    "Maintenir une veille, actualiser les couches physiques et contrôler les indicateurs sociaux avant toute décision."
  ];
}


/* ================= MARQUEURS ET POPUPS ================= */

function markerIcon(lv, selected, rank) {
  const size = selected ? 28 : 23;

  return L.divIcon({
    className: "",
    html: `
      <div class="site-marker ${lv}"
           style="
             width:${size}px;
             height:${size}px;
             background:${CONFIG.colors[lv]};
           ">
        ${rank}
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -10]
  });
}

function popup(f) {
  const p = f.properties;
  const score = priority(f);
  const lv = level(score);

  return `
    <h3 class="popup-title">${esc(p.name)}</h3>

    <div class="popup-kpis">

      <span>
        Priorité
        <strong style="color:${CONFIG.colors[lv.key]}">
          ${fr(score)} / 100
        </strong>
      </span>

      <span>
        Susceptibilité physique
        <strong>${fr(susceptibility(f), 2)} / 5</strong>
      </span>

      <span>
        Classe physique du site
        <strong>${physicalSiteClass(f).label}</strong>
      </span>

      <span>
        Occupation au point
        <strong>${esc(getLandcoverLabel(p))}</strong>
      </span>

      <span>
        Perception du risque (IPRM)
        <strong>${fr(p.iprm)} / 100</strong>
      </span>

      <span>
        Capacité à se protéger (ICA)
        <strong>${fr(p.ica)} / 100</strong>
      </span>

      <span>
        Personnes enquêtées
        <strong>${Number(p.survey_n || 0)}</strong>
      </span>

    </div>
  `;
}


/* ================= CONTRÔLES DES SCÉNARIOS ================= */

function buildControls() {
  if (!$("weightControls") || !$("scoreControls")) return;

  $("weightControls").innerHTML = "";
  $("scoreControls").innerHTML = "";

  for (const key of Object.keys(CONFIG.weights)) {
    $("weightControls").insertAdjacentHTML(
      "beforeend",
      `
        <div class="range-row">
          <div class="range-label">
            <span>${CONFIG.labels[key]}</span>
            <strong id="weightValue-${key}">
              ${fr(normalisedWeights()[key] * 100)} %
            </strong>
          </div>

          <input
            type="range"
            min="1"
            max="70"
            step="0.5"
            value="${state.weights[key]}"
            data-weight="${key}"
            aria-label="Importance : ${CONFIG.labels[key]}"
          >
        </div>
      `
    );

    $("scoreControls").insertAdjacentHTML(
      "beforeend",
      `
        <div class="range-row">
          <div class="range-label">
            <span>${CONFIG.labels[key]}</span>
            <strong id="scoreValue-${key}">—</strong>
          </div>

          <input
            type="range"
            min="1"
            max="5"
            step="0.5"
            value="3"
            data-score="${key}"
            aria-label="Note : ${CONFIG.labels[key]}"
          >
        </div>
      `
    );
  }

  $("weightControls").addEventListener("input", event => {
    const key = event.target.dataset.weight;

    if (!key) return;

    state.weights[key] = Number(event.target.value);

    updateWeightLabels();
    render();
    refreshPoint();
  });

  $("scoreControls").addEventListener("input", event => {
    const key = event.target.dataset.score;

    if (!key || !state.selected) return;

    state.scores[state.selected][key] =
      Number(event.target.value);

    setText(`scoreValue-${key}`, fr(event.target.value));

    render();
  });
}

function updateWeightLabels() {
  for (const [key, value] of Object.entries(normalisedWeights())) {
    setText(`weightValue-${key}`, `${fr(value * 100)} %`);
  }
}

function updateScoreControls(name) {
  const scores = state.scores[name];

  if (!scores) return;

  document.querySelectorAll("[data-score]").forEach(input => {
    input.value = scores[input.dataset.score];

    setText(
      `scoreValue-${input.dataset.score}`,
      fr(input.value)
    );
  });
}

function selectSite(name, pan = true) {
  const f = findSite(name);

  if (!f) return;

  state.selected = name;

  if ($("siteSelect")) {
    $("siteSelect").value = name;
  }

  updateScoreControls(name);

  if (pan) {
    map.panTo([
      f.geometry.coordinates[1],
      f.geometry.coordinates[0]
    ]);
  }

  render();
}


/* ================= AFFICHAGE DE LA CARTE ================= */

function renderMap() {
  if (!state.data) return;

  const hideLow = $("filterToggle")?.checked || false;
  const ranks = rankMap(priority);

  for (const f of features()) {
    const name = f.properties.name;
    const lv = level(priority(f));
    const marker = state.markers.get(name);
    const buffer = state.buffers.get(name);

    if (!marker || !buffer) continue;

    marker.setIcon(
      markerIcon(
        lv.key,
        name === state.selected,
        ranks.get(name)
      )
    );

    marker.bindPopup(popup(f));

    const show = !(hideLow && lv.key === "low");

    if (show && !sitesLayer.hasLayer(marker)) {
      sitesLayer.addLayer(marker);
    }

    if (!show && sitesLayer.hasLayer(marker)) {
      sitesLayer.removeLayer(marker);
    }

    buffer.setRadius(state.radius);

    buffer.setStyle({
      color: CONFIG.colors[lv.key],
      fillColor: CONFIG.colors[lv.key]
    });
  }

  if ($("bufferToggle")?.checked) {
    if (!map.hasLayer(buffersLayer)) {
      buffersLayer.addTo(map);
    }
  } else {
    if (map.hasLayer(buffersLayer)) {
      map.removeLayer(buffersLayer);
    }
  }
}

function renderSummary() {
  const ranked = [...features()]
    .sort((a, b) => priority(b) - priority(a));

  if (!ranked.length) return;

  const top = ranked[0];
  const p = top.properties;

  const nbHigh = ranked.filter(
    f => level(priority(f)).key === "high"
  ).length;

  setHTML(
    "summaryText",
    `
      Sur ${ranked.length} sites, <strong>${nbHigh}</strong>
      présentent une priorité élevée.
      Le site présentant la priorité la plus élevée est
      <strong>${esc(p.name)}</strong>
      (${fr(priority(top))}/100).
      Le niveau de sensibilisation déclaré est de
      ${fr(p.sensitized_pct, 0)} %.
    `
  );
}

function renderExplain(f) {
  const p = f.properties;
  const w = normalisedWeights();
  const scores = state.scores[p.name];

  const lv = level(priority(f));

  const cPhys =
    (1 - state.social) * physicalPct(susceptibility(f));

  const cSoc =
    state.social * socialUrgency(f);

  const total = cPhys + cSoc || 1;

  const terrain = Object.keys(w)
    .map(key => ({
      key,
      contribution: w[key] * (scores[key] - 1)
    }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 2)
    .map(item => CONFIG.labels[item.key].toLowerCase())
    .join(" et ");

  const socialFactors = [
    [
      "une faible capacité à se protéger",
      0.45 * (100 - Number(p.ica || 0))
    ],
    [
      "une faible perception du risque",
      0.35 * (100 - Number(p.knowledge_danger_pct || 0))
    ],
    [
      "un faible niveau de sensibilisation",
      0.20 * (100 - Number(p.sensitized_pct || 0))
    ]
  ].sort((a, b) => b[1] - a[1]);

  const social = socialFactors[0][0];

  const delta = priority(f) - priorityBase(f);

  const r0 = rankMap(priorityBase).get(p.name);
  const r1 = rankMap(priority).get(p.name);

  const deltaTxt =
    Math.abs(delta) < 0.05
      ? ""
      : `
        <span class="delta ${delta > 0 ? "up" : "down"}">
          ${delta > 0 ? "▲ +" : "▼ "}
          ${fr(delta)} pt par rapport au scénario de base
          ${r0 !== r1 ? `, rang ${r0} → ${r1}` : ""}.
        </span>
      `;

  setHTML(
    "explainText",
    `
      <strong>${esc(p.name)}</strong> présente une priorité
      ${lv.label.toLowerCase()}.

      La composante physique représente
      ${fr(cPhys / total * 100, 0)} % de la priorité
      (facteurs dominants : ${terrain}).

      La composante sociale représente
      ${fr(cSoc / total * 100, 0)} %,
      principalement en raison de ${social}.
      ${deltaTxt}
    `
  );

  if ($("barPhys")) {
    $("barPhys").style.width =
      `${cPhys / total * 100}%`;
  }

  if ($("barSocial")) {
    $("barSocial").style.width =
      `${cSoc / total * 100}%`;
  }
}

function renderSelected() {
  const f = findSite(state.selected);

  if (!f) return;

  const p = f.properties;
  const score = priority(f);
  const lv = level(score);

  const [title, text] = recommendation(f);

  setText("resultSite", p.name);
  setText("priorityBadge", `Priorité ${lv.label.toLowerCase()}`);

  if ($("priorityBadge")) {
    $("priorityBadge").className =
      `priority-badge ${lv.key}`;
  }

  setText("priorityScore", fr(score));
  setText("gaugeValue", fr(score, 0));

  if ($("gauge")) {
    $("gauge").style.setProperty("--score", score);
  }

  setText(
    "susceptibilityScore",
    fr(susceptibility(f), 2)
  );

  setText(
    "susceptibilityNote",
    `sur 5 · classe physique ${physicalSiteClass(f).label.toLowerCase()} · ${getLandcoverLabel(p).toLowerCase()}`
  );

  setText("iprmScore", fr(p.iprm));
  setText("icaScore", fr(p.ica));

  setText(
    "sensitizedScore",
    `${fr(p.sensitized_pct)} %`
  );

  const n = Number(
    p.survey_n ??
    p.n ??
    p.n_respondents ??
    p.respondents ??
    p.effectif ??
    0
  );

  if ($("sensitizedNote")) {
    $("sensitizedNote").textContent =
      `Indicateur calculé sur ${n} personnes enquêtées.`;
  }

  setText("recommendationTitle", title);
  setText("recommendationText", text);

  renderExplain(f);
}


/* ================= CLASSEMENT DES SITES ================= */

function renderRanking() {
  if (!$("rankingBody")) return;

  const ranked = [...features()]
    .sort((a, b) => priority(b) - priority(a));

  $("rankingBody").innerHTML = ranked.map((f, index) => {
    const p = f.properties;
    const score = priority(f);
    const lv = level(score);

    return `
      <tr data-site="${esc(p.name)}">
        <td>${index + 1}</td>
        <td>${esc(p.name)}</td>
        <td>${fr(score)}</td>
        <td>
          <span class="priority-badge ${lv.key}">
            ${lv.label}
          </span>
        </td>
      </tr>
    `;
  }).join("");

  $("rankingBody").querySelectorAll("tr").forEach(row => {
    row.addEventListener("click", () => {
      selectSite(row.dataset.site);
    });
  });
}


/* ================= SIGNAUX DE DÉCISION ================= */

function renderDecisionSignals() {
  if (!$("decisionSignals")) return;

  const ranked = [...features()]
    .sort((a, b) => priority(b) - priority(a));

  const high = ranked.filter(
    f => level(priority(f)).key === "high"
  );

  const weakICA = ranked.filter(
    f => Number(f.properties.ica) < 35
  );

  const lowSensitization = ranked.filter(
    f => Number(f.properties.sensitized_pct) < 10
  );

  $("decisionSignals").innerHTML = `
    <div class="signal-item">
      <strong>${high.length}</strong>
      <span>site(s) de priorité élevée</span>
    </div>

    <div class="signal-item">
      <strong>${weakICA.length}</strong>
      <span>site(s) avec une capacité d'adaptation faible</span>
    </div>

    <div class="signal-item">
      <strong>${lowSensitization.length}</strong>
      <span>site(s) avec moins de 10 % de personnes sensibilisées</span>
    </div>
  `;
}


/* ================= LÉGENDE ================= */

function renderLegend() {
  if (!$("layerLegend")) return;

  $("layerLegend").innerHTML = `
    <strong>Priorité des sites</strong>

    <div class="legend-row">
      <span class="legend-color" style="background:${CONFIG.colors.low}"></span>
      Faible
    </div>

    <div class="legend-row">
      <span class="legend-color" style="background:${CONFIG.colors.medium}"></span>
      Modérée
    </div>

    <div class="legend-row">
      <span class="legend-color" style="background:${CONFIG.colors.high}"></span>
      Élevée
    </div>
  `;
}


/* ================= RENDU GÉNÉRAL ================= */

function render() {
  if (!state.data || !state.selected) return;

  renderMap();
  renderSummary();
  renderSelected();
  renderRanking();
  renderDecisionSignals();
  renderLegend();
}


/* ================= INITIALISATION DES DONNÉES ================= */

function initializeSites() {
  const list = features();

  if (!list.length) {
    throw new Error("Aucun site trouvé dans le GeoJSON.");
  }

  for (const f of list) {
    const p = f.properties;

    const scores = p.factor_scores || {
      geology: p.geology,
      soil: p.soil,
      slope: p.slope,
      hydro: p.hydro
    };

    state.scores[p.name] = {
      geology: Number(scores.geology ?? 3),
      soil: Number(scores.soil ?? 3),
      slope: Number(scores.slope ?? 3),
      hydro: Number(scores.hydro ?? 3)
    };

    state.originalScores[p.name] = {
      ...state.scores[p.name]
    };

    const coordinates = [
      f.geometry.coordinates[1],
      f.geometry.coordinates[0]
    ];

    const marker = L.marker(coordinates, {
      icon: markerIcon("medium", false, 1)
    });

    marker.on("click", () => {
      selectSite(p.name, false);
    });

    state.markers.set(p.name, marker);

    const buffer = L.circle(coordinates, {
      radius: state.radius,
      color: CONFIG.colors.medium,
      fillColor: CONFIG.colors.medium,
      fillOpacity: 0.08,
      weight: 1
    });

    state.buffers.set(p.name, buffer);

    buffersLayer.addLayer(buffer);
  }

  const first = list[0].properties.name;

  state.selected = first;

  if ($("siteSelect")) {
    $("siteSelect").innerHTML = list.map(f => `
      <option value="${esc(f.properties.name)}">
        ${esc(f.properties.name)}
      </option>
    `).join("");

    $("siteSelect").value = first;
  }

  if ($("siteSelect")) {
    $("siteSelect").addEventListener("change", event => {
      selectSite(event.target.value);
    });
  }

  updateScoreControls(first);
}


/* ================= COUCHES RASTER PNG ================= */

async function loadRasterOverlays() {
  try {
    const metadata = await loadJson("data/grid_metadata.json");

    const bounds = [
      [
        metadata.wgs84_bounds[0][0],
        metadata.wgs84_bounds[0][1]
      ],
      [
        metadata.wgs84_bounds[1][0],
        metadata.wgs84_bounds[1][1]
      ]
    ];

    const overlays = [
      {
        name: "Susceptibilité physique",
        path: "data/overlay_susceptibility.png"
      },
      {
        name: "Occupation du sol",
        path: "data/overlay_landcover.png"
      }
    ];

    for (const item of overlays) {
      try {
        const response = await fetch(item.path);

        if (!response.ok) continue;

        const layer = L.imageOverlay(
          item.path,
          bounds,
          { opacity: 0.65, interactive: false }
        );

        state.overlays.push({
          name: item.name,
          layer
        });
      } catch (error) {
        console.warn(
          `Couche facultative non chargée : ${item.path}`,
          error
        );
      }
    }

    updateLayerControl();

  } catch (error) {
    console.warn(
      "Métadonnées raster non disponibles.",
      error
    );
  }
}

function updateLayerControl() {
  if (state.layerControl) {
    map.removeControl(state.layerControl);
  }

  const baseLayers = {
    "OpenStreetMap": streetLayer
  };

  const overlays = {
    "Sites d'orpaillage": sitesLayer,
    "Zones tampons": buffersLayer
  };

  for (const item of state.overlays) {
    overlays[item.name] = item.layer;
  }

  state.layerControl = L.control.layers(
    baseLayers,
    overlays,
    { collapsed: true }
  ).addTo(map);
}


/* ================= DIAGNOSTIC D'UN POINT ================= */

function showPoint(lat, lng, name = "Point analysé") {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    setText("orError", "Coordonnées incorrectes.");
    return;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    setText("orError", "Coordonnées hors limites.");
    return;
  }

  state.point = { lat, lng, name };

  pointLayer.clearLayers();

  const marker = L.marker([lat, lng]).addTo(pointLayer);

  marker.bindPopup(`
    <strong>${esc(name)}</strong><br>
    Latitude : ${fr(lat, 6)}<br>
    Longitude : ${fr(lng, 6)}
  `).openPopup();

  map.setView([lat, lng], 14);

  const nearest = [...features()].sort((a, b) => {
    const da = map.distance(
      [lat, lng],
      [
        a.geometry.coordinates[1],
        a.geometry.coordinates[0]
      ]
    );

    const db = map.distance(
      [lat, lng],
      [
        b.geometry.coordinates[1],
        b.geometry.coordinates[0]
      ]
    );

    return da - db;
  })[0];

  if (nearest) {
    const p = nearest.properties;

    setHTML(
      "pointResult",
      `
        <strong>Point localisé</strong><br>
        ${esc(name)}<br><br>

        Site de référence le plus proche :
        <strong>${esc(p.name)}</strong><br>

        Distance :
        ${fr(
          map.distance(
            [lat, lng],
            [
              nearest.geometry.coordinates[1],
              nearest.geometry.coordinates[0]
            ]
          ),
          0
        )} m<br>

        Susceptibilité physique du site :
        ${fr(susceptibility(nearest), 2)} / 5<br>

        Classe :
        ${physicalSiteClass(nearest).label}<br><br>

        <em>
          Ce diagnostic présente les indicateurs du site de référence
          le plus proche. Il ne constitue pas une extraction des valeurs
          du pixel raster à la position exacte du point.
        </em>
      `
    );
  }

  setText("orError", "");
}

function refreshPoint() {
  if (!state.point) return;

  showPoint(
    state.point.lat,
    state.point.lng,
    state.point.name
  );
}

function clearPoint() {
  pointLayer.clearLayers();
  state.point = null;

  setText("pointResult", "");
  setText("orError", "");
}


/* ================= GESTION DES POINTS ================= */

function bindPointControls() {
  if ($("orBtn")) {
    $("orBtn").addEventListener("click", () => {
      const lat = Number($("orLat")?.value);
      const lng = Number($("orLng")?.value);
      const name = $("orName")?.value || "Point analysé";

      if (!$("orLat")?.value || !$("orLng")?.value) {
        setText("orError", "Veuillez renseigner la latitude et la longitude.");
        return;
      }

      showPoint(lat, lng, name);
    });
  }

  if ($("orClearBtn")) {
    $("orClearBtn").addEventListener("click", clearPoint);
  }

  if ($("analysePointBtn")) {
    $("analysePointBtn").addEventListener("click", () => {
      setText(
        "dangerAlert",
        "Cliquez sur la carte pour localiser le point à examiner."
      );

      map.once("click", event => {
        showPoint(
          event.latlng.lat,
          event.latlng.lng,
          "Point choisi sur la carte"
        );

        setText("dangerAlert", "");
      });
    });
  }

  if ($("clearPointBtn")) {
    $("clearPointBtn").addEventListener("click", clearPoint);
  }

  if ($("orExportBtn")) {
    $("orExportBtn").addEventListener("click", () => {
      if (!state.point) return;

      downloadCsv(
        [
          ["Nom", "Latitude", "Longitude"],
          [
            state.point.name,
            state.point.lat,
            state.point.lng
          ]
        ],
        "point_diagnostic.csv"
      );
    });
  }
}


/* ================= IMPORT DE POINTS GEOJSON ================= */

function importGeoJSON(file) {
  const reader = new FileReader();

  reader.onload = event => {
    try {
      const geojson = JSON.parse(event.target.result);

      if (state.importedLayer) {
        map.removeLayer(state.importedLayer);
      }

      state.importedLayer = L.geoJSON(geojson, {
        pointToLayer: (feature, latlng) =>
          L.circleMarker(latlng, {
            radius: 6,
            color: "#174b3b",
            fillColor: "#2f855a",
            fillOpacity: 0.8
          }),

        onEachFeature: (feature, layer) => {
          const name =
            feature.properties?.name ||
            feature.properties?.locality ||
            "Point importé";

          layer.bindPopup(esc(name));
        }
      }).addTo(map);

      map.fitBounds(state.importedLayer.getBounds());

    } catch (error) {
      alert("Le fichier GeoJSON est invalide.");
      console.error(error);
    }
  };

  reader.readAsText(file);
}


/* ================= GESTION DES LOTS DE POINTS ================= */

function parseCoordinates(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line
        .split(/[;,\t ]+/)
        .map(Number);

      if (parts.length < 2 || parts.some(v => !Number.isFinite(v))) {
        return null;
      }

      return {
        lat: parts[0],
        lng: parts[1]
      };
    })
    .filter(Boolean);
}

function bindLotControls() {
  if ($("lotInput")) {
    $("lotInput").addEventListener("change", event => {
      state.lot = parseCoordinates(event.target.value);

      setText(
        "lotResult",
        `${state.lot.length} point(s) reconnu(s).`
      );

      lotLayer.clearLayers();

      state.lot.forEach((point, index) => {
        L.circleMarker(
          [point.lat, point.lng],
          {
            radius: 5,
            color: "#174b3b",
            fillColor: "#d97706",
            fillOpacity: 0.9
          }
        )
          .bindPopup(`Point ${index + 1}`)
          .addTo(lotLayer);
      });

      if (state.lot.length) {
        map.fitBounds(
          L.latLngBounds(
            state.lot.map(p => [p.lat, p.lng])
          ),
          { padding: [30, 30] }
        );
      }
    });
  }

  if ($("lotClearBtn")) {
    $("lotClearBtn").addEventListener("click", () => {
      state.lot = [];
      lotLayer.clearLayers();

      if ($("lotInput")) $("lotInput").value = "";

      setText("lotResult", "");
    });
  }

  if ($("lotExportBtn")) {
    $("lotExportBtn").addEventListener("click", () => {
      if (!state.lot.length) return;

      downloadCsv(
        [
          ["Point", "Latitude", "Longitude"],
          ...state.lot.map((p, i) => [
            i + 1,
            p.lat,
            p.lng
          ])
        ],
        "points_importes.csv"
      );
    });
  }

  if ($("geojsonInput")) {
    $("geojsonInput").addEventListener("change", event => {
      const file = event.target.files?.[0];

      if (file) importGeoJSON(file);
    });
  }
}


/* ================= ONGLET SCÉNARIOS ================= */

function bindScenarioControls() {
  if ($("resetWeights")) {
    $("resetWeights").addEventListener("click", () => {
      state.weights = { ...CONFIG.weights };

      document.querySelectorAll("[data-weight]").forEach(input => {
        input.value = state.weights[input.dataset.weight];
      });

      updateWeightLabels();
      render();
    });
  }

  if ($("resetScores")) {
    $("resetScores").addEventListener("click", () => {
      if (!state.selected) return;

      state.scores[state.selected] = {
        ...state.originalScores[state.selected]
      };

      updateScoreControls(state.selected);
      render();
    });
  }

  document.querySelectorAll("[data-preset]").forEach(button => {
    button.addEventListener("click", () => {
      const preset = button.dataset.preset;

      const presets = {
        base: { ...CONFIG.weights },
        slope: {
          geology: 5,
          soil: 20,
          slope: 60,
          hydro: 15
        },
        soil: {
          geology: 5,
          soil: 60,
          slope: 20,
          hydro: 15
        },
        hydro: {
          geology: 5,
          soil: 20,
          slope: 15,
          hydro: 60
        },
        social: { ...CONFIG.weights }
      };

      if (!presets[preset]) return;

      state.weights = { ...presets[preset] };

      document.querySelectorAll("[data-weight]").forEach(input => {
        input.value = state.weights[input.dataset.weight];
      });

      if (preset === "social") {
        state.social = 0.35;
      } else {
        state.social = 0.35;
      }

      updateWeightLabels();
      render();
    });
  });
}


/* ================= FILTRES ET RAYONS ================= */

function bindMapControls() {
  if ($("filterToggle")) {
    $("filterToggle").addEventListener("change", renderMap);
  }

  if ($("bufferToggle")) {
    $("bufferToggle").addEventListener("change", renderMap);
  }

  if ($("radiusInput")) {
    $("radiusInput").addEventListener("input", event => {
      state.radius = clamp(Number(event.target.value), 100, 10000);

      if ($("radiusValue")) {
        $("radiusValue").textContent =
          `${fr(state.radius, 0)} m`;
      }

      renderMap();
    });
  }

  if ($("radiusValue") && $("radiusValue").tagName === "INPUT") {
    $("radiusValue").addEventListener("change", event => {
      state.radius = clamp(Number(event.target.value), 100, 10000);
      renderMap();
    });
  }

  if ($("fitBtn")) {
    $("fitBtn").addEventListener("click", () => {
      const group = L.featureGroup(
        [...state.markers.values()]
      );

      map.fitBounds(group.getBounds(), {
        padding: [35, 35]
      });
    });
  }
}


/* ================= NAVIGATION ENTRE ONGLETS ================= */

function bindTabs() {
  document.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => {
      const target = button.dataset.go;

      document.querySelectorAll("[data-go]").forEach(item => {
        item.classList.toggle("active", item === button);
      });

      document.querySelectorAll("[data-tab]").forEach(section => {
        section.hidden = section.dataset.tab !== target;
        section.classList.toggle(
          "active",
          section.dataset.tab === target
        );
      });

      setTimeout(() => map.invalidateSize(), 150);
    });
  });
}


/* ================= FENÊTRES D'AIDE ET À PROPOS ================= */

function bindDialogs() {
  const pairs = [
    ["aboutBtn", "about"],
    ["helpBtn", "guide"],
    ["aboutClose", "about"],
    ["guideClose", "guide"]
  ];

  pairs.forEach(([buttonId, panelId]) => {
    if (!$(buttonId) || !$(panelId)) return;

    $(buttonId).addEventListener("click", () => {
      const panel = $(panelId);

      if (buttonId.endsWith("Close")) {
        panel.hidden = true;
      } else {
        panel.hidden = !panel.hidden;
      }
    });
  });

  if ($("presentBtn")) {
    $("presentBtn").addEventListener("click", () => {
      const about = $("about");

      if (about) about.hidden = false;
    });
  }
}


/* ================= JOURNAL DES MISES À JOUR ================= */

function renderUpdateLog() {
  if (!$("updateLog")) return;

  if (!state.updateLog.length) {
    $("updateLog").textContent =
      "Aucune information de mise à jour disponible.";
    return;
  }

  $("updateLog").innerHTML = state.updateLog
    .map(item => `
      <div class="update-item">
        <strong>${esc(item.date || "")}</strong>
        <span>${esc(item.dataset || "")}</span>
        <p>${esc(item.action || "")}</p>
      </div>
    `)
    .join("");
}


/* ================= EXPORT DES RÉSULTATS ================= */

function exportResults() {
  const rows = [
    [
      "Site",
      "Score physique",
      "Classe physique",
      "Priorité",
      "Niveau de priorité",
      "IPRM",
      "ICA",
      "Sensibilisation (%)",
      "Effectif enquêté",
      "Occupation du sol"
    ]
  ];

  features().forEach(f => {
    const p = f.properties;
    const lv = level(priority(f));

    rows.push([
      p.name,
      susceptibility(f),
      physicalSiteClass(f).label,
      priority(f),
      lv.label,
      p.iprm,
      p.ica,
      p.sensitized_pct,
      p.survey_n,
      getLandcoverLabel(p)
    ]);
  });

  downloadCsv(rows, "mercurescope_resultats.csv");
}

function bindExports() {
  if ($("exportBtn")) {
    $("exportBtn").addEventListener("click", exportResults);
  }

  if ($("reportBtn")) {
    $("reportBtn").addEventListener("click", () => {
      window.print();
    });
  }
}


/* ================= SOURCES ET INFORMATIONS ================= */

function renderAbout() {
  setHTML(
    "aboutSources",
    `
      <p>
        Données physiques : géologie, pédologie, pente et hydrographie.
      </p>
      <p>
        Données sociales : enquête auprès des populations des cinq localités.
      </p>
      <p>
        Données cartographiques : analyse spatiale et traitement SIG
        à une résolution de 30 m.
      </p>
    `
  );

  setHTML(
    "aboutPeople",
    `
      <p>
        Application développée dans le cadre du mémoire de Master 2 SIG
        portant sur la susceptibilité à un transfert potentiel du mercure
        lié à l'orpaillage artisanal dans la commune de Gaoua.
      </p>
    `
  );
}


/* ================= DÉMARRAGE ================= */

async function init() {
  try {
    if (!$("map")) {
      throw new Error("L'élément HTML map est introuvable.");
    }

    state.data = await loadJson(
      "data/sites_indicators.geojson"
    );

    if (!state.data.features) {
      throw new Error("Le GeoJSON ne contient pas de liste de sites.");
    }

    try {
      state.updateLog = await loadJson(
        "data/update_log.json"
      );
    } catch (error) {
      console.warn("Journal des mises à jour indisponible.", error);
      state.updateLog = [];
    }

    initializeSites();

    buildControls();

    bindScenarioControls();
    bindPointControls();
    bindLotControls();
    bindMapControls();
    bindTabs();
    bindDialogs();
    bindExports();

    renderUpdateLog();
    renderAbout();

    updateWeightLabels();

    render();

    await loadRasterOverlays();

    setTimeout(() => {
      map.invalidateSize();

      const group = L.featureGroup(
        [...state.markers.values()]
      );

      if (group.getLayers().length) {
        map.fitBounds(group.getBounds(), {
          padding: [35, 35]
        });
      }
    }, 300);

    console.log("MercureScope Gaoua est chargé.");

  } catch (error) {
    console.error("Erreur de démarrage :", error);

    setText(
      "summaryText",
      "Erreur de chargement. Vérifiez les fichiers de données et la console du navigateur."
    );

    setText(
      "dangerAlert",
      `Erreur : ${error.message}`
    );
  }
}

init();
