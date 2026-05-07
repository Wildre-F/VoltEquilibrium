// VoltEquilibrium — Recommendations: Appliance Shift Schedule
const token = sessionStorage.getItem("authToken") || localStorage.getItem("authToken");
if (!token) window.location.replace("../frontend/login.html");
else if (!sessionStorage.getItem("authToken")) sessionStorage.setItem("authToken", token);

const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:3000" : "";

async function apiFetch(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    sessionStorage.removeItem("authToken");
    localStorage.removeItem("authToken");
    window.location.replace("../frontend/login.html");
    return null;
  }
  return res.json();
}

// ── Traffic light logic ──────────────────────────────────────────────────────
function getTrafficLight(soc, generationW, cloudCover, isBatteryOnly) {

  if (isBatteryOnly) {
    // Battery-only user: no generation, judge purely on SOC
    if (soc > 80) {
      return {
        color: "green", bg: "var(--color-tertiary)", bgLight: "var(--color-tertiary-fixed)",
        label: "Great Time", icon: "sentiment_very_satisfied",
        message: "Battery is well charged. You can run heavy appliances safely.",
      };
    }
    if (soc < 30) {
      return {
        color: "red", bg: "var(--color-error)", bgLight: "var(--color-error-container)",
        label: "Avoid Now", icon: "sentiment_dissatisfied",
        message: "Battery is low. Avoid heavy appliances and request energy from the community.",
      };
    }
    return {
      color: "orange", bg: "var(--color-secondary)", bgLight: "var(--color-secondary-container)",
      label: "Moderate", icon: "sentiment_neutral",
      message: "Battery is at a moderate level. Use appliances cautiously or request more energy.",
    };
  }

  // Generator user: check SOC + generation
  if (soc > 80 && (generationW > 2000 || cloudCover < 30)) {
    return {
      color: "green", bg: "var(--color-tertiary)", bgLight: "var(--color-tertiary-fixed)",
      label: "Great Time", icon: "sentiment_very_satisfied",
      message: "Battery is well charged and generation is strong. Run your heavy appliances now!",
    };
  }
  if (soc < 30 || (generationW < 100 && soc < 50)) {
    return {
      color: "red", bg: "var(--color-error)", bgLight: "var(--color-error-container)",
      label: "Avoid Now", icon: "sentiment_dissatisfied",
      message: "Battery is low and generation is minimal. Delay heavy appliances to preserve your stored energy.",
    };
  }
  return {
    color: "orange", bg: "var(--color-secondary)", bgLight: "var(--color-secondary-container)",
    label: "Moderate", icon: "sentiment_neutral",
    message: "Battery is at a moderate level. Use appliances cautiously and monitor your SOC.",
  };
}

function getHourLight(cloudCover, currentSoc) {
  // Predict based on cloud + current SOC trend
  if (currentSoc > 60 && cloudCover < 30) return "green";
  if (currentSoc < 30 || cloudCover > 70) return "red";
  return "orange";
}

const lightColors = {
  green: "var(--color-tertiary)",
  orange: "var(--color-secondary)",
  red: "var(--color-error)",
};

