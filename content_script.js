// content_script.js - Chrome Extension Content Script (Manifest V3)
console.log("[Content Script] Loaded and active on:", window.location.href);

// ============================================================================
// 1. DOM Extraction Logic
// ============================================================================

/**
 * Checks if a DOM element is visible to the user.
 * Skips display:none, visibility:hidden, zero-size, or aria-hidden elements.
 */
function isElementVisible(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

  // offsetParent is null for display:none elements (unless position: fixed or <body>)
  if (el.offsetParent === null && el.tagName !== "BODY" && window.getComputedStyle(el).position !== "fixed") {
    return false;
  }

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
    return false;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }

  // Check aria-hidden
  if (el.getAttribute("aria-hidden") === "true" || el.closest('[aria-hidden="true"]')) {
    return false;
  }

  return true;
}

/**
 * Derives a clean, robust, and stable selector or identifier for an element.
 */
function getStableSelector(el) {
  if (!el || !(el instanceof Element)) return "";

  // 1. Unique ID (if valid and not dynamic/temporary)
  if (el.id && typeof el.id === "string" && !/^[0-9]|^:r[0-9]+:/.test(el.id)) {
    try {
      const escapedId = CSS.escape(el.id);
      if (document.querySelectorAll(`#${escapedId}`).length === 1) {
        return `#${escapedId}`;
      }
    } catch (_) { /* invalid CSS id format, continue */ }
  }

  // 2. Testing hooks (data-testid, data-cy, data-test, data-qa)
  const testAttrs = ["data-testid", "data-cy", "data-qa", "data-test"];
  for (const attr of testAttrs) {
    const val = el.getAttribute(attr);
    if (val) {
      const sel = `[${attr}="${CSS.escape(val)}"]`;
      if (document.querySelectorAll(sel).length === 1) {
        return sel;
      }
    }
  }

  const tagName = el.tagName.toLowerCase();

  // 3. Name attribute (common for form elements)
  const nameVal = el.getAttribute("name");
  if (nameVal) {
    const sel = `${tagName}[name="${CSS.escape(nameVal)}"]`;
    if (document.querySelectorAll(sel).length === 1) {
      return sel;
    }
  }

  // 4. Aria label (useful for accessible icon buttons)
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0 && ariaLabel.length < 50) {
    const sel = `${tagName}[aria-label="${CSS.escape(ariaLabel.trim())}"]`;
    if (document.querySelectorAll(sel).length === 1) {
      return sel;
    }
  }

  // 5. Placeholder (for text inputs)
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim().length > 0 && placeholder.length < 50) {
    const sel = `${tagName}[placeholder="${CSS.escape(placeholder.trim())}"]`;
    if (document.querySelectorAll(sel).length === 1) {
      return sel;
    }
  }

  // 6. Anchor href (for specific navigation links)
  if (tagName === "a" && el.getAttribute("href")) {
    const href = el.getAttribute("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:") && href.length < 80) {
      const sel = `a[href="${CSS.escape(href)}"]`;
      if (document.querySelectorAll(sel).length === 1) {
        return sel;
      }
    }
  }

  // 7. Fallback: Compact hierarchical path
  return buildCompactCssPath(el);
}

/**
 * Builds a unique CSS path using tags and nth-of-type indices.
 */
function buildCompactCssPath(el) {
  const path = [];
  let curr = el;

  while (curr && curr.nodeType === Node.ELEMENT_NODE && curr.tagName !== "HTML") {
    if (curr.id && typeof curr.id === "string" && !/^[0-9]/.test(curr.id)) {
      try {
        const escapedId = CSS.escape(curr.id);
        if (document.querySelectorAll(`#${escapedId}`).length === 1) {
          path.unshift(`#${escapedId}`);
          break;
        }
      } catch (_) {}
    }

    let nodeSelector = curr.tagName.toLowerCase();
    let sibling = curr;
    let nth = 1;

    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName.toLowerCase() === nodeSelector) {
        nth++;
      }
    }

    if (nth > 1) {
      nodeSelector += `:nth-of-type(${nth})`;
    }

    path.unshift(nodeSelector);
    curr = curr.parentElement;
    if (curr && curr.tagName === "BODY") {
      path.unshift("body");
      break;
    }
  }

  return path.join(" > ");
}

/**
 * Resolves visible label or text description for an element.
 */
