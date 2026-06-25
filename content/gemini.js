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

  const DEFAULT_MODEL = "gemini-2.5-flash";
  const MAX_HTML = 6000; // characters of page HTML sent as context

  function endpoint(model, apiKey) {
    return (
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model || DEFAULT_MODEL) +
      ":generateContent?key=" +
      encodeURIComponent(apiKey)
    );
  }

  function buildPrompt(requirement, context) {
    return [
      "You are a DOM-manipulation assistant embedded in a browser extension.",
      "Generate JavaScript that, when executed in the context of the current",
      "web page, applies the user's requested changes by manipulating the live",
      "DOM (document, document.body, document.querySelectorAll, etc.).",
      "",
      "Strict rules:",
      "- Output ONLY raw JavaScript. No markdown, no code fences, no comments,",
      "  no explanations.",
      "- Do NOT use import/export, top-level return, fetch, XMLHttpRequest, or",
      "  any network request. Do NOT navigate or reload the page.",
      "- For styling changes, create or reuse a single",
      '  <style id="a11y-ai-style"> element appended to <head> and put your CSS',
      "  there, so the changes can be cleanly removed later.",
      "- For structural changes, edit the DOM directly.",
      "- Make the code idempotent: safe to run more than once without",
      "  duplicating elements.",
      "- Do not touch elements with ids starting with 'a11y-toolbar'.",
      "",
      "Page URL: " + context.url,
      "Page title: " + context.title,
      "",
      "Truncated page HTML for reference:",
      context.html,
      "",
      "User requirement:",
      requirement,
    ].join("\n");
  }

  function stripFences(text) {
    let t = (text || "").trim();
    const fenced = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
    if (fenced) return fenced[1].trim();
    // Defensive: strip stray leading/trailing fences if the regex above missed.
    t = t.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```$/, "");
    return t.trim();
  }

  async function generate({ apiKey, model, requirement, context }) {
    const res = await fetch(endpoint(model, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildPrompt(requirement, context) }],
          },
        ],
        generationConfig: { temperature: 0.2 },
      }),
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = (body && body.error && body.error.message) || "";
      } catch (e) {
        /* ignore */
      }
      if (res.status === 400 || res.status === 403) {
        detail = detail || "check that your API key is valid.";
      }
      throw new Error(
        "Gemini API error " + res.status + (detail ? ": " + detail : "")
      );
    }

    const data = await res.json();
    const parts =
      (data &&
        data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts) ||
      [];
    const text = parts.map((p) => p.text || "").join("");
    return stripFences(text);
  }

  window.__a11yGemini = { generate, DEFAULT_MODEL, MAX_HTML };
})();
