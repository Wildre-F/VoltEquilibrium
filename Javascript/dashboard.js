// VoltEquilibrium Dashboard — Live Data
// Fetches from GET /api/readings/latest every 30 s and drives:
//   • Speed-dial SVG gauges
//   • Stat tiles
//   • Chart.js power history line graph
//   • Solar / Wind source toggle

// ── Auth guard ────────────────────────────────────────────────────────────────
document.documentElement.style.visibility = "hidden";

window.addEventListener("pageshow", async () => {
  const token = localStorage.getItem("authToken");
  if (!token) {
    window.location.replace("../frontend/login.html");
    return;
  }

  try {
    const res = await fetch("http://localhost:3000/api/setup/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    localStorage.setItem("userRole", data.role);
    if (!data.hasSetup && data.role !== "consumer") {
      window.location.replace("../frontend/setup.html");
      return;
    }
  } catch {
    /* show page anyway if status check fails */
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
          // Pick icon based on cloud cover
          const icon =
            h.cloud > 70
              ? "cloud"
              : h.cloud > 30
                ? "partly_cloudy_day"
                : "sunny";
          const iconColor =
            h.cloud > 70 ? "#6e7976" : h.cloud > 30 ? "#005db6" : "#374e00";
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

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function init() {
    initChartFilters(); // wire up filter buttons
    await loadHistory(); // pre-fill charts from DB
    await fetchAndRender(); // get latest live readings
    await loadForecast(); // load weather widget
    setInterval(fetchAndRender, POLL_MS);
    setInterval(loadForecast, 15 * 60 * 1000); // refresh forecast every 15 min
    setTimeout(() => toast.show("Welcome to VoltEquilibrium", "success"), 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
