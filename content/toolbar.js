/*
 * Accessibility Toolbar — content script.
 *
 * Injects a fixed toolbar at the top of every page that lets the user adjust
 * font size, line spacing, font family and contrast. Settings are persisted
 * per-host in chrome.storage.local and re-applied on every page load.
 */
(() => {
  "use strict";

  // Avoid double-injection if the script runs twice (e.g. SPA navigations).
  if (window.__a11yToolbarInjected) return;
  window.__a11yToolbarInjected = true;

  const STEP = 0.1; // font/line-height adjustment per click (10%)
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 3.0;
  const STORAGE_KEY = "a11y:" + location.hostname;

  const DEFAULT_STATE = {
    fontScale: 1,
    lineScale: 1,
    readableFont: false,
    highContrast: false,
    darkMode: false,
    hidden: false,
  };

  let state = { ...DEFAULT_STATE };

  // Remembers each element's original font-size / line-height (in px) so that
  // repeated adjustments scale from the original value instead of compounding.
  const baseFontSize = new WeakMap();
  const baseLineHeight = new WeakMap();

  const round = (n) => Math.round(n * 100) / 100;
  const clamp = (n) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, round(n)));

  function isOwnNode(el) {
    return el.closest && el.closest("#a11y-toolbar, #a11y-toolbar-handle");
  }

  function scalableElements() {
    // Text-bearing elements. Skip script/style/our own UI.
    return document.body
      ? document.body.querySelectorAll(
          "*:not(script):not(style):not(noscript):not(svg):not(canvas)"
        )
      : [];
  }

  function applyFontScaling(roots) {
    const elements = roots || scalableElements();
    elements.forEach((el) => {
      if (isOwnNode(el)) return;

      // Font size
      if (!baseFontSize.has(el)) {
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (!isNaN(size)) baseFontSize.set(el, size);
      }
      const base = baseFontSize.get(el);
      if (base != null) {
        if (state.fontScale === 1) {
          el.style.removeProperty("font-size");
        } else {
          el.style.setProperty(
            "font-size",
            round(base * state.fontScale) + "px",
            "important"
          );
        }
      }

      // Line height
      if (!baseLineHeight.has(el)) {
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        if (!isNaN(lh)) baseLineHeight.set(el, lh);
      }
      const baseLh = baseLineHeight.get(el);
      if (baseLh != null) {
        if (state.lineScale === 1) {
          el.style.removeProperty("line-height");
        } else {
          el.style.setProperty(
            "line-height",
            round(baseLh * state.lineScale) + "px",
            "important"
          );
        }
      }
    });
  }

  function applyPageClasses() {
    const root = document.documentElement;
    root.classList.toggle("a11y-readable-font", state.readableFont);
    root.classList.toggle("a11y-high-contrast", state.highContrast);
    root.classList.toggle("a11y-dark-mode", state.darkMode);
  }

  function applyAll(roots) {
    applyFontScaling(roots);
    applyPageClasses();
  }

  // --- Persistence -----------------------------------------------------------

  function save() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: state });
    } catch (e) {
      /* storage may be unavailable on some pages; ignore */
    }
  }

  function load() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (res) => {
          if (res && res[STORAGE_KEY]) {
            state = { ...DEFAULT_STATE, ...res[STORAGE_KEY] };
          }
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  // --- Actions ---------------------------------------------------------------

  function setFontScale(scale) {
    state.fontScale = clamp(scale);
    applyFontScaling();
    save();
    syncButtons();
  }

  function setLineScale(scale) {
    state.lineScale = clamp(scale);
    applyFontScaling();
    save();
    syncButtons();
  }

  function toggle(key) {
    state[key] = !state[key];
    applyPageClasses();
    save();
    syncButtons();
  }

  function resetAll() {
    state = { ...DEFAULT_STATE, hidden: state.hidden };
    applyAll();
    // Remove styling injected by AI requests (structural DOM edits need a reload).
    const aiStyle = document.getElementById("a11y-ai-style");
    if (aiStyle) aiStyle.remove();
    save();
    syncButtons();
  }

  function setHidden(hidden) {
    state.hidden = hidden;
    save();
    renderVisibility();
  }

  // --- UI --------------------------------------------------------------------

  let toolbarEl = null;
  let handleEl = null;

  function btn(label, title, onClick, extraClass) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    if (extraClass) b.className = extraClass;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onClick(b);
    });
    return b;
  }

  function buildToolbar() {
    toolbarEl = document.createElement("div");
    toolbarEl.id = "a11y-toolbar";
    toolbarEl.setAttribute("role", "toolbar");
    toolbarEl.setAttribute("aria-label", "Accessibility toolbar");

    const row = document.createElement("div");
    row.className = "a11y-row";

    const label = document.createElement("span");
    label.className = "a11y-label";
    label.textContent = "Accessibility";
    row.appendChild(label);

    row.appendChild(
      btn("A−", "Decrease font size", () =>
        setFontScale(state.fontScale - STEP)
      )
    );
    row.appendChild(
      btn("A+", "Increase font size", () =>
        setFontScale(state.fontScale + STEP)
      )
    );
    row.appendChild(
      btn("Reset text", "Reset font size", () => setFontScale(1))
    );

    row.appendChild(
      btn("Line−", "Decrease line spacing", () =>
        setLineScale(state.lineScale - STEP)
      )
    );
    row.appendChild(
      btn("Line+", "Increase line spacing", () =>
        setLineScale(state.lineScale + STEP)
      )
    );

    row.appendChild(
      btn("Readable font", "Toggle a clearer, dyslexia-friendly font", () =>
        toggle("readableFont")
      )
    ).dataset.key = "readableFont";
    row.appendChild(
      btn("High contrast", "Toggle high contrast", () =>
        toggle("highContrast")
      )
    ).dataset.key = "highContrast";
    row.appendChild(
      btn("Dark mode", "Toggle dark / inverted mode", () => toggle("darkMode"))
    ).dataset.key = "darkMode";

    const aiBtn = btn(
      "✨ AI",
      "Make AI-powered changes with Gemini",
      toggleAiPanel
    );
    aiBtn.id = "a11y-ai-btn";
    row.appendChild(aiBtn);

    const spacer = document.createElement("span");
    spacer.className = "a11y-spacer";
    row.appendChild(spacer);

    row.appendChild(btn("Reset all", "Reset all changes", resetAll));
    row.appendChild(
      btn("✕", "Hide toolbar", () => setHidden(true), "a11y-close")
    );

    toolbarEl.appendChild(row);
    toolbarEl.appendChild(buildAiPanel());

    document.documentElement.appendChild(toolbarEl);
  }

  // --- AI panel (Gemini) -----------------------------------------------------

  const GEMINI_STORE = "a11y:gemini"; // global (not per-host) — holds the API key

  let aiPanelEl, aiInput, aiKeyInput, aiApplyBtn, aiStatus;

  function loadGeminiCfg() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(GEMINI_STORE, (res) =>
          resolve((res && res[GEMINI_STORE]) || {})
        );
      } catch (e) {
        resolve({});
      }
    });
  }

  function saveGeminiCfg(cfg) {
    try {
      chrome.storage.local.set({ [GEMINI_STORE]: cfg });
    } catch (e) {
      /* ignore */
    }
  }

  function buildAiPanel() {
    aiPanelEl = document.createElement("div");
    aiPanelEl.id = "a11y-ai-panel";

    aiInput = document.createElement("textarea");
    aiInput.id = "a11y-ai-input";
    aiInput.rows = 2;
    aiInput.placeholder =
      "Describe the changes you want Gemini to make to this page… " +
      "(e.g. “use a dark background, enlarge the headings and hide the sidebar”)";
    aiInput.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runAi();
      }
    });

    const controls = document.createElement("div");
    controls.className = "a11y-ai-controls";

    aiKeyInput = document.createElement("input");
    aiKeyInput.id = "a11y-ai-key";
    aiKeyInput.type = "password";
    aiKeyInput.placeholder = "Gemini API key";
    aiKeyInput.autocomplete = "off";
    aiKeyInput.spellcheck = false;

    aiApplyBtn = btn("Apply", "Send to Gemini and apply the changes", runAi);
    aiApplyBtn.id = "a11y-ai-apply";

    controls.appendChild(aiKeyInput);
    controls.appendChild(aiApplyBtn);

    aiStatus = document.createElement("span");
    aiStatus.id = "a11y-ai-status";

    aiPanelEl.appendChild(aiInput);
    aiPanelEl.appendChild(controls);
    aiPanelEl.appendChild(aiStatus);

    // Pre-fill the saved key (stored once, reused across sites).
    loadGeminiCfg().then((cfg) => {
      if (cfg.apiKey) aiKeyInput.value = cfg.apiKey;
    });

    return aiPanelEl;
  }

  function toggleAiPanel() {
    if (!aiPanelEl) return;
    const open = !aiPanelEl.classList.contains("open");
    aiPanelEl.classList.toggle("open", open);
    const aiBtn = document.getElementById("a11y-ai-btn");
    if (aiBtn) aiBtn.classList.toggle("a11y-active", open);
    if (open) aiInput.focus();
    updateOffset();
  }

  function setAiStatus(text, kind) {
    if (!aiStatus) return;
    aiStatus.textContent = text || "";
    aiStatus.dataset.kind = kind || "";
  }

  function pageContext() {
    let html = "";
    try {
      html = document.body ? document.body.innerHTML : "";
    } catch (e) {
      /* ignore */
    }
    const max = (window.__a11yGemini && window.__a11yGemini.MAX_HTML) || 6000;
    if (html.length > max) html = html.slice(0, max) + "\n<!-- …truncated… -->";
    return { url: location.href, title: document.title, html };
  }

  // Execute Gemini's code in the content-script isolated world. The DOM is
  // shared with the page, so manipulations take effect immediately.
  function applyAiCode(code) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(code)();
    } catch (e) {
      throw new Error("Generated code failed: " + (e.message || e));
    }
  }

  async function runAi() {
    if (!window.__a11yGemini) {
      setAiStatus("Gemini client failed to load.", "error");
      return;
    }
    const requirement = (aiInput.value || "").trim();
    const apiKey = (aiKeyInput.value || "").trim();
    if (!requirement) {
      setAiStatus("Describe what you'd like to change.", "error");
      aiInput.focus();
      return;
    }
    if (!apiKey) {
      setAiStatus("Enter your Gemini API key.", "error");
      aiKeyInput.focus();
      return;
    }

    const cfg = await loadGeminiCfg();
    cfg.apiKey = apiKey; // persist the key for reuse
    saveGeminiCfg(cfg);

    setAiStatus("Asking Gemini…", "busy");
    aiApplyBtn.disabled = true;
    try {
      const code = await window.__a11yGemini.generate({
        apiKey,
        model: cfg.model,
        requirement,
        context: pageContext(),
      });
      if (!code) throw new Error("Gemini returned no code.");
      applyAiCode(code);
      setAiStatus("Changes applied. Reload the page to undo them.", "ok");
    } catch (err) {
      setAiStatus(err.message || String(err), "error");
    } finally {
      aiApplyBtn.disabled = false;
    }
  }

  function buildHandle() {
    handleEl = document.createElement("button");
    handleEl.id = "a11y-toolbar-handle";
    handleEl.type = "button";
    handleEl.textContent = "♿ Accessibility";
    handleEl.title = "Show accessibility toolbar";
    handleEl.addEventListener("click", (e) => {
      e.preventDefault();
      setHidden(false);
    });
    document.documentElement.appendChild(handleEl);
  }

  // Offset the page so the fixed bar (which grows when the AI panel opens)
  // doesn't cover the top of the content.
  function updateOffset() {
    if (!toolbarEl) return;
    const offset = state.hidden ? "" : toolbarEl.offsetHeight + "px";
    document.documentElement.style.setProperty(
      "margin-top",
      offset,
      "important"
    );
  }

  function renderVisibility() {
    if (!toolbarEl) return;
    toolbarEl.classList.toggle("a11y-hidden", state.hidden);
    if (handleEl) handleEl.style.display = state.hidden ? "block" : "none";
    updateOffset();
  }

  function syncButtons() {
    if (!toolbarEl) return;
    toolbarEl.querySelectorAll("button[data-key]").forEach((b) => {
      b.classList.toggle("a11y-active", !!state[b.dataset.key]);
    });
  }

  // --- Dynamic content -------------------------------------------------------

  let pending = [];
  let scheduled = false;

  function scheduleScale(nodes) {
    if (state.fontScale === 1 && state.lineScale === 1) return;
    nodes.forEach((n) => pending.push(n));
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const toProcess = pending;
      pending = [];
      const els = [];
      toProcess.forEach((n) => {
        if (n.nodeType !== 1 || isOwnNode(n)) return;
        els.push(n);
        n.querySelectorAll &&
          n
            .querySelectorAll("*:not(script):not(style):not(noscript)")
            .forEach((c) => els.push(c));
      });
      if (els.length) applyFontScaling(els);
    });
  }

  function observeMutations() {
    const observer = new MutationObserver((mutations) => {
      const added = [];
      mutations.forEach((m) => {
        m.addedNodes.forEach((n) => added.push(n));
      });
      if (added.length) scheduleScale(added);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // --- Messaging from popup --------------------------------------------------

  function listenForPopup() {
    if (!chrome.runtime || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case "a11y-show":
          setHidden(false);
          break;
        case "a11y-reset":
          resetAll();
          break;
        case "a11y-get-state":
          sendResponse(state);
          return; // synchronous response
      }
    });
  }

  // --- Init ------------------------------------------------------------------

  async function init() {
    await load();
    buildToolbar();
    buildHandle();
    applyAll();
    syncButtons();
    renderVisibility();
    observeMutations();
    listenForPopup();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
