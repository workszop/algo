/* Popup logic: sends messages to the active tab's content script. */
(() => {
  "use strict";

  const statusEl = document.getElementById("status");

  function flash(text) {
    statusEl.textContent = text;
    setTimeout(() => {
      statusEl.textContent = "";
    }, 1800);
  }

  function sendToActiveTab(message, onDone) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        flash("No active tab.");
        return;
      }
      chrome.tabs.sendMessage(tab.id, message, () => {
        // chrome.runtime.lastError fires on pages where content scripts can't
        // run (e.g. chrome:// pages, the Web Store). Surface it gracefully.
        if (chrome.runtime.lastError) {
          flash("Toolbar isn't available on this page.");
        } else if (onDone) {
          onDone();
        }
      });
    });
  }

  document.getElementById("show").addEventListener("click", () => {
    sendToActiveTab({ type: "a11y-show" }, () => flash("Toolbar shown."));
  });

  document.getElementById("reset").addEventListener("click", () => {
    sendToActiveTab({ type: "a11y-reset" }, () => flash("Page reset."));
  });

  // --- Gemini API key ---------------------------------------------------------

  const GEMINI_STORE = "a11y:gemini"; // shared with the content script
  const keyInput = document.getElementById("api-key");
  const saveBtn = document.getElementById("save-key");
  const keyStatusEl = document.getElementById("key-status");
  let keyStatusTimer = null;

  function keyStatus(text, isError, persist) {
    if (keyStatusTimer) clearTimeout(keyStatusTimer);
    keyStatusEl.textContent = text;
    keyStatusEl.classList.toggle("error", !!isError);
    if (!persist) {
      keyStatusTimer = setTimeout(() => {
        keyStatusEl.textContent = "";
        keyStatusEl.classList.remove("error");
      }, 2500);
    }
  }

  // Verify the key by hitting the lightweight ListModels endpoint (no quota
  // cost). 200 = valid; 400/403 = bad key; anything else = couldn't verify.
  async function validateKey(apiKey) {
    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { headers: { "x-goog-api-key": apiKey } }
      );
      if (res.ok) return { ok: true };
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return { ok: false, message: "Invalid API key." };
      }
      return { ok: false, message: "Couldn't verify key (error " + res.status + ")." };
    } catch (e) {
      return { ok: false, message: "Network error while verifying key." };
    }
  }

  function storeKey(apiKey, message) {
    // Merge into the existing config so the model choice is preserved.
    chrome.storage.local.get(GEMINI_STORE, (res) => {
      const cfg = (res && res[GEMINI_STORE]) || {};
      cfg.apiKey = apiKey;
      chrome.storage.local.set({ [GEMINI_STORE]: cfg }, () => keyStatus(message));
    });
  }

  // Pre-fill the saved key (if any) so it can be reviewed or replaced.
  chrome.storage.local.get(GEMINI_STORE, (res) => {
    const cfg = (res && res[GEMINI_STORE]) || {};
    if (cfg.apiKey) keyInput.value = cfg.apiKey;
  });

  saveBtn.addEventListener("click", async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      storeKey("", "API key cleared."); // allow clearing without a check
      return;
    }
    saveBtn.disabled = true;
    keyStatus("Checking key…", false, true);
    const result = await validateKey(apiKey);
    saveBtn.disabled = false;
    if (result.ok) {
      storeKey(apiKey, "API key saved.");
    } else {
      keyStatus(result.message, true); // reject: don't store an invalid key
    }
  });
})();
