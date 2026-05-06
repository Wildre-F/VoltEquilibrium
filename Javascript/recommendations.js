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
// Smart Power Schedule — Eskom vs Battery by time of day
// ═══════════════════════════════════════════════════════════════════════════

function getTariffPeriod(hour) {
  if (hour >= 22 || hour < 6)
    return { name: "Off-Peak", rate: 1.50, source: "eskom", color: "var(--color-secondary)", label: "Use Eskom", icon: "electrical_services", tip: "Cheap tariff — charge battery from grid" };
  if ((hour >= 7 && hour < 9) || (hour >= 17 && hour < 20))
    return { name: "Peak", rate: 4.50, source: "battery", color: "var(--color-tertiary)", label: "Use Battery", icon: "battery_horiz_075", tip: "Expensive tariff — avoid grid, use stored energy" };
  return { name: "Standard", rate: 2.50, source: "eskom", color: "var(--color-primary)", label: "Use Eskom", icon: "electrical_services", tip: "Standard tariff — grid is fine" };
}

async function loadPowerSchedule() {
  const scheduleEl = document.getElementById("schedule-widget");
  if (!scheduleEl) return;

  // Fetch loadshedding stage
  let lsStage = 0;
  try {
    const lsJson = await apiFetch("/api/loadshedding");
    if (lsJson?.success) lsStage = lsJson.stage || 0;
  } catch (err) {
    console.error("[recommendations] loadshedding fetch error:", err.message);
  }

  // Fetch battery SOC
  let soc = 0;
  try {
    const readJson = await apiFetch("/api/readings/latest");
    if (readJson?.success) {
      const d = (readJson.data.all || [])[0] || {};
      soc = parseFloat(d.state_of_charge) || 0;
    }
  } catch (err) {
    console.error("[recommendations] battery SOC fetch error:", err.message);
  }

  const now = new Date();
  const currentHour = now.getHours();
  const current = getTariffPeriod(currentHour);

  // Override if load shedding active
  const lsActive = lsStage > 0;
  if (lsActive) {
    current.source = "battery";
    current.color = "var(--color-error)";
    current.label = "Battery (Load Shedding)";
    current.icon = "flash_off";
    current.tip = `Stage ${lsStage} active — Eskom unavailable, using battery`;
  }

  // Current recommendation
  const recEl = document.getElementById("schedule-current");
  if (recEl) {
    const socWarning = soc < 30 ? `<span class="text-error font-bold"> — LOW, request energy!</span>` : "";
    recEl.innerHTML = `
      <div class="flex items-center gap-3 mb-2">
        <div class="w-10 h-10 rounded-full flex items-center justify-center" style="background:${current.color}20;">
          <span class="material-symbols-outlined" style="color:${current.color};font-variation-settings:'FILL' 1;">${current.icon}</span>
        </div>
        <div>
          <p class="text-sm font-bold font-headline" style="color:${current.color};">${current.label}</p>
          <p class="text-[10px] text-on-surface-variant font-body">${current.name} — R${current.rate.toFixed(2)}/kWh</p>
        </div>
      </div>
      <p class="text-xs text-on-surface-variant font-body mb-1">${current.tip}</p>
      <p class="text-xs font-label text-on-surface-variant">Battery: <span class="font-bold text-on-surface">${soc.toFixed(0)}%</span>${socWarning} · Load Shedding: <span class="font-bold ${lsActive ? "text-error" : "text-on-surface"}">${lsActive ? "Stage " + lsStage : "None"}</span></p>`;
  }

  // 24-hour timeline (12 x 2-hour blocks)
  const timelineEl = document.getElementById("schedule-timeline");
  if (timelineEl) {
    let blocks = "";
    for (let h = 0; h < 24; h += 2) {
      const period = getTariffPeriod(h);
      const isCurrent = currentHour >= h && currentHour < h + 2;
      const isLs = lsActive && isCurrent;
      const blockColor = isLs ? "var(--color-error)" : period.color;
      const label = h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
      const ring = isCurrent ? `outline:3px solid ${blockColor};outline-offset:2px;` : "";
      blocks += `<div class="flex-1 flex flex-col items-center gap-1">
        <div class="w-full h-10 rounded-lg flex items-center justify-center" style="background:${blockColor}${isCurrent ? "" : "20"};border:2px solid ${blockColor};${ring}">
          ${isCurrent ? `<span class="material-symbols-outlined text-white text-sm" style="font-variation-settings:'FILL' 1;">${isLs ? "flash_off" : period.icon}</span>` : ""}
        </div>
        <span class="text-[9px] font-label ${isCurrent ? "font-bold text-on-surface" : "text-on-surface-variant/60"}">${label}</span>
      </div>`;
    }
    timelineEl.innerHTML = blocks;
  }

  // Legend
  const legendEl = document.getElementById("schedule-legend");
  if (legendEl) {
    legendEl.innerHTML = `
      <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:var(--color-secondary);"></span><span class="text-[9px] font-label text-on-surface-variant">Off-Peak R1.50</span></span>
      <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:var(--color-primary);"></span><span class="text-[9px] font-label text-on-surface-variant">Standard R2.50</span></span>
      <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:var(--color-tertiary);"></span><span class="text-[9px] font-label text-on-surface-variant">Peak R4.50</span></span>
      ${lsActive ? `<span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:var(--color-error);"></span><span class="text-[9px] font-label text-error font-bold">Load Shedding</span></span>` : ""}`;
  }

  // Estimated daily savings
  const savingsEl = document.getElementById("schedule-savings");
  if (savingsEl) {
    // Peak hours: 7-9am + 5-8pm = 5 hours. Avg load ~500W = 2.5 kWh during peak
    // Savings = peak_kwh × (peak_rate - offpeak_rate) = 2.5 × (4.50 - 1.50) = R7.50
    const peakHours = 5;
    const avgLoadKw = 0.5;
    const peakKwh = peakHours * avgLoadKw;
    const savings = peakKwh * (4.50 - 1.50);
    savingsEl.textContent = `~R${savings.toFixed(2)}/day saved by using battery during peak hours`;
  }

  document.getElementById("schedule-updated").textContent =
    `Updated ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// ── Init + poll ──────────────────────────────────────────────────────────────
loadApplianceShift();
loadPowerSchedule();
setInterval(loadApplianceShift, 30000);
setInterval(loadPowerSchedule, 60000); // refresh schedule every minute
