const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const NUTRI_MAP = { A: 100, B: 75, C: 50, D: 25, E: 0 };
const NUTRI_RANK = { A: 5, B: 4, C: 3, D: 2, E: 1 };

const CORE_COLUMNS = [
  { key: "nutri", label: "Nutri" },
  { key: "yuka", label: "Yuka" },
  { key: "off", label: "OFF" },
  { key: "epi", label: "Epi Score" },
  { key: "healthScore", label: "Health Score" },
  { key: "impact", label: "Dietary Impact" }
];

// Matches columns B..J of the Lookup tab (per 100g)
const NUTRIENT_COLUMNS = [
  { key: "fiber", label: "Fiber (/100g)" },
  { key: "protein", label: "Protein (/100g)" },
  { key: "potassium", label: "Potassium (/100g)" },
  { key: "magnesium", label: "Magnesium (/100g)" },
  { key: "calcium", label: "Calcium (/100g)" },
  { key: "iron", label: "Iron (/100g)" },
  { key: "vitC", label: "Vitamin C (/100g)" },
  { key: "vitA", label: "Vitamin A (/100g)" },
  { key: "vitB12", label: "Vitamin B12 (/100g)" }
];

// Matches columns K..P of the Lookup tab (per 100g)
const ENERGY_COLUMNS = [
  { key: "calories", label: "Calories (/100g)" },
  { key: "totalFat", label: "Total Fat (/100g)" },
  { key: "satFat", label: "Sat. Fat (/100g)" },
  { key: "carbs", label: "Carbs (/100g)" },
  { key: "sugars", label: "Sugars (/100g)" },
  { key: "sodium", label: "Sodium (/100g)" }
];

const ALL_COLUMN_DEFS = [...CORE_COLUMNS, ...NUTRIENT_COLUMNS, ...ENERGY_COLUMNS];

const COLS_STORAGE_KEY = "fht_visible_columns";
const NUTRIENTS_GROUP_KEY = "fht_show_nutrients";
const ENERGY_GROUP_KEY = "fht_show_energy";

let tokenClient = null;
let accessToken = null;
let foods = [];
let lookupByName = {};
let lookupLoaded = false;
let headerMap = {};
let sheetSummary = {};
let html5QrCode = null;

// --- Settings & Column Visibility Persistence ---
const getSettings = () => ({
  clientId: localStorage.getItem("fht_client_id") || "",
  sheetId: localStorage.getItem("fht_sheet_id") || "1X6ZyKBCrsx6eM8zWT15s_CDtFV4zZMlzCXpUoSsB54c",
  sheetName: localStorage.getItem("fht_sheet_name") || "Overall"
});

function getCoreVisibleColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY));
    if (Array.isArray(saved)) {
      return CORE_COLUMNS.filter(c => saved.includes(c.key)).map(c => c.key);
    }
  } catch (_) {}
  return CORE_COLUMNS.map(c => c.key);
}

function saveCoreVisibleColumns(cols) {
  localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(cols));
}

function isNutrientsGroupEnabled() {
  return localStorage.getItem(NUTRIENTS_GROUP_KEY) === "true";
}

function isEnergyGroupEnabled() {
  return localStorage.getItem(ENERGY_GROUP_KEY) === "true";
}

function getActiveColumns() {
  const cols = getCoreVisibleColumns().map(key => ALL_COLUMN_DEFS.find(c => c.key === key)).filter(Boolean);
  if (isNutrientsGroupEnabled()) {
    cols.push(...NUTRIENT_COLUMNS);
  }
  if (isEnergyGroupEnabled()) {
    cols.push(...ENERGY_COLUMNS);
  }
  return cols;
}

function syncColumnControls() {
  const activeCore = new Set(getCoreVisibleColumns());
  document.querySelectorAll('#columnToggles input[type="checkbox"]').forEach((cb) => {
    cb.checked = activeCore.has(cb.dataset.col);
  });
  document.getElementById("toggleNutrientsGroup").checked = isNutrientsGroupEnabled();
  document.getElementById("toggleEnergyGroup").checked = isEnergyGroupEnabled();
}

