// VoltEquilibrium — Shared theme toggle
// This script can load in <head> — applies saved theme immediately, defers toggle listener

// 1. Apply saved theme immediately (no flash of wrong theme)
(function(){
  var s = localStorage.getItem("voltequilibrium-theme");
  var p = window.matchMedia("(prefers-color-scheme:dark)").matches;
  if (s === "dark" || (!s && p)) {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
  }
})();

// 2. Attach toggle listener when DOM is ready
document.addEventListener("DOMContentLoaded", function() {
  // Update icon to match current state
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
