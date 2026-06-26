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
  const keyStatusEl = document.getElementById("key-status");

  function keyStatus(text) {
    keyStatusEl.textContent = text;
    setTimeout(() => {
      keyStatusEl.textContent = "";
    }, 1800);
  }

  // Pre-fill the saved key (if any) so it can be reviewed or replaced.
  chrome.storage.local.get(GEMINI_STORE, (res) => {
    const cfg = (res && res[GEMINI_STORE]) || {};
    if (cfg.apiKey) keyInput.value = cfg.apiKey;
  });

  document.getElementById("save-key").addEventListener("click", () => {
    const apiKey = keyInput.value.trim();
    // Merge into the existing config so the model choice is preserved.
    chrome.storage.local.get(GEMINI_STORE, (res) => {
      const cfg = (res && res[GEMINI_STORE]) || {};
      cfg.apiKey = apiKey;
      chrome.storage.local.set({ [GEMINI_STORE]: cfg }, () => {
        keyStatus(apiKey ? "API key saved." : "API key cleared.");
      });
    });
  });
})();
