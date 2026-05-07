(function () {
  const API   = "http://localhost:3000";
  const token = sessionStorage.getItem("authToken") || localStorage.getItem("authToken");
  if (!token) { window.location.replace("login.html"); return; }
  if (!sessionStorage.getItem("authToken")) sessionStorage.setItem("authToken", token);

  // Decode JWT to get current user id
  function myId() {
    try { return JSON.parse(atob(token.split(".")[1])).id; } catch { return null; }
  }

  // Sign out handled by theme.js

  // ── Toast ──────────────────────────────────────────────────────────────────
  function toast(msg, type = "info") {
    const colors = { info: "bg-primary text-white", success: "bg-tertiary-container text-white",
                     error: "bg-error text-white", warning: "bg-secondary text-white" };
    const el = document.createElement("div");
    el.className = `${colors[type]} px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 min-w-[220px] translate-x-full transition-transform duration-300 text-sm font-semibold`;
    el.innerHTML = `<span class="material-symbols-outlined text-sm">${type === "error" ? "error" : type === "success" ? "check_circle" : "info"}</span>${msg}`;
    document.getElementById("toast-container").appendChild(el);
    requestAnimationFrame(() => el.classList.remove("translate-x-full"));
    setTimeout(() => { el.classList.add("translate-x-full"); setTimeout(() => el.remove(), 300); }, 3500);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let currentSoc      = null;
  let canShare        = false;
  let activeTab       = "sales";
  let batteryCapacity = null; // kWh
  let eskomRate       = null; // R per kWh

  // ── Status Bar ─────────────────────────────────────────────────────────────
  async function loadStatus() {
    // Load shedding (no auth needed)
    fetch(`${API}/api/loadshedding`)
      .then(r => r.json())
      .then(json => {
        const stage = json.success ? json.stage : null;
        const lsVal  = document.getElementById("ls-val");
        const lsIcon = document.getElementById("ls-icon");
        if (stage === null) { lsVal.textContent = "N/A"; return; }
        if (stage === 0) {
          lsVal.textContent = "None";
          lsIcon.className = "w-10 h-10 rounded-full bg-tertiary-fixed flex items-center justify-center shrink-0";
          lsIcon.querySelector("span").className = "material-symbols-outlined text-primary text-lg";
        } else if (stage <= 2) {
          lsVal.textContent = `Stage ${stage}`;
          lsIcon.style.cssText = "width:2.5rem;height:2.5rem;border-radius:9999px;background:#fef9c3;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
          lsIcon.querySelector("span").style.color = "#854d0e";
        } else if (stage <= 4) {
          lsVal.textContent = `Stage ${stage}`;
          lsIcon.style.cssText = "width:2.5rem;height:2.5rem;border-radius:9999px;background:#ffedd5;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
          lsIcon.querySelector("span").style.color = "#9a3412";
        } else {
          lsVal.textContent = `Stage ${stage}`;
          lsIcon.style.cssText = "width:2.5rem;height:2.5rem;border-radius:9999px;background:#ffdad6;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
          lsIcon.querySelector("span").style.color = "#ba1a1a";
        }
      }).catch(() => { document.getElementById("ls-val").textContent = "N/A"; });

    // Power stats (auth required)
    try {
      const [rRes, cRes] = await Promise.all([
        fetch(`${API}/api/readings/latest`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API}/api/co2`,             { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const rJson = await rRes.json();
      const cJson = await cRes.json();

      if (rJson.success) {
        const all     = rJson.data?.all || [];
        const battRow = all.find(r => r.state_of_charge != null);
        if (battRow) {
          currentSoc = parseFloat(battRow.state_of_charge);
          const socEl   = document.getElementById("soc-val");
          const socIcon = document.getElementById("soc-icon");
          socEl.textContent = `${currentSoc.toFixed(1)}%`;
          if (currentSoc > 60) {
            socIcon.style.cssText = "";
            socIcon.className = "w-10 h-10 rounded-full bg-tertiary-fixed flex items-center justify-center shrink-0";
            socIcon.querySelector("span").className = "material-symbols-outlined text-primary text-lg";
          } else if (currentSoc > 30) {
            socIcon.style.cssText = "width:2.5rem;height:2.5rem;border-radius:9999px;background:#fef9c3;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
            socIcon.querySelector("span").style.color = "#854d0e";
          } else {
            socIcon.style.cssText = "width:2.5rem;height:2.5rem;border-radius:9999px;background:#ffdad6;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
            socIcon.querySelector("span").style.color = "#ba1a1a";
          }
          updateEligibility();
        }
      }
      if (cJson.success) {
        document.getElementById("today-kwh").textContent = `${cJson.data.todayKwh.toFixed(2)} kWh`;
      }
    } catch { /* silent */ }
  }

  function updateEligibility() {
    canShare = currentSoc !== null && currentSoc > 30;
    const icon = document.getElementById("elig-icon");
    const sym  = document.getElementById("elig-sym");
    const val  = document.getElementById("elig-val");
    if (currentSoc === null) { val.textContent = "…"; return; }
    if (canShare) {
      icon.style.cssText = "width:2.5rem;height:2.5rem;border-radius:9999px;background:#bdf447;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
      sym.className = "material-symbols-outlined text-lg";
      sym.style.color = "#374e00";
      sym.textContent = "check_circle";
      val.textContent = "Can Share";
      val.style.color = "#374e00";
    } else {
      icon.style.cssText = "width:2.5rem;height:2.5rem;border-radius:9999px;background:#ffdad6;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
      sym.className = "material-symbols-outlined text-lg";
      sym.style.color = "#ba1a1a";
      sym.textContent = "block";
      val.textContent = "SOC Too Low";
      val.style.color = "#ba1a1a";
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  let modalType = null; // "donations" | "sales" | "requests"

  const backdrop    = document.getElementById("modal-backdrop");
  const modalTitle  = document.getElementById("modal-title");
  const modalIcon   = document.getElementById("modal-icon");
  const modalIconWrap = document.getElementById("modal-icon-wrap");
  const modalSocWarn  = document.getElementById("modal-soc-warn");
  const modalPriceWrap = document.getElementById("modal-price-wrap");
  const modalConfirm  = document.getElementById("modal-confirm");
  const modalKwh    = document.getElementById("modal-kwh");
  const modalPrice  = document.getElementById("modal-price");

  function openModal(type) {
    modalType = type;
    modalKwh.value   = "";
    modalPrice.value = "";

    const needsShare = type !== "requests";
    modalSocWarn.classList.toggle("hidden", !needsShare || canShare);
    modalPriceWrap.classList.toggle("hidden", type !== "sales");

    // ── Compute kWh max & hint ─────────────────────────────────────────────
    const kwhHint = document.getElementById("modal-kwh-hint");
    let maxKwh = null;

    if (type === "requests" && batteryCapacity === null) {
      // No-battery user: community cap applies
      maxKwh = 2;
      modalKwh.max = maxKwh;
      kwhHint.textContent = `Max ${maxKwh} kWh per request (community allowance, up to 10 kWh total outstanding)`;
    } else if (batteryCapacity !== null && currentSoc !== null) {
      if (type === "requests") {
        // Max requestable = empty space in battery
        maxKwh = parseFloat((batteryCapacity * (1 - currentSoc / 100)).toFixed(2));
        kwhHint.textContent = `Max: ${maxKwh} kWh (battery space available)`;
      } else {
        // Max shareable = energy currently stored
        maxKwh = parseFloat((batteryCapacity * (currentSoc / 100)).toFixed(2));
        kwhHint.textContent = `Max: ${maxKwh} kWh (current charge)`;
      }
      modalKwh.max = maxKwh;
    } else {
      kwhHint.textContent = "";
      modalKwh.removeAttribute("max");
    }

    // Show "Fill to 100%" button only for requests when battery data is available
    const fillBtn = document.getElementById("modal-fill-btn");
    if (type === "requests" && maxKwh !== null && maxKwh > 0) {
      fillBtn.classList.remove("hidden");
      fillBtn.onclick = () => { modalKwh.value = maxKwh; };
    } else {
      fillBtn.classList.add("hidden");
    }

    // ── Eskom rate hint for sales ──────────────────────────────────────────
    const eskomHint = document.getElementById("modal-eskom-hint");
    if (type === "sales" && eskomRate !== null) {
      eskomHint.textContent = `Eskom rate: R${eskomRate.toFixed(2)}/kWh`;
    } else {
      eskomHint.textContent = "";
    }

    if (type === "donations") {
      modalTitle.textContent = "Donate Energy";
      modalIcon.textContent  = "solar_power";
      modalIcon.style.color  = "";
      modalIconWrap.style.background = "#9ff2e1";
      modalConfirm.className = "flex-1 bg-primary text-white py-3 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity";
      modalConfirm.textContent = "Confirm Donation";
    } else if (type === "sales") {
      modalTitle.textContent = "List Energy for Sale";
      modalIcon.textContent  = "sell";
      modalIcon.style.color  = "";
      modalIconWrap.style.background = "#9ff2e1";
      modalConfirm.className = "flex-1 bg-primary text-white py-3 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity";
      modalConfirm.textContent = "List for Sale";
    } else {
      modalTitle.textContent = "Post Energy Request";
      modalIcon.textContent  = "electric_bolt";
      modalIconWrap.style.background = "#d6e3ff";
      modalIcon.style.color  = "#005db6";
      modalConfirm.className = "flex-1 bg-secondary text-white py-3 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity";
      modalConfirm.textContent = "Post Request";
    }

    backdrop.classList.remove("hidden");
    setTimeout(() => modalKwh.focus(), 50);
  }

  function closeModal() {
    backdrop.classList.add("hidden");
    modalType = null;
    document.getElementById("modal-comment").value = "";
  }

  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  // Modal only closes via Cancel button, not clicking outside

  document.getElementById("open-sale-modal").addEventListener("click",    () => openModal("sales"));
  document.getElementById("open-request-modal").addEventListener("click", () => openModal("requests"));

  modalConfirm.addEventListener("click", async () => {
    const kwh   = parseFloat(modalKwh.value);
    const price = parseFloat(modalPrice.value);

    if (!kwh || kwh <= 0) { toast("Enter a valid kWh amount.", "warning"); return; }
    const maxAllowed = modalKwh.max ? parseFloat(modalKwh.max) : null;
    if (maxAllowed !== null && kwh > maxAllowed) {
      toast(`Maximum allowed is ${maxAllowed} kWh.`, "warning"); return;
    }
    if (modalType === "sales" && (!price || price <= 0)) { toast("Enter a valid price.", "warning"); return; }
    if (modalType !== "requests" && !canShare) { toast("Battery SOC too low to share energy.", "error"); return; }

    const comment = document.getElementById("modal-comment").value.trim();
    const body = modalType === "sales"
      ? { amount_kwh: kwh, price_per_kwh: price, comment: comment || undefined }
      : { amount_kwh: kwh, comment: comment || undefined };

    try {
      const res  = await authFetch(`${API}/api/community/${modalType}`, { method: "POST", body: JSON.stringify(body) });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const labels = { sales: "Sale listed!", requests: "Request posted!" };
      toast(labels[modalType] || "Done!", "success");
      closeModal();
      loadTab(modalType);
      loadMyListings();
    } catch (err) { toast(err.message, "error"); }
  });

  // ── Tab switching ────────────────────────────────────────────────────────
  window.showView = showView;
  function showView(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach(b => {
      const isActive = b.dataset.tab === activeTab;
      b.classList.toggle("active", isActive);
      if (!isActive) {
        b.classList.add("text-on-surface-variant", "hover:bg-surface-container-low");
        b.classList.remove("text-white");
      } else {
        b.classList.remove("text-on-surface-variant", "hover:bg-surface-container-low");
      }
    });
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${activeTab}`));
    if (tab === "my") {
      loadMyListings();
    } else {
      loadTab(activeTab);
    }
  }

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.tab));
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function authFetch(url, opts = {}) {
    return fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
  }

  // ── Render listing rows ────────────────────────────────────────────────────
  function renderRow(item, type) {
    const mine    = Number(item.user_id) === Number(myId());
    const isSale  = type === "sales";

    let actionBtn;
    if (mine) {
      actionBtn = `<button data-action="delete" data-type="${type}" data-id="${item.id}"
           class="text-error hover:bg-error-container rounded-full p-1 transition-colors" title="Cancel">
           <span class="material-symbols-outlined text-base">close</span></button>`;
    } else {
      // Both sales and requests open a Details modal first
      actionBtn = `<button data-action="details" data-type="${type}" data-id="${item.id}"
           data-username="${(item.username || '').replace(/"/g,'&quot;')}"
           data-amount="${item.amount_kwh}"
           data-price="${item.price_per_kwh || ''}"
           data-comment="${(item.comment || '').replace(/"/g,'&quot;')}"
           data-created="${item.created_at}"
           class="bg-surface-container-high text-on-surface text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full hover:bg-surface-container-highest transition-colors whitespace-nowrap flex items-center gap-1">
           <span class="material-symbols-outlined text-sm">info</span>Details</button>`;
    }

    const displayUser = item.username || "Unknown";
    const sub = isSale
      ? `<span class="text-xs text-on-surface-variant font-label">${item.amount_kwh} kWh &nbsp;·&nbsp; R${parseFloat(item.price_per_kwh).toFixed(2)}/kWh</span>`
      : `<span class="text-xs text-on-surface-variant font-label">${item.amount_kwh} kWh needed${mine ? "" : " — donate for free"}</span>`;

    const rowLabel = isSale ? "Energy Sale" : "Energy Request";

    const badge = mine
      ? `<span class="text-[10px] font-bold bg-primary-fixed text-primary px-2 py-0.5 rounded-full font-label uppercase">Mine</span>`
      : "";

    return `
      <div class="flex items-center justify-between p-4 bg-surface-container-low rounded-xl hover:bg-surface-container transition-colors" data-row-id="${item.id}">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full ${mine ? "bg-primary-fixed" : "bg-surface-container-highest"} flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-base ${mine ? "text-primary" : "text-on-surface-variant"}">person</span>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <p class="text-sm font-semibold text-on-surface">${rowLabel}</p>
              ${badge}
            </div>
            <p class="text-xs text-on-surface-variant/70 font-label">${mine ? "You" : displayUser}</p>
            ${sub}
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs text-on-surface-variant/60 font-label hidden sm:block">${relTime(item.created_at)}</span>
          ${actionBtn}
        </div>
      </div>`;
  }

  // ── Load tab listings ──────────────────────────────────────────────────────
  async function loadTab(type) {
    const listEl = document.getElementById(`${type}-list`);
    listEl.innerHTML = `<p class="text-on-surface-variant text-sm text-center py-8">Loading…</p>`;

    // Donations tab shows others' open requests (donate to someone who needs it)
    const fetchType = type === "donations" ? "requests" : type;

    try {
      const res  = await authFetch(`${API}/api/community/${fetchType}`);
      const json = await res.json();
      if (!json.success) {
        listEl.innerHTML = `<div class="text-center py-8">
          <span class="material-symbols-outlined text-3xl text-on-surface-variant/40 block mb-2">inbox</span>
          <p class="text-on-surface-variant text-sm">No ${type} available right now.</p>
          <p class="text-on-surface-variant/50 text-xs mt-1">Make sure your location is set in your profile.</p>
        </div>`;
        return;
      }

      let rows = json.data;

      // For requests tab, show all (own ones will render with delete, others with Details)

      if (!rows.length) {
        const emptyMsg = type === "donations"
          ? "No neighbours need energy right now."
          : `No open ${type} in your area yet.`;
        const emptyHint = type === "donations"
          ? "Check back later — when someone posts a request you can donate to them here."
          : "Be the first to post one above.";
        listEl.innerHTML = `<div class="text-center py-8">
          <span class="material-symbols-outlined text-3xl text-on-surface-variant/40 block mb-2">inbox</span>
          <p class="text-on-surface-variant text-sm">${emptyMsg}</p>
          <p class="text-on-surface-variant/50 text-xs mt-1">${emptyHint}</p>
        </div>`;
        return;
      }
      listEl.innerHTML = rows.map(r => renderRow(r, type)).join("");
      listEl.querySelectorAll("button[data-action]").forEach(btn => {
        btn.addEventListener("click", () => {
          if (btn.dataset.action === "details") openDetails(btn);
          else handleAction(btn.dataset.action, btn.dataset.type, btn.dataset.id);
        });
      });
    } catch {
      listEl.innerHTML = `<div class="text-center py-8">
        <span class="material-symbols-outlined text-3xl text-on-surface-variant/40 block mb-2">wifi_off</span>
        <p class="text-on-surface-variant text-sm">Could not reach the server.</p>
      </div>`;
    }
  }

  // ── Details modal ──────────────────────────────────────────────────────────
  let detailsItemId   = null;
  let detailsItemType = null;

  const detailsBackdrop = document.getElementById("details-backdrop");
  document.getElementById("details-close").addEventListener("click",  () => detailsBackdrop.classList.add("hidden"));
  document.getElementById("details-cancel").addEventListener("click", () => detailsBackdrop.classList.add("hidden"));
  // Details modal only closes via Cancel/Close button, not clicking outside

  document.getElementById("details-buy").addEventListener("click", async () => {
    if (!detailsItemId) return;
    const donorComment = document.getElementById("det-donor-comment").value.trim();
    detailsBackdrop.classList.add("hidden");
    await handleAction("fill", detailsItemType, detailsItemId, donorComment || null);
  });

  function openDetails(btn) {
    const username  = btn.dataset.username || "Unknown";
    const amount    = parseFloat(btn.dataset.amount);
    const price     = btn.dataset.price ? parseFloat(btn.dataset.price) : null;
    const comment   = btn.dataset.comment || "";
    const createdAt = btn.dataset.created;
    const isSale    = btn.dataset.type === "sales";
    detailsItemId   = btn.dataset.id;
    detailsItemType = btn.dataset.type;

    // Icon + title
    document.getElementById("det-title").textContent        = isSale ? "Sale Details" : "Request Details";
    document.getElementById("det-icon").textContent         = isSale ? "sell" : "electric_bolt";
    document.getElementById("det-icon-wrap").style.background = isSale ? "#9ff2e1" : "#d6e3ff";
    document.getElementById("det-icon").style.color          = isSale ? "#005147" : "#005db6";
    document.getElementById("det-user-label").textContent    = isSale ? "Seller" : "Requester";

    document.getElementById("det-username").textContent = username;
    document.getElementById("det-amount").textContent   = `${amount} kWh`;
    document.getElementById("det-time").textContent     = relTime(createdAt);

    // Price / total (sales only)
    document.getElementById("det-price-row").classList.toggle("hidden", !isSale);
    document.getElementById("det-total-row").classList.toggle("hidden", !isSale);
    if (isSale && price !== null) {
      document.getElementById("det-price").textContent = `R${price.toFixed(2)}`;
      document.getElementById("det-total").textContent = `R${(amount * price).toFixed(2)}`;
    }

    // Their comment
    const commentRow = document.getElementById("det-comment-row");
    if (comment) {
      document.getElementById("det-comment").textContent = comment;
      commentRow.classList.remove("hidden");
    } else {
      commentRow.classList.add("hidden");
    }

    // Donor comment field (requests only)
    const donorWrap = document.getElementById("det-donor-comment-wrap");
    donorWrap.classList.toggle("hidden", isSale);
    document.getElementById("det-donor-comment").value = "";

    // Action button label
    document.getElementById("details-buy").textContent = isSale ? "Buy Now" : "Donate";
    document.getElementById("details-buy").className   = isSale
      ? "flex-1 bg-secondary text-white py-3 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity"
      : "flex-1 bg-tertiary-container text-white py-3 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity";

    detailsBackdrop.classList.remove("hidden");
  }

  // ── Handle fill / delete ───────────────────────────────────────────────────
  async function handleAction(action, type, id, comment = null) {
    // Check SOC before donating/selling (not needed for requests — buyer is receiver)
    if (action === "fill" && type === "sales" && !canShare) {
      toast("Battery SOC too low to share energy.", "error"); return;
    }
    try {
      let res;
      if (action === "fill") {
        const body = comment ? { comment } : {};
        res = await authFetch(`${API}/api/community/${type}/${id}/fill`, { method: "POST", body: JSON.stringify(body) });
      } else {
        res = await authFetch(`${API}/api/community/${type}/${id}`, { method: "DELETE" });
      }
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const successMsg = action === "fill"
        ? (type === "requests" ? "Donation sent! Thank you." : "Purchase complete!")
        : "Listing removed.";
      toast(successMsg, "success");
      loadTab(activeTab);
      loadMyListings();
      loadStatus();
    } catch (err) {
      toast(err.message, "error");
    }
  }


  // ── My Listings ────────────────────────────────────────────────────────────
  async function loadMyListings() {
    const el = document.getElementById("my-listings");
    try {
      const [sRes, rRes] = await Promise.all([
        authFetch(`${API}/api/community/sales`),
        authFetch(`${API}/api/community/requests`),
      ]);
      const [sJson, rJson] = await Promise.all([sRes.json(), rRes.json()]);
      const uid  = Number(myId());
      const mine = [
        ...(sJson.data || []).filter(r => Number(r.user_id) === uid).map(r => ({ ...r, _type: "sales" })),
        ...(rJson.data || []).filter(r => Number(r.user_id) === uid).map(r => ({ ...r, _type: "requests" })),
      ];
      if (!mine.length) {
        el.innerHTML = `<p class="text-on-surface-variant text-sm text-center py-6">You have no active listings.</p>`;
        return;
      }
      el.innerHTML = mine.map(item => {
        const typeLabel = item._type === "donations" ? "Donation" : item._type === "sales" ? "Sale" : "Request";
        const detail    = item._type === "sales"
          ? `${item.amount_kwh} kWh @ R${parseFloat(item.price_per_kwh).toFixed(2)}/kWh`
          : `${item.amount_kwh} kWh`;
        return `
          <div class="flex items-center justify-between p-4 bg-surface-container-low rounded-xl" data-row-id="${item.id}">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-full bg-primary-fixed flex items-center justify-center shrink-0">
                <span class="material-symbols-outlined text-primary text-base">${item._type === "requests" ? "electric_bolt" : "solar_power"}</span>
              </div>
              <div>
                <p class="text-sm font-semibold text-on-surface">${typeLabel}</p>
                <p class="text-xs text-on-surface-variant font-label">${detail} &nbsp;·&nbsp; ${relTime(item.created_at)}</p>
              </div>
            </div>
            <button data-action="delete" data-type="${item._type}" data-id="${item.id}"
              class="text-error hover:bg-error-container rounded-full p-1 transition-colors" title="Cancel">
              <span class="material-symbols-outlined text-base">close</span>
            </button>
          </div>`;
      }).join("");
      el.querySelectorAll("button[data-action]").forEach(btn => {
        btn.addEventListener("click", () => handleAction("delete", btn.dataset.type, btn.dataset.id));
      });
    } catch {
      el.innerHTML = `<div class="text-center py-6">
        <span class="material-symbols-outlined text-3xl text-on-surface-variant/40 block mb-2">wifi_off</span>
        <p class="text-on-surface-variant text-sm">Could not load your listings.</p>
      </div>`;
    }
  }

  // ── Fetch battery capacity + Eskom rate once on load ──────────────────────
  async function loadBatteryMeta() {
    try {
      const [bRes, cRes] = await Promise.all([
        authFetch(`${API}/api/battery`),
        authFetch(`${API}/api/co2`),
      ]);
      const bJson = await bRes.json();
      const cJson = await cRes.json();
      if (bJson.success) batteryCapacity = bJson.data.capacityKwh;
      if (cJson.success) eskomRate = cJson.data.constants.randsPerKwh;
    } catch { /* silent */ }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  loadBatteryMeta();
  loadStatus();
  loadTab("donations");
  loadMyListings();
  setInterval(loadStatus, 60000); // refresh status every minute
})();
