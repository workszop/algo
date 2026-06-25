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
})();
