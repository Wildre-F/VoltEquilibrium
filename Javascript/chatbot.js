// VoltBot — AI Energy Chatbot Widget
(function () {
  const token = sessionStorage.getItem("authToken") || localStorage.getItem("authToken");
  if (!token) return;

  const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://localhost:3000" : "";

  // Inject chatbot HTML
  const widget = document.createElement("div");
  widget.innerHTML = `
    <div id="chatbot-fab" style="position:fixed;bottom:24px;right:24px;z-index:50;cursor:pointer;">
      <button id="chatbot-toggle" style="width:56px;height:56px;border-radius:50%;background:var(--color-primary);color:var(--color-on-primary);border:none;box-shadow:0 4px 16px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 0.5s cubic-bezier(0.4,0,0.2,1);">
        <span id="chatbot-fab-icon" class="material-symbols-outlined" style="font-size:28px;font-variation-settings:'FILL' 1;">auto_awesome</span>
      </button>
    </div>
    <div id="chatbot-panel" style="position:fixed;bottom:90px;right:24px;z-index:50;width:380px;max-height:520px;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.18);background:var(--color-surface-container-lowest);border:1px solid var(--color-outline-variant);transform:scale(0.8) translateY(20px);opacity:0;pointer-events:none;transform-origin:bottom right;transition:transform 0.25s cubic-bezier(0.4,0,0.2,1),opacity 0.25s cubic-bezier(0.4,0,0.2,1);">
      <div style="background:var(--color-primary);color:var(--color-on-primary);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="material-symbols-outlined" style="font-size:22px;font-variation-settings:'FILL' 1;">smart_toy</span>
          <span style="font-weight:800;font-family:Manrope;font-size:14px;">VoltBot</span>
          <span id="chatbot-status" style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-family:Inter;opacity:0.8;">
            <span id="chatbot-status-dot" style="width:6px;height:6px;border-radius:50%;background:#888;"></span>
            <span id="chatbot-status-text">Checking...</span>
          </span>
          <span id="chatbot-response-time" style="font-size:9px;font-family:Inter;opacity:0.6;display:none;">
            <span class="material-symbols-outlined" style="font-size:10px;vertical-align:middle;">speed</span>
            <span id="chatbot-rt-value">—</span>
          </span>
        </div>
        <button id="chatbot-clear" title="Clear chat" style="background:none;border:none;color:var(--color-on-primary);cursor:pointer;opacity:0.7;">
          <span class="material-symbols-outlined" style="font-size:18px;">delete_sweep</span>
        </button>
      </div>
      <div id="chatbot-messages" style="padding:16px;height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;">
        <div style="background:var(--color-primary-fixed);color:var(--color-on-primary-fixed);padding:10px 14px;border-radius:14px 14px 14px 4px;max-width:85%;align-self:flex-start;">
          Hi! I'm VoltBot, your energy assistant. Ask me anything about your solar system, battery, savings, or community energy sharing.
        </div>
      </div>
      <div style="padding:10px 14px 14px;border-top:1px solid var(--color-outline-variant);display:flex;gap:8px;">
        <input id="chatbot-input" type="text" placeholder="Ask about your energy..."
          style="flex:1;padding:10px 14px;border-radius:12px;border:1px solid var(--color-outline-variant);background:var(--color-surface-container);color:var(--color-on-surface);font-size:13px;font-family:'Plus Jakarta Sans',sans-serif;outline:none;" />
        <button id="chatbot-send" style="width:40px;height:40px;border-radius:12px;background:var(--color-primary);color:var(--color-on-primary);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;">
          <span class="material-symbols-outlined" style="font-size:20px;">send</span>
        </button>
      </div>
    </div>`;
  document.body.appendChild(widget);

  const panel    = document.getElementById("chatbot-panel");
  const messages = document.getElementById("chatbot-messages");
  const input    = document.getElementById("chatbot-input");
  const sendBtn  = document.getElementById("chatbot-send");
  let isOpen = false;
  let botOnline = false;

  function updateBotStatus(online) {
    botOnline = online;
    const dot  = document.getElementById("chatbot-status-dot");
    const text = document.getElementById("chatbot-status-text");
    if (dot && text) {
      dot.style.background = online ? "#4ade80" : "#f87171";
      dot.style.boxShadow  = online ? "0 0 6px #4ade80" : "none";
      text.textContent      = online ? "Online" : "Offline";
    }
    if (sendBtn) sendBtn.disabled = !online;
  }

  async function checkBotStatus() {
    try {
      const res = await fetch(`${API}/api/chat/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      updateBotStatus(res.ok);
    } catch {
      updateBotStatus(false);
    }
  }

  // Check status on load and every 30s
  checkBotStatus();
  setInterval(checkBotStatus, 30000);

  const fabBtn  = document.getElementById("chatbot-toggle");
  const fabIcon = document.getElementById("chatbot-fab-icon");

  fabBtn.addEventListener("click", () => {
    isOpen = !isOpen;
    // Spin 180 and swap icon
    fabBtn.style.transform = isOpen ? "rotate(180deg)" : "rotate(0deg)";
    fabIcon.textContent = isOpen ? "close" : "auto_awesome";

    if (isOpen) {
      panel.style.transform = "scale(1) translateY(0)";
      panel.style.opacity = "1";
      panel.style.pointerEvents = "auto";
      checkBotStatus();
      loadHistory();
      input.focus();
    } else {
      panel.style.transform = "scale(0.8) translateY(20px)";
      panel.style.opacity = "0";
      panel.style.pointerEvents = "none";
    }
  });

  // Confirm dialog for clearing chat
  const confirmOverlay = document.createElement("div");
  confirmOverlay.id = "chatbot-confirm";
  confirmOverlay.style.cssText = "display:none;position:absolute;inset:0;z-index:10;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);border-radius:20px;flex-direction:column;align-items:center;justify-content:center;padding:24px;";
  confirmOverlay.innerHTML = `
    <div style="background:var(--color-surface-container-lowest);border-radius:16px;padding:24px;max-width:280px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <span class="material-symbols-outlined" style="font-size:36px;color:var(--color-error);margin-bottom:8px;display:block;">delete_forever</span>
      <p style="font-weight:700;font-family:Manrope;font-size:14px;color:var(--color-on-surface);margin-bottom:6px;">Clear chat history?</p>
      <p style="font-size:12px;color:var(--color-on-surface-variant);margin-bottom:20px;line-height:1.5;">VoltBot will lose all context from this conversation and start fresh.</p>
      <div style="display:flex;gap:8px;">
        <button id="chatbot-confirm-cancel" style="flex:1;padding:10px;border-radius:10px;border:1.5px solid var(--color-outline-variant);background:none;color:var(--color-on-surface);font-family:Inter;font-weight:700;font-size:12px;cursor:pointer;">Keep Chat</button>
        <button id="chatbot-confirm-yes" style="flex:1;padding:10px;border-radius:10px;border:none;background:var(--color-error);color:var(--color-on-error);font-family:Inter;font-weight:700;font-size:12px;cursor:pointer;">Clear All</button>
      </div>
    </div>`;
  panel.style.position = "fixed";
  panel.appendChild(confirmOverlay);

  document.getElementById("chatbot-clear").addEventListener("click", () => {
    confirmOverlay.style.display = "flex";
  });

  document.getElementById("chatbot-confirm-cancel").addEventListener("click", () => {
    confirmOverlay.style.display = "none";
  });

  document.getElementById("chatbot-confirm-yes").addEventListener("click", async () => {
    confirmOverlay.style.display = "none";
    await fetch(`${API}/api/chat/history`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    messages.innerHTML = `
      <div style="background:var(--color-primary-fixed);color:var(--color-on-primary-fixed);padding:10px 14px;border-radius:14px 14px 14px 4px;max-width:85%;align-self:flex-start;">
        Chat cleared! How can I help?
      </div>`;
  });

  function formatBotMessage(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')                     // **bold**
      .replace(/\*\s(.+?)(?=\n|$)/g, '<div style="display:flex;gap:6px;margin:2px 0;"><span style="color:var(--color-primary);flex-shrink:0;">&#8226;</span><span>$1</span></div>') // * bullet
      .replace(/^- (.+?)$/gm, '<div style="display:flex;gap:6px;margin:2px 0;"><span style="color:var(--color-primary);flex-shrink:0;">&#8226;</span><span>$1</span></div>')      // - bullet
      .replace(/\n/g, '<br>');                                                // line breaks
  }

  function addMessage(role, content, animate) {
    const div = document.createElement("div");
    if (role === "user") {
      div.style.cssText = "background:var(--color-primary);color:var(--color-on-primary);padding:10px 14px;border-radius:14px 14px 4px 14px;max-width:85%;align-self:flex-end;";
      div.textContent = content;
    } else {
      div.style.cssText = "background:var(--color-primary-fixed);color:var(--color-on-primary-fixed);padding:12px 16px;border-radius:14px 14px 14px 4px;max-width:88%;align-self:flex-start;line-height:1.6;";
      if (animate) {
        div.style.opacity = "0";
        div.style.transform = "translateY(8px)";
        div.style.transition = "opacity 0.4s ease-out, transform 0.4s ease-out";
      }
      div.innerHTML = formatBotMessage(content);
    }
    messages.appendChild(div);
    if (animate) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        div.style.opacity = "1";
        div.style.transform = "translateY(0)";
      }));
    }
    messages.scrollTop = messages.scrollHeight;
  }

  function addTyping() {
    const div = document.createElement("div");
    div.id = "chatbot-typing";
    div.style.cssText = "background:var(--color-surface-container);padding:12px 18px;border-radius:14px 14px 14px 4px;max-width:85%;align-self:flex-start;display:flex;align-items:center;gap:8px;";
    div.innerHTML = `
      <div style="display:flex;gap:4px;align-items:center;">
        <span style="width:7px;height:7px;border-radius:50%;background:var(--color-on-surface-variant);opacity:0.4;animation:dotBounce 1.4s infinite ease-in-out both;animation-delay:0s;"></span>
        <span style="width:7px;height:7px;border-radius:50%;background:var(--color-on-surface-variant);opacity:0.4;animation:dotBounce 1.4s infinite ease-in-out both;animation-delay:0.2s;"></span>
        <span style="width:7px;height:7px;border-radius:50%;background:var(--color-on-surface-variant);opacity:0.4;animation:dotBounce 1.4s infinite ease-in-out both;animation-delay:0.4s;"></span>
      </div>
      <span style="font-size:11px;color:var(--color-on-surface-variant);font-family:Inter;">VoltBot is thinking</span>`;
    // Inject keyframes if not already present
    if (!document.getElementById("chatbot-keyframes")) {
      const style = document.createElement("style");
      style.id = "chatbot-keyframes";
      style.textContent = "@keyframes dotBounce{0%,80%,100%{transform:scale(0.6);opacity:0.4;}40%{transform:scale(1);opacity:1;}}";
      document.head.appendChild(style);
    }
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function removeTyping() {
    const t = document.getElementById("chatbot-typing");
    if (t) t.remove();
  }

  const responseTimes = [];

  function updateResponseTimeTag(ms) {
    responseTimes.push(ms);
    if (responseTimes.length > 10) responseTimes.shift();
    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const rtEl = document.getElementById("chatbot-response-time");
    const rtVal = document.getElementById("chatbot-rt-value");
    if (rtEl && rtVal) {
      rtEl.style.display = "inline-flex";
      rtVal.textContent = avg < 1000 ? `~${Math.round(avg)}ms` : `~${(avg / 1000).toFixed(1)}s`;
    }
  }

  async function sendMessage() {
    const msg = input.value.trim();
    if (!msg) return;

    input.value = "";
    addMessage("user", msg);
    addTyping();
    sendBtn.disabled = true;
    const startTime = Date.now();

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      const elapsed = Date.now() - startTime;
      removeTyping();
      if (data.success) {
        addMessage("assistant", data.data.content, true);
        updateResponseTimeTag(elapsed);
      } else {
        addMessage("assistant", data.message || "Sorry, something went wrong.", true);
      }
    } catch (err) {
      console.error("[chatbot] send message error:", err.message);
      removeTyping();
      addMessage("assistant", "Could not reach the AI assistant. Please try again.", true);
      updateBotStatus(false);
    }
    sendBtn.disabled = false;
    input.focus();
  }

  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  async function loadHistory() {
    try {
      const res = await fetch(`${API}/api/chat/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success && data.data.length > 0) {
        // Keep the welcome message, add history
        messages.innerHTML = "";
        data.data.forEach((m) => addMessage(m.role, m.content));
      }
    } catch (err) {
      console.error("[chatbot] load history error:", err.message);
    }
  }
})();
