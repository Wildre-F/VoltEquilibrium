// ── Auth guard ─────────────────────────────────────────────────────────────
const token = sessionStorage.getItem("authToken") || localStorage.getItem("authToken");
if (!token) window.location.replace("../frontend/login.html");
else if (!sessionStorage.getItem("authToken")) sessionStorage.setItem("authToken", token);

// ── Dark mode handled by theme.js ─────────────────────────────────────────

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
  if (res.status === 401 || res.status === 403) {
    sessionStorage.removeItem("authToken");
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

  const power   = json.data?.power   || [];
  const battery = json.data?.battery || [];

  renderOverviewChart(power);
  renderBatteryChart(battery);

  document.getElementById("chart-status").textContent =
    power.length > 0 ? `${power.length} data points` : `No ${currentSource} data for this date`;
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
    overviewChartInstance.update();
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
    batteryChartInstance.update();
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

// ── Theme toggle handled by theme.js ──────────────────────────────────────

// ── Sign out ───────────────────────────────────────────────────────────────
document.getElementById("sign-out").addEventListener("click", (e) => {
  e.preventDefault();
  sessionStorage.removeItem("authToken");
  localStorage.removeItem("authToken");
  window.location.replace("../frontend/login.html");
});

// ═══════════════════════════════════════════════════════════════════════════
// Efficiency Model
// ═══════════════════════════════════════════════════════════════════════════

const SOLAR_TEMP_BASE       = 25;
const SOLAR_TEMP_COEFF      = 0.004;   // -0.4 % per °C above 25
const CLOUD_REDUCTION_MAX   = 0.8;     // cloud cover reduces output up to 80 %
const PEAK_SUN_HOURS        = 5.5;     // South Africa average
const DEGRADATION_PER_YEAR  = 0.005;   // 0.5 % panel degradation / year
const RANDS_PER_KWH         = 2.5;     // Eskom tariff
const TARIFF_ESCALATION     = 0.05;    // 5 % annual tariff increase
const WIND_CUT_IN           = 3;
const WIND_RATED            = 12;
const WIND_CUT_OUT          = 20;

let efficiencyChartInstance = null;
let roiChartInstance        = null;

async function loadEfficiencyModel() {
  const json = await apiFetch(`/api/inverter/efficiency?source=${currentSource}&days=30`);
  if (!json || !json.success || !json.data) return;

  const { inverters, daily } = json.data;
  // capacity is stored in kW — convert to watts for all calculations
  const totalCapacity = (json.data.totalCapacity || 0) * 1000;
  if (!totalCapacity || daily.length === 0) {
    document.getElementById("eff-current").textContent      = "N/A";
    document.getElementById("eff-vs-expected").textContent   = "No data";
    document.getElementById("eff-today-output").textContent  = "—";
    document.getElementById("eff-temp-pill").textContent     = "—";
    document.getElementById("eff-cloud-pill").textContent    = "—";
    document.getElementById("eff-age-pill").textContent      = "—";
    return;
  }

  // --- Today's snapshot (last entry in daily array) ---
  const today     = daily[daily.length - 1];
  const hour      = new Date().getHours();
  const isSourceSolar = currentSource === "solar";

  let theoreticalW;
  if (isSourceSolar) {
    const sunFactor   = (hour >= 6 && hour <= 19) ? Math.sin((hour - 6) * Math.PI / 13) : 0;
    const cloudFactor = 1 - (today.avgCloudCover / 100) * CLOUD_REDUCTION_MAX;
    const tempFactor  = 1 - Math.max(0, (today.avgTemp - SOLAR_TEMP_BASE) * SOLAR_TEMP_COEFF);
    theoreticalW      = totalCapacity * sunFactor * cloudFactor * tempFactor;
  } else {
    const ws = today.avgWindSpeed || 0;
    if (ws < WIND_CUT_IN || ws > WIND_CUT_OUT) {
      theoreticalW = 0;
    } else if (ws >= WIND_RATED) {
      theoreticalW = totalCapacity;
    } else {
      theoreticalW = totalCapacity * Math.pow(ws / WIND_RATED, 3);
    }
  }

  // Current efficiency
  let effPct = "N/A";
  let deviationText = "—";
  if (theoreticalW > 1) {
    const eff = (today.avgPowerW / theoreticalW) * 100;
    effPct = Math.min(eff, 150).toFixed(0) + "%";
    const deviation = eff - 100;
    if (deviation >= 0) {
      deviationText = `+${deviation.toFixed(0)}%`;
      document.getElementById("eff-vs-expected").classList.add("text-primary");
      document.getElementById("eff-vs-expected").classList.remove("text-error");
    } else {
      deviationText = `${deviation.toFixed(0)}%`;
      document.getElementById("eff-vs-expected").classList.add("text-error");
      document.getElementById("eff-vs-expected").classList.remove("text-primary");
    }
  } else {
    deviationText = isSourceSolar ? "No sunlight" : "No wind";
  }

  document.getElementById("eff-current").textContent    = effPct;
  document.getElementById("eff-vs-expected").textContent = deviationText;

  // Today's output vs theoretical daily
  let theoreticalDailyKwh;
  if (isSourceSolar) {
    const cloudF = 1 - (today.avgCloudCover / 100) * CLOUD_REDUCTION_MAX;
    const tempF  = 1 - Math.max(0, (today.avgTemp - SOLAR_TEMP_BASE) * SOLAR_TEMP_COEFF);
    theoreticalDailyKwh = (totalCapacity / 1000) * PEAK_SUN_HOURS * cloudF * tempF;
  } else {
    const ws = today.avgWindSpeed || 0;
    let cf = 0;
    if (ws >= WIND_CUT_IN && ws <= WIND_CUT_OUT) {
      cf = ws >= WIND_RATED ? 1 : Math.pow(ws / WIND_RATED, 3);
    }
    theoreticalDailyKwh = (totalCapacity / 1000) * 24 * cf * 0.35; // 35 % capacity factor
  }

  document.getElementById("eff-today-output").innerHTML =
    `<span class="text-lg font-bold">${today.dailyKwh.toFixed(1)}</span>` +
    `<span class="text-[10px] text-on-surface-variant"> / ${theoreticalDailyKwh.toFixed(1)} kWh</span>`;

  // Factor pills
  if (isSourceSolar) {
    const tempImpact  = -Math.max(0, (today.avgTemp - SOLAR_TEMP_BASE) * SOLAR_TEMP_COEFF) * 100;
    const cloudImpact = -(today.avgCloudCover / 100) * CLOUD_REDUCTION_MAX * 100;
    document.getElementById("eff-temp-pill").textContent  = `${today.avgTemp.toFixed(0)}°C (${tempImpact.toFixed(1)}%)`;
    document.getElementById("eff-cloud-pill").textContent = `${today.avgCloudCover.toFixed(0)}% cloud (${cloudImpact.toFixed(0)}%)`;
  } else {
    document.getElementById("eff-temp-pill").textContent  = `${today.avgTemp.toFixed(0)}°C`;
    document.getElementById("eff-cloud-pill").textContent = `Wind ${(today.avgWindSpeed || 0).toFixed(1)} m/s`;
  }

  // System age
  const oldestInverter = inverters.reduce((a, b) =>
    new Date(a.createdAt) < new Date(b.createdAt) ? a : b
  );
  const ageYears = (Date.now() - new Date(oldestInverter.createdAt).getTime()) / (365.25 * 24 * 3600 * 1000);
  const ageDeg   = (ageYears * DEGRADATION_PER_YEAR * 100).toFixed(1);
  document.getElementById("eff-age-pill").textContent = `${ageYears.toFixed(1)} yrs (−${ageDeg}%)`;

  // --- Panel health status ---
  const validDays = daily.filter((d) => {
    if (isSourceSolar) {
      const cF = 1 - (d.avgCloudCover / 100) * CLOUD_REDUCTION_MAX;
      const tF = 1 - Math.max(0, (d.avgTemp - SOLAR_TEMP_BASE) * SOLAR_TEMP_COEFF);
      return (totalCapacity / 1000) * PEAK_SUN_HOURS * cF * tF > 0.01;
    }
    return (d.avgWindSpeed || 0) >= WIND_CUT_IN;
  });

  let avgEff = 0;
  if (validDays.length > 0) {
    const effSum = validDays.reduce((sum, d) => {
      let theorKwh;
      if (isSourceSolar) {
        const cF = 1 - (d.avgCloudCover / 100) * CLOUD_REDUCTION_MAX;
        const tF = 1 - Math.max(0, (d.avgTemp - SOLAR_TEMP_BASE) * SOLAR_TEMP_COEFF);
        theorKwh = (totalCapacity / 1000) * PEAK_SUN_HOURS * cF * tF;
      } else {
        const ws = d.avgWindSpeed || 0;
        const cf = ws >= WIND_RATED ? 1 : Math.pow(ws / WIND_RATED, 3);
        theorKwh = (totalCapacity / 1000) * 24 * cf * 0.35;
      }
      return sum + (theorKwh > 0.01 ? (d.dailyKwh / theorKwh) * 100 : 0);
    }, 0);
    avgEff = effSum / validDays.length;
  }

  const statusEl   = document.getElementById("eff-status");
  const statusIcon = document.getElementById("eff-status-icon");
  const statusText = document.getElementById("eff-status-text");

  if (validDays.length < 3) {
    statusEl.className   = "flex items-center gap-2 rounded-lg px-4 py-2.5 mb-4 text-sm font-label bg-surface-container text-on-surface-variant";
    statusIcon.textContent = "info";
    statusText.textContent = "Not enough data yet — need at least 3 days to assess panel health.";
  } else if (avgEff >= 85) {
    statusEl.className   = "flex items-center gap-2 rounded-lg px-4 py-2.5 mb-4 text-sm font-label bg-tertiary/10 text-tertiary";
    statusIcon.textContent = "check_circle";
    statusText.textContent = `Panels are healthy — averaging ${avgEff.toFixed(0)}% efficiency over ${validDays.length} days. No action needed.`;
  } else if (avgEff >= 70) {
    statusEl.className   = "flex items-center gap-2 rounded-lg px-4 py-2.5 mb-4 text-sm font-label bg-secondary/10 text-secondary";
    statusIcon.textContent = "warning";
    statusText.textContent = `Panels may need cleaning — averaging ${avgEff.toFixed(0)}% efficiency. Dust or light shading could be reducing output.`;
  } else if (avgEff >= 50) {
    statusEl.className   = "flex items-center gap-2 rounded-lg px-4 py-2.5 mb-4 text-sm font-label bg-error/10 text-error";
    statusIcon.textContent = "error";
    statusText.textContent = `Panels underperforming — averaging ${avgEff.toFixed(0)}% efficiency. Check for heavy soiling, shading, or wiring issues.`;
  } else {
    statusEl.className   = "flex items-center gap-2 rounded-lg px-4 py-2.5 mb-4 text-sm font-label bg-error/20 text-error";
    statusIcon.textContent = "dangerous";
    statusText.textContent = `Possible fault detected — averaging only ${avgEff.toFixed(0)}% efficiency. Inspect panels for damage, inverter errors, or connection problems.`;
  }

  // --- 30-day efficiency chart ---
  renderEfficiencyChart(daily, totalCapacity);
}

function renderEfficiencyChart(daily, capacity) {
  const isSourceSolar = currentSource === "solar";
  const labels = daily.map((d) => {
    const dt = new Date(d.date);
    return dt.toLocaleDateString([], { month: "short", day: "numeric" });
  });

  const effData = daily.map((d) => {
    let theorKwh;
    if (isSourceSolar) {
      const cF = 1 - (d.avgCloudCover / 100) * CLOUD_REDUCTION_MAX;
      const tF = 1 - Math.max(0, (d.avgTemp - SOLAR_TEMP_BASE) * SOLAR_TEMP_COEFF);
      theorKwh = (capacity / 1000) * PEAK_SUN_HOURS * cF * tF;
    } else {
      const ws = d.avgWindSpeed || 0;
      let cf = 0;
      if (ws >= WIND_CUT_IN && ws <= WIND_CUT_OUT) {
        cf = ws >= WIND_RATED ? 1 : Math.pow(ws / WIND_RATED, 3);
      }
      theorKwh = (capacity / 1000) * 24 * cf * 0.35;
    }
    return theorKwh > 0.01 ? Math.min((d.dailyKwh / theorKwh) * 100, 150) : null;
  });

  const refLine = daily.map(() => 100);

  const datasets = [
    {
      label:           "Efficiency (%)",
      data:            effData,
      borderColor:     "#005147",
      backgroundColor: "#00514722",
      borderWidth:     2,
      pointRadius:     daily.length > 20 ? 0 : 3,
      tension:         0.3,
      fill:            true,
    },
    {
      label:       "100% reference",
      data:        refLine,
      borderColor: "#6e7976",
      borderDash:  [6, 3],
      borderWidth: 1,
      pointRadius: 0,
      fill:        false,
    },
  ];

  if (efficiencyChartInstance) {
    efficiencyChartInstance.data.labels   = labels;
    efficiencyChartInstance.data.datasets = datasets;
    efficiencyChartInstance.update("none");
  } else {
    const ctx = document.getElementById("efficiency-chart").getContext("2d");
    efficiencyChartInstance = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, labels: { font: { family: "Inter", size: 10 } } },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 10, font: { family: "Inter", size: 10 } } },
          y: {
            suggestedMin: 40,
            suggestedMax: 120,
            ticks: { font: { family: "Inter", size: 10 }, callback: (v) => v + "%" },
          },
        },
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ROI Calculator
// ═══════════════════════════════════════════════════════════════════════════

