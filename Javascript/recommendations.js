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
  const readingsJson = await apiFetch("/api/readings/latest");
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

  // Update time
  document.getElementById("shift-updated").textContent =
    `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// Sign out handled by theme.js

// ── Help panel with fade in/out ──────────────────────────────────────────────
function openHelp() {
  const panel = document.getElementById("recs-help-panel");
  panel.classList.remove("hidden", "hiding");
  panel.classList.add("showing");
}
function closeHelp() {
  const panel = document.getElementById("recs-help-panel");
  panel.classList.remove("showing");
  panel.classList.add("hiding");
  setTimeout(() => { panel.classList.add("hidden"); panel.classList.remove("hiding"); }, 250);
}
document.getElementById("recs-help-btn")?.addEventListener("click", openHelp);
document.getElementById("recs-help-close")?.addEventListener("click", closeHelp);

// ═══════════════════════════════════════════════════════════════════════════
// Maintenance Health (real-time via /api/inverter/maintenance/health)
// Compares live actual output vs expected output using current weather
// ═══════════════════════════════════════════════════════════════════════════

async function loadMaintenanceHealth() {
  const json = await apiFetch("/api/inverter/maintenance/health");
  if (!json || !json.success) return;

  if (!json.data) {
    document.getElementById("mh-efficiency").textContent = "N/A";
    document.getElementById("mh-status-text").textContent = "No inverters found";
    return;
  }

  const d = json.data;
  const eff = d.overall_efficiency_pct;

  // Efficiency display
  if (eff !== null) {
    VE.animateNumber("mh-efficiency", eff, { decimals: 0, suffix: "%" });
  } else {
    document.getElementById("mh-efficiency").textContent = "N/A";
  }

  // Health status badge
  const badge = document.getElementById("mh-status-badge");
  const icon = document.getElementById("mh-status-icon");
  const text = document.getElementById("mh-status-text");

  if (eff === null) {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-surface-container text-on-surface-variant";
    icon.textContent = "info";
    text.textContent = "No generation right now (nighttime or no sun/wind)";
  } else if (d.alarm) {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-error/10 text-error";
    icon.textContent = "warning";
    text.textContent = "Panels underperforming. Check for soiling, shading, or faults.";
  } else if (eff >= 85) {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-tertiary/10 text-tertiary";
    icon.textContent = "check_circle";
    text.textContent = "Panels are healthy. No action needed.";
  } else if (eff >= 70) {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-secondary/10 text-secondary";
    icon.textContent = "info";
    text.textContent = "Slightly below expected. Monitor for changes.";
  } else {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-error/10 text-error";
    icon.textContent = "error";
    text.textContent = "Significant underperformance detected.";
  }

  // Savings lost
  VE.animateNumber("mh-savings-lost", d.total_financial_loss_rand, { decimals: 2, prefix: "R", suffix: " today" });
}

// ── Init + poll ──────────────────────────────────────────────────────────────
loadApplianceShift();
loadMaintenanceHealth();
setInterval(loadApplianceShift, 30000);
setInterval(loadMaintenanceHealth, 30000);
