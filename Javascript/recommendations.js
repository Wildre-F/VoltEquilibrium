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

  if (!json || !json.success || !json.data) {
    const widget = document.getElementById("mh-widget");
    if (widget) {
      widget.innerHTML = `
        <div class="flex items-center gap-2 mb-4">
          <span class="material-symbols-outlined text-primary" style="font-variation-settings:'FILL' 1;">battery_charging_full</span>
          <h2 class="text-sm font-bold font-headline text-on-surface">System Health</h2>
        </div>
        <div class="text-center py-6">
          <span class="material-symbols-outlined text-3xl text-primary/30 block mb-3" style="font-variation-settings:'FILL' 1;">electric_bolt</span>
          <p class="text-sm font-semibold text-on-surface font-headline">Battery-only system</p>
          <p class="text-xs text-on-surface-variant font-body mt-1">Panel health monitoring is available for solar and wind users. Your battery health is tracked on the Dashboard.</p>
          <a href="Dashboard.html" class="inline-block mt-3 text-xs text-primary font-bold font-label hover:underline">Go to Dashboard</a>
        </div>`;
    }
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
    document.getElementById("mh-savings-lost").textContent = "R0.00 today";
  } else if (d.alarm) {
    badge.className = "flex items-center gap-2 rounded-lg px-3 py-2 mb-4 text-xs font-label bg-error/10 text-error";
    icon.textContent = "warning";
    text.textContent = "Panels underperforming. Check for soiling, shading, or faults.";
    // Show Lottie warning animation
    const warnEl = document.getElementById("mh-lottie-warning");
    if (warnEl && typeof lottie !== "undefined" && !warnEl._loaded) {
      warnEl.style.display = "block";
      lottie.loadAnimation({ container: warnEl, renderer: "svg", loop: true, autoplay: true, path: "../lottie/warning.json" });
      warnEl._loaded = true;
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// Carbon to Action Converter
// Converts CO2 savings into real-world equivalents
// ═══════════════════════════════════════════════════════════════════════════

// Conversion factors (sourced from EPA, IPCC)
const C2A_KG_CO2_PER_TREE_PER_YEAR = 22;    // avg tree absorbs ~22 kg CO2/year
const C2A_KG_CO2_PER_KM_CAR        = 0.21;  // avg car emits ~210g CO2/km
const C2A_KWH_PER_LED_BULB_YEAR    = 10 * 8 * 365 / 1000; // 10W bulb, 8hrs/day, 1 year = 29.2 kWh
const C2A_KG_CO2_PER_KWH           = 0.928; // SA grid factor

const C2A_TIPS = [
  { min: 0, tip: "Replacing a single 60W incandescent bulb with a 10W LED saves about 0.046 kg of CO2 per hour of use." },
  { min: 10, tip: "You've offset the equivalent of driving a car for {km} km. Every kWh of solar replaces dirty coal power." },
  { min: 50, tip: "Your {trees} tree equivalent is growing! A mature tree absorbs about 22 kg of CO2 per year." },
  { min: 100, tip: "You've saved over 100 kg of CO2. That's like taking a car off the road for {km} km!" },
  { min: 500, tip: "Half a tonne of CO2 offset! You're making a real difference to South Africa's carbon footprint." },
  { min: 1000, tip: "Over 1 tonne of CO2 offset. That's equivalent to planting {trees} trees and letting them grow for a year." },
  { min: 5000, tip: "5 tonnes of CO2! You're a climate champion. Your panels have avoided {km} km of car emissions." },
];

async function loadCarbonToAction() {
  const json = await apiFetch("/api/co2");
  if (!json || !json.success || !json.data) return;

  const d = json.data;
  const co2Kg = d.lifetimeCo2Kg || 0;
  const lifetimeKwh = d.lifetimeKwh || 0;

  // Calculate equivalents
  const trees = co2Kg / C2A_KG_CO2_PER_TREE_PER_YEAR;
  const carKm = co2Kg / C2A_KG_CO2_PER_KM_CAR;
  const ledBulbs = lifetimeKwh / C2A_KWH_PER_LED_BULB_YEAR;

  // Animate numbers
  VE.animateNumber("c2a-co2", co2Kg, { decimals: 1 });
  VE.animateNumber("c2a-trees", trees, { decimals: 1 });
  VE.animateNumber("c2a-km", carKm, { decimals: 0 });
  VE.animateNumber("c2a-bulbs", ledBulbs, { decimals: 0 });

  // Pick the best tip based on CO2 amount
  let tip = C2A_TIPS[0].tip;
  for (const t of C2A_TIPS) {
    if (co2Kg >= t.min) tip = t.tip;
  }
  tip = tip.replace("{km}", Math.round(carKm).toLocaleString()).replace("{trees}", trees.toFixed(1));

  const tipEl = document.getElementById("c2a-tip-text");
  if (tipEl) tipEl.textContent = tip;

  const statusEl = document.getElementById("c2a-status");
  if (statusEl) statusEl.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// ── Init + poll ──────────────────────────────────────────────────────────────
loadApplianceShift();
loadCarbonToAction();
loadMaintenanceHealth();
setInterval(loadApplianceShift, 30000);
setInterval(loadMaintenanceHealth, 30000);
