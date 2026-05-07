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

  _sessionExpiredShown: false,

  showSessionExpired() {
    if (this._sessionExpiredShown) return;
    this._sessionExpiredShown = true;

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;";
    overlay.innerHTML = `
      <div style="background:var(--color-surface-container-lowest,#fff);border-radius:20px;padding:32px;max-width:340px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.25);">
        <span class="material-symbols-outlined" style="font-size:48px;color:var(--color-secondary,#005db6);margin-bottom:12px;display:block;font-variation-settings:'FILL' 1;">lock_clock</span>
        <h2 style="font-weight:800;font-family:Manrope,sans-serif;font-size:18px;color:var(--color-on-surface,#181c1c);margin-bottom:8px;">Session Expired</h2>
        <p style="font-size:13px;color:var(--color-on-surface-variant,#3e4946);margin-bottom:24px;line-height:1.5;font-family:'Plus Jakarta Sans',sans-serif;">Your session has timed out for security. Please log in again to continue.</p>
        <button onclick="window.VE.clearToken();window.location.replace('../frontend/login.html');"
          style="width:100%;padding:12px;border-radius:12px;border:none;background:var(--color-primary,#005147);color:var(--color-on-primary,#fff);font-family:Inter,sans-serif;font-weight:700;font-size:13px;cursor:pointer;">
          Log In Again
        </button>
      </div>`;
    document.body.appendChild(overlay);
  },

  authRedirect() {
    this.clearToken();
    this.showSessionExpired();
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
