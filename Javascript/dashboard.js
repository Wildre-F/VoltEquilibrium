// VoltEquilibrium Dashboard — Live Data
// Fetches from GET /api/readings/latest every 30 s and drives:
//   • Speed-dial SVG gauges
//   • Stat tiles
//   • Chart.js power history line graph
//   • Solar / Wind source toggle

// ── Auth guard ────────────────────────────────────────────────────────────────
// DEV_MODE: bypasses login redirects so frontend can be edited without Docker auth.
// This branch (dev/frontend-no-auth) only — never merge this flag as true.
const DEV_MODE = true;

if (!DEV_MODE) document.documentElement.style.visibility = "hidden";

window.addEventListener("pageshow", async () => {
  if (DEV_MODE) return;

  const token = localStorage.getItem("authToken");
  if (!token) {
    window.location.replace("../frontend/login.html");
    return;
  }

  try {
    const res = await fetch("http://localhost:3000/api/setup/status", {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Token expired or invalid — clear it and send to login
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem("authToken");
      window.location.replace("../frontend/login.html");
      return;
    }

    const data = await res.json();
    localStorage.setItem("userRole", data.role);
    if (!data.hasSetup && data.role !== "consumer") {
      window.location.replace("../frontend/setup.html");
      return;
    }
  } catch {
    /* network failure — show the page and let individual API calls handle auth */
  }

  document.documentElement.style.visibility = "visible";
});

(function () {
  "use strict";

  const API_BASE = "http://localhost:3000";
  const POLL_MS = 30000;
  const MAX_HISTORY = 20; // rolling window for Live filter

  // Tracks the active range (number of points) for each chart.
  // Live = 20, 1h = 120, 1d = 2880, Max = 5000.
  // pushToChart uses this so the trim limit matches the selected filter.
  const activeRange = { solar: MAX_HISTORY, wind: MAX_HISTORY };

  const token = localStorage.getItem("authToken");

  // Handle OAuth token in URL
  const oauthToken = new URLSearchParams(window.location.search).get("token");
  if (oauthToken) {
    localStorage.setItem("authToken", oauthToken);
    window.history.replaceState({}, "", window.location.pathname);
  }

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
  // The HTML uses id="sign-out" (not "sign-out-btn") so we target that directly.
  document.getElementById("sign-out")?.addEventListener("click", (e) => {
    e.preventDefault();
    localStorage.removeItem("authToken");
    window.location.href = "../frontend/login.html";
  });

  // ── Toast ──────────────────────────────────────────────────────────────────
  const toast = {
    show(msg, type = "info") {
      const colors = {
        info: "bg-primary text-white",
        success: "bg-tertiary text-on-surface",
        warning: "bg-secondary text-white",
        error: "bg-error text-white",
      };
      const icons = {
        info: "info",
        success: "check_circle",
        warning: "warning",
        error: "error",
      };
      const el = document.createElement("div");
      el.className = `${colors[type]} px-4 py-3 rounded-xl shadow-lg transform translate-x-full transition-transform duration-300 flex items-center gap-2 min-w-[200px]`;
      el.innerHTML = `<span class="material-symbols-outlined text-sm">${icons[type]}</span><span class="text-sm font-semibold">${msg}</span>`;
      document.getElementById("toast-container").appendChild(el);
      requestAnimationFrame(() => el.classList.remove("translate-x-full"));
      setTimeout(() => {
        el.classList.add("translate-x-full");
        setTimeout(() => el.remove(), 300);
      }, 3000);
    },
  };

  // ── Speed dial helper ──────────────────────────────────────────────────────
  // How the dial works:
  //   The SVG <path> draws a 270-degree arc (from bottom-left to bottom-right).
  //   stroke-dasharray=216 sets the total visible length of the arc.
  //   stroke-dashoffset controls how much of that length is hidden from the start.
  //   dashoffset = ARC_LEN × (1 - fraction)  →  0 = full, 216 = empty.
  const ARC_LEN = 216;
  function setDial(arcId, textId, value, max, displayText) {
    const arc = document.getElementById(arcId);
    const text = document.getElementById(textId);
    if (!arc || !text) return;
    const fraction = Math.min(1, Math.max(0, (value || 0) / max));
    arc.style.strokeDashoffset = (ARC_LEN * (1 - fraction)).toFixed(2);
    text.textContent = displayText;
  }

  // ── Chart.js setup ─────────────────────────────────────────────────────────
  function makeChart(canvasId, color) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    return new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            data: [],
            borderColor: color,
            backgroundColor: color + "18",
            borderWidth: 2.5,
            pointRadius: 3,
            pointBackgroundColor: color,
            tension: 0.4,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        animation: { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(0)} W` },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, maxTicksLimit: 8, color: "#6e7976" },
          },
          y: {
            beginAtZero: true,
            ticks: { font: { size: 10 }, color: "#6e7976" },
            grid: { color: "#e0e3e240" },
          },
        },
      },
    });
  }

  const solarChart = makeChart("solar-chart", "#005147");
  const windChart = makeChart("wind-chart", "#005db6");

  function pushToChart(chart, timeLabel, value, maxPoints) {
    if (!chart) return;
    chart.data.labels.push(timeLabel);
    chart.data.datasets[0].data.push(value || 0);
    if (chart.data.labels.length > maxPoints) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
    }
    chart.update();
  }

  // ── Source toggle ──────────────────────────────────────────────────────────
  let activeSource = "solar";

  document.querySelectorAll(".src-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeSource = btn.dataset.source;
      document.querySelectorAll(".src-btn").forEach((b) => {
        const isActive = b.dataset.source === activeSource;
        b.classList.toggle("active", isActive);
      });
      showActivePanel();
    });
  });

  function showActivePanel() {
    const hasSolar = !!lastData?.solar?.length;
    const hasWind = !!lastData?.wind?.length;

    document.getElementById("panel-solar").classList.add("hidden");
    document.getElementById("panel-wind").classList.add("hidden");
    document.getElementById("panel-nodata").classList.add("hidden");

    if (activeSource === "solar" && hasSolar) {
      document.getElementById("panel-solar").classList.remove("hidden");
    } else if (activeSource === "wind" && hasWind) {
      document.getElementById("panel-wind").classList.remove("hidden");
    } else {
      document.getElementById("panel-nodata").classList.remove("hidden");
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  let lastData = null;

  function render(data) {
    lastData = data;
    const now = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const lu = document.getElementById("last-updated");
    if (lu) lu.textContent = `Updated ${now}`;

    const solar = data.solar?.[0] || null;
    const wind = data.wind?.[0] || null;

    // ── Solar ──────────────────────────────────────────────────────────────
    if (solar) {
      const pw = parseFloat(solar.power_w) || 0;
      const maxW = (solar.profile || "").includes("large") ? 10000 : 3000;

      setDial(
        "solar-power-arc",
        "solar-power-text",
        pw,
        maxW,
        pw >= 1000 ? `${(pw / 1000).toFixed(2)} kW` : `${Math.round(pw)} W`,
      );
      setDial(
        "solar-dcv-arc",
        "solar-dcv-text",
        parseFloat(solar.dc_voltage) || 0,
        150,
        `${(+solar.dc_voltage || 0).toFixed(1)} V`,
      );
      setDial(
        "solar-acv-arc",
        "solar-acv-text",
        parseFloat(solar.ac_voltage) || 0,
        260,
        `${(+solar.ac_voltage || 0).toFixed(1)} V`,
      );
      setDial(
        "solar-soc-arc",
        "solar-soc-text",
        parseFloat(solar.state_of_charge) || 0,
        100,
        `${(+solar.state_of_charge || 0).toFixed(1)} %`,
      );

      setText(
        "solar-freq",
        solar.frequency != null ? `${(+solar.frequency).toFixed(2)} Hz` : "—",
      );
      setText(
        "solar-temp",
        solar.inverter_temp != null
          ? `${(+solar.inverter_temp).toFixed(1)}°C`
          : "—",
      );
      setText(
        "solar-kwh",
        solar.energy_kwh != null
          ? `${(+solar.energy_kwh).toFixed(3)} kWh`
          : "—",
      );
      setText(
        "solar-cloud",
        solar.cloud_cover != null ? `${solar.cloud_cover}%` : "—",
      );

      pushToChart(solarChart, now, pw, activeRange.solar);
    }

    // ── Wind ───────────────────────────────────────────────────────────────

    if (wind) {
      const pw = parseFloat(wind.power_w) || 0;
      const maxW = (wind.profile || "").includes("large") ? 15000 : 2000;
      const maxRPM = (wind.profile || "").includes("large") ? 25 : 600;

      setDial(
        "wind-power-arc",
        "wind-power-text",
        pw,
        maxW,
        pw >= 1000 ? `${(pw / 1000).toFixed(2)} kW` : `${Math.round(pw)} W`,
      );
      setDial(
        "wind-speed-arc",
        "wind-speed-text",
        parseFloat(wind.wind_speed) || 0,
        25,
        `${(+wind.wind_speed || 0).toFixed(1)} m/s`,
      );
      setDial(
        "wind-rpm-arc",
        "wind-rpm-text",
        parseFloat(wind.rotor_rpm) || 0,
        maxRPM,
        `${(+wind.rotor_rpm || 0).toFixed(0)} RPM`,
      );
      const batteryRow = data.all.find((r) => r.state_of_charge != null) || {};
      const windSoc = parseFloat(batteryRow.state_of_charge) || 0;
      setDial(
        "wind-soc-arc",
        "wind-soc-text",
        windSoc,
        100,
        `${windSoc.toFixed(1)} %`,
      );

      setText(
        "wind-pitch",
        wind.pitch_angle != null ? `${(+wind.pitch_angle).toFixed(1)}°` : "—",
      );
      setText(
        "wind-temp",
        wind.inverter_temp != null
          ? `${(+wind.inverter_temp).toFixed(1)}°C`
          : "—",
      );
      setText(
        "wind-kwh",
        wind.energy_kwh != null ? `${(+wind.energy_kwh).toFixed(3)} kWh` : "—",
      );
      setText(
        "wind-freq",
        wind.frequency != null ? `${(+wind.frequency).toFixed(2)} Hz` : "—",
      );

      pushToChart(windChart, now, pw, activeRange.wind);
    }

    showActivePanel();
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ── Fetch loop ─────────────────────────────────────────────────────────────
  let errShown = false;

  async function fetchAndRender() {
    try {
      const res = await fetch(`${API_BASE}/api/readings/latest`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      errShown = false;
      render(json.data);
    } catch (err) {
      console.error("[dashboard]", err.message);
      if (!errShown) {
        toast.show("Could not reach server — retrying...", "warning");
        errShown = true;
      }
    }
  }

  // ── History ────────────────────────────────────────────────────────────────
  async function loadHistory() {
    try {
      const res = await fetch(`${API_BASE}/api/readings/history?limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const json = await res.json();
      if (!json.success) return;

      // Safe handling for solar data
      (json.data?.solar || []).forEach((row) => {
        const t = new Date(row.recorded_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        pushToChart(solarChart, t, parseFloat(row.power_w) || 0, MAX_HISTORY);
      });

      // Safe handling for wind data
      (json.data?.wind || []).forEach((row) => {
        const t = new Date(row.recorded_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        pushToChart(windChart, t, parseFloat(row.power_w) || 0, MAX_HISTORY);
      });
    } catch (err) {
      console.warn("[dashboard] History load failed:", err.message);
    }
  }

  // ── Weather forecast widget ────────────────────────────────────────────────
  async function loadForecast() {
    try {
      const res = await fetch(`${API_BASE}/api/weather/forecast`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();

      if (!json.success) {
        document.getElementById("weather-loading").textContent =
          json.message || "No location set — update in Profile.";
        return;
      }

      const d = json.data;

      // Location label + updated time
      setText("weather-location-label", d.location);
      setText(
        "weather-updated",
        `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      );

      // Current conditions
      setText("w-temp", `${d.current.temp?.toFixed(1)}°C`);
      setText("w-wind", `${d.current.wind?.toFixed(1)} m/s`);
      setText("w-cloud", `${d.current.cloud}%`);

      // Hourly forecast cards
      const container = document.getElementById("weather-hourly");
      document.getElementById("weather-loading")?.remove();

      container.innerHTML = d.hourly
        .map((h) => {
          // Pick icon based on cloud cover AND time of day
          const hour    = parseInt(h.time.split(":")[0], 10);
          const isNight = hour < 6 || hour >= 20;

          const icon =
            h.cloud > 70
              ? "cloud"
              : h.cloud > 30
                ? isNight ? "nights_stay" : "partly_cloudy_day"
                : isNight ? "bedtime"     : "sunny";

          const iconColor =
            h.cloud > 70
              ? "#6e7976"
              : h.cloud > 30
                ? "#005db6"
                : isNight ? "#3d3a6b" : "#374e00";
          return `
          <div class="bg-surface-container-low rounded-xl p-3 text-center">
            <div class="text-xs font-bold font-label text-on-surface-variant/60 mb-1">${h.time}</div>
            <span class="material-symbols-outlined text-xl block mb-1" style="color:${iconColor}">${icon}</span>
            <div class="text-sm font-bold font-headline text-primary">${h.temp?.toFixed(1)}°</div>
            <div class="text-xs text-on-surface-variant/60 mt-1">${h.wind?.toFixed(1)} m/s</div>
          </div>
        `;
        })
        .join("");
    } catch (err) {
      console.warn("[dashboard] Forecast failed:", err.message);
      setText("weather-loading", "Could not load forecast.");
    }
  }

  function initChartFilters() {
    document.querySelectorAll(".chart-filter-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const chartType = btn.dataset.chart; // "solar" or "wind"
        const range = parseInt(btn.dataset.range);

        // Update active button styling within this filter group
        const group =
          chartType === "solar" ? "solar-chart-filters" : "wind-chart-filters";
        document
          .querySelectorAll(`#${group} .chart-filter-btn`)
          .forEach((b) => {
            b.classList.toggle("active", b === btn);
          });

        const chart = chartType === "solar" ? solarChart : windChart;
        if (!chart) return;

        // Update the active range so pushToChart trims to the right window
        activeRange[chartType] = range;
        await reloadChart(chart, chartType, range);
      });
    });
  }

  async function reloadChart(chart, type, limit) {
    try {
      const res = await fetch(
        `${API_BASE}/api/readings/history?limit=${limit}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const json = await res.json();
      if (!json.success) return;

      const rows =
        type === "solar" ? json.data.solar || [] : json.data.wind || [];

      // Clear existing chart data and repopulate
      chart.data.labels = [];
      chart.data.datasets[0].data = [];

      rows.forEach((row) => {
        const t = new Date(row.recorded_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        chart.data.labels.push(t);
        chart.data.datasets[0].data.push(parseFloat(row.power_w) || 0);
      });

      chart.update();
    } catch (err) {
      console.warn("[dashboard] Chart reload failed:", err.message);
    }
  }

  // ── CO2 & Savings widget ───────────────────────────────────────────────────
  let co2ChartInstance = null;
  let co2Payload = null; // cached for filter switching without re-fetching

  async function loadCo2() {
    try {
      const res = await fetch(`${API_BASE}/api/co2`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!json.success) return;
      co2Payload = json.data;

      setText("co2-today-kg", co2Payload.todayCo2Kg.toFixed(3));
      setText("co2-today-rands", `R ${co2Payload.todayRands.toFixed(2)}`);
      setText("co2-lifetime-kg", co2Payload.lifetimeCo2Kg.toFixed(3));
      setText("co2-lifetime-rands", `R ${co2Payload.lifetimeRands.toFixed(2)}`);

      // Keep the currently active filter when refreshing
      const active = document.querySelector("[data-co2].active");
      renderCo2Chart(active ? active.dataset.co2 : "co2");
    } catch (err) {
      console.warn("[dashboard] CO2 load failed:", err.message);
    }
  }

  function renderCo2Chart(metric) {
    if (!co2Payload) return;

    const labels = co2Payload.history.map((d) => {
      const dt = new Date(d.date);
      return `${dt.getDate()}/${dt.getMonth() + 1}`;
    });

    let values, label, color;
    if (metric === "kwh") {
      values = co2Payload.history.map((d) => d.kwh);
      label = "Energy (kWh)";
      color = "#005db6";
    } else if (metric === "rands") {
      values = co2Payload.history.map((d) => d.randsSaved);
      label = "Savings (ZAR)";
      color = "#374e00";
    } else {
      values = co2Payload.history.map((d) => d.co2Kg);
      label = "CO₂ Offset (kg)";
      color = "#005147";
    }

    const ctx = document.getElementById("co2-chart")?.getContext("2d");
    if (!ctx) return;
    if (co2ChartInstance) co2ChartInstance.destroy();

    co2ChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label,
            data: values,
            backgroundColor: color + "33",
            borderColor: color,
            borderWidth: 1.5,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, color: "#6e7976" },
          },
          y: {
            beginAtZero: true,
            grid: { color: "#e0e3e2" },
            ticks: { font: { size: 10 }, color: "#6e7976" },
          },
        },
      },
    });
  }

  function initCo2Filters() {
    document.querySelectorAll("[data-co2]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("[data-co2]")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderCo2Chart(btn.dataset.co2);
      });
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function init() {
    initChartFilters(); // wire up filter buttons
    initCo2Filters(); // wire up CO2 filter buttons
    await loadHistory(); // pre-fill charts from DB
    await fetchAndRender(); // get latest live readings
    await loadForecast(); // load weather widget
    await loadCo2(); // load CO2 & savings widget
    setInterval(fetchAndRender, POLL_MS);
    setInterval(loadForecast, 15 * 60 * 1000); // refresh forecast every 15 min
    setInterval(loadCo2, 5 * 60 * 1000); // refresh CO2 every 5 min
    setTimeout(() => toast.show("Welcome to VoltEquilibrium", "success"), 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
