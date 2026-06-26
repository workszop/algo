/*
 * Accessibility Toolbar - content script.
 *
 * Injects a fixed toolbar at the top of every page that lets the user adjust
 * font size, line spacing, font family and contrast. Settings are persisted
 * per-host in chrome.storage.local and re-applied on every page load.
 */
(() => {
  "use strict";

  // Version of this instance. When the extension is updated and re-injected
  // (see background.js), a newer instance claims ownership by overwriting
  // window.__a11yToolbarVersion; older instances notice they're no longer
  // current via isCurrent() and stand down. This is what stops a stale toolbar
  // from lingering in tabs that were open during an update.
  const VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return "dev";
    }
  })();
  window.__a11yToolbarVersion = VERSION;
  const isCurrent = () => window.__a11yToolbarVersion === VERSION;

  // Remove any toolbar UI left over from a previous (or older) instance so the
  // freshest version is the only one on the page.
  function removeExistingUI() {
    ["a11y-toolbar", "a11y-toolbar-handle", "a11y-ai-panel"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

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

  // True once Gemini has applied changes to the page this session. AI edits are
  // inline styles / DOM mutations on arbitrary elements (not persisted), so the
  // only reliable way to fully undo them is a page reload - see resetAll().
  let aiChangesApplied = false;

  // Remembers each element's original font-size / line-height (in px) so that
  // repeated adjustments scale from the original value instead of compounding.
  const baseFontSize = new WeakMap();
  const baseLineHeight = new WeakMap();

  const round = (n) => Math.round(n * 100) / 100;
  const clamp = (n) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, round(n)));

  function isOwnNode(el) {
    return (
      el.closest &&
      el.closest("#a11y-toolbar, #a11y-toolbar-handle, #a11y-ai-panel")
    );
  }

  function scalableElements() {
    // Text-bearing elements. Skip script/style/our own UI.
    return document.body
      ? document.body.querySelectorAll(
          "*:not(script):not(style):not(noscript):not(svg):not(canvas)"
        )
      : [];
  }

  // Scale one CSS property from the element's remembered original value, so
  // repeated adjustments don't compound. Removes the override at scale 1.
  function scaleProp(el, baseMap, cssomProp, cssProp, scale) {
    if (!baseMap.has(el)) {
      const v = parseFloat(getComputedStyle(el)[cssomProp]);
      if (!isNaN(v)) baseMap.set(el, v);
    }
    const base = baseMap.get(el);
    if (base == null) return;
    if (scale === 1) {
      el.style.removeProperty(cssProp);
    } else {
      el.style.setProperty(cssProp, round(base * scale) + "px", "important");
    }
  }

  function applyFontScaling(roots) {
    const elements = roots || scalableElements();
    elements.forEach((el) => {
      if (isOwnNode(el)) return;
      scaleProp(el, baseFontSize, "fontSize", "font-size", state.fontScale);
      scaleProp(el, baseLineHeight, "lineHeight", "line-height", state.lineScale);
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

  // Promise-based wrappers over chrome.storage.local that never throw, so
  // callers don't each need their own try/catch. storage can be unavailable
  // on some pages (e.g. before the extension context is ready).
  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (res) => resolve((res && res[key]) || null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    try {
      chrome.storage.local.set({ [key]: value });
    } catch (e) {
      /* ignore */
    }
  }

  const save = () => storageSet(STORAGE_KEY, state);

  async function load() {
    const saved = await storageGet(STORAGE_KEY);
    if (saved) state = { ...DEFAULT_STATE, ...saved };
  }

  // --- Actions ---------------------------------------------------------------

  function setScale(key, value) {
    state[key] = clamp(value);
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
    const hadAiChanges = aiChangesApplied;
    state = { ...DEFAULT_STATE, hidden: state.hidden };
    save(); // persist the reset first, so a reload comes back to a clean page

    if (hadAiChanges) {
      // AI edits live as inline styles / DOM mutations on arbitrary elements
      // and can't be reliably walked back in place; reloading restores the
      // original page. The reset state is already saved, so nothing re-applies.
      try {
        location.reload();
        return;
      } catch (e) {
        /* fall through to the in-place reset below */
      }
    }

    applyAll();
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

  // Resolve a packaged asset (e.g. the brand mark) to a URL usable from the
  // host page. Listed under web_accessible_resources in the manifest.
  function assetUrl(path) {
    try {
      return chrome.runtime.getURL(path);
    } catch (e) {
      return "";
    }
  }

  // The Quantica Q (octagon) brand mark in its native magenta, on the dark bar.
  // Sized via CSS (.a11y-brand img / #a11y-toolbar-handle img).
  function brandMark() {
    const img = document.createElement("img");
    img.src = assetUrl("icons/qmark-magenta.png");
    img.alt = "Quantica";
    img.decoding = "async";
    return img;
  }

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

    // Brand lockup: Quantica Q mark + "Accessibility" wordmark.
    const brand = document.createElement("span");
    brand.className = "a11y-brand";
    brand.appendChild(brandMark());
    const label = document.createElement("span");
    label.className = "a11y-label";
    label.textContent = "Accessibility";
    brand.appendChild(label);
    row.appendChild(brand);

    row.appendChild(
      btn("A−", "Decrease font size", () =>
        setScale("fontScale", state.fontScale - STEP)
      )
    );
    row.appendChild(
      btn("A+", "Increase font size", () =>
        setScale("fontScale", state.fontScale + STEP)
      )
    );
    row.appendChild(
      btn("Reset text", "Reset font size", () => setScale("fontScale", 1))
    );

    row.appendChild(
      btn("Line−", "Decrease line spacing", () =>
        setScale("lineScale", state.lineScale - STEP)
      )
    );
    row.appendChild(
      btn("Line+", "Increase line spacing", () =>
        setScale("lineScale", state.lineScale + STEP)
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

    const aiBtn = btn("AI", "Make AI-powered changes with Gemini", toggleAiPanel);
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
    document.documentElement.appendChild(toolbarEl);

    // The AI panel is a floating box appended to <html> directly (not nested
    // in the bar), so its fixed positioning is relative to the viewport.
    buildAiPanel();
  }

  // --- AI panel (Gemini) -----------------------------------------------------

  const GEMINI_STORE = "a11y:gemini"; // global (not per-host) - holds the API key

  // Selectable Gemini models; the first is the default.
  const GEMINI_MODELS = [
    { value: "gemini-3.5-flash", label: "Flash (latest)" },
    { value: "gemini-3.5-flash-lite", label: "Lite (latest)" },
    { value: "gemini-2.5-flash", label: "Flash 2.5" },
  ];

  let aiPanelEl, aiInput, aiModelSelect, aiApplyBtn, aiStatus;

  const loadGeminiCfg = async () => (await storageGet(GEMINI_STORE)) || {};
  const saveGeminiCfg = (cfg) => storageSet(GEMINI_STORE, cfg);

  function buildAiPanel() {
    aiPanelEl = document.createElement("div");
    aiPanelEl.id = "a11y-ai-panel";
    aiPanelEl.setAttribute("role", "dialog");
    aiPanelEl.setAttribute("aria-label", "AI accessibility assistant");

    const header = document.createElement("div");
    header.className = "a11y-ai-header";
    const title = document.createElement("span");
    title.className = "a11y-ai-title";
    title.textContent = "AI accessibility assistant";
    header.appendChild(title);
    header.appendChild(
      btn("✕", "Close", () => toggleAiPanel(false), "a11y-ai-x")
    );

    aiInput = document.createElement("textarea");
    aiInput.id = "a11y-ai-input";
    aiInput.rows = 3;
    aiInput.placeholder =
      "Describe how to make this page easier to use… " +
      "(e.g. “use a dark background, enlarge the body text and increase spacing”)";
    aiInput.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runAi();
      }
    });

    const controls = document.createElement("div");
    controls.className = "a11y-ai-controls";

    aiModelSelect = document.createElement("select");
    aiModelSelect.id = "a11y-ai-model";
    aiModelSelect.title = "Gemini model";
    GEMINI_MODELS.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.label;
      aiModelSelect.appendChild(opt);
    });
    aiModelSelect.addEventListener("change", () => {
      loadGeminiCfg().then((cfg) => {
        cfg.model = aiModelSelect.value;
        saveGeminiCfg(cfg);
      });
    });

    aiApplyBtn = btn("Apply", "Send to Gemini and apply the changes", runAi);
    aiApplyBtn.id = "a11y-ai-apply";

    controls.appendChild(aiModelSelect);
    controls.appendChild(aiApplyBtn);

    aiStatus = document.createElement("span");
    aiStatus.id = "a11y-ai-status";

    aiPanelEl.appendChild(header);
    aiPanelEl.appendChild(aiInput);
    aiPanelEl.appendChild(controls);
    aiPanelEl.appendChild(aiStatus);
    document.documentElement.appendChild(aiPanelEl);

    // Restore the saved model choice. The API key is managed separately in the
    // extension popup, so it isn't shown here.
    loadGeminiCfg().then((cfg) => {
      aiModelSelect.value = cfg.model || GEMINI_MODELS[0].value;
    });
  }

  // Pass a boolean to force a state, or omit to toggle.
  function toggleAiPanel(force) {
    if (!aiPanelEl) return;
    const open = typeof force === "boolean" ? force : !aiPanelEl.classList.contains("open");
    aiPanelEl.classList.toggle("open", open);
    const aiBtn = document.getElementById("a11y-ai-btn");
    if (aiBtn) aiBtn.classList.toggle("a11y-active", open);
    if (open) aiInput.focus();
  }

  function setAiStatus(text, kind) {
    if (!aiStatus) return;
    aiStatus.textContent = text || "";
    aiStatus.dataset.kind = kind || "";
  }

  // --- Page summarizer (builds the snapshot sent to Gemini) -----------------

  // Property allow/block lists. The spec is validated against these before
  // anything is applied, so the model can't set risky layout properties via
  // `styles` even if it tries. Mirrors the lists in the system instruction.
  const ALLOWED_PROPERTIES = new Set([
    "color", "background-color", "font-size", "line-height", "letter-spacing",
    "word-spacing", "font-family", "font-weight", "text-align",
    "text-decoration", "outline", "outline-offset", "border", "border-color",
    "border-radius", "box-shadow", "max-width", "width", "margin", "padding",
    "animation", "transition", "scroll-behavior",
  ]);

  // Reject ids/classes that look auto-generated (hashes, CSS-modules, long
  // digit runs) so we only hand Gemini stable selectors it can rely on.
  function isStableName(name) {
    if (typeof name !== "string") return false;
    name = name.trim();
    if (name.length < 2 || name.length > 40) return false;
    if (/^\d/.test(name)) return false;
    if (/\d{4,}/.test(name)) return false; // long digit runs
    if (/(^|[-_])[0-9a-f]{6,}([-_]|$)/i.test(name)) return false; // hash-like
    if (/[a-z][A-Z].*\d/.test(name)) return false; // camelCase + digit
    return /^[a-zA-Z][\w-]*$/.test(name);
  }

  function elementClasses(el) {
    const c = el.className;
    if (typeof c !== "string") return []; // SVG etc.: className isn't a string
    return c.trim() ? c.trim().split(/\s+/) : [];
  }

  // Build a stable, readable selector for one element.
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName.toLowerCase();
    if (el.id && isStableName(el.id)) return tag + "#" + el.id;
    const role = el.getAttribute && el.getAttribute("role");
    if (role && isStableName(role)) return tag + '[role="' + role + '"]';
    const cls = elementClasses(el).find(isStableName);
    if (cls) return tag + "." + cls;
    return tag;
  }

  function firstMatch(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      try {
        const el = document.querySelector(selectors[i]);
        if (el && !isOwnNode(el)) return el;
      } catch (e) {
        /* skip unsupported selector */
      }
    }
    return null;
  }

  // First banner-sized element whose id/class matches `re` (skips our own UI).
  // The size guard avoids matching small links like a footer "cookie statement"
  // when we're really after the cookie banner / sidebar / ad container.
  function findByName(re) {
    const els = document.body
      ? document.body.querySelectorAll("[id], [class]")
      : [];
    for (let i = 0; i < els.length && i < 4000; i++) {
      const el = els[i];
      if (isOwnNode(el)) continue;
      const hay = (
        (el.id || "") +
        " " +
        elementClasses(el).join(" ")
      ).toLowerCase();
      if (!re.test(hay)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 240 || r.height >= 60) return el; // banner-/panel-sized
    }
    return null;
  }

  // First sizable element with a fixed/sticky position (bars, banners, popups).
  function findSticky() {
    const els = document.body ? document.body.querySelectorAll("*") : [];
    for (let i = 0; i < els.length && i < 4000; i++) {
      const el = els[i];
      if (isOwnNode(el)) continue;
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") {
        const r = el.getBoundingClientRect();
        if (r.width > 60 && r.height > 24) return el;
      }
    }
    return null;
  }

  function sampleTextOf(selector, max) {
    try {
      const el = document.querySelector(selector);
      if (!el) return "";
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      return t.slice(0, max || 120).replace(/"/g, "'");
    } catch (e) {
      return "";
    }
  }

  // Curated snapshot for the model: viewport, a plain-language summary of
  // notable regions, a numbered list of stable selector candidates, and a few
  // visible text samples - sent in place of raw innerHTML so the model picks
  // from real selectors instead of inferring them from arbitrary markup.
  function buildPageSnapshot() {
    const summary = [];
    const candidates = [];
    const add = (sel) => {
      if (sel && candidates.indexOf(sel) === -1) candidates.push(sel);
    };

    add("body");

    const main = firstMatch(["main", "article", '[role="main"]']);
    const mainSel = main ? selectorFor(main) : "";
    if (mainSel) {
      summary.push("Main content: " + mainSel);
      add(mainSel);
      add(mainSel + " p");
      add(mainSel + " li");
    } else {
      summary.push("Main content: not clearly marked - use body / p");
    }

    const nav = firstMatch(["nav", '[role="navigation"]']);
    if (nav) {
      const s = selectorFor(nav);
      summary.push("Navigation: " + s);
      add(s);
    }

    const sidebar =
      firstMatch(["aside", '[role="complementary"]']) || findByName(/sidebar/);
    if (sidebar) {
      const s = selectorFor(sidebar);
      summary.push("Sidebar: " + s);
      add(s);
    }

    const cookie = findByName(/cookie|consent|gdpr/);
    if (cookie) {
      const s = selectorFor(cookie);
      summary.push("Cookie/consent banner: " + s);
      add(s);
    }

    const ad = findByName(/(^|[-_ ])ads?([-_ ]|$)|advert|sponsor|promo/);
    if (ad) {
      const s = selectorFor(ad);
      summary.push("Ad/promo: " + s);
      add(s);
    }

    const dialog = firstMatch(['[role="dialog"]', "dialog", ".modal"]);
    if (dialog) {
      const s = selectorFor(dialog);
      summary.push("Dialog/modal: " + s);
      add(s);
    }

    const sticky = findSticky();
    if (sticky) {
      const s = selectorFor(sticky);
      summary.push("Sticky/fixed element: " + s);
      add(s);
    }

    const headings = ["h1", "h2", "h3"].filter((h) => {
      try {
        return !!document.querySelector(h);
      } catch (e) {
        return false;
      }
    });
    if (headings.length) {
      summary.push("Main headings: " + headings.join(", "));
      add(headings.join(", "));
    }

    if (firstMatch(["form", "input", "textarea", "select"])) {
      summary.push("Forms: detected (input, textarea, select, button)");
      add("input, textarea, select");
    } else {
      summary.push("Forms: none detected");
    }

    add("p, li, span");
    add("a, button");

    const samples = [];
    const seen = {};
    const trySample = (sel) => {
      if (!sel || seen[sel]) return;
      seen[sel] = true;
      const t = sampleTextOf(sel, 120);
      if (t) samples.push({ selector: sel, text: t });
    };
    trySample("h1");
    trySample(mainSel ? mainSel + " p" : "p");
    if (nav) trySample(selectorFor(nav));
    trySample("h2");

    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      summary: summary,
      candidates: candidates.slice(0, 14),
      samples: samples.slice(0, 6),
    };
  }

  // Apply Gemini's structured change spec with safe DOM APIs, after validating
  // it: invalid selectors are skipped, and `styles` declarations are filtered
  // against ALLOWED_PROPERTIES so risky layout properties never get applied
  // even if the model returns them. No strings are evaluated as JavaScript, so
  // this works even under strict page CSPs. Returns { changed, warnings }.
  function applyAiSpec(spec) {
    if (!spec || typeof spec !== "object") {
      throw new Error("Gemini returned an unexpected response.");
    }

    const warnings = [];
    if (Array.isArray(spec.warnings)) {
      spec.warnings.forEach((w) => {
        if (w) warnings.push(String(w));
      });
    }

    // Resolve a selector, noting any the browser rejects rather than aborting.
    const select = (selector) => {
      try {
        return document.querySelectorAll(selector);
      } catch (e) {
        warnings.push("Skipped invalid selector: " + selector);
        return [];
      }
    };

    let changed = 0;

    (spec.styles || []).forEach((rule) => {
      if (!rule || !rule.selector || !Array.isArray(rule.declarations)) return;
      select(rule.selector).forEach((el) => {
        if (isOwnNode(el)) return; // never restyle our own toolbar
        rule.declarations.forEach((d) => {
          if (!d || !d.property || d.value == null) return;
          const prop = String(d.property).toLowerCase().trim();
          if (!ALLOWED_PROPERTIES.has(prop)) {
            warnings.push("Skipped property not on the allow-list: " + prop);
            return;
          }
          try {
            el.style.setProperty(prop, String(d.value), "important");
            changed++;
          } catch (e) {
            /* ignore unsupported value */
          }
        });
      });
    });

    (spec.operations || []).forEach((op) => {
      if (!op || !op.action || !op.selector) return;
      select(op.selector).forEach((el) => {
        if (isOwnNode(el)) return;
        switch (op.action) {
          case "hide":
            el.style.setProperty("display", "none", "important");
            break;
          case "show":
            el.style.setProperty("display", "revert", "important");
            break;
          case "remove":
            el.remove();
            break;
          case "setText":
            el.textContent = op.value || "";
            break;
          case "addClass":
            if (op.value) el.classList.add(op.value);
            break;
          case "removeClass":
            if (op.value) el.classList.remove(op.value);
            break;
          case "setAttribute":
            if (op.attribute) el.setAttribute(op.attribute, op.value || "");
            break;
          default:
            return;
        }
        changed++;
      });
    });

    return { changed: changed, warnings: warnings };
  }

  async function runAi() {
    if (!window.__a11yGemini) {
      setAiStatus("Gemini client failed to load.", "error");
      return;
    }
    const requirement = (aiInput.value || "").trim();
    if (!requirement) {
      setAiStatus("Describe what you'd like to change.", "error");
      aiInput.focus();
      return;
    }

    const model = aiModelSelect.value;
    const cfg = await loadGeminiCfg();
    const apiKey = (cfg.apiKey || "").trim();
    if (!apiKey) {
      setAiStatus(
        "Add your Gemini API key in the extension popup (toolbar icon) first.",
        "error"
      );
      return;
    }
    cfg.model = model; // remember the model choice
    saveGeminiCfg(cfg);

    setAiStatus("Asking Gemini…", "busy");
    aiApplyBtn.disabled = true;
    try {
      const spec = await window.__a11yGemini.generate({
        apiKey,
        model,
        requirement,
        context: buildPageSnapshot(),
      });
      const { changed, warnings } = applyAiSpec(spec);
      if (warnings.length) {
        // Surfaced for debugging; the status line stays user-friendly.
        console.warn("[a11y AI] " + warnings.length + " warning(s):", warnings);
      }
      const skipped = warnings.length
        ? " " + warnings.length + " item(s) skipped (see console)."
        : "";
      if (changed === 0) {
        setAiStatus(
          "No changes were applied." + skipped,
          "error"
        );
      } else {
        aiChangesApplied = true; // let "Reset all" reload to a clean page
        setAiStatus(
          "Applied changes to " +
            changed +
            (changed === 1 ? " element." : " elements.") +
            skipped +
            ' Use "Reset all" to restore the original page.',
          "ok"
        );
      }
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
    handleEl.appendChild(brandMark());
    handleEl.appendChild(document.createTextNode("Accessibility"));
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
    // The handle's base CSS sets `display: inline-flex !important` (to lay out
    // the Q-mark + label), so toggling visibility needs an !important inline
    // style to win - otherwise the handle stays visible and overlaps the bar.
    if (handleEl) {
      handleEl.style.setProperty(
        "display",
        state.hidden ? "inline-flex" : "none",
        "important"
      );
    }
    if (state.hidden) toggleAiPanel(false); // hide the floating box with the bar
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
    if (!isCurrent()) return;
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
      if (!isCurrent()) {
        observer.disconnect(); // a newer instance has taken over
        return;
      }
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
    chrome.runtime.onMessage.addListener((msg) => {
      if (!isCurrent()) return; // only the newest instance handles popup actions
      if (msg?.type === "a11y-show") setHidden(false);
      else if (msg?.type === "a11y-reset") resetAll();
    });
  }

  // --- Init ------------------------------------------------------------------

  async function init() {
    removeExistingUI(); // drop any toolbar from a previous/older instance
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
