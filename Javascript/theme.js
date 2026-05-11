// VoltEquilibrium — Shared theme + page load screen
// Loads in <head> — applies theme instantly and hides content until ready

// 0. Load Lottie player library
  if (!document.querySelector('script[src*="lottie"]')) {
    var lottieScript = document.createElement("script");
    lottieScript.src = "https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js";
    lottieScript.async = true;
    document.head.appendChild(lottieScript);
  }

// 1. Apply saved theme immediately (no flash of wrong theme)
(function(){
  var s = localStorage.getItem("voltequilibrium-theme");
  var p = window.matchMedia("(prefers-color-scheme:dark)").matches;
  if (s === "dark" || (!s && p)) {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
  }

  // 2. Inject favicon if missing
  if (!document.querySelector('link[rel="icon"]')) {
    var fav = document.createElement("link");
    fav.rel = "icon";
    fav.type = "image/svg+xml";
    fav.href = "../favicon.svg";
    document.head.appendChild(fav);
  }

  // 3. Inject loading overlay (hides FOUC — flash of unstyled content)
  var style = document.createElement("style");
  style.id = "ve-loader-style";
  style.textContent = `
    .skeleton {
      background: linear-gradient(90deg, var(--color-surface-container, #ebeeed) 25%, var(--color-surface-container-high, #e6e9e8) 50%, var(--color-surface-container, #ebeeed) 75%);
      background-size: 200% 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
      border-radius: 8px;
    }
    @keyframes skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
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
  loader.innerHTML = '<div id="ve-loader-lottie" style="width:64px;height:64px;"></div><div class="ve-brand">VoltEquilibrium</div>';
  // Try to use Lottie spinner, fall back to CSS spinner
  function initLoaderLottie() {
    if (typeof lottie !== "undefined" && document.getElementById("ve-loader-lottie")) {
      lottie.loadAnimation({ container: document.getElementById("ve-loader-lottie"), renderer: "svg", loop: true, autoplay: true, path: "../lottie/spinner.json" });
    } else {
      var el = document.getElementById("ve-loader-lottie");
      if (el) el.innerHTML = '<div class="ve-spinner"></div>';
    }
  }
  setTimeout(initLoaderLottie, 100);

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

  // 5. Sign out with confirmation modal
  document.getElementById("sign-out")?.addEventListener("click", function(e) {
    e.preventDefault();

    // Create overlay if not exists
    if (document.getElementById("signout-overlay")) return;

    var overlay = document.createElement("div");
    overlay.id = "signout-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.25s ease-out;";

    overlay.innerHTML =
      '<div id="signout-card" style="background:var(--color-surface-container-lowest,#fff);border-radius:20px;padding:32px;max-width:340px;width:90%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.25);transform:scale(0.9) translateY(10px);opacity:0;transition:transform 0.3s ease-out,opacity 0.3s ease-out;">' +
        '<span class="material-symbols-outlined" style="font-size:48px;color:var(--color-error,#ba1a1a);margin-bottom:12px;display:block;font-variation-settings:\'FILL\' 1;">logout</span>' +
        '<h2 style="font-weight:800;font-family:Manrope,sans-serif;font-size:18px;color:var(--color-on-surface,#181c1c);margin-bottom:8px;">Sign Out?</h2>' +
        '<p style="font-size:13px;color:var(--color-on-surface-variant,#3e4946);margin-bottom:24px;line-height:1.5;font-family:\'Plus Jakarta Sans\',sans-serif;">Are you sure you want to sign out of VoltEquilibrium?</p>' +
        '<div style="display:flex;gap:10px;">' +
          '<button id="signout-cancel" style="flex:1;padding:12px;border-radius:12px;border:1.5px solid var(--color-outline-variant,#bec9c5);background:none;color:var(--color-on-surface,#181c1c);font-family:Inter,sans-serif;font-weight:700;font-size:13px;cursor:pointer;">Cancel</button>' +
          '<button id="signout-confirm" style="flex:1;padding:12px;border-radius:12px;border:none;background:var(--color-error,#ba1a1a);color:var(--color-on-error,#fff);font-family:Inter,sans-serif;font-weight:700;font-size:13px;cursor:pointer;">Sign Out</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    // Fade in
    requestAnimationFrame(function() {
      overlay.style.opacity = "1";
      var card = document.getElementById("signout-card");
      if (card) { card.style.transform = "scale(1) translateY(0)"; card.style.opacity = "1"; }
    });

    // Cancel
    document.getElementById("signout-cancel").addEventListener("click", function() {
      overlay.style.opacity = "0";
      var card = document.getElementById("signout-card");
      if (card) { card.style.transform = "scale(0.9) translateY(10px)"; card.style.opacity = "0"; }
      setTimeout(function() { overlay.remove(); }, 300);
    });

    // Confirm
    document.getElementById("signout-confirm").addEventListener("click", function() {
      sessionStorage.removeItem("authToken");
      localStorage.removeItem("authToken");
      window.location.replace("../frontend/login.html");
    });
  });
});
