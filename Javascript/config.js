// VoltEquilibrium — Shared frontend configuration
// Include this script on every page BEFORE other JS files
window.VE = {
  API: (location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? "http://localhost:3000" : "",

  getToken() {
    return sessionStorage.getItem("authToken") || localStorage.getItem("authToken");
  },

  setToken(token) {
    sessionStorage.setItem("authToken", token);
    localStorage.setItem("authToken", token);
  },

  clearToken() {
    sessionStorage.removeItem("authToken");
    localStorage.removeItem("authToken");
  },

  authRedirect() {
    this.clearToken();
    window.location.replace("../frontend/login.html");
  },

  // Standard auth fetch wrapper
  async fetch(path, options = {}) {
    const token = this.getToken();
    if (!token) { this.authRedirect(); return null; }
    const res = await fetch(`${this.API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    if (res.status === 401 || res.status === 403) { this.authRedirect(); return null; }
    return res.json();
  },
};