async function calculateROI() {
  const costInput = document.getElementById("roi-cost");
  const billInput = document.getElementById("roi-bill");
  const cost      = parseFloat(costInput.value);
  const bill      = parseFloat(billInput.value) || null;

  // Persist inputs so they survive page reloads
  if (costInput.value) localStorage.setItem("roi-cost", costInput.value);
  else localStorage.removeItem("roi-cost");
  if (billInput.value) localStorage.setItem("roi-bill", billInput.value);
  else localStorage.removeItem("roi-bill");

  if (!cost || cost <= 0) {
    costInput.focus();
    return;
  }

  // Fetch real generation data
  const co2Json = await apiFetch("/api/co2");
  if (!co2Json || !co2Json.success) return;

  // Use 30-day history for a reliable daily average
  const history = co2Json.data.history || [];
  const daysWithData = history.filter((d) => d.kwh > 0);
  const totalHistoryKwh = daysWithData.reduce((sum, d) => sum + d.kwh, 0);
  const avgDailyKwh = daysWithData.length > 0
    ? totalHistoryKwh / daysWithData.length
    : (co2Json.data.todayKwh || 0);

  if (avgDailyKwh <= 0) {
    document.getElementById("roi-payback").textContent  = "N/A";
    document.getElementById("roi-monthly").textContent   = "No data";
    document.getElementById("roi-ten-year").textContent  = "—";
    document.getElementById("roi-results").classList.remove("hidden");
    return;
  }

  // Monthly savings
  let monthlySavings = avgDailyKwh * 30.44 * RANDS_PER_KWH;
  if (bill && bill > 0) monthlySavings = Math.min(monthlySavings, bill);

  // 10-year projection with degradation + tariff escalation
  const projection = [];
  let cumulative = 0;
  let paybackYear = null;

  for (let year = 0; year <= 10; year++) {
    const yearGenKwh  = avgDailyKwh * 365.25 * (1 - DEGRADATION_PER_YEAR * year);
    const yearTariff  = RANDS_PER_KWH * Math.pow(1 + TARIFF_ESCALATION, year);
    let yearSavings   = yearGenKwh * yearTariff;
    if (bill && bill > 0) yearSavings = Math.min(yearSavings, bill * 12);
    cumulative += yearSavings;
    projection.push({ year, yearSavings, cumulative });
    if (paybackYear === null && cumulative >= cost) paybackYear = year;
  }

  // Format payback
  let paybackText;
  if (paybackYear !== null) {
    if (paybackYear === 0) {
      paybackText = "< 1 year";
    } else {
      // Interpolate within the payback year
      const prev = paybackYear > 0 ? projection[paybackYear - 1].cumulative : 0;
      const curr = projection[paybackYear].cumulative;
      const fraction = (cost - prev) / (curr - prev);
      const exact = (paybackYear - 1) + fraction;
      const yrs = Math.floor(exact);
      const months = Math.round((exact - yrs) * 12);
      paybackText = months > 0 ? `${yrs}y ${months}m` : `${yrs} yrs`;
    }
  } else {
    paybackText = "> 10 yrs";
  }

  const tenYearNet = cumulative - cost;

  document.getElementById("roi-payback").textContent  = paybackText;
  document.getElementById("roi-monthly").textContent   = `R${monthlySavings.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  document.getElementById("roi-ten-year").textContent  = `R${tenYearNet.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  document.getElementById("roi-results").classList.remove("hidden");

  renderROIChart(projection, cost);
}

function renderROIChart(projection, cost) {
  const labels = projection.map((p) => `Year ${p.year}`);
  const cumulativeData = projection.map((p) => parseFloat(p.cumulative.toFixed(0)));
  const costLine = projection.map(() => cost);

  const barColors = cumulativeData.map((v) =>
    v >= cost ? "#374e00" : "#005147"
  );

  const datasets = [
    {
      type:            "bar",
      label:           "Cumulative Savings (R)",
      data:            cumulativeData,
      backgroundColor: barColors,
      borderRadius:    6,
      order:           2,
    },
    {
      type:        "line",
      label:       "Installation Cost",
      data:        costLine,
      borderColor: "#ba1a1a",
      borderDash:  [8, 4],
      borderWidth: 2,
      pointRadius: 0,
      fill:        false,
      order:       1,
    },
  ];

  if (roiChartInstance) {
    roiChartInstance.data.labels   = labels;
    roiChartInstance.data.datasets = datasets;
    roiChartInstance.update("none");
  } else {
    const ctx = document.getElementById("roi-chart").getContext("2d");
    roiChartInstance = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, labels: { font: { family: "Inter", size: 10 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = ctx.raw;
                return `${ctx.dataset.label}: R${val.toLocaleString()}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { font: { family: "Inter", size: 10 } } },
          y: {
            beginAtZero: true,
            ticks: {
              font: { family: "Inter", size: 10 },
              callback: (v) => "R" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v),
            },
          },
        },
      },
    });
  }
}

// ── ROI Calculate button ──────────────────────────────────────────────────
document.getElementById("roi-calculate").addEventListener("click", calculateROI);

// ── Hook efficiency into source toggle ────────────────────────────────────
document.getElementById("source-toggle").querySelectorAll(".src-btn").forEach((btn) => {
  btn.addEventListener("click", () => loadEfficiencyModel());
});

// ── Restore ROI inputs from localStorage ──────────────────────────────────
const savedCost = localStorage.getItem("roi-cost");
const savedBill = localStorage.getItem("roi-bill");
if (savedCost) document.getElementById("roi-cost").value = savedCost;
if (savedBill) document.getElementById("roi-bill").value = savedBill;

// ── Init ───────────────────────────────────────────────────────────────────
loadAnalytics();
loadEfficiencyModel();
if (savedCost) calculateROI();
