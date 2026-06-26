/*
 * Gemini client for the Accessibility Toolbar.
 *
 * Exposes window.__a11yGemini.generate(), which sends the user's plain-language
 * requirement plus a snapshot of the page to the Gemini API and returns a
 * STRUCTURED change spec (not executable code). The content script applies the
 * spec with safe DOM APIs (element.style, classList, …). This avoids evaluating
 * strings as JavaScript, which strict-CSP pages block ('unsafe-eval').
 *
 * The fetch is allowed by the "host_permissions" entry in manifest.json.
 */
(() => {
  "use strict";

  const DEFAULT_MODEL = "gemini-3.5-flash";
  const MAX_HTML = 6000; // characters of page HTML sent as context

  // JSON schema the model must fill. Declarations are an array of
  // property/value pairs because Gemini schemas don't support free-form maps.
  const RESPONSE_SCHEMA = {
    type: "object",
    properties: {
      styles: {
        type: "array",
        description:
          "Style rules; each applies its declarations as inline styles to " +
          "every element matching the CSS selector.",
        items: {
          type: "object",
          properties: {
            selector: { type: "string", description: "A CSS selector." },
            declarations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  property: {
                    type: "string",
                    description: "CSS property, e.g. background-color.",
                  },
                  value: {
                    type: "string",
                    description: "CSS value, e.g. #111111 or 20px.",
                  },
                },
                required: ["property", "value"],
              },
            },
          },
          required: ["selector", "declarations"],
        },
      },
      operations: {
        type: "array",
        description: "Structural DOM changes applied to matching elements.",
        items: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "hide",
                "show",
                "remove",
                "setText",
                "addClass",
                "removeClass",
                "setAttribute",
              ],
            },
            selector: { type: "string", description: "A CSS selector." },
            value: {
              type: "string",
              description:
                "Text for setText, class name for add/removeClass, or " +
                "attribute value for setAttribute.",
            },
            name: {
              type: "string",
              description: "Attribute name (setAttribute only).",
            },
          },
          required: ["action", "selector"],
        },
      },
    },
  };

  const SYSTEM_INSTRUCTION = [
    "You are an accessibility assistant for a browser extension. Given a web",
    "page and a user request, you return a JSON change spec (matching the",
    "provided schema) describing how to make the page easier to use. The",
    "extension applies it with safe DOM APIs — you do NOT write code.",
    "",
    "Guidance:",
    "- Prefer `styles` for appearance: background/text colour and contrast,",
    "  font-size, line-height, letter/word spacing, max-width, etc.",
    "- Target real selectors based on the provided HTML. Use broad selectors",
    '  like "body", "p, li, span", "h1, h2, h3" when appropriate.',
    "- Provide concrete CSS values (e.g. font-size: 20px, line-height: 1.8).",
    "  The extension applies every declaration with high priority.",
    "- Use `operations` for structural changes: hide/remove distracting",
    "  elements, setText, add/removeClass, setAttribute (e.g. alt text).",
    "- Only include changes the user asked for. Return empty arrays if there is",
    "  nothing to do.",
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
      "User request:",
      requirement,
    ].join("\n");
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
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
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
    const text = parts.map((p) => p.text || "").join("").trim();
    if (!text) throw new Error("Gemini returned an empty response.");
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("Gemini returned malformed JSON.");
    }
  }

  window.__a11yGemini = { generate, DEFAULT_MODEL };
})();
