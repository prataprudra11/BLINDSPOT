// vision/vision-trigger.js - DOM-First Vision Trigger Logic
// Ensures vision/OCR ONLY runs as a fallback for elements the DOM cannot explain.

(function (global) {
  const isNode = typeof module !== "undefined" && module.exports;

  // Explainable keywords indicating an image may contain identity documents or sensitive credentials
  const PII_IMAGE_KEYWORDS = [
    "id card",
    "id_card",
    "identity",
    "license",
    "driving license",
    "passport",
    "aadhaar",
    "pan card",
    "pan_card",
    "document",
    "screenshot",
    "cheque",
    "passbook",
    "bank statement",
    "tax id",
    "ssn",
    "kyc",
    "verification doc",
    "id proof"
  ];

  const PII_KEYWORD_REGEX = new RegExp(
    `\\b(${PII_IMAGE_KEYWORDS.map(k => k.replace(/[\s-_]+/g, "[\\s-_]+")).join("|")})\\b`,
    "i"
  );

  const DECORATIVE_TOKENS = ["logo", "icon", "banner", "avatar", "placeholder", "badge", "decoration"];

  /**
   * Determines whether OCR / visual inspection should be triggered for a given element.
   * Strictly adheres to the "DOM-first, vision-fallback" principle.
   * 
   * @param {Object} el - Extracted element record or DOM node
   * @param {Object} [domContext] - Optional full page context or parent text
   * @returns {{ trigger: boolean, reason: string, categoryHint?: string }}
   */
  function shouldTriggerVision(el, domContext = {}) {
    if (!el) {
      return { trigger: false, reason: "Invalid element record." };
    }

    const tag = (el.tag || el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();

    // 1. Canvas Elements: Always trigger because canvas pixel buffers cannot be explained by DOM text
    if (tag === "canvas" || type === "canvas") {
      return {
        trigger: true,
        reason: "Canvas element: programmatic pixel buffer cannot be explained by DOM text.",
        categoryHint: "canvas_document"
      };
    }

    // 2. Image Elements
    if (tag === "img" || type === "image") {
      const alt = (el.alt || el.getAttribute?.("alt") || "").trim();
      const ariaLabel = (el.label || el["aria-label"] || el.getAttribute?.("aria-label") || "").trim();
      const role = (el.getAttribute?.("role") || "").toLowerCase();
      const className = (el.className || el.getAttribute?.("class") || "").toLowerCase();
      const surroundingText = (el.surroundingText || el.text || "").trim();

      // Check for explicit decorative roles
      if (role === "presentation" || role === "none" || el["aria-hidden"] === "true") {
        return {
          trigger: false,
          reason: "Image marked as explicitly decorative (aria-hidden or role=presentation)."
        };
      }

      // Check metadata text against PII keywords
      const combinedContext = `${alt} ${ariaLabel} ${surroundingText} ${el.name || ""} ${className}`.toLowerCase();
      const match = combinedContext.match(PII_KEYWORD_REGEX);

      if (match) {
        return {
          trigger: true,
          reason: `Image context matches PII keyword heuristic: '${match[0]}'.`,
          categoryHint: "id_document"
        };
      }

      // Check if image is obviously decorative
      const isDecorative = DECORATIVE_TOKENS.some(token => combinedContext.includes(token));
      if (isDecorative) {
        return {
          trigger: false,
          reason: `Plain decorative image detected ('${alt || className}'): skipped to preserve compute.`
        };
      }

      // Images lacking any alt or label in sensitive forms
      if (!alt && !ariaLabel) {
        const isFormPage = domContext.isForm || (typeof window !== "undefined" && !!document.querySelector("form"));
        if (isFormPage) {
          return {
            trigger: true,
            reason: "Image lacks alt/aria description inside a verification form.",
            categoryHint: "unlabeled_image"
          };
        }
      }

      return {
        trigger: false,
        reason: `Image does not match PII context criteria (alt='${alt || "none"}').`
      };
    }

    // 3. All other elements (input, button, p, h1, etc.) stay DOM-only
    return {
      trigger: false,
      reason: `Element <${tag}> is fully explainable via DOM text.`
    };
  }

  /**
   * Logs vision trigger evaluation for audit and demo transparency.
   */
  function logTriggerDecision(elId, decision) {
    const icon = decision.trigger ? "👁️ [Vision Trigger: ON]" : "⏭️ [Vision Trigger: SKIPPED]";
    console.log(`${icon} Element ${elId}: ${decision.reason}`);
  }

  const VisionTrigger = {
    shouldTriggerVision,
    logTriggerDecision,
    PII_IMAGE_KEYWORDS,
    PII_KEYWORD_REGEX
  };

  if (isNode) {
    module.exports = VisionTrigger;
  }
  if (typeof window !== "undefined") {
    window.VisionTrigger = VisionTrigger;
  }
  if (global) {
    global.VisionTrigger = VisionTrigger;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