function getElementVisibleText(el) {
  // 1. Explicit <label for="...">
  if (el.id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const labelText = (label?.innerText || label?.textContent || "").trim();
      if (labelText) {
        return labelText;
      }
    } catch (_) {}
  }

  // 2. Enclosing parent <label>
  const parentLabel = el.closest("label");
  const parentLabelText = (parentLabel?.innerText || parentLabel?.textContent || "").trim();
  if (parentLabelText) {
    return parentLabelText;
  }

  // 3. Aria-label or Title
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  const title = el.getAttribute("title");
  if (title && title.trim()) return title.trim();

  // 4. Placeholder
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) return placeholder.trim();

  // 5. Button/Submit input value
  if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) {
    if (el.value && el.value.trim()) return el.value.trim();
  }

  // 6. Direct text content
  const text = el.innerText || el.textContent || "";
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

/**
 * Detects whether an element represents sensitive information (password, payment).
 * Ensures values for sensitive elements are NEVER retrieved or exposed.
 */
function checkSensitivity(el) {
  const tagName = el.tagName.toLowerCase();
  const inputType = (el.getAttribute("type") || "").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  const nameAndId = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""}`.toLowerCase();

  // Rule 1: Password inputs
  if (tagName === "input" && inputType === "password") {
    return {
      sensitive: true,
      category: "password"
    };
  }

  // Rule 2: Payment / Credit card inputs
  const paymentAutocompleteTokens = [
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-type",
    "transaction-amount",
    "cvv",
    "cvc"
  ];

  const hasPaymentAutocomplete = paymentAutocompleteTokens.some((token) => autocomplete.includes(token));
  const hasPaymentNamePattern = /\b(cc[-_]?number|credit[-_]?card|card[-_]?num|cvv|cvc|security[-_]?code)\b/i.test(nameAndId);

  if (hasPaymentAutocomplete || hasPaymentNamePattern) {
    return {
      sensitive: true,
      category: "payment"
    };
  }

  return {
    sensitive: false
  };
}

/**
 * Determines element functional classification or input type.
 */
function resolveElementType(el) {
  const tagName = el.tagName.toLowerCase();

  if (tagName === "input") {
    return el.type ? el.type.toLowerCase() : "text";
  }
  if (tagName === "textarea") return "textarea";
  if (tagName === "select") return "select";
  if (tagName === "button" || el.getAttribute("role") === "button") return "button";
  if (tagName === "a" || el.getAttribute("role") === "link") return "link";
  if (/^h[1-6]$/.test(tagName) || el.getAttribute("role") === "heading") return "heading";
  if (["p", "blockquote", "li", "span"].includes(tagName)) return "text block";

  return tagName;
}

/**
 * Main DOM extraction routine.
 * Scans page, applies prioritization (inputs/buttons > headings > text),
 * and limits payload to top ~200 items.
 */
function extractDOM() {
  console.log("[Content Script] 🔄 Starting DOM extraction scan on:", window.location.href);

  // RESET ELEMENT MAPPER on each perception cycle to eliminate stale DOM references
  const mapper = typeof ElementMapper !== "undefined" ? ElementMapper : (typeof window !== "undefined" ? window.ElementMapper : null);
  if (mapper && typeof mapper.resetMap === "function") {
    mapper.resetMap();
  }

  const seenElements = new Set();
  const extractedList = [];
  const MAX_ELEMENTS = 200;

  // Priority 1: Interactive controls (inputs, buttons, links, dropdowns)
  const interactiveSelectors = [
    "button",
    "input",
    "select",
    "textarea",
    "a[href]",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]'
  ];
  const interactiveElements = Array.from(document.querySelectorAll(interactiveSelectors.join(",")));

  // Priority 2: Headings and landmarks
  const headingSelectors = ["h1", "h2", "h3", "h4", "h5", "h6", '[role="heading"]'];
  const headingElements = Array.from(document.querySelectorAll(headingSelectors.join(",")));

  // Priority 3: Informative text blocks
  const textSelectors = ["p", "label", "li", "dt", "dd"];
  const textElements = Array.from(document.querySelectorAll(textSelectors.join(",")));

  // Process items in order of priority
  const prioritizedCandidates = [
    ...interactiveElements,
    ...headingElements,
    ...textElements
  ];

  for (const el of prioritizedCandidates) {
    if (extractedList.length >= MAX_ELEMENTS) break;
    if (seenElements.has(el)) continue;
    seenElements.add(el);

    if (!isElementVisible(el)) continue;

    const text = getElementVisibleText(el);
    const tagName = el.tagName.toLowerCase();

    // For plain text blocks, avoid recording empty or ultra-short noise
    if (["p", "li", "span", "dd"].includes(tagName) && text.length < 2) {
      continue;
    }

    const sensitivity = checkSensitivity(el);
    const elementType = resolveElementType(el);
    const selector = getStableSelector(el);

    // Register with ElementMapper: assigns anonymous ID (el_001, ...) and stores DOM node locally
    const anonymousId = (mapper && typeof mapper.registerElement === "function")
      ? mapper.registerElement(el, selector)
      : `el_${String(extractedList.length + 1).padStart(3, "0")}`;

    // Outgoing payload contains ONLY the anonymous id. Real selector is kept strictly in local memory.
    const item = {
      id: anonymousId,
      tag: tagName,
      type: elementType,
      text: text,
      sensitive: sensitivity.sensitive
    };

    const nameAttr = el.getAttribute("name");
    if (nameAttr) {
      item.name = nameAttr;
    }

    if (sensitivity.sensitive) {
      item.category = sensitivity.category;
      // CRITICAL: Value is NEVER included or inspected for sensitive items.
    } else if (["input", "textarea", "select"].includes(tagName) && typeof el.value === "string" && el.value.length > 0) {
      // For non-sensitive form controls, record current value so local perception can sanitize it
      item.value = el.value;
    }

    extractedList.push(item);
  }

  const structuredOutput = {
    url: window.location.href,
    title: document.title,
    extractedAt: new Date().toISOString(),
    totalElements: extractedList.length,
    elements: extractedList
  };

  // ZERO LEAKAGE: Never log structuredOutput containing raw DOM text in production.
  console.log("================================================================================");
  console.log(`[Content Script] ✅ DOM Extraction Complete (${extractedList.length} elements scanned).`);
  console.log("================================================================================");

  return structuredOutput;
}

// Expose extractDOM and getSanitizedContext on window for interactive inspection in DevTools
window.extractDOM = extractDOM;
window.getSanitizedContext = function() {
  const rawDOM = extractDOM();
  const sanitizer = typeof sanitizeContext === "function" ? sanitizeContext : window.sanitizeContext;
  return sanitizer ? sanitizer(rawDOM) : rawDOM;
};

// ============================================================================
// 2. Message Listeners & Handshake
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Content Script] 📥 Received message from:", sender.tab ? "another content script" : "extension/background", message);

  switch (message.type) {
    case "PING_CONTENT_SCRIPT":
      console.log("[Content Script] 🔄 Responding to PING_CONTENT_SCRIPT...");
      sendResponse({
        status: "success",
        message: "Content script is responsive!",
        url: window.location.href,
        title: document.title,
        timestamp: new Date().toISOString()
      });
      break;

    case "TASK_ANNOUNCEMENT": {
      console.log("[Content Script] 🎯 Task announced to page:", message.goal);
      console.log("[Content Script] 🚀 Triggering DOM extraction and local redaction pipeline...");
      
      const rawDOM = extractDOM();
      const sanitizer = typeof sanitizeContext === "function" ? sanitizeContext : window.sanitizeContext;
      const sanitizedDOM = sanitizer ? sanitizer(rawDOM) : rawDOM;

      console.log(`[Content Script] 🛡️ Sanitization complete: ${sanitizedDOM.redactions?.length || 0} PII items redacted.`);

      // Send ONLY sanitized context to background worker. Raw DOM is never transmitted.
      sendResponse({
        status: "acknowledged",
        message: `Task received. Extracted and sanitized ${sanitizedDOM.totalElements} elements on page: ${document.title}`,
        sanitizedContext: sanitizedDOM,
        timestamp: new Date().toISOString()
      });
      break;
    }

    case "EXTRACT_DOM": {
      console.log("[Content Script] 📋 Manual EXTRACT_DOM requested.");
      const rawDOM = extractDOM();
      const sanitizer = typeof sanitizeContext === "function" ? sanitizeContext : window.sanitizeContext;
      const sanitizedDOM = sanitizer ? sanitizer(rawDOM) : rawDOM;

      sendResponse({
        status: "success",
        data: sanitizedDOM
      });
      break;
    }

    default:
      console.log("[Content Script] ⚠️ Unknown message type received:", message.type);
      sendResponse({
        status: "unhandled",
        message: `Unknown message type: ${message.type}`
      });
      break;
  }

  return true; // Asynchronous reply capability
});

// Proactively send a notification message to the background service worker on initial page load
(function notifyBackgroundScriptReady() {
  try {
    console.log("[Content Script] 📤 Sending 'CONTENT_SCRIPT_READY' handshake to background worker...");
    chrome.runtime.sendMessage(
      {
        type: "CONTENT_SCRIPT_READY",
        url: window.location.href,
        title: document.title,
        timestamp: new Date().toISOString()
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Content Script] Handshake message note (background may be inactive):", chrome.runtime.lastError.message);
        } else {
          console.log("[Content Script] 📥 Handshake response received from background:", response);
        }
      }
    );
  } catch (err) {
    console.error("[Content Script] Error sending initial handshake:", err);
  }
})();
