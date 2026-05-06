// VoltEquilibrium — Shared theme toggle
// Include on every page after main content scripts
(function(){
  var s = localStorage.getItem("voltequilibrium-theme");
  var p = window.matchMedia("(prefers-color-scheme:dark)").matches;
  if (s === "dark" || (!s && p)) {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
    var i = document.getElementById("theme-icon");
    if (i) i.textContent = "light_mode";
  }
})();

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
