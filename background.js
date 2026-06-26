/*
 * Background service worker.
 *
 * When the extension is installed or updated, content scripts declared in the
 * manifest only run on pages loaded AFTER that point — already-open tabs keep
 * running the previously injected (now stale) version. To avoid showing an old
 * toolbar on some tabs and the new one on others, we re-inject the current
 * scripts/styles into every open http(s) tab on install and update. The content
 * script removes any existing toolbar and takes over via its version token.
 */
chrome.runtime.onInstalled.addListener(() => {
  reinjectAllTabs();
});

async function reinjectAllTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }

  for (const tab of tabs) {
    if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) continue;
    const target = { tabId: tab.id };
    try {
      await chrome.scripting.insertCSS({ target, files: ["content/toolbar.css"] });
      await chrome.scripting.executeScript({
        target,
        files: ["content/gemini.js", "content/toolbar.js"],
      });
    } catch (e) {
      // Some tabs (e.g. the Web Store, PDF viewer, blocked origins) can't be
      // injected into; skip them silently.
    }
  }
}
