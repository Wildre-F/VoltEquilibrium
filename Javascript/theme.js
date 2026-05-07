// VoltEquilibrium — Shared theme + page load screen
// Loads in <head> — applies theme instantly and hides content until ready

// 1. Apply saved theme immediately (no flash of wrong theme)
(function(){
  var s = localStorage.getItem("voltequilibrium-theme");
  var p = window.matchMedia("(prefers-color-scheme:dark)").matches;
  if (s === "dark" || (!s && p)) {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
  }

  // 2. Inject loading overlay (hides FOUC — flash of unstyled content)
  var style = document.createElement("style");
  style.id = "ve-loader-style";
  style.textContent = `
    #ve-loader {
      position: fixed; inset: 0; z-index: 99999;
      background: var(--color-background, #f7faf9);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      transition: opacity 0.3s ease-out;
    }
    #ve-loader .ve-spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--color-outline-variant, #bec9c5);
      border-top-color: var(--color-primary, #005147);
      border-radius: 50%;
      animation: ve-spin 0.7s linear infinite;
    }
    #ve-loader .ve-brand {
      margin-top: 14px;
      font-family: Manrope, sans-serif;
      font-weight: 800;
      font-size: 16px;
      letter-spacing: -0.03em;
      color: var(--color-primary, #005147);
    }
    @keyframes ve-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);

  var loader = document.createElement("div");
  loader.id = "ve-loader";
  loader.innerHTML = '<div class="ve-spinner"></div><div class="ve-brand">VoltEquilibrium</div>';

  // Insert as soon as body exists (or wait for it)
  if (document.body) {
    document.body.appendChild(loader);
  } else {
    document.addEventListener("DOMContentLoaded", function() {
      document.body.appendChild(loader);
    });
  }
})();

// 3. Remove loader when page is fully loaded
window.addEventListener("load", function() {
  var loader = document.getElementById("ve-loader");
  if (loader) {
    loader.style.opacity = "0";
    setTimeout(function() { loader.remove(); }, 300);
  }
  var style = document.getElementById("ve-loader-style");
  if (style) style.remove();
});

// 4. Attach theme toggle listener when DOM is ready
document.addEventListener("DOMContentLoaded", function() {
  var isDark = document.documentElement.classList.contains("dark");
  var icon = document.getElementById("theme-icon");
  if (icon) icon.textContent = isDark ? "light_mode" : "dark_mode";

  document.getElementById("theme-toggle")?.addEventListener("click", function(){
    var d = document.documentElement.classList.contains("dark");
    if (d) {
      document.documentElement.classList.replace("dark", "light");
      document.getElementById("theme-icon").textContent = "dark_mode";
      localStorage.setItem("voltequilibrium-theme", "light");
    } else {
      document.documentElement.classList.replace("light", "dark");
      document.getElementById("theme-icon").textContent = "light_mode";
      localStorage.setItem("voltequilibrium-theme", "dark");
    }
  });
});