function loadSettingsUI() {
  const s = getSettings();
  document.getElementById("clientIdInput").value = s.clientId;
  document.getElementById("sheetIdInput").value = s.sheetId;
  document.getElementById("sheetNameInput").value = s.sheetName;
  if (!s.clientId) {
    document.getElementById("settingsPanel").classList.remove("hidden");
  }
}

document.getElementById("settingsToggleBtn").addEventListener("click", () => {
  document.getElementById("settingsPanel").classList.toggle("hidden");
});

document.getElementById("saveSettingsBtn").addEventListener("click", () => {
  localStorage.setItem("fht_client_id", document.getElementById("clientIdInput").value.trim());
  localStorage.setItem("fht_sheet_id", document.getElementById("sheetIdInput").value.trim());
  localStorage.setItem("fht_sheet_name", document.getElementById("sheetNameInput").value.trim() || "Overall");
  document.getElementById("settingsPanel").classList.add("hidden");

  if (accessToken) {
    fetchSheetData();
  } else {
    initGoogleAuth();
    requestToken();
  }
});

// --- Google OAuth ---
function initGoogleAuth() {
  const { clientId } = getSettings();
  if (!clientId || !window.google) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) {
        setStatus("Auth error: " + resp.error);
        return;
      }
      accessToken = resp.access_token;
      document.getElementById("authBtn").textContent = "Connected ✓";
      setStatus("Synced with Google Sheets");
      fetchSheetData();
    }
  });
}

function requestToken() {
  const { clientId } = getSettings();
  if (!clientId) {
    document.getElementById("settingsPanel").classList.remove("hidden");
    alert("Please enter your Google OAuth Client ID first.");
    return;
  }
  if (!tokenClient) initGoogleAuth();
  tokenClient.requestAccessToken({ prompt: "" });
}

document.getElementById("authBtn").addEventListener("click", requestToken);
document.getElementById("refreshBtn").addEventListener("click", () => {
  lookupLoaded = false;
  fetchSheetData();
});

function setStatus(msg) {
  document.getElementById("syncStatus").textContent = msg;
}

// --- Scoring Logic (Matches Overall Sheet Formula) ---
function computeHealthScore(nutriGrade, yuka, off, epi) {
  const nutriNum = NUTRI_MAP[(nutriGrade || "C").toUpperCase()] ?? 50;
  return (nutriNum + Number(yuka || 0) + Number(off || 0) + Number(epi || 50)) / 4;
}

// --- Google Sheets Read / Write ---
async function fetchLookupDataIfNeeded() {
  if (!accessToken || lookupLoaded) return;
  const { sheetId } = getSettings();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent("Lookup")}!A1:P200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  if (data.error || !data.values || data.values.length < 2) return;

  const map = {};
  data.values.slice(1).forEach((row) => {
    const rawName = (row[0] || "").trim().toLowerCase();
    if (!rawName) return;
    map[rawName] = {
      fiber: parseFloat(row[1]) || 0,
      protein: parseFloat(row[2]) || 0,
      potassium: parseFloat(row[3]) || 0,
      magnesium: parseFloat(row[4]) || 0,
      calcium: parseFloat(row[5]) || 0,
      iron: parseFloat(row[6]) || 0,
      vitC: parseFloat(row[7]) || 0,
      vitA: parseFloat(row[8]) || 0,
      vitB12: parseFloat(row[9]) || 0,
      calories: parseFloat(row[10]) || 0,
      totalFat: parseFloat(row[11]) || 0,
      satFat: parseFloat(row[12]) || 0,
      carbs: parseFloat(row[13]) || 0,
      sugars: parseFloat(row[14]) || 0,
      sodium: parseFloat(row[15]) || 0
    };
  });

  lookupByName = map;
  lookupLoaded = true;
}