// ── Load and render ──────────────────────────────────────────────────────────
async function loadApplianceShift() {
  const [readingsJson, forecastJson] = await Promise.all([
    apiFetch("/api/readings/latest"),
    apiFetch("/api/weather/forecast"),
  ]);

  if (!readingsJson?.success) return;

  const all = readingsJson.data.all || [];
  const d = all[0] || {};

  const soc = parseFloat(d.state_of_charge) || 0;
  const genW = parseFloat(d.power_w) || 0;
  const loadW = parseFloat(d.load_watts) || 0;
  const gridW = parseFloat(d.grid_watts) || 0;
  const cloud = parseFloat(d.cloud_cover) || 0;
  const isBatteryOnly = d.type === "battery";

  const light = getTrafficLight(soc, genW, cloud, isBatteryOnly);
  const fmt = (w) => w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;

  // Update traffic light
  const dot = document.getElementById("shift-light");
  if (dot) {
    dot.style.background = light.bg;
    dot.style.boxShadow = `0 0 20px ${light.bg}, 0 0 40px ${light.bg}40`;
  }
  const face = document.getElementById("shift-face");
  if (face) face.textContent = light.icon;
  const labelEl = document.getElementById("shift-label");
  if (labelEl) {
    labelEl.textContent = light.label;
    labelEl.style.color = light.bg;
  }
  const iconEl = document.getElementById("shift-icon");
  if (iconEl) {
    iconEl.textContent = light.icon;
    iconEl.style.color = light.bg;
  }
  const msgEl = document.getElementById("shift-message");
  if (msgEl) msgEl.textContent = light.message;

  // Update stats
  document.getElementById("shift-soc").textContent = `${soc.toFixed(0)}%`;
  document.getElementById("shift-gen").textContent = fmt(genW);
  document.getElementById("shift-load").textContent = fmt(loadW);
  document.getElementById("shift-grid").textContent = gridW > 0 ? fmt(gridW) : "0 W";

  // Update SOC bar
  const socBar = document.getElementById("shift-soc-bar");
  if (socBar) {
    socBar.style.width = `${Math.min(100, Math.max(0, soc))}%`;
    socBar.style.background = soc > 80 ? lightColors.green : soc > 30 ? lightColors.orange : lightColors.red;
  }

  // 6-hour forecast timeline
  const timeline = document.getElementById("shift-timeline");
  if (timeline && forecastJson?.success) {
    const hours = forecastJson.data.hourly || [];
    if (hours.length > 0) {
      timeline.innerHTML = hours.map(h => {
        const hLight = getHourLight(h.cloud, soc);
        return `<div class="flex-1 flex flex-col items-center gap-1">
          <div class="w-full h-8 rounded-lg transition-colors" style="background:${lightColors[hLight]}20;border:2px solid ${lightColors[hLight]}"></div>
          <span class="text-[10px] font-label text-on-surface-variant">${h.time}</span>
          <span class="text-[9px] font-label text-on-surface-variant/60">${h.cloud}%</span>
        </div>`;
      }).join("");
    } else {
      timeline.innerHTML = `<p class="text-xs text-on-surface-variant/60 text-center py-2 w-full">No forecast data — set your location in profile</p>`;
    }
  }

  // Update time
  document.getElementById("shift-updated").textContent =
    `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// ── Sign out ─────────────────────────────────────────────────────────────────
document.getElementById("sign-out")?.addEventListener("click", (e) => {
  e.preventDefault();
  sessionStorage.removeItem("authToken");
  localStorage.removeItem("authToken");
  window.location.replace("../frontend/login.html");
});

// ── Help panel toggle ────────────────────────────────────────────────────────
document.getElementById("recs-help-btn")?.addEventListener("click", () => {
  document.getElementById("recs-help-panel").classList.toggle("hidden");
});
document.getElementById("recs-help-close")?.addEventListener("click", () => {
  document.getElementById("recs-help-panel").classList.add("hidden");
});

// ═══════════════════════════════════════════════════════════════════════════
// 7-Day Generation Forecast (on Recommendations page)
// ═══════════════════════════════════════════════════════════════════════════

let recsForecastChart = null;

async function loadRecsForecast() {
  const statusEl = document.getElementById("recs-forecast-status");
  if (statusEl) statusEl.textContent = "Loading...";

  const json = await apiFetch("/api/forecast/generation?days=7");
  if (!json || !json.success || !json.data || !json.data.summary) {
    if (statusEl) statusEl.textContent = json?.data?.message || "No forecast available";
    return;
  }

  const { daily, summary } = json.data;

  document.getElementById("rfc-total-kwh").textContent = summary.totalPredictedKwh.toFixed(1);
  document.getElementById("rfc-savings").textContent = `R${summary.estimatedSavingsRands.toFixed(0)}`;
  document.getElementById("rfc-co2").textContent = summary.estimatedCo2OffsetKg.toFixed(1);
  document.getElementById("rfc-best-day").innerHTML =
    `<span>${new Date(summary.bestDay.date).toLocaleDateString([], { weekday: "short" })}</span>` +
    `<br><span class="text-[10px] text-on-surface-variant">${summary.bestDay.kwh.toFixed(1)} kWh</span>`;

  if (statusEl) statusEl.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  // 7-day bar chart
  const labels = daily.map(d => new Date(d.date).toLocaleDateString([], { weekday: "short", day: "numeric" }));
  const data = daily.map(d => d.predictedKwh);
  const colors = daily.map(d =>
    d.confidence === "high" ? "#005147" : d.confidence === "medium" ? "#005db6" : "#6e7976"
  );

  const datasets = [{ label: "Predicted kWh", data, backgroundColor: colors, borderRadius: 6 }];

  if (recsForecastChart) {
    recsForecastChart.data.labels = labels;
    recsForecastChart.data.datasets = datasets;
    recsForecastChart.update();
  } else {
    const canvas = document.getElementById("recs-forecast-chart");
    if (!canvas) return;
    recsForecastChart = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${ctx.raw.toFixed(1)} kWh` } },
        },
        scales: {
          x: { ticks: { font: { family: "Inter", size: 10 } } },
          y: { beginAtZero: true, ticks: { font: { family: "Inter", size: 10 }, callback: (v) => v + " kWh" } },
        },
      },
    });
  }
}

// ── Init + poll ──────────────────────────────────────────────────────────────
loadApplianceShift();
loadRecsForecast();
setInterval(loadApplianceShift, 30000);
