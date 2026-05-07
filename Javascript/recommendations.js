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
// Maintenance Health (reuses /api/inverter/efficiency endpoint)
// ═══════════════════════════════════════════════════════════════════════════

const MH_CLOUD_MAX     = 0.8;
const MH_TEMP_BASE     = 25;
const MH_TEMP_COEFF    = 0.004;
const MH_PEAK_SUN      = 5.5;
const MH_RANDS_PER_KWH = 2.5;

let mhSparkline = null;

async function loadMaintenanceHealth() {
  const json = await apiFetch("/api/inverter/efficiency?source=solar&days=30");
  if (!json || !json.success || !json.data) return;

  const { totalCapacity, daily } = json.data;
  const capacity = (totalCapacity || 0) * 1000; // kW stored in DB, convert to W
  if (!capacity || daily.length < 3) {
    document.getElementById("mh-efficiency").textContent = "N/A";
    document.getElementById("mh-status-text").textContent = "Not enough data (need 3+ days)";
    return;
  }

  // Calculate daily efficiencies
  const efficiencies = daily.map(d => {
    const cF = 1 - (d.avgCloudCover / 100) * MH_CLOUD_MAX;
    const tF = 1 - Math.max(0, (d.avgTemp - MH_TEMP_BASE) * MH_TEMP_COEFF);
    const theorKwh = (capacity / 1000) * MH_PEAK_SUN * cF * tF;
    return theorKwh > 0.01 ? Math.min(150, (d.dailyKwh / theorKwh) * 100) : null;
  }).filter(e => e !== null);

  if (efficiencies.length === 0) return;

  const avgEff = efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length;

  // Efficiency display
  document.getElementById("mh-efficiency").textContent = `${avgEff.toFixed(0)}%`;

  // Health status
  const badge = document.getElementById("mh-status-badge");
  const icon = document.getElementById("mh-status-icon");
  const text = document.getElementById("mh-status-text");

  if (avgEff >= 85) {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-tertiary/10 text-tertiary";
    icon.textContent = "check_circle";
    text.textContent = "Panels are healthy — no action needed";
  } else if (avgEff >= 70) {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-secondary/10 text-secondary";
    icon.textContent = "warning";
    text.textContent = "May need cleaning — dust or shading detected";
  } else if (avgEff >= 50) {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-error/10 text-error";
    icon.textContent = "error";
    text.textContent = "Underperforming — check soiling or wiring";
  } else {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-error/20 text-error";
    icon.textContent = "dangerous";
    text.textContent = "Possible fault — inspect panels immediately";
  }

  // Savings lost
  const avgTheoreticalDaily = daily.reduce((sum, d) => {
    const cF = 1 - (d.avgCloudCover / 100) * MH_CLOUD_MAX;
    const tF = 1 - Math.max(0, (d.avgTemp - MH_TEMP_BASE) * MH_TEMP_COEFF);
    return sum + (capacity / 1000) * MH_PEAK_SUN * cF * tF;
  }, 0) / daily.length;
  const avgActualDaily = daily.reduce((sum, d) => sum + d.dailyKwh, 0) / daily.length;
  const missedKwhPerDay = Math.max(0, avgTheoreticalDaily - avgActualDaily);
  const monthlySavingsLost = missedKwhPerDay * 30 * MH_RANDS_PER_KWH;
  document.getElementById("mh-savings-lost").textContent = `R${monthlySavingsLost.toFixed(0)}/mo`;

  // Mini sparkline
  const labels = daily.map((d, i) => i);
  const sparkData = daily.map(d => {
    const cF = 1 - (d.avgCloudCover / 100) * MH_CLOUD_MAX;
    const tF = 1 - Math.max(0, (d.avgTemp - MH_TEMP_BASE) * MH_TEMP_COEFF);
    const theorKwh = (capacity / 1000) * MH_PEAK_SUN * cF * tF;
    return theorKwh > 0.01 ? Math.min(150, (d.dailyKwh / theorKwh) * 100) : null;
  });

  const datasets = [{
    data: sparkData,
    borderColor: avgEff >= 85 ? "#005147" : avgEff >= 70 ? "#005db6" : "#ba1a1a",
    backgroundColor: (avgEff >= 85 ? "#005147" : avgEff >= 70 ? "#005db6" : "#ba1a1a") + "22",
    borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: true,
  }];

  if (mhSparkline) {
    mhSparkline.data.labels = labels;
    mhSparkline.data.datasets = datasets;
    mhSparkline.update();
  } else {
    const canvas = document.getElementById("mh-sparkline");
    if (!canvas) return;
    mhSparkline = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, suggestedMin: 40, suggestedMax: 120 } },
      },
    });
  }
}

// ── Init + poll ──────────────────────────────────────────────────────────────
loadApplianceShift();
loadMaintenanceHealth();
setInterval(loadApplianceShift, 30000);
