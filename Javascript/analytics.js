// ── Auth guard ─────────────────────────────────────────────────────────────
// DEV_MODE: bypasses login redirects so frontend can be edited without Docker auth.
// This branch (dev/frontend-no-auth) only — never merge this flag as true.
const DEV_MODE = true;

const token = localStorage.getItem("authToken");
if (!DEV_MODE && !token) window.location.replace("../frontend/login.html");

// ── Dark mode ──────────────────────────────────────────────────────────────
(function applyTheme() {
  const saved = localStorage.getItem("voltequilibrium-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (saved === "dark" || (!saved && prefersDark)) {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
    const icon = document.getElementById("theme-icon");
    if (icon) icon.textContent = "light_mode";
  }
})();

const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:3000"
  : "";

// ── State ──────────────────────────────────────────────────────────────────
let currentSource = "solar";
let currentDetail = "min";
let currentDate   = new Date().toISOString().slice(0, 10);

let overviewChartInstance = null;
let batteryChartInstance  = null;

const overviewSeriesMeta = [
  { key: "avgPowerW",  label: "Generated (W)", color: "#005147", borderDash: [] },
  { key: "avgLoadW",   label: "Load (W)",       color: "#005db6", borderDash: [] },
  { key: "avgGridW",   label: "Grid (W)",        color: "#ba1a1a", borderDash: [4,3] },
  { key: "peakPowerW", label: "Peak (W)",        color: "#374e00", borderDash: [2,2] },
  { key: "avgTemp",    label: "Temp (°C)",       color: "#6e7976", borderDash: [6,3] },
];
const hiddenSeries = new Set();

// ── Helpers ────────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!DEV_MODE && (res.status === 401 || res.status === 403)) {
    localStorage.removeItem("authToken");
    window.location.replace("../frontend/login.html");
    return null;
  }
  return res.json();
}

function fmtTime(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Load and render ────────────────────────────────────────────────────────
async function loadAnalytics() {
  document.getElementById("chart-status").textContent = "Loading…";

  const json = await apiFetch(
    `/api/inverter/analytics?source=${currentSource}&date=${currentDate}&detail=${currentDetail}`,
  );
  if (!json || !json.success) {
    document.getElementById("chart-status").textContent = "Failed to load data";
    return;
  }

  renderOverviewChart(json.data.power);
  renderBatteryChart(json.data.battery);

  const count = json.data.power.length;
  document.getElementById("chart-status").textContent =
    count > 0 ? `${count} data points` : "No data for this date";
}

// ── Overview chart ─────────────────────────────────────────────────────────
function renderOverviewChart(rows) {
  const labels = rows.map((r) => fmtTime(r.time));

  const datasets = overviewSeriesMeta.map((meta) => ({
    label:           meta.label,
    data:            rows.map((r) => r[meta.key] ?? null),
    borderColor:     meta.color,
    backgroundColor: meta.color + "22",
    borderDash:      meta.borderDash,
    borderWidth:     2,
    pointRadius:     rows.length > 60 ? 0 : 2,
    tension:         0.3,
    fill:            meta.key === "avgPowerW",
    hidden:          hiddenSeries.has(meta.key),
  }));

  if (overviewChartInstance) {
    overviewChartInstance.data.labels   = labels;
    overviewChartInstance.data.datasets = datasets;
    overviewChartInstance.update("none");
  } else {
    const ctx = document.getElementById("overview-chart").getContext("2d");
    overviewChartInstance = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          zoom: {
            pan:  { enabled: true, mode: "x" },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
          },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 12, font: { family: "Inter", size: 10 } } },
          y: { beginAtZero: true, ticks: { font: { family: "Inter", size: 10 } } },
        },
      },
    });
  }

  buildOverviewLegend();
}

function buildOverviewLegend() {
  const legendEl = document.getElementById("overview-legend");
  legendEl.innerHTML = overviewSeriesMeta.map((meta) => `
    <button class="legend-btn${hiddenSeries.has(meta.key) ? " hidden-series" : ""}" data-series="${meta.key}">
      <span class="dot" style="background:${meta.color}"></span>${meta.label}
    </button>`).join("");

  legendEl.querySelectorAll(".legend-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.series;
      if (hiddenSeries.has(key)) hiddenSeries.delete(key);
      else hiddenSeries.add(key);
      const idx = overviewSeriesMeta.findIndex((m) => m.key === key);
      if (overviewChartInstance && idx >= 0) {
        overviewChartInstance.data.datasets[idx].hidden = hiddenSeries.has(key);
        overviewChartInstance.update();
      }
      btn.classList.toggle("hidden-series", hiddenSeries.has(key));
    });
  });
}

