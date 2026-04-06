// VoltEquilibrium Dashboard JavaScript
// Handles real-time data simulation, interactivity, and UI updates

// Hide page immediately until auth check passes
document.documentElement.style.visibility = 'hidden';

window.addEventListener('pageshow', (event) => {
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.replace('/frontend/login.html');
    } else {
        document.documentElement.style.visibility = 'visible';
    }
});

(function () {
  "use strict";

  // Configuration
  const CONFIG = {
    updateInterval: 3000,
    chartUpdateInterval: 5000,
    toastDuration: 3000,
    animationDuration: 500,
    detailUpdateInterval: 2000,
  };

  // State management
  const state = {
    liveGeneration: 12.4,
    solarOutput: 8.2,
    windOutput: 4.2,
    efficiency: 98.4,
    storage: 82,
    nodeHealth: 92,
    dailySave: 42,
    co2Offset: 1.2,
    projectedSavings: 124.5,
    currentPeriod: "D",
    isTransferRequested: false,
    detailPanelOpen: false,
  };

  // Utility functions
  const utils = {
    random: (min, max) => Math.random() * (max - min) + min,
    format: (num, decimals = 1) => num.toFixed(decimals),
    formatCurrency: (num) => `$${num.toFixed(2)}`,
    clamp: (val, min, max) => Math.min(Math.max(val, min), max),
    randomWalk: (current, variance, min, max) => {
      const change = utils.random(-variance, variance);
      return utils.clamp(current + change, min, max);
    },
  };

  // Toast notification system
  const toast = {
    container: document.getElementById("toast-container"),

    show: (message, type = "info") => {
      const toastEl = document.createElement("div");
      const colors = {
        info: "bg-primary text-white",
        success: "bg-tertiary text-on-surface",
        warning: "bg-secondary text-white",
        error: "bg-error text-white",
      };

      toastEl.className = `${colors[type]} px-4 py-3 rounded-xl shadow-lg transform translate-x-full transition-transform duration-300 flex items-center gap-2 min-w-[200px]`;
      toastEl.innerHTML = `
                <span class="material-symbols-outlined text-sm">${type === "success" ? "check_circle" : type === "warning" ? "warning" : type === "error" ? "error" : "info"}</span>
                <span class="text-sm font-semibold">${message}</span>
            `;

      toast.container.appendChild(toastEl);

      requestAnimationFrame(() => {
        toastEl.classList.remove("translate-x-full");
      });

      setTimeout(() => {
        toastEl.classList.add("translate-x-full");
        setTimeout(() => toastEl.remove(), 300);
      }, CONFIG.toastDuration);
    },
  };

  // Detail Panel System
  const detailPanel = {
    panel: document.getElementById("detail-panel"),
    overlay: document.getElementById("detail-overlay"),
    updateInterval: null,

    init: () => {
      const viewBtn = document.getElementById("view-detail-btn");
      const closeBtn = document.getElementById("close-detail");

      viewBtn.addEventListener("click", detailPanel.open);
      closeBtn.addEventListener("click", detailPanel.close);
      detailPanel.overlay.addEventListener("click", detailPanel.close);

      // Close on escape key
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && state.detailPanelOpen) {
          detailPanel.close();
        }
      });
    },

    open: () => {
      state.detailPanelOpen = true;
      detailPanel.panel.classList.remove("translate-x-full");
      detailPanel.overlay.classList.remove("opacity-0", "pointer-events-none");
      document.body.style.overflow = "hidden"; // Prevent background scrolling

      toast.show("Loading detailed telemetry...", "info");
      detailPanel.startRealtimeUpdates();

      // Animate bars on open
      setTimeout(() => {
        document.querySelectorAll(".detail-bar").forEach((bar) => {
          bar.style.width = bar.style.width;
        });
      }, 100);
    },

    close: () => {
      state.detailPanelOpen = false;
      detailPanel.panel.classList.add("translate-x-full");
      detailPanel.overlay.classList.add("opacity-0", "pointer-events-none");
      document.body.style.overflow = "";
      detailPanel.stopRealtimeUpdates();
    },

    startRealtimeUpdates: () => {
      // Update detail panel values every 2 seconds
      detailPanel.updateInterval = setInterval(() => {
        if (!state.detailPanelOpen) return;

        // Update solar arrays
        const solarA = utils.random(3.5, 4.5);
        const solarB = utils.random(3.8, 4.8);
        document.getElementById("solar-a").textContent =
          `${solarA.toFixed(1)} MW`;
        document.getElementById("solar-b").textContent =
          `${solarB.toFixed(1)} MW`;
        document.getElementById("detail-total").textContent =
          `${(solarA + solarB + utils.random(2.5, 3.5) + utils.random(1.2, 1.8)).toFixed(1)} MW`;

        // Update temps and irradiance
        document.getElementById("temp-a").textContent =
          `${Math.round(utils.random(32, 38))}°C`;
        document.getElementById("temp-b").textContent =
          `${Math.round(utils.random(34, 40))}°C`;
        document.getElementById("irr-a").textContent =
          `${Math.round(utils.random(850, 920))} W/m²`;
        document.getElementById("irr-b").textContent =
          `${Math.round(utils.random(820, 890))} W/m²`;
        document.getElementById("eff-a").textContent =
          `${utils.random(20.5, 22).toFixed(1)}%`;
        document.getElementById("eff-b").textContent =
          `${utils.random(20, 21.5).toFixed(1)}%`;

        // Update wind turbines
        const wind1 = utils.random(2.5, 3.2);
        const wind2 = utils.random(1.2, 1.8);
        document.getElementById("wind-1").textContent =
          `${wind1.toFixed(1)} MW`;
        document.getElementById("wind-2").textContent =
          `${wind2.toFixed(1)} MW`;
        document.getElementById("wind-speed-1").textContent =
          `${Math.round(utils.random(12, 16))} m/s`;
        document.getElementById("wind-speed-2").textContent =
          `${Math.round(utils.random(8, 12))} m/s`;
        document.getElementById("rotor-1").textContent =
          `${Math.round(utils.random(16, 20))} RPM`;
        document.getElementById("rotor-2").textContent =
          `${Math.round(utils.random(10, 14))} RPM`;
        document.getElementById("pitch-1").textContent =
          `${Math.round(utils.random(10, 15))}°`;
        document.getElementById("pitch-2").textContent =
          `${Math.round(utils.random(6, 12))}°`;

        // Update grid parameters
        document.getElementById("grid-freq").textContent =
          `${(50 + utils.random(-0.05, 0.05)).toFixed(2)} Hz`;
        document.getElementById("grid-voltage").textContent =
          `${(11 + utils.random(-0.2, 0.3)).toFixed(1)} kV`;
        document.getElementById("grid-pf").textContent =
          `${utils.random(0.92, 0.97).toFixed(2)}`;
      }, CONFIG.detailUpdateInterval);
    },

    stopRealtimeUpdates: () => {
      clearInterval(detailPanel.updateInterval);
    },
  };

  // Handle OAuth token from URL
  const urlParams = new URLSearchParams(window.location.search);
  const oauthToken = urlParams.get("token");
  if (oauthToken) {
    localStorage.setItem("authToken", oauthToken);
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Authentication check
  const token = localStorage.getItem("authToken");

  // Sign out function
  function signOut(event) {
    event.preventDefault();
    event.stopPropagation();

    localStorage.removeItem("authToken");
    window.location.href = "/frontend/login.html";
  }

  // Attach sign out event listener
  const signOutBtn = document.getElementById("sign-out");

  if (signOutBtn) {
    signOutBtn.addEventListener("click", signOut);
  }

  // Live data simulation
  const liveData = {
    update: () => {
      state.liveGeneration = utils.randomWalk(
        state.liveGeneration,
        0.3,
        10,
        15,
      );
      state.solarOutput = utils.randomWalk(state.solarOutput, 0.2, 6, 10);
      state.windOutput = utils.randomWalk(state.windOutput, 0.15, 3, 6);
      state.efficiency = utils.randomWalk(state.efficiency, 0.2, 95, 99.5);
      state.storage = utils.randomWalk(state.storage, 1, 70, 95);

      liveData.render();
    },

    render: () => {
      document.getElementById("live-generation").innerHTML =
        `${utils.format(state.liveGeneration)} <span class="text-2xl text-on-surface-variant/40">MW</span>`;
      document.getElementById("solar-value").textContent =
        `${utils.format(state.solarOutput)} MW`;
      document.getElementById("wind-value").textContent =
        `${utils.format(state.windOutput)} MW`;
      document.getElementById("efficiency-value").textContent =
        `${utils.format(state.efficiency)}%`;
      document.getElementById("storage-value").textContent =
        `${Math.round(state.storage)}%`;
    },
  };

  // Live bar chart animation
  const barChart = {
    update: () => {
      const bars = document.querySelectorAll("#live-bars > div");
      bars.forEach((bar) => {
        const newHeight = utils.random(20, 100);
        bar.style.height = `${newHeight}%`;
      });
    },
  };

  // Time period filter handling
  const timeFilters = {
    init: () => {
      const buttons = document.querySelectorAll("#time-filters button");
      buttons.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          buttons.forEach((b) => {
            b.classList.remove("bg-surface-container-highest", "text-primary");
            b.classList.add("hover:bg-surface-container-highest");
          });
          e.target.classList.add(
            "bg-surface-container-highest",
            "text-primary",
          );
          e.target.classList.remove("hover:bg-surface-container-highest");

          state.currentPeriod = e.target.dataset.period;
          timeFilters.updateChart(state.currentPeriod);

          toast.show(
            `Switched to ${e.target.dataset.period === "D" ? "Daily" : e.target.dataset.period === "W" ? "Weekly" : "Monthly"} view`,
            "info",
          );
        });
      });
    },

    updateChart: (period) => {
      const chartLine = document.getElementById("chart-line");
      const labels = document.getElementById("chart-labels");

      const paths = {
        D: "M0 200 Q 50 180, 100 220 T 200 150 T 300 180 T 400 100 T 500 130 T 600 80 T 700 120",
        W: "M0 180 Q 100 120, 200 160 T 400 80 T 600 140 T 700 100",
        M: "M0 220 Q 50 200, 150 140 T 350 180 T 550 60 T 700 120",
      };

      const labelSets = {
        D: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
        W: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        M: ["Week 1", "Week 2", "Week 3", "Week 4", "Week 5", "Current"],
      };

      chartLine.style.transition = "d 0.5s ease";
      chartLine.setAttribute("d", paths[period]);
      labels.innerHTML = labelSets[period]
        .map((label) => `<span>${label}</span>`)
        .join("");
    },
  };

  // Node health simulation
  const nodeHealth = {
    update: () => {
      state.nodeHealth = utils.randomWalk(state.nodeHealth, 2, 85, 98);
      const bar = document.getElementById("node-health-bar");
      const text = document.getElementById("node-health-text");

      bar.style.width = `${state.nodeHealth}%`;

      if (state.nodeHealth > 90) {
        text.textContent = "Optimal";
        bar.className = "bg-tertiary-fixed h-full transition-all duration-1000";
      } else if (state.nodeHealth > 80) {
        text.textContent = "Good";
        bar.className = "bg-secondary h-full transition-all duration-1000";
      } else {
        text.textContent = "Fair";
        bar.className = "bg-warning h-full transition-all duration-1000";
      }
    },
  };

  // Savings calculation simulation
  const savings = {
    update: () => {
      state.dailySave = utils.randomWalk(state.dailySave, 2, 35, 50);
      state.co2Offset = utils.randomWalk(state.co2Offset, 0.1, 0.8, 1.5);
      state.projectedSavings = utils.randomWalk(
        state.projectedSavings,
        3,
        100,
        150,
      );

      document.getElementById("daily-save-value").innerHTML =
        `${Math.round(state.dailySave)} <span class="text-xs text-on-surface-variant/40">kWh</span>`;
      document.getElementById("co2-value").innerHTML =
        `${utils.format(state.co2Offset)} <span class="text-xs text-on-surface-variant/40">T</span>`;
      document.getElementById("projected-savings").innerHTML =
        `${utils.formatCurrency(state.projectedSavings)} <span class="text-xs text-tertiary font-semibold">+${Math.round(((state.projectedSavings - 100) / 100) * 100)}%</span>`;
    },
  };

  // Smart tips rotation
  const smartTips = {
    tips: [
      "Strong winds predicted at 14:00. Recommend shifting battery charging to turbine primary.",
      "Solar efficiency peak expected at noon. Consider deferring high-consumption tasks.",
      "Community grid has excess capacity. Good time to sell surplus energy.",
      "Battery at optimal charge level. Ready for evening demand surge.",
      "Weather forecast indicates cloudy afternoon. Solar output may decrease by 15%.",
    ],
    currentIndex: 0,

    rotate: () => {
      smartTips.currentIndex =
        (smartTips.currentIndex + 1) % smartTips.tips.length;
      const tipText = document.getElementById("smart-tip-text");
      tipText.style.opacity = "0";
      setTimeout(() => {
        tipText.textContent = smartTips.tips[smartTips.currentIndex];
        tipText.style.opacity = "1";
      }, 300);
    },

    init: () => {
      document.getElementById("smart-tip").addEventListener("click", () => {
        smartTips.rotate();
        toast.show("Tip updated based on current conditions", "info");
      });
    },
  };

  // Request transfer button
  const transferButton = {
    init: () => {
      const btn = document.getElementById("request-transfer-btn");
      btn.addEventListener("click", () => {
        if (state.isTransferRequested) {
          toast.show("Transfer already in progress", "warning");
          return;
        }

        state.isTransferRequested = true;
        btn.textContent = "Processing...";
        btn.disabled = true;
        btn.classList.add("opacity-75", "cursor-not-allowed");

        toast.show("Energy transfer request submitted", "success");

        setTimeout(() => {
          state.isTransferRequested = false;
          btn.textContent = "Request Transfer";
          btn.disabled = false;
          btn.classList.remove("opacity-75", "cursor-not-allowed");
          toast.show("Transfer completed successfully!", "success");

          state.projectedSavings += 5;
          savings.update();
        }, 3000);
      });
    },
  };

  // Mobile navigation
  const mobileNav = {
    init: () => {
      const buttons = document.querySelectorAll(".nav-btn");
      buttons.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const target = e.currentTarget;

          buttons.forEach((b) => {
            b.classList.remove("text-primary");
            b.classList.add("text-on-surface-variant/50");
            b.querySelector(
              ".material-symbols-outlined",
            ).style.fontVariationSettings = "'FILL' 0";
          });

          target.classList.remove("text-on-surface-variant/50");
          target.classList.add("text-primary");
          target.querySelector(
            ".material-symbols-outlined",
          ).style.fontVariationSettings = "'FILL' 1";

          const nav = target.dataset.nav;
          toast.show(
            `Navigating to ${nav.charAt(0).toUpperCase() + nav.slice(1)}...`,
            "info",
          );
        });
      });
    },
  };

  // Card interactions
  const cardInteractions = {
    init: () => {
      document
        .getElementById("daily-save-card")
        .addEventListener("click", () => {
          toast.show(
            `Daily energy savings: ${Math.round(state.dailySave)} kWh`,
            "info",
          );
        });

      document.getElementById("co2-card").addEventListener("click", () => {
        toast.show(
          `CO2 offset this month: ${utils.format(state.co2Offset)} tonnes`,
          "success",
        );
      });

      document.getElementById("savings-card").addEventListener("click", () => {
        toast.show(
          `Projected monthly savings: ${utils.formatCurrency(state.projectedSavings)}`,
          "info",
        );
      });
    },
  };

  // Initialize all modules
  const init = () => {
    setInterval(liveData.update, CONFIG.updateInterval);
    setInterval(barChart.update, CONFIG.chartUpdateInterval);
    setInterval(nodeHealth.update, 5000);
    setInterval(savings.update, 8000);
    setInterval(smartTips.rotate, 15000);

    timeFilters.init();
    smartTips.init();
    transferButton.init();
    detailPanel.init();
    mobileNav.init();
    cardInteractions.init();

    liveData.render();

    setTimeout(() => {
      toast.show("Welcome to VoltEquilibrium Dashboard", "success");
    }, 500);

    console.log("VoltEquilibrium Dashboard initialized");
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