async function fetchSheetData() {
  if (!accessToken) return;
  const { sheetId, sheetName } = getSettings();
  setStatus("Loading sheet...");

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}!A1:P200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();

  if (data.error) {
    if (res.status === 401) {
      accessToken = null;
      document.getElementById("authBtn").textContent = "Sign in with Google";
      setStatus("Session expired — click Sign in with Google");
    } else {
      setStatus("Sheet error: " + data.error.message);
    }
    return;
  }

  if (!data.values || data.values.length < 2) {
    setStatus("No rows found in " + sheetName);
    return;
  }

  const headers = data.values[0].map(h => h.trim().toLowerCase());
  headerMap = {
    name: headers.findIndex(h => h === "product name" || h.includes("product") || h === "food"),
    qtyLabel: headers.findIndex(h => h === "quantity"),
    grams: headers.findIndex(h => h.includes("grams")),
    freq: headers.findIndex(h => h.includes("freq")),
    weeklyQty: headers.findIndex(h => h === "weekly quantity"),
    nutri: headers.findIndex(h => h === "nutri" || h.includes("nutri")),
    yuka: headers.findIndex(h => h === "yuka" || h.includes("yuka")),
    off: headers.findIndex(h => h === "off" || h.includes("off")),
    epi: headers.findIndex(h => h.includes("epi")),
    score: headers.findIndex(h => h === "health score"),
    impact: headers.findIndex(h => h.includes("impact"))
  };

  sheetSummary = {};
  data.values.slice(1, 10).forEach(row => {
    if (row[12] && row[13] !== undefined) {
      sheetSummary[row[12].trim().toLowerCase()] = parseFloat(row[13]);
    }
  });

  foods = data.values.slice(1)
    .filter(row => row[headerMap.name >= 0 ? headerMap.name : 0])
    .map((row, idx) => {
      const name = row[headerMap.name >= 0 ? headerMap.name : 0] || "";
      const qtyLabel = headerMap.qtyLabel >= 0 ? (row[headerMap.qtyLabel] || "") : "";
      const nutri = (row[headerMap.nutri] || "C").toUpperCase();
      const yuka = parseFloat(row[headerMap.yuka]) || 0;
      const off = parseFloat(row[headerMap.off]) || 0;
      const epi = headerMap.epi >= 0 && row[headerMap.epi] !== "" ? parseFloat(row[headerMap.epi]) : 50;
      const sheetScore = headerMap.score >= 0 ? parseFloat(row[headerMap.score]) : NaN;
      const healthScore = !isNaN(sheetScore) ? sheetScore : computeHealthScore(nutri, yuka, off, epi);
      const grams = headerMap.grams >= 0 ? (parseFloat(row[headerMap.grams]) || 0) : 0;
      const freq = headerMap.freq >= 0 ? (parseFloat(row[headerMap.freq]) || 0) : 0;
      const weeklyGrams = headerMap.weeklyQty >= 0 && row[headerMap.weeklyQty] !== ""
        ? (parseFloat(row[headerMap.weeklyQty]) || 0)
        : grams * freq;
      const impact = headerMap.impact >= 0 ? (parseFloat(row[headerMap.impact]) || 0) : 0;

      return { rowNumber: idx + 2, name, qtyLabel, nutri, yuka, off, epi, healthScore, grams, freq, weeklyGrams, impact };
    });

  if (isNutrientsGroupEnabled() || isEnergyGroupEnabled()) {
    await fetchLookupDataIfNeeded();
  }

  setStatus(`Synced (${foods.length} items) • ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  renderApp();
}

async function appendFoodRow(item) {
  if (!accessToken) {
    alert("Please sign in with Google first.");
    return;
  }
  const { sheetId, sheetName } = getSettings();
  const nextRow = foods.length + 2;
  const row = new Array(11).fill("");

  row[0] = item.name;
  row[1] = `${item.grams}g`;
  row[2] = item.grams;
  row[3] = item.freq;
  row[4] = `=C${nextRow}*D${nextRow}`;
  row[5] = item.nutri;
  row[6] = item.yuka;
  row[7] = item.off;
  row[8] = item.epi;
  row[9] = `=(IFS(TRIM(UPPER(F${nextRow}))="A",100,TRIM(UPPER(F${nextRow}))="B",75,TRIM(UPPER(F${nextRow}))="C",50,TRIM(UPPER(F${nextRow}))="D",25,TRIM(UPPER(F${nextRow}))="E",0)+G${nextRow}+H${nextRow}+I${nextRow})/4`;
  row[10] = `=(J${nextRow}-50)*(E${nextRow}/100)`;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}!A${nextRow}:K${nextRow}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ values: [row] })
  });

  if (res.ok) {
    await fetchSheetData();
    switchTab("catalog");
  } else {
    const err = await res.json();
    alert("Failed to write to sheet: " + (err.error?.message || "Unknown error"));
  }
}

// --- Sorting & Filtering ---
function matchesNumericFilter(value, opId, valId) {
  const op = document.getElementById(opId).value;
  const rawVal = document.getElementById(valId).value;
  if (op === "any" || rawVal === "") return true;
  const threshold = parseFloat(rawVal);
  if (isNaN(threshold)) return true;

  if (op === "gte") return value >= threshold;
  if (op === "lte") return value <= threshold;
  return true;
}

function compareFoods(a, b, field, dir) {
  let diff = 0;
  if (field === "nutri") {
    diff = (NUTRI_RANK[a.nutri] || 0) - (NUTRI_RANK[b.nutri] || 0);
  } else {
    diff = (Number(a[field]) || 0) - (Number(b[field]) || 0);
  }
  if (diff === 0) {
    return a.name.localeCompare(b.name);
  }
  return dir === "asc" ? diff : -diff;
}

// --- Rendering ---
function scoreBadgeClass(score) {
  if (score >= 70) return "badge-high";
  if (score >= 45) return "badge-mid";
  return "badge-low";
}

function formatMetricVal(val, decimals = 2) {
  const n = Number(val);
  if (!isFinite(n) || n === 0) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(decimals).replace(/\.?0+$/, "");
}

function renderColumnCell(food, colKey, isSortedCol) {
  const cls = isSortedCol ? ' class="sorted-col-cell"' : "";
  if (colKey === "nutri") {
    return `<td${cls}><strong>${escapeHtml(food.nutri)}</strong></td>`;
  }
  if (colKey === "yuka") {
    return `<td${cls}>${food.yuka}</td>`;
  }
  if (colKey === "off") {
    return `<td${cls}>${food.off}</td>`;
  }
  if (colKey === "epi") {
    return `<td${cls}>${food.epi}</td>`;
  }
  if (colKey === "healthScore") {
    const val = Number(food.healthScore);
    return `<td${cls}><span class="badge ${scoreBadgeClass(val)}">${val.toFixed(1)}</span></td>`;
  }
  if (colKey === "impact") {
    return `<td${cls}>${Number(food.impact).toFixed(1)}</td>`;
  }

  const lookup = lookupByName[food.name.trim().toLowerCase()] || {};
  const val = lookup[colKey] ?? 0;
  return `<td${cls}>${formatMetricVal(val)}</td>`;
}

function renderApp() {
  document.getElementById("foodCount").textContent = foods.length;
  document.getElementById("totalItems").textContent = foods.length;

  if (foods.length > 0) {
    const overall = sheetSummary["overall health score"];
    const foodQuality = sheetSummary["food quality score"];
    const avg = foods.reduce((acc, f) => acc + f.healthScore, 0) / foods.length;

    document.getElementById("avgScore").textContent = !isNaN(overall) ? overall.toFixed(1) : avg.toFixed(1);

    const totalWeeklyG = foods.reduce((acc, f) => acc + f.weeklyGrams, 0);
    const weighted = !isNaN(foodQuality)
      ? foodQuality
      : (totalWeeklyG > 0 ? foods.reduce((acc, f) => acc + f.healthScore * f.weeklyGrams, 0) / totalWeeklyG : avg);
    document.getElementById("weightedScore").textContent = weighted.toFixed(1);
  }

  const top = [...foods]
    .sort((a, b) => (b.impact || b.weeklyGrams) - (a.impact || a.weeklyGrams))
    .slice(0, 8);

  document.getElementById("topFoodsList").innerHTML = top.map(f => `
    <div class="food-item">
      <div>
        <strong>${escapeHtml(f.name)}</strong>
        <div class="food-meta">Nutri ${f.nutri} • Yuka ${f.yuka} • OFF ${f.off} • Epi ${f.epi}${f.weeklyGrams ? ` • ${f.weeklyGrams}g/wk` : ""}</div>
      </div>
      <span class="badge ${scoreBadgeClass(f.healthScore)}">${f.healthScore.toFixed(1)}</span>
    </div>
  `).join("");

  renderCatalog();
}

function renderCatalog() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  const nutriFilter = document.getElementById("filterNutri").value;
  const sortField = document.getElementById("sortField").value;
  const sortDir = document.getElementById("sortDirBtn").dataset.dir || "desc";
  const activeCols = getActiveColumns();
  const arrow = sortDir === "asc" ? "↑" : "↓";

  const filtered = foods
    .filter((f) => {
      if (q && !f.name.toLowerCase().includes(q)) return false;
      if (nutriFilter !== "ALL" && f.nutri !== nutriFilter) return false;
      if (!matchesNumericFilter(f.yuka, "opYuka", "valYuka")) return false;
      if (!matchesNumericFilter(f.off, "opOff", "valOff")) return false;
      if (!matchesNumericFilter(f.epi, "opEpi", "valEpi")) return false;
      if (!matchesNumericFilter(f.healthScore, "opHealth", "valHealth")) return false;
      if (!matchesNumericFilter(f.impact, "opImpact", "valImpact")) return false;
      return true;
    })
    .sort((a, b) => compareFoods(a, b, sortField, sortDir));

  document.getElementById("filteredCount").textContent =
    `Showing ${filtered.length} of ${foods.length} foods • Sorted by ${sortField} (${arrow})`;

  if (filtered.length === 0) {
    document.getElementById("foodList").innerHTML = `<p class="hint" style="padding:12px;">No matching foods found.</p>`;
    return;
  }

  const headerCells = activeCols.map((col) => {
    const isSorted = col.key === sortField;
    const thClass = isSorted ? ' class="sorted-col"' : "";
    const indicator = isSorted ? `<span class="sort-indicator">${arrow}</span>` : "";
    return `<th${thClass}>${escapeHtml(col.label)}${indicator}</th>`;
  }).join("");

  const bodyRows = filtered.map((f) => {
    const metricCells = activeCols
      .map((col) => renderColumnCell(f, col.key, col.key === sortField))
      .join("");
    return `
      <tr>
        <td><strong>${escapeHtml(f.name)}</strong></td>
        ${metricCells}
      </tr>
    `;
  }).join("");

  document.getElementById("foodList").innerHTML = `
    <table class="food-table">
      <thead>
        <tr>
          <th>Product</th>
          ${headerCells}
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
  `;
}

document.querySelectorAll('#columnToggles input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener("change", () => {
    const checked = Array.from(document.querySelectorAll('#columnToggles input[type="checkbox"]:checked'))
      .map(el => el.dataset.col);
    saveCoreVisibleColumns(checked);
    renderCatalog();
  });
});

async function handleGroupToggle(storageKey, isChecked) {
  localStorage.setItem(storageKey, String(isChecked));
  if (isChecked && accessToken && !lookupLoaded) {
    setStatus("Loading Lookup columns...");
    await fetchLookupDataIfNeeded();
    setStatus(`Synced (${foods.length} items) • ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  }
  renderCatalog();
}