// ── Battery chart ──────────────────────────────────────────────────────────
function renderBatteryChart(rows) {
  const labels   = rows.map((r) => fmtTime(r.time));
  const socData  = rows.map((r) => r.avgSoc  ?? null);
  const voltData = rows.map((r) => r.avgVolt ?? null);

  const datasets = [
    {
      label:           "SOC (%)",
      data:            socData,
      borderColor:     "#005147",
      backgroundColor: "#00514722",
      borderWidth:     2,
      pointRadius:     rows.length > 60 ? 0 : 2,
      tension:         0.3,
      fill:            true,
      yAxisID:         "ySoc",
    },
    {
      label:           "Voltage (V)",
      data:            voltData,
      borderColor:     "#005db6",
      backgroundColor: "transparent",
      borderWidth:     2,
      pointRadius:     rows.length > 60 ? 0 : 2,
      tension:         0.3,
      fill:            false,
      yAxisID:         "yVolt",
    },
  ];

  if (batteryChartInstance) {
    batteryChartInstance.data.labels   = labels;
    batteryChartInstance.data.datasets = datasets;
    batteryChartInstance.update("none");
  } else {
    const ctx = document.getElementById("battery-chart").getContext("2d");
    batteryChartInstance = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, labels: { font: { family: "Inter", size: 10 } } },
          zoom: {
            pan:  { enabled: true, mode: "x" },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
          },
        },
        scales: {
          x:     { ticks: { maxTicksLimit: 12, font: { family: "Inter", size: 10 } } },
          ySoc:  { type: "linear", position: "left",  min: 0, max: 100, ticks: { font: { family: "Inter", size: 10 } }, title: { display: true, text: "SOC (%)" } },
          yVolt: { type: "linear", position: "right", grid: { drawOnChartArea: false }, ticks: { font: { family: "Inter", size: 10 } }, title: { display: true, text: "Voltage (V)" } },
        },
      },
    });
  }
}

// ── CSV download ───────────────────────────────────────────────────────────
document.getElementById("csv-download").addEventListener("click", () => {
  const url = `${API}/api/inverter/analytics/export?source=${currentSource}&date=${currentDate}&detail=${currentDetail}`;
  fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.blob())
    .then((blob) => {
      const a    = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = `analytics-${currentSource}-${currentDate}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
});

// ── Source toggle ──────────────────────────────────────────────────────────
document.getElementById("source-toggle").querySelectorAll(".src-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".src-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentSource = btn.dataset.src;
    loadAnalytics();
  });
});

// ── Detail level ───────────────────────────────────────────────────────────
document.querySelectorAll(".detail-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".detail-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentDetail = btn.dataset.detail;
    loadAnalytics();
  });
});

// ── Date picker ────────────────────────────────────────────────────────────
const dateInput = document.getElementById("analytics-date");
dateInput.value = currentDate;
dateInput.addEventListener("change", () => {
  currentDate = dateInput.value;
  loadAnalytics();
});

// ── Zoom reset ─────────────────────────────────────────────────────────────
document.getElementById("overview-zoom-reset").addEventListener("click", () => {
  overviewChartInstance?.resetZoom();
});
document.getElementById("battery-zoom-reset").addEventListener("click", () => {
  batteryChartInstance?.resetZoom();
});

// ── Theme toggle ───────────────────────────────────────────────────────────
document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const isDark = document.documentElement.classList.contains("dark");
  if (isDark) {
    document.documentElement.classList.replace("dark", "light");
    document.getElementById("theme-icon").textContent = "dark_mode";
    localStorage.setItem("voltequilibrium-theme", "light");
  } else {
    document.documentElement.classList.replace("light", "dark");
    document.getElementById("theme-icon").textContent = "light_mode";
    localStorage.setItem("voltequilibrium-theme", "dark");
  }
});

// ── Sign out ───────────────────────────────────────────────────────────────
document.getElementById("sign-out").addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem("authToken");
  window.location.replace("../frontend/login.html");
});

// ── Init ───────────────────────────────────────────────────────────────────
loadAnalytics();
