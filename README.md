# Accessibility Toolbar — Chrome Extension

A Chrome extension (Manifest V3) that injects a toolbar at the top of every
website, giving readers quick controls to make pages easier to read.

## Features

The toolbar appears fixed at the top of the page with buttons to:

- **A− / A+** — decrease / increase the font size of all text (10% steps).
- **Reset text** — restore the original font size.
- **Line− / Line+** — decrease / increase line spacing.
- **Readable font** — switch to a clearer, more legible (dyslexia-friendly) font.
- **High contrast** — boost page contrast and saturation.
- **Dark mode** — invert the page colors for a dark theme (images/videos are
  kept un-inverted).
- **Reset all** — undo every change on the page.
- **✕** — hide the toolbar (a small "♿ Accessibility" handle stays in the
  top-right corner so you can bring it back).

Settings are saved **per website** (via `chrome.storage.local`) and
automatically re-applied the next time you visit. Font scaling also applies to
content that loads dynamically (infinite scroll, single-page apps).

A small **popup** (click the extension icon) lets you re-show the toolbar or
reset the current page.

## How font scaling works

Each element's original font size and line height are remembered the first time
they're seen, so repeated `A+`/`A−` clicks always scale from the original value
instead of compounding. Setting the scale back to 100% removes the inline
overrides entirely.

## Installation (load unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium-based browser).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder.
4. The "Accessibility Toolbar" icon appears in the toolbar, and the bar shows
   at the top of pages you visit.

## Project structure

```
manifest.json          Extension manifest (MV3)
content/
  toolbar.js           Injected toolbar UI + page-adjustment logic
  toolbar.css          Toolbar and page-effect styles
popup/
  popup.html/.css/.js  Extension popup (show / reset)
icons/                 Extension icons (16/48/128 px)
```

## Notes

- Content scripts can't run on browser-internal pages (`chrome://`, the Chrome
  Web Store, etc.), so the toolbar won't appear there.
- Dark mode and high contrast use CSS `filter`, which applies to the whole page;
  media elements are re-inverted so photos and videos still look correct.
