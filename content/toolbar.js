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

    const label = document.createElement("span");
    label.className = "a11y-label";
    label.textContent = "Accessibility";
    toolbarEl.appendChild(label);

    toolbarEl.appendChild(
      btn("A−", "Decrease font size", () =>
        setFontScale(state.fontScale - STEP)
      )
    );
    toolbarEl.appendChild(
      btn("A+", "Increase font size", () =>
        setFontScale(state.fontScale + STEP)
      )
    );
    toolbarEl.appendChild(
      btn("Reset text", "Reset font size", () => setFontScale(1))
    );

    toolbarEl.appendChild(
      btn("Line−", "Decrease line spacing", () =>
        setLineScale(state.lineScale - STEP)
      )
    );
    toolbarEl.appendChild(
      btn("Line+", "Increase line spacing", () =>
        setLineScale(state.lineScale + STEP)
      )
    );

    toolbarEl.appendChild(
      btn("Readable font", "Toggle a clearer, dyslexia-friendly font", () =>
        toggle("readableFont")
      )
    ).dataset.key = "readableFont";
    toolbarEl.appendChild(
      btn("High contrast", "Toggle high contrast", () =>
        toggle("highContrast")
      )
    ).dataset.key = "highContrast";
    toolbarEl.appendChild(
      btn("Dark mode", "Toggle dark / inverted mode", () => toggle("darkMode"))
    ).dataset.key = "darkMode";

    const spacer = document.createElement("span");
    spacer.className = "a11y-spacer";
    toolbarEl.appendChild(spacer);

    toolbarEl.appendChild(btn("Reset all", "Reset all changes", resetAll));
    toolbarEl.appendChild(
      btn("✕", "Hide toolbar", () => setHidden(true), "a11y-close")
    );

    document.documentElement.appendChild(toolbarEl);
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

  function renderVisibility() {
    if (!toolbarEl) return;
    toolbarEl.classList.toggle("a11y-hidden", state.hidden);
    if (handleEl) handleEl.style.display = state.hidden ? "block" : "none";
    // Offset the page so the fixed bar doesn't cover the top of the content.
    const offset = state.hidden ? "" : toolbarEl.offsetHeight + "px";
    document.documentElement.style.setProperty("margin-top", offset, "important");
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