document.getElementById("toggleNutrientsGroup").addEventListener("change", (e) => {
  handleGroupToggle(NUTRIENTS_GROUP_KEY, e.currentTarget.checked);
});

document.getElementById("toggleEnergyGroup").addEventListener("change", (e) => {
  handleGroupToggle(ENERGY_GROUP_KEY, e.currentTarget.checked);
});

document.getElementById("sortDirBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const nextDir = btn.dataset.dir === "desc" ? "asc" : "desc";
  btn.dataset.dir = nextDir;
  btn.textContent = nextDir === "desc" ? "↓ Desc" : "↑ Asc";
  renderCatalog();
});

document.getElementById("resetFiltersBtn").addEventListener("click", () => {
  document.getElementById("searchInput").value = "";
  document.getElementById("filterNutri").value = "ALL";
  document.getElementById("sortField").value = "healthScore";
  const dirBtn = document.getElementById("sortDirBtn");
  dirBtn.dataset.dir = "desc";
  dirBtn.textContent = "↓ Desc";
  ["opYuka", "opOff", "opEpi", "opHealth", "opImpact"].forEach((id) => {
    document.getElementById(id).value = "any";
  });
  ["valYuka", "valOff", "valEpi", "valHealth", "valImpact"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  saveCoreVisibleColumns(CORE_COLUMNS.map(c => c.key));
  localStorage.setItem(NUTRIENTS_GROUP_KEY, "false");
  localStorage.setItem(ENERGY_GROUP_KEY, "false");
  syncColumnControls();
  renderCatalog();
});

[
  "searchInput",
  "filterNutri",
  "sortField",
  "opYuka", "valYuka",
  "opOff", "valOff",
  "opEpi", "valEpi",
  "opHealth", "valHealth",
  "opImpact", "valImpact"
].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderCatalog);
  document.getElementById(id).addEventListener("change", renderCatalog);
});

