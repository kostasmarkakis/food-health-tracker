const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const NUTRI_MAP = { A: 100, B: 75, C: 50, D: 25, E: 0 };

let tokenClient = null;
let accessToken = null;
let foods = [];
let headerMap = {};
let html5QrCode = null;

// --- Settings Persistence ---
const getSettings = () => ({
  clientId: localStorage.getItem("fht_client_id") || "",
  sheetId: localStorage.getItem("fht_sheet_id") || "1X6ZyKBCrsx6eM8zWT15s_CDtFV4zZMlzCXpUoSsB54c",
  sheetName: localStorage.getItem("fht_sheet_name") || "Sheet1"
});

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
  localStorage.setItem("fht_sheet_name", document.getElementById("sheetNameInput").value.trim() || "Sheet1");
  document.getElementById("settingsPanel").classList.add("hidden");
  initGoogleAuth();
  requestToken();
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
document.getElementById("refreshBtn").addEventListener("click", fetchSheetData);

function setStatus(msg) {
  document.getElementById("syncStatus").textContent = msg;
}

// --- Scoring Logic ---
function computeHealthScore(nutriGrade, yuka, off, epi) {
  const nutriNum = NUTRI_MAP[(nutriGrade || "C").toUpperCase()] ?? 50;
  // Balanced weights across Nutri, Yuka, OFF, and Epi Score (sum = 1.00)
  return (0.15 * nutriNum) + (0.35 * Number(yuka || 0)) + (0.25 * Number(off || 0)) + (0.25 * Number(epi || 50));
}

// --- Google Sheets Read / Write ---
async function fetchSheetData() {
  if (!accessToken) return;
  const { sheetId, sheetName } = getSettings();
  setStatus("Loading sheet...");

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}!A1:Z200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();

  if (!data.values || data.values.length < 2) {
    setStatus("No rows found in " + sheetName);
    return;
  }

  const headers = data.values[0].map(h => h.trim().toLowerCase());
  headerMap = {
    name: headers.findIndex(h => h.includes("product") || h.includes("name") || h === "food"),
    nutri: headers.findIndex(h => h.includes("nutri")),
    yuka: headers.findIndex(h => h.includes("yuka")),
    off: headers.findIndex(h => h.includes("off")),
    epi: headers.findIndex(h => h.includes("epi")),
    score: headers.findIndex(h => h.includes("health") || h.includes("combined")),
    grams: headers.findIndex(h => h.includes("gram") || h.includes("quantity") || h === "q"),
    freq: headers.findIndex(h => h.includes("freq") || h === "f")
  };

  foods = data.values.slice(1)
    .filter(row => row[headerMap.name >= 0 ? headerMap.name : 0])
    .map((row, idx) => {
      const name = row[headerMap.name >= 0 ? headerMap.name : 0] || "";
      const nutri = (row[headerMap.nutri] || "C").toUpperCase();
      const yuka = parseFloat(row[headerMap.yuka]) || 0;
      const off = parseFloat(row[headerMap.off]) || 0;
      const epi = headerMap.epi >= 0 && row[headerMap.epi] !== "" ? parseFloat(row[headerMap.epi]) : 50;
      const sheetScore = headerMap.score >= 0 ? parseFloat(row[headerMap.score]) : NaN;
      const healthScore = !isNaN(sheetScore) ? sheetScore : computeHealthScore(nutri, yuka, off, epi);
      const grams = headerMap.grams >= 0 ? (parseFloat(row[headerMap.grams]) || 0) : 0;
      const freq = headerMap.freq >= 0 ? (parseFloat(row[headerMap.freq]) || 0) : 0;
      return { rowNumber: idx + 2, name, nutri, yuka, off, epi, healthScore, grams, freq, weeklyGrams: grams * freq };
    });

  setStatus(`Synced (${foods.length} items) • ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  renderApp();
}

async function appendFoodRow(item) {
  if (!accessToken) {
    alert("Please sign in with Google first.");
    return;
  }
  const { sheetId, sheetName } = getSettings();
  const row = [];
  const maxCol = Math.max(4, ...Object.values(headerMap));
  for (let i = 0; i <= maxCol; i++) row[i] = "";

  row[headerMap.name >= 0 ? headerMap.name : 0] = item.name;
  if (headerMap.nutri >= 0) row[headerMap.nutri] = item.nutri;
  if (headerMap.yuka >= 0) row[headerMap.yuka] = item.yuka;
  if (headerMap.off >= 0) row[headerMap.off] = item.off;
  if (headerMap.epi >= 0) row[headerMap.epi] = item.epi;
  if (headerMap.score >= 0) row[headerMap.score] = Number(item.healthScore.toFixed(1));
  if (headerMap.grams >= 0) row[headerMap.grams] = item.grams;
  if (headerMap.freq >= 0) row[headerMap.freq] = item.freq;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "POST",
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

// --- Rendering ---
function scoreBadgeClass(score) {
  if (score >= 70) return "badge-high";
  if (score >= 45) return "badge-mid";
  return "badge-low";
}

function renderApp() {
  document.getElementById("foodCount").textContent = foods.length;
  document.getElementById("totalItems").textContent = foods.length;

  if (foods.length > 0) {
    const avg = foods.reduce((acc, f) => acc + f.healthScore, 0) / foods.length;
    document.getElementById("avgScore").textContent = avg.toFixed(1);

    const totalWeeklyG = foods.reduce((acc, f) => acc + f.weeklyGrams, 0);
    if (totalWeeklyG > 0) {
      const weighted = foods.reduce((acc, f) => acc + f.healthScore * f.weeklyGrams, 0) / totalWeeklyG;
      document.getElementById("weightedScore").textContent = weighted.toFixed(1);
    } else {
      document.getElementById("weightedScore").textContent = avg.toFixed(1);
    }
  }

  // Top Weekly Drivers
  const top = [...foods]
    .sort((a, b) => (b.weeklyGrams || b.healthScore) - (a.weeklyGrams || a.healthScore))
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

  renderCatalog(document.getElementById("searchInput").value);
}

function renderCatalog(filter = "") {
  const q = filter.trim().toLowerCase();
  const filtered = foods.filter(f => f.name.toLowerCase().includes(q));
  document.getElementById("foodList").innerHTML = filtered.map(f => `
    <div class="food-item">
      <div>
        <strong>${escapeHtml(f.name)}</strong>
        <div class="food-meta">Nutri: ${f.nutri} | Yuka: ${f.yuka} | OFF: ${f.off} | Epi: ${f.epi}</div>
      </div>
      <span class="badge ${scoreBadgeClass(f.healthScore)}">${f.healthScore.toFixed(1)}</span>
    </div>
  `).join("") || `<p class="hint">No matching foods found.</p>`;
}

document.getElementById("searchInput").addEventListener("input", (e) => renderCatalog(e.target.value));

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
    // Map NOVA group (1-4) to a 0-100 OFF baseline if exact score isn't present
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
  updatePreview();
  setTimeout(initGoogleAuth, 600);
});