// ── Auth guard ─────────────────────────────────────────────────────────────
// DEV_MODE: bypasses login redirects so frontend can be edited without Docker auth.
// This branch (dev/frontend-no-auth) only — never merge this flag as true.
const DEV_MODE = true;

const token = localStorage.getItem("authToken");
if (!DEV_MODE && !token) window.location.replace("../frontend/login.html");

const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:3000" : "";

// ── Dark mode (persisted from login) ──────────────────────────────────────
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

// ── Help modal definitions ─────────────────────────────────────────────────
const HELP_TILES = [
  {
    title: "Grid Voltage",
    desc: "The AC voltage at the point where the inverter connects to the building's electrical grid.",
    calc: "Measured live from the inverter's AC output terminal (ac_voltage field).",
  },
  {
    title: "Grid Frequency",
    desc: "The alternating current frequency of the grid output, measured in Hertz. South African standard is 50 Hz.",
    calc: "Measured live from the inverter's AC output (frequency field). Healthy range: 49.5–50.5 Hz.",
  },
  {
    title: "Grid kWh Used Today",
    desc: "Total energy imported from or exported to the municipal grid today. A positive value means you drew power from the grid (battery was empty); a value near zero means you were self-sufficient.",
    calc: "Cumulative grid_kwh published by the simulator, reset at midnight.",
  },
  {
    title: "Inverter DC Voltage",
    desc: "The DC bus voltage between the solar panels / wind generator and the inverter's input stage.",
    calc: "Measured live from the inverter's DC input terminal (dc_voltage field).",
  },
  {
    title: "Inverter Load Watts",
    desc: "The current power consumption of the connected building or household load in Watts.",
    calc: "Measured live (load_watts field). Typical household: 200–400 W, commercial building: 800–1200 W.",
  },
  {
    title: "Inverter Frequency",
    desc: "Same AC frequency signal as Grid Frequency — confirms the inverter is locked to the grid and stable.",
    calc: "Same frequency field, shown here in the context of the inverter's output rather than the grid input.",
  },
  {
    title: "Avg PV Volts",
    desc: "The average DC voltage across all readings today. Lower than expected voltage can indicate shading, soiling, or a degraded panel string.",
    calc: "AVG(dc_voltage) from raw_readings where recorded_at >= today midnight.",
  },
  {
    title: "Avg PV Amps",
    desc: "The average DC current drawn from the panels today. Higher current means more sunlight or wind is being converted to electricity.",
    calc: "AVG(dc_current) from raw_readings where recorded_at >= today midnight.",
  },
  {
    title: "PV Watts",
    desc: "The live power output from your generation source (solar panels or wind turbine) right now, in Watts.",
    calc: "Latest power_w reading. Theoretical max = dc_voltage × dc_current × efficiency factor.",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem("authToken");
    window.location.replace("../frontend/login.html");
    return null;
  }
  return res.json();
}

function fmt(n, decimals = 1) {
  return n != null ? parseFloat(n).toFixed(decimals) : "—";
}
function fmtTime(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Electrical tile (large, 3-per-row) ────────────────────────────────────
function buildElecTile(label, value, unit, icon, iconColor) {
  return `
    <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-sm p-5 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold font-label uppercase tracking-widest text-on-surface-variant/60 dark:text-slate-400">${label}</span>
        <span class="material-symbols-outlined text-xl" style="color:${iconColor}">${icon}</span>
      </div>
      <div class="flex items-end gap-1.5">
        <span class="text-3xl font-extrabold font-headline text-on-surface dark:text-white leading-none">${value}</span>
        <span class="text-sm font-label text-on-surface-variant/60 dark:text-slate-400 mb-0.5">${unit}</span>
      </div>
    </div>`;
}

// ── Load summary ───────────────────────────────────────────────────────────
async function loadSummary() {
  const json = await apiFetch("/api/inverter/summary");
  if (!json || !json.success) return;

  const { inverters, battery, electrical } = json.data;
  const e = electrical || {};

  // Build a labelled row of 3 tiles
  function buildRow(label, accentColor, iconName, tiles) {
    return `
      <div>
        <div class="flex items-center gap-2 mb-3">
          <span class="material-symbols-outlined text-base" style="color:${accentColor}">${iconName}</span>
          <span class="text-sm font-bold font-headline uppercase tracking-widest" style="color:${accentColor}">${label}</span>
          <div class="flex-1 h-px" style="background:${accentColor}22"></div>
        </div>
        <div class="grid grid-cols-3 gap-4">${tiles.join("")}</div>
      </div>`;
  }

  const grid = document.getElementById("totals-grid");
  grid.innerHTML = [
    buildRow("Solar", "#374e00", "wb_sunny", [
      buildElecTile("PV Watts",     fmt(e.solarWatts, 0),   "W",  "solar_power", "#374e00"),
      buildElecTile("Avg PV Volts", fmt(e.avgPvVolts, 1),   "V",  "sunny",       "#374e00"),
      buildElecTile("Avg PV Amps",  fmt(e.avgPvAmps, 3),    "A",  "bolt",        "#374e00"),
    ]),
    buildRow("Wind", "#005db6", "air", [
      buildElecTile("Wind Power",   fmt(e.windWatts, 0),    "W",   "wind_power",  "#005db6"),
      buildElecTile("Wind Speed",   fmt(e.windSpeed, 2),    "m/s", "air",         "#005db6"),
      buildElecTile("Rotor RPM",    fmt(e.rotorRpm, 1),     "rpm", "rotate_right","#005db6"),
    ]),
    buildRow("Grid & Inverter", "#005147", "electrical_services", [
      buildElecTile("Grid Voltage",    fmt(e.gridVoltage, 1),   "V",   "electric_bolt",          "#005147"),
      buildElecTile("Grid Frequency",  fmt(e.gridFrequency, 2), "Hz",  "cycle",                  "#005147"),
      buildElecTile("Grid kWh Today",  fmt(e.gridKwhUsed, 3),   "kWh", "electrical_services",    "#ba1a1a"),
      buildElecTile("Inverter Voltage",fmt(e.invVoltage, 1),    "V",   "developer_board",        "#005147"),
      buildElecTile("Load",            fmt(e.invLoadWatts, 0),  "W",   "home",                   "#005147"),
      buildElecTile("Inv. Frequency",  fmt(e.invFrequency, 2),  "Hz",  "settings_input_antenna", "#005147"),
    ]),
  ].join("");

  // Device cards
  const cardsEl = document.getElementById("inverter-cards");
  if (inverters.length === 0) {
    cardsEl.innerHTML = `<div class="flex items-center justify-center h-40 bg-white dark:bg-slate-800 rounded-2xl shadow-sm text-on-surface-variant/40 text-sm font-label col-span-2">No inverters found.</div>`;
    return;
  }

  cardsEl.innerHTML = inverters.map((inv) => {
    const isWind    = inv.type === "wind";
    const typeIcon  = isWind ? "air" : "wb_sunny";
    const typeColor = isWind ? "#005db6" : "#374e00";
    const windRows  = isWind ? `
      <div class="flex justify-between text-sm py-1 border-b border-outline-variant/10">
        <span class="text-on-surface-variant/60 dark:text-slate-400 font-label">Wind Speed</span>
        <span class="font-semibold font-label dark:text-white">${inv.liveWindSpeed != null ? inv.liveWindSpeed + " m/s" : "—"}</span>
      </div>
      <div class="flex justify-between text-sm py-1 border-b border-outline-variant/10">
        <span class="text-on-surface-variant/60 dark:text-slate-400 font-label">Rotor RPM</span>
        <span class="font-semibold font-label dark:text-white">${inv.liveRotorRpm != null ? fmt(inv.liveRotorRpm, 1) : "—"}</span>
      </div>
      <div class="flex justify-between text-sm py-1">
        <span class="text-on-surface-variant/60 dark:text-slate-400 font-label">Pitch Angle</span>
        <span class="font-semibold font-label dark:text-white">${inv.livePitchAngle != null ? fmt(inv.livePitchAngle, 1) + "°" : "—"}</span>
      </div>` : "";

    return `
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-sm p-5">
        <div class="flex items-start justify-between mb-4">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:${typeColor}18">
              <span class="material-symbols-outlined" style="color:${typeColor}">${typeIcon}</span>
            </div>
            <div>
              <p class="font-bold font-headline text-on-surface dark:text-white">${inv.name}</p>
              <p class="text-xs text-on-surface-variant/60 dark:text-slate-400 font-label capitalize">${inv.profile || inv.type}</p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-xl font-extrabold font-headline text-primary">${inv.livePowerW != null ? fmt(inv.livePowerW, 0) + " W" : "—"}</p>
            <p class="text-xs text-on-surface-variant/40 dark:text-slate-500 font-label">live output</p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-x-6 mb-4">
          <div>
            <p class="text-xs text-on-surface-variant/50 dark:text-slate-500 font-label uppercase tracking-widest mb-0.5">Serial</p>
            <p class="text-sm font-semibold font-label text-on-surface dark:text-white">${inv.serialNumber || "—"}</p>
          </div>
          <div>
            <p class="text-xs text-on-surface-variant/50 dark:text-slate-500 font-label uppercase tracking-widest mb-0.5">Firmware</p>
            <p class="text-sm font-semibold font-label text-on-surface dark:text-white">${inv.firmwareVersion || "—"}</p>
          </div>
          <div class="mt-2">
            <p class="text-xs text-on-surface-variant/50 dark:text-slate-500 font-label uppercase tracking-widest mb-0.5">Capacity</p>
            <p class="text-sm font-semibold font-label text-on-surface dark:text-white">${inv.capacity ? inv.capacity + " kW" : "—"}</p>
          </div>
          <div class="mt-2">
            <p class="text-xs text-on-surface-variant/50 dark:text-slate-500 font-label uppercase tracking-widest mb-0.5">Last Seen</p>
            <p class="text-sm font-semibold font-label text-on-surface dark:text-white">${fmtTime(inv.lastSeen)}</p>
          </div>
        </div>
        <div class="border-t border-outline-variant/20 pt-3">
          <div class="flex justify-between text-sm py-1 border-b border-outline-variant/10">
            <span class="text-on-surface-variant/60 dark:text-slate-400 font-label">Today Generated</span>
            <span class="font-semibold font-label dark:text-white">${fmt(inv.todayKwh, 3)} kWh</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-outline-variant/10">
            <span class="text-on-surface-variant/60 dark:text-slate-400 font-label">Today Load</span>
            <span class="font-semibold font-label dark:text-white">${fmt(inv.todayLoadKwh, 3)} kWh</span>
          </div>
          <div class="flex justify-between text-sm py-1 border-b border-outline-variant/10">
            <span class="text-on-surface-variant/60 dark:text-slate-400 font-label">Today Grid</span>
            <span class="font-semibold font-label dark:text-white">${fmt(inv.todayGridKwh, 3)} kWh</span>
          </div>
          <div class="flex justify-between text-sm py-1 ${isWind ? "border-b border-outline-variant/10" : ""}">
            <span class="text-on-surface-variant/60 dark:text-slate-400 font-label">Temperature</span>
            <span class="font-semibold font-label dark:text-white">${inv.liveTemp != null ? fmt(inv.liveTemp, 1) + " °C" : "—"}</span>
          </div>
          ${windRows}
        </div>
        ${battery ? `
        <div class="mt-4 pt-3 border-t border-outline-variant/20">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-bold font-label text-on-surface-variant/60 dark:text-slate-400 uppercase tracking-widest">Battery</span>
            <span class="text-sm font-extrabold font-headline text-primary">${fmt(battery.soc, 1)}%</span>
          </div>
          <div class="w-full h-2 bg-surface-container dark:bg-slate-700 rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-700"
              style="width:${Math.min(100, Math.max(0, battery.soc))}%;background:${battery.soc > 50 ? "#005147" : battery.soc > 20 ? "#374e00" : "#ba1a1a"}">
            </div>
          </div>
          <div class="flex justify-between text-xs font-label text-on-surface-variant/50 dark:text-slate-500 mt-1">
            <span>${fmt(battery.voltage, 2)} V · ${fmt(battery.powerW, 1)} W</span>
            <span>${fmt(battery.temperature, 1)} °C</span>
          </div>
        </div>` : ""}
      </div>`;
  }).join("");

  document.getElementById("last-updated").textContent = "Updated " + new Date().toLocaleTimeString();
}

// ── Help modal ─────────────────────────────────────────────────────────────
function openHelp() {
  const modal = document.getElementById("help-modal");
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeHelp() {
  document.getElementById("help-modal").classList.add("hidden");
  document.body.style.overflow = "";
}

document.getElementById("help-btn").addEventListener("click", openHelp);
document.getElementById("help-close").addEventListener("click", closeHelp);
document.getElementById("help-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeHelp();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeHelp(); });

// Populate help modal content
document.getElementById("help-content").innerHTML = HELP_TILES.map((t, i) => `
  <div class="bg-surface-container-low dark:bg-slate-700 rounded-xl p-4">
    <div class="flex items-start gap-3 mb-2">
      <span class="text-xs font-bold font-label bg-primary text-white rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0 mt-0.5">${i + 1}</span>
      <p class="font-bold font-headline text-on-surface dark:text-white text-sm">${t.title}</p>
    </div>
    <p class="text-sm text-on-surface-variant dark:text-slate-300 font-body mb-2 ml-8">${t.desc}</p>
    <p class="text-xs text-on-surface-variant/60 dark:text-slate-400 font-label italic ml-8">📐 ${t.calc}</p>
  </div>`).join("");

// ── Theme toggle ───────────────────────────────────────────────────────────
document.getElementById("theme-toggle").addEventListener("click", () => {
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

// ── Guided tour (Driver.js) ────────────────────────────────────────────────
function startTour() {
  const isDark = document.documentElement.classList.contains("dark");
  const driver = window.driver.js.driver({
    animate: true,
    smoothScroll: true,
    showProgress: true,
    progressText: "{{current}} / {{total}}",
    nextBtnText: "Next →",
    prevBtnText: "← Back",
    doneBtnText: "Done",
    overlayColor: isDark ? "#0f172a" : "#000",
    overlayOpacity: 0.6,
    popoverClass: "ve-tour-popover",
    steps: [
      {
        element: "#tour-btn",
        popover: {
          title: "Welcome to the Inverter page",
          description: "This page shows live telemetry from all your inverters. Let's walk through each section.",
          side: "bottom",
          align: "start",
        },
      },
      {
        element: "#section-totals",
        popover: {
          title: "Inverter Totals",
          description: "Live electrical metrics grouped by source. Refreshes every 30 seconds automatically.",
          side: "top",
          align: "start",
        },
      },
      {
        element: "#totals-grid > div:nth-child(1)",
        popover: {
          title: "Solar Row",
          description: "<b>PV Watts</b> — live solar output. <b>Avg PV Volts</b> — average DC voltage from panels today (low value = shading or soiling). <b>Avg PV Amps</b> — average DC current today.",
          side: "bottom",
          align: "start",
        },
      },
      {
        element: "#totals-grid > div:nth-child(2)",
        popover: {
          title: "Wind Row",
          description: "<b>Wind Power</b> — live turbine output. <b>Wind Speed</b> — current wind speed at your location. <b>Rotor RPM</b> — how fast the turbine blades are spinning.",
          side: "bottom",
          align: "start",
        },
      },
      {
        element: "#totals-grid > div:nth-child(3)",
        popover: {
          title: "Grid & Inverter Row",
          description: "<b>Grid Voltage / Frequency</b> — your AC output quality. <b>Grid kWh Today</b> — energy drawn from or exported to the municipal grid today. <b>Inverter Voltage</b> — DC bus voltage. <b>Load</b> — current power draw of your building. <b>Inv. Frequency</b> — confirms inverter is locked to the grid.",
          side: "top",
          align: "start",
        },
      },
      {
        element: "#section-devices",
        popover: {
          title: "Device Cards",
          description: "One card per inverter. Shows serial number, firmware, live output, today's energy totals, and the shared battery state of charge.",
          side: "top",
          align: "start",
        },
      },
      {
        element: "#help-btn",
        popover: {
          title: "Quick Reference",
          description: "Click the ? button any time to open a reference sheet explaining every metric and how it's calculated.",
          side: "bottom",
          align: "end",
        },
      },
    ],
  });
  driver.drive();
}

document.getElementById("tour-btn").addEventListener("click", startTour);

// ── Init ───────────────────────────────────────────────────────────────────
loadSummary();
setInterval(loadSummary, 30000);