// --- Add Form & Live Preview ---
function updatePreview() {
  const score = computeHealthScore(
    document.getElementById("fNutri").value,
    document.getElementById("fYuka").value,
    document.getElementById("fOff").value,
    document.getElementById("fEpi").value
  );
  document.getElementById("previewScore").textContent = score.toFixed(1);
}

["fNutri", "fYuka", "fOff", "fEpi"].forEach(id => {
  document.getElementById(id).addEventListener("input", updatePreview);
});

document.getElementById("addFoodForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nutri = document.getElementById("fNutri").value;
  const yuka = parseFloat(document.getElementById("fYuka").value);
  const off = parseFloat(document.getElementById("fOff").value);
  const epi = parseFloat(document.getElementById("fEpi").value);
  const item = {
    name: document.getElementById("fName").value.trim(),
    nutri,
    yuka,
    off,
    epi,
    healthScore: computeHealthScore(nutri, yuka, off, epi),
    grams: parseFloat(document.getElementById("fGrams").value) || 0,
    freq: parseFloat(document.getElementById("fFreq").value) || 0
  };
  await appendFoodRow(item);
  e.target.reset();
  updatePreview();
});

// --- Open Food Facts Barcode Scanner ---
document.getElementById("scanBarcodeBtn").addEventListener("click", async () => {
  const readerEl = document.getElementById("reader");
  const stopBtn = document.getElementById("stopScanBtn");
  const statusEl = document.getElementById("offStatus");

  readerEl.classList.remove("hidden");
  stopBtn.classList.remove("hidden");
  statusEl.textContent = "Point camera at a product barcode...";

  html5QrCode = new Html5Qrcode("reader");
  await html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 140 } },
    async (barcode) => {
      await stopScanner();
      statusEl.textContent = `Barcode ${barcode} found — fetching Open Food Facts...`;
      await lookupOpenFoodFacts(barcode);
    }
  );
});

