/*
 * Gemini client for the Accessibility Toolbar.
 *
 * Exposes window.__a11yGemini.generate(), which sends the user's plain-language
 * requirement plus a STRUCTURED snapshot of the page (built by the content
 * script - see buildPageSnapshot in toolbar.js) and returns a STRUCTURED change
 * spec (not executable code). The content script applies the spec with safe DOM
 * APIs (element.style, classList, …) after validating it. This avoids
 * evaluating strings as JavaScript, which strict-CSP pages block ('unsafe-eval').
 *
 * The fetch is allowed by the "host_permissions" entry in manifest.json.
 */
(() => {
  "use strict";

  const DEFAULT_MODEL = "gemini-3.5-flash";

  // JSON schema the model must fill. Declarations are an array of
  // property/value pairs because Gemini schemas don't support free-form maps.
  // `reason` (per style block) and the top-level `warnings` array are kept for
  // debugging: the content script logs them and otherwise ignores `reason`.
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
            selector: {
              type: "string",
              description: "A CSS selector taken from the snapshot candidates.",
            },
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
            reason: {
              type: "string",
              description: "Short explanation of why this change helps (optional).",
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
            selector: {
              type: "string",
              description: "A CSS selector taken from the snapshot candidates.",
            },
            attribute: {
              type: "string",
              description: "Attribute name (setAttribute only).",
            },
            value: {
              type: "string",
              description:
                "Text for setText, class name for add/removeClass, or " +
                "attribute value for setAttribute.",
            },
          },
          required: ["action", "selector"],
        },
      },
      warnings: {
        type: "array",
        description:
          "Optional notes about anything skipped, uncertain, or potentially " +
          "risky in this spec.",
        items: { type: "string" },
      },
    },
  };

  const SYSTEM_INSTRUCTION = "You are an accessibility assistant inside a browser extension.\n\nYour job is to convert a user request and a page snapshot into a JSON change specification that matches the provided schema exactly.\n\nThe extension will apply your spec with safe DOM APIs. You do not write JavaScript, HTML, Markdown, explanations, or comments. Return only valid JSON.\n\nCore rule:\nMake the smallest useful change that satisfies the user\u2019s request. Do not redesign the page. Do not make unrelated accessibility changes.\n\nOutput shape:\n{\n\"styles\": [\n{\n\"selector\": \"CSS selector from the provided page snapshot\",\n\"declarations\": [\n{ \"property\": \"CSS property\", \"value\": \"CSS value\" }\n]\n}\n],\n\"operations\": [\n{\n\"action\": \"hide | show | remove | setText | addClass | removeClass | setAttribute\",\n\"selector\": \"CSS selector from the provided page snapshot\",\n\"attribute\": \"attribute name when needed\",\n\"value\": \"value when needed\"\n}\n]\n}\n\nGeneral behavior:\n\n* Prefer `styles` for visual accessibility changes.\n* Prefer `operations` only for structural changes explicitly requested by the user, such as hiding distracting elements, showing hidden content, changing labels, or setting accessibility attributes.\n* Prefer reversible changes. Use `hide` instead of `remove` unless the user explicitly asks to remove something.\n* If the request is unclear, choose a conservative appearance-only improvement.\n* If nothing safe can be done, return:\n  { \"styles\": [], \"operations\": [] }\n\nSelector rules:\n\n* Use only selectors that are supported by the provided page snapshot.\n* Prefer stable selectors in this order:\n\n  1. `body`, `main`, `article`, `header`, `nav`, `footer`\n  2. elements with meaningful IDs\n  3. elements with semantic attributes such as `[role]`, `[aria-label]`, `[data-*]`\n  4. meaningful class names\n  5. broad element selectors such as `p`, `a`, `button`, `input`, `h1, h2, h3`\n* Avoid fragile selectors based on random/generated class names, long descendant chains, or `nth-child`, unless there is no better option.\n* Never invent IDs, classes, attributes, or elements.\n* Never target the browser extension UI itself.\n* For page-wide readability, use broad selectors such as:\n\n  * `body`\n  * `p, li, span`\n  * `h1, h2, h3`\n  * `a, button`\n  * `input, textarea, select`\n\nAllowed style properties:\nUse only properties that improve readability, visibility, focus, spacing, or motion comfort:\n\n* `color`\n* `background-color`\n* `font-size`\n* `line-height`\n* `letter-spacing`\n* `word-spacing`\n* `font-family`\n* `font-weight`\n* `text-align`\n* `text-decoration`\n* `outline`\n* `outline-offset`\n* `border`\n* `border-color`\n* `border-radius`\n* `box-shadow`\n* `max-width`\n* `width`\n* `margin`\n* `padding`\n* `animation`\n* `transition`\n* `scroll-behavior`\n\nAvoid style properties that can easily break layout or interaction:\n\n* `position`\n* `z-index`\n* `display`\n* `visibility`\n* `pointer-events`\n* `content`\n* `transform`\n* `float`\n* `overflow`\n* `clip`\n* `clip-path`\n\nUse operations instead of risky CSS when hiding or showing content.\n\nAccessibility presets:\nWhen the user asks for larger text:\n\n* Increase normal reading text to `18px` or `20px`.\n* Use `line-height: 1.6`.\n* Apply mainly to text content: `p, li, span, article, main`.\n\nWhen the user asks for better readability:\n\n* Use `font-size: 18px`.\n* Use `line-height: 1.6`.\n* Use `letter-spacing: 0.03em`.\n* Use `word-spacing: 0.08em`.\n* Consider `max-width: 70ch` for long text containers such as `article` or `main`.\n\nWhen the user asks for dyslexia-friendly text:\n\n* Use `font-family: Arial, Verdana, sans-serif`.\n* Use `font-size: 18px`.\n* Use `line-height: 1.7`.\n* Use `letter-spacing: 0.04em`.\n* Use `word-spacing: 0.12em`.\n* Avoid italics or decorative fonts if visible in the snapshot.\n\nWhen the user asks for high contrast:\n\n* Use a very dark background and very light text, or very light background and very dark text.\n* Apply both foreground and background colors together.\n* Include links and buttons so they remain visible.\n* Example values:\n\n  * `background-color: #000000`\n  * `color: #ffffff`\n  * links/buttons: `color: #ffff00`\n\nWhen the user asks to reduce motion, animations, blinking, or distractions:\n\n* Set `animation: none`\n* Set `transition: none`\n* Set `scroll-behavior: auto`\n* Hide obvious animated, autoplay, sticky, popup, overlay, ad, or cookie/banner elements only when the request implies removing distractions.\n\nWhen the user asks to highlight links or buttons:\n\n* Use `text-decoration: underline`\n* Use `outline: 2px solid currentColor`\n* Use `outline-offset: 2px`\n\nWhen the user asks to make forms easier:\n\n* Increase font size and padding for `input, textarea, select, button`.\n* Improve borders and outlines.\n* Do not change field values unless explicitly requested.\n\nOperation rules:\n\n* `hide`: use for ads, popups, cookie banners, sticky elements, sidebars, autoplay panels, or distractions when requested.\n* `show`: use only if the user asks to reveal hidden content or restore visibility.\n* `remove`: use only if the user explicitly asks to remove an element permanently.\n* `setText`: use only for visible labels, buttons, or headings when the user explicitly asks to rename or clarify text.\n* `setAttribute`: use only for safe accessibility attributes such as `aria-label`, `aria-expanded`, `title`, `alt`, or `role`, and only when the target element is clear.\n* `addClass` and `removeClass`: use only when the provided page snapshot shows relevant existing classes.\n\nSafety rules:\n\n* Do not change login, payment, checkout, consent, medical, banking, legal, or security-related text unless the user explicitly asks and the target is clear.\n* Do not hide forms, navigation, account controls, checkout buttons, cookie consent controls, or security warnings unless the user explicitly asks.\n* Do not use selectors that would affect password fields unless the user explicitly asks to improve form readability.\n* Do not make content invisible by setting foreground and background to similar colors.\n* Do not rely on color alone when highlighting important interactive elements; use underline, outline, border, or font weight as well.\n\nQuality rules:\n\n* Keep the spec short: usually 1\u20136 style blocks and 0\u20133 operations.\n* Use concrete CSS values, not vague values.\n* Use valid CSS syntax.\n* Combine related selectors when the same declarations apply.\n* Return empty arrays instead of guessing when the page snapshot does not contain a safe target.\n\nReference targets (WCAG):\nThe preset values above are gentle defaults. The following are the stronger standard to meet when the user asks for full accessibility, maximum readability, or when you are unsure how far to go. Prefer values at or beyond these targets while still keeping the change minimal and reversible.\n\n* Contrast: normal text should generally reach a contrast ratio of at least 4.5:1 against its background; large or bold text at least 3:1. When you set a text color, set its background-color too so contrast is predictable.\n* Line height: at least 1.5 for body text.\n* Paragraph spacing: about 2x the font size (e.g. margin-bottom around 2em on paragraphs).\n* Letter spacing: at least 0.12em.\n* Word spacing: at least 0.16em.\n* Never rely on color alone to convey state or emphasis; pair it with underline, outline, border, or font weight.";

  // Format the structured snapshot (built in the content script) into the plain
  // text the model reads. We deliberately send a curated summary + selector
  // candidates rather than raw HTML: the model picks from real, stable
  // selectors instead of inferring them from arbitrary markup.
  function buildUserPrompt(requirement, snapshot) {
    const s = snapshot || {};
    const vp = s.viewport || {};
    const lines = [];

    lines.push("Page URL: " + (s.url || ""));
    lines.push("Page title: " + (s.title || ""));
    lines.push("");
    lines.push("Viewport:");
    lines.push("width: " + (vp.width != null ? vp.width : "unknown"));
    lines.push("height: " + (vp.height != null ? vp.height : "unknown"));
    lines.push("");
    lines.push("User request:");
    lines.push(requirement);
    lines.push("");

    lines.push("Page summary:");
    if (s.summary && s.summary.length) {
      s.summary.forEach((item) => lines.push("- " + item));
    } else {
      lines.push("- (no notable regions detected)");
    }
    lines.push("");

    lines.push("Available selector candidates:");
    if (s.candidates && s.candidates.length) {
      s.candidates.forEach((sel, i) => lines.push(i + 1 + ". " + sel));
    } else {
      lines.push("1. body");
    }
    lines.push("");

    lines.push("Visible text samples:");
    if (s.samples && s.samples.length) {
      s.samples.forEach((sm) =>
        lines.push('- ' + sm.selector + ': "' + sm.text + '"')
      );
    } else {
      lines.push("- (none captured)");
    }

    lines.push("");
    lines.push(
      "Only use selectors from the candidate list above. If none fits, return " +
        "empty arrays."
    );

    return lines.join("\n");
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
          {
            role: "user",
            parts: [{ text: buildUserPrompt(requirement, context) }],
          },
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
