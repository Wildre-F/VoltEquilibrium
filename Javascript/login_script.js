/**
 * VoltEquilibrium Login/Register Page JavaScript
 * Handles authentication, validation, theme switching, and 3D flip animation
 */

(function () {
  "use strict";

  // ==========================================
  // CONFIGURATION & STATE
  // ==========================================

  const API_BASE = "http://localhost:3000";

  const CONFIG = {
    minPasswordLength: 8,
    apiEndpoints: {
      login: `${API_BASE}/api/login`,
      register: `${API_BASE}/api/register`,
      forgotPassword: `${API_BASE}/api/forgot-password`,
      google: `${API_BASE}/auth/google`,
    },
  };

  const state = {
    isDarkMode: false,
    isLoading: false,
    isFlipped: false,
  };

  // ==========================================
  // UTILITY FUNCTIONS
  // ==========================================

  function showToast(message, type = "info", duration = 3000) {
    const existingToast = document.querySelector(".toast");
    if (existingToast) existingToast.remove();

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="material-symbols-outlined">${type === "success" ? "check_circle" : type === "error" ? "error" : "info"}</span>
                <span>${message}</span>
            </div>
        `;

    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  function shakeElement(element) {
    element.classList.add("shake");
    setTimeout(() => element.classList.remove("shake"), 300);
  }

  // ==========================================
  // FLIP ANIMATION - FIXED
  // ==========================================

  function flipToRegister() {
    const flipper = document.getElementById("flipper");
    flipper.classList.add("flipped");
    state.isFlipped = true;
    clearAllErrors();

    // Adjust container height for register form
    const backSide = document.querySelector(".flip-back");
    if (backSide) {
      backSide.style.overflowY = "auto";
    }
  }

  function flipToLogin() {
    const flipper = document.getElementById("flipper");
    flipper.classList.remove("flipped");
    state.isFlipped = false;
    clearAllErrors();

    // Reset scroll position
    const backSide = document.querySelector(".flip-back");
    if (backSide) {
      backSide.scrollTop = 0;
    }
  }

  // ==========================================
  // THEME MANAGEMENT
  // ==========================================

  function initTheme() {
    const savedTheme = localStorage.getItem("voltequilibrium-theme");
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;

    if (savedTheme === "dark" || (!savedTheme && prefersDark)) {
      enableDarkMode();
    } else {
      enableLightMode();
    }
  }

  function enableDarkMode() {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
    document.getElementById("theme-icon").textContent = "light_mode";
    state.isDarkMode = true;
    localStorage.setItem("voltequilibrium-theme", "dark");
  }

  function enableLightMode() {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
    document.getElementById("theme-icon").textContent = "dark_mode";
    state.isDarkMode = false;
    localStorage.setItem("voltequilibrium-theme", "light");
  }

  function toggleTheme() {
    state.isDarkMode ? enableLightMode() : enableDarkMode();
    showToast(
      state.isDarkMode ? "Dark mode enabled" : "Light mode enabled",
      "info",
      2000,
    );
  }

  // ==========================================
  // PASSWORD TOGGLES
  // ==========================================

  function setupPasswordToggle(inputId, iconId) {
    const input = document.getElementById(inputId);
    const icon = document.getElementById(iconId);

    if (!input || !icon) return;

    icon.parentElement.addEventListener("click", () => {
      if (input.type === "password") {
        input.type = "text";
        icon.textContent = "visibility_off";
      } else {
        input.type = "password";
        icon.textContent = "visibility";
      }
    });
  }

  // ==========================================
  // FORM VALIDATION
  // ==========================================

  function showError(inputId, errorId, message) {
    const input = document.getElementById(inputId);
    const error = document.getElementById(errorId);
    if (input && error) {
      error.textContent = message;
      error.classList.remove("hidden");
      input.classList.add("input-error");
      shakeElement(input.parentElement);
    }
    return false;
  }

  function clearError(inputId, errorId) {
    const input = document.getElementById(inputId);
    const error = document.getElementById(errorId);
    if (input && error) {
      error.classList.add("hidden");
      input.classList.remove("input-error");
    }
  }

  function clearAllErrors() {
    // Login errors
    clearError("login-email", "login-email-error");
    clearError("login-password", "login-password-error");
    // Register errors
    clearError("reg-firstname", "reg-firstname-error");
    clearError("reg-lastname", "reg-lastname-error");
    clearError("reg-email", "reg-email-error");
    clearError("reg-organization", "reg-organization-error");
    clearError("reg-password", "reg-password-error");
    clearError("reg-confirm", "reg-confirm-error");
    const termsError = document.getElementById("reg-terms-error");
    if (termsError) termsError.classList.add("hidden");
  }

  function validateLogin() {
    let valid = true;
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    if (!email) {
      showError("login-email", "login-email-error", "Email is required");
      valid = false;
    } else if (!isValidEmail(email)) {
      showError(
        "login-email",
        "login-email-error",
        "Please enter a valid email",
      );
      valid = false;
    }

    if (!password) {
      showError(
        "login-password",
        "login-password-error",
        "Password is required",
      );
      valid = false;
    } else if (password.length < CONFIG.minPasswordLength) {
      showError(
        "login-password",
        "login-password-error",
        `Minimum ${CONFIG.minPasswordLength} characters`,
      );
      valid = false;
    }

    return valid
      ? {
          email,
          password,
          remember: document.getElementById("login-remember").checked,
        }
      : null;
  }

  function validateRegister() {
    let valid = true;
    const firstname = document.getElementById("reg-firstname").value.trim();
    const lastname = document.getElementById("reg-lastname").value.trim();
    const email = document.getElementById("reg-email").value.trim();
    const password = document.getElementById("reg-password").value;
    const confirm = document.getElementById("reg-confirm").value;
    const terms = document.getElementById("reg-terms").checked;

    if (!firstname) {
      showError("reg-firstname", "reg-firstname-error", "First name required");
      valid = false;
    }
    if (!lastname) {
      showError("reg-lastname", "reg-lastname-error", "Last name required");
      valid = false;
    }
    if (!email || !isValidEmail(email)) {
      showError(
        "reg-email",
        "reg-email-error",
        !email ? "Email required" : "Invalid email",
      );
      valid = false;
    }
    if (!password || password.length < CONFIG.minPasswordLength) {
      showError(
        "reg-password",
        "reg-password-error",
        `Min ${CONFIG.minPasswordLength} characters`,
      );
      valid = false;
    }
    if (password !== confirm) {
      showError("reg-confirm", "reg-confirm-error", "Passwords do not match");
      valid = false;
    }
    if (!terms) {
      const termsError = document.getElementById("reg-terms-error");
      termsError.textContent = "You must agree to the terms";
      termsError.classList.remove("hidden");
      shakeElement(termsError);
      valid = false;
    }

    return valid ? { firstname, lastname, email, password } : null;
  }

  // ==========================================
  // FORM SUBMISSION
  // ==========================================

  function setLoading(btnId, textId, isLoading, defaultText) {
    const btn = document.getElementById(btnId);
    const text = document.getElementById(textId);

    if (isLoading) {
      btn.disabled = true;
      text.innerHTML = '<span class="spinner"></span>Processing...';
      btn.classList.add("opacity-80", "cursor-not-allowed");
    } else {
      btn.disabled = false;
      text.textContent = defaultText;
      btn.classList.remove("opacity-80", "cursor-not-allowed");
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    if (state.isLoading) return;

    const data = validateLogin();
    if (!data) {
      showToast("Please fix the errors", "error");
      return;
    }

    state.isLoading = true;
    setLoading("login-submit-btn", "login-btn-text", true, "Sign In to Hub");

    try {
      const result = await callAPI(CONFIG.apiEndpoints.login, {
        email: data.email,
        password: data.password,
      });

      localStorage.setItem("authToken", result.token);

      showToast("Welcome back! Redirecting...", "success");

      if (data.remember) {
        localStorage.setItem("voltequilibrium-remember", "true");
        localStorage.setItem("voltequilibrium-email", data.email);
      } else {
        localStorage.removeItem("voltequilibrium-remember");
        localStorage.removeItem("voltequilibrium-email");
      }

      setTimeout(() => {
        window.location.href = "../frontend/setup.html";
      }, 1500);
    } catch (err) {
      showToast(err.message, "error");
      shakeElement(document.getElementById("login-form"));
    } finally {
      state.isLoading = false;
      setLoading("login-submit-btn", "login-btn-text", false, "Sign In to Hub");
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    if (state.isLoading) return;

    const data = validateRegister();
    if (!data) {
      showToast("Please fix the errors", "error");
      return;
    }
    state.isLoading = true;
    setLoading(
      "register-submit-btn",
      "register-btn-text",
      true,
      "Request Access",
    );

    try {
      await callAPI(CONFIG.apiEndpoints.register, {
        username: `${data.firstname} ${data.lastname}`,
        email: data.email,
        password: data.password,
      });

      showToast("Registration successful! You can now sign in.", "success");

      setTimeout(() => {
        flipToLogin();
        document.getElementById("login-email").value = data.email;
        document.getElementById("login-password").focus();
      }, 1500);
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      state.isLoading = false;
      setLoading(
        "register-submit-btn",
        "register-btn-text",
        false,
        "Request Access",
      );
    }
  }

  async function callAPI(url, data) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || "Request failed");
    }

    return result;
  }

  // ==========================================
  // SOCIAL AUTH
  // ==========================================

  function handleSocial(provider, action) {
    if (provider === "Google") {
      window.location.href = "http://localhost:3000/auth/google";
    } else {
      showToast(`${provider} ${action} coming soon`, "info");
    }
  }

  // ==========================================
  // Loadshedding
  // ==========================================

  async function updateLoadShedding() {
    try {
      const response = await fetch(`${API_BASE}/api/loadshedding`);
      const data = await response.json();
      const el = document.getElementById("network-health");

      if (!data.success) throw new Error();

      const stage = data.stage;
      if (stage === 0) {
        el.textContent = "Stage 0";
        el.className = "text-4xl font-headline font-bold text-white";
      } else if (stage <= 2) {
        el.textContent = `Stage ${stage}`;
        el.className = "text-4xl font-headline font-bold text-tertiary-fixed";
      } else {
        el.textContent = `Stage ${stage}`;
        el.className = "text-4xl font-headline font-bold text-error";
      }
    } catch (error) {
      const el = document.getElementById("network-health");
      el.textContent = "Unavailable";
      el.className = "text-4xl font-headline font-bold text-error";
    }
  }

  // ==========================================
  // FORGOT PASSWORD
  // ==========================================

  async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById("login-email").value;
    if (!email || !isValidEmail(email)) {
      showToast("Enter your email first", "error");
      document.getElementById("login-email").focus();
      return;
    }

    try {
      const response = await fetch(CONFIG.apiEndpoints.forgotPassword, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const result = await response.json();

      if (result.success) {
        showToast("Password reset email sent!", "success");
      } else {
        showToast(result.message, "error");
      }
    } catch (error) {
      showToast("Something went wrong. Please try again.", "error");
    }
  }

  // ==========================================
  // INPUT ENHANCEMENTS
  // ==========================================

  function setupRealTimeValidation(inputId, errorId, validator) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const debounced = debounce(() => {
      if (input.value && validator(input.value)) {
        clearError(inputId, errorId);
      }
    }, 500);

    input.addEventListener("input", debounced);
    input.addEventListener("focus", () => clearError(inputId, errorId));
  }

  function checkRememberedUser() {
    if (localStorage.getItem("voltequilibrium-remember") === "true") {
      const email = localStorage.getItem("voltequilibrium-email");
      if (email) {
        document.getElementById("login-email").value = email;
        document.getElementById("login-remember").checked = true;
        document.getElementById("login-password").focus();
      }
    }
  }

  // ==========================================
  // KEYBOARD SHORTCUTS
  // ==========================================

  function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (state.isFlipped) {
          document
            .getElementById("register-form")
            .dispatchEvent(new Event("submit"));
        } else {
          document
            .getElementById("login-form")
            .dispatchEvent(new Event("submit"));
        }
      }
      if (e.key === "Escape") clearAllErrors();
    });
  }

  // ==========================================
  // INITIALIZATION
  // ==========================================

  function init() {
    initTheme();
    checkRememberedUser();

    // Flip controls
    document
      .getElementById("show-register")
      .addEventListener("click", flipToRegister);
    document
      .getElementById("show-login")
      .addEventListener("click", flipToLogin);

    // Theme
    document
      .getElementById("theme-toggle")
      .addEventListener("click", toggleTheme);

    // Password toggles
    setupPasswordToggle("login-password", "login-password-icon");
    setupPasswordToggle("reg-password", "reg-password-icon");

    // Forms
    document
      .getElementById("login-form")
      .addEventListener("submit", handleLogin);
    document
      .getElementById("register-form")
      .addEventListener("submit", handleRegister);

    // Social
    document
      .getElementById("google-login")
      .addEventListener("click", () => handleSocial("Google", "Login"));
    document
      .getElementById("microsoft-login")
      .addEventListener("click", () => handleSocial("Microsoft", "Login"));
    document
      .getElementById("google-register")
      .addEventListener("click", () => handleSocial("Google", "Sign Up"));
    document
      .getElementById("microsoft-register")
      .addEventListener("click", () => handleSocial("Microsoft", "Sign Up"));

    // Forgot password
    document
      .getElementById("forgot-password")
      .addEventListener("click", handleForgotPassword);

    // Real-time validation
    setupRealTimeValidation("login-email", "login-email-error", isValidEmail);
    setupRealTimeValidation("reg-email", "reg-email-error", isValidEmail);

    // Keyboard shortcuts
    setupKeyboardShortcuts();

    // Loadshedding Status
    updateLoadShedding();
    setInterval(updateLoadShedding, 300000);

    // Welcome
    console.log(
      "%c⚡ VoltEquilibrium",
      "color: #005147; font-size: 24px; font-weight: bold;",
    );
    setTimeout(
      () => showToast("Welcome to VoltEquilibrium", "info", 2000),
      500,
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
