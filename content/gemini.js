/*
 * Gemini client for the Accessibility Toolbar.
 *
 * Exposes window.__a11yGemini.generate(), which sends the user's plain-language
 * requirement plus a snapshot of the page to the Gemini API and returns raw
 * JavaScript that, when executed on the page, applies the requested changes.
 *
 * The fetch is allowed by the "host_permissions" entry for
 * generativelanguage.googleapis.com in manifest.json.
 */
(() => {
  "use strict";

  const DEFAULT_MODEL = "gemini-3.5-flash";
  const MAX_HTML = 6000; // characters of page HTML sent as context

  // Behaviour rules sent once as the system instruction, separate from the
  // per-request user prompt below.
  const SYSTEM_INSTRUCTION = [
    "You are a DOM-manipulation assistant embedded in a browser extension.",
    "Generate JavaScript that, when executed on the current web page, applies",
    "the user's requested changes by manipulating the live DOM (document,",
    "document.body, document.querySelectorAll, etc.).",
    "",
    "Rules:",
    "- Output ONLY raw JavaScript: no markdown, no code fences, no comments,",
    "  no explanations.",
    "- Never use import/export, top-level return, fetch, XMLHttpRequest or any",
    "  network request, and never navigate or reload the page.",
    '- Put styling in a single reusable <style id="a11y-ai-style"> element',
    "  appended to <head>, so the changes can be cleanly removed later.",
    "- Edit the DOM directly for structural changes.",
    "- Make all code idempotent: safe to run more than once without duplicating",
    "  elements.",
    '- Never touch elements whose id starts with "a11y-toolbar".',
  ].join("\n");

  function buildUserPrompt(requirement, { url, title, html }) {
    const snippet =
      html.length > MAX_HTML
        ? html.slice(0, MAX_HTML) + "\n<!-- …truncated… -->"
        : html;
    return [
      "Page URL: " + url,
      "Page title: " + title,
      "",
      "Truncated page HTML for reference:",
      snippet,
      "",
      "User requirement:",
      requirement,
    ].join("\n");
  }

  // Gemini is asked for raw JS, but strip code fences defensively in case it
  // wraps the output in ```js … ``` anyway.
  function stripFences(text) {
    const t = (text || "").trim();
    const fenced = t.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
    return (fenced ? fenced[1] : t).trim();
  }

  async function generate({ apiKey, model, requirement, context }) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model || DEFAULT_MODEL) +
      ":generateContent";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [
          { role: "user", parts: [{ text: buildUserPrompt(requirement, context) }] },
        ],
        generationConfig: { temperature: 0.2 },
      }),
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.error?.message || "";
      } catch (e) {
        /* response body wasn't JSON; ignore */
      }
      if (!detail && (res.status === 400 || res.status === 403)) {
        detail = "check that your API key is valid";
      }
      throw new Error(
        "Gemini API error " + res.status + (detail ? ": " + detail : "")
      );
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return stripFences(parts.map((p) => p.text || "").join(""));
  }

  window.__a11yGemini = { generate, DEFAULT_MODEL };
})();