document.getElementById("stopScanBtn").addEventListener("click", stopScanner);

async function stopScanner() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); } catch (_) {}
    html5QrCode = null;
  }
  document.getElementById("reader").classList.add("hidden");
  document.getElementById("stopScanBtn").classList.add("hidden");
}

async function lookupOpenFoodFacts(barcode) {
  const statusEl = document.getElementById("offStatus");
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
    const data = await res.json();
    if (data.status !== 1 || !data.product) {
      statusEl.textContent = "Product not found in Open Food Facts. Enter details manually.";
      return;
    }
    const p = data.product;
    document.getElementById("fName").value = p.product_name || p.generic_name || "";
    if (p.nutriscore_grade && NUTRI_MAP[p.nutriscore_grade.toUpperCase()] !== undefined) {
      document.getElementById("fNutri").value = p.nutriscore_grade.toUpperCase();
    }
    const novaMap = { 1: 95, 2: 75, 3: 50, 4: 20 };
    if (p.nova_group && novaMap[p.nova_group]) {
      document.getElementById("fOff").value = novaMap[p.nova_group];
    }
    updatePreview();
    statusEl.textContent = `Loaded "${p.product_name || barcode}" from Open Food Facts! Add Yuka & Epi Score.`;
  } catch (err) {
    statusEl.textContent = "Error querying Open Food Facts.";
  }
}

// --- Tabs & Init ---
function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === `tab-${tabName}`));
}

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

window.addEventListener("load", () => {
  loadSettingsUI();
  syncColumnControls();
  updatePreview();
  setTimeout(initGoogleAuth, 600);
});
