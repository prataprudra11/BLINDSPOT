// action-validator.js - Local Action Validator (Manifest V3 & Server/Node)
// Verifies server actions against live page state before any execution.
// NEVER execute an action if validation fails.

(function (global) {
  const isNode = typeof module !== "undefined" && module.exports;
  const Schema = isNode ? require("./action-schema") : (global.ActionSchema || {});
  const { ACTION_TYPES, isAllowedAction, validateActionSchema } = Schema;

  /**
   * Helper: Resolves ElementMapper from available scope.
   */
  function getMapper() {
    if (typeof ElementMapper !== "undefined") return ElementMapper;
    if (global && global.ElementMapper) return global.ElementMapper;
    if (typeof window !== "undefined" && window.ElementMapper) return window.ElementMapper;
    if (isNode) {
      try {
        return require("./element-mapper");
      } catch (_) {}
    }
    return null;
  }

  /**
   * Helper: Checks if a DOM element is visible on screen.
   */
  function isNodeVisible(el) {
    if (!el || el.nodeType !== 1) return false;

    const win = (el.ownerDocument && el.ownerDocument.defaultView) || (typeof window !== "undefined" ? window : null);
    if (win && win.getComputedStyle) {
      try {
        const style = win.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
          return false;
        }
      } catch (_) {}
    }

    if (el.getAttribute && (el.getAttribute("aria-hidden") === "true" || (el.closest && el.closest('[aria-hidden="true"]')))) {
      return false;
    }

    // Check offsetParent (returns null if display:none in browsers with layout or mocked in JSDOM)
    if ("offsetParent" in el && el.offsetParent === null && el.tagName !== "BODY") {
      if (win && win.getComputedStyle) {
        try {
          if (win.getComputedStyle(el).position !== "fixed") return false;
        } catch (_) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Helper: Checks if a DOM element is disabled.
   */
  function isNodeDisabled(el) {
    if (!el) return false;
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
    if (el.closest && el.closest("fieldset[disabled]")) return true;
    return false;
  }

  /**
   * Validates an action received from the planner against the active DOM state.
   * 
   * @param {Object} action - Structured action object
   * @param {Object} [options] - Optional overrides (e.g. custom mapper or window location)
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateAction(action, options = {}) {
    // 1. Schema check
    const schemaCheck = validateActionSchema ? validateActionSchema(action) : { valid: true };
    if (!schemaCheck.valid) {
      return { valid: false, reason: `Schema violation: ${schemaCheck.reason}` };
    }

    const actionType = action.action.toUpperCase();

    // Completion signal is valid to receive
    if (actionType === "DONE") {
      return { valid: true };
    }

    // 2. Action type whitelist (strictly 8 allowed types)
    if (isAllowedAction && !isAllowedAction(actionType)) {
      return {
        valid: false,
        reason: `Disallowed action type '${action.action}'. Permitted types: CLICK, TYPE, SELECT, CHECK, UNCHECK, SCROLL, NAVIGATE, WAIT.`
      };
    }

    // 3. Handling NAVIGATE
    if (actionType === "NAVIGATE") {
      const targetUrl = action.value;
      if (!targetUrl || typeof targetUrl !== "string") {
        return { valid: false, reason: "NAVIGATE requires a destination URL in 'value'." };
      }

      // Security check: Only allow same-origin or explicit current test page URL
      const currentHref = options.currentUrl || (typeof window !== "undefined" ? window.location.href : "");
      try {
        const targetParsed = new URL(targetUrl, currentHref || "http://localhost");
        if (currentHref) {
          const currentParsed = new URL(currentHref);
          const isSameOrigin = targetParsed.origin === currentParsed.origin;
          const isFileProtocol = currentParsed.protocol === "file:" && targetParsed.protocol === "file:";

          if (!isSameOrigin && !isFileProtocol) {
            return {
              valid: false,
              reason: `NAVIGATE to cross-origin '${targetUrl}' blocked for security.`
            };
          }
        }
      } catch (err) {
        return { valid: false, reason: `Malformed NAVIGATE URL '${targetUrl}': ${err.message}` };
      }

      return { valid: true };
    }

    // 4. Handling WAIT
    if (actionType === "WAIT") {
      return { valid: true };
    }

    // 5. DOM Target Resolution for DOM actions (CLICK, TYPE, SELECT, CHECK, UNCHECK, SCROLL)
    const mapper = options.mapper || getMapper();
    if (!mapper || typeof mapper.getElement !== "function") {
      return { valid: false, reason: "ElementMapper is not available to resolve target element." };
    }

    const node = mapper.getElement(action.target);
    if (!node) {
      return {
        valid: false,
        reason: `Target '${action.target}' does not resolve to an active DOM node in ElementMapper (element missing or stale).`
      };
    }

    // 6. Element State Checks (visibility & disabled)
    if (isNodeDisabled(node)) {
      return {
        valid: false,
        reason: `Target '${action.target}' is currently disabled and cannot accept actions.`
      };
    }

    if (!isNodeVisible(node)) {
      return {
        valid: false,
        reason: `Target '${action.target}' is currently hidden or not visible.`
      };
    }

    const tagName = (node.tagName || "").toLowerCase();
    const role = (node.getAttribute ? node.getAttribute("role") || "" : "").toLowerCase();
    const inputType = (node.getAttribute ? node.getAttribute("type") || "" : "").toLowerCase();

    // 7. Action-to-Tag/Role Compatibility Matrix
    switch (actionType) {
      case "CLICK": {
        const isClickableTag = tagName === "button" || tagName === "a" || (tagName === "input" && ["button", "submit", "reset", "image"].includes(inputType));
        const isClickableRole = ["button", "link", "menuitem", "tab"].includes(role);

        if (!isClickableTag && !isClickableRole) {
          return {
            valid: false,
            reason: `Target '${action.target}' (<${tagName}> role='${role}') is not a clickable element. CLICK only allowed on buttons, links, or clickable roles.`
          };
        }
        break;
      }

      case "TYPE": {
        const isTextInput = tagName === "input" && !["button", "submit", "reset", "image", "checkbox", "radio", "file", "hidden"].includes(inputType);
        const isTextArea = tagName === "textarea";

        if (!isTextInput && !isTextArea) {
          return {
            valid: false,
            reason: `Target '${action.target}' (<${tagName}>) is not a text input control. TYPE only allowed on <input> (text-like) or <textarea>.`
          };
        }

        if (typeof action.value !== "string") {
          return {
            valid: false,
            reason: `TYPE action requires a valid string 'value' to input.`
          };
        }
        break;
      }

      case "SELECT": {
        if (tagName !== "select") {
          return {
            valid: false,
            reason: `Target '${action.target}' (<${tagName}>) is not a <select> element. SELECT only allowed on <select>.`
          };
        }

        if (action.value === undefined || action.value === null) {
          return {
            valid: false,
            reason: `SELECT action requires an option 'value' to select.`
          };
        }
        break;
      }

      case "CHECK":
      case "UNCHECK": {
        const isCheckableInput = tagName === "input" && (inputType === "checkbox" || inputType === "radio");
        const isCheckableRole = role === "checkbox" || role === "radio";

        if (!isCheckableInput && !isCheckableRole) {
          return {
            valid: false,
            reason: `Target '${action.target}' (<${tagName}> type='${inputType}') is not checkable. ${actionType} only allowed on checkboxes and radios.`
          };
        }
        break;
      }

      case "SCROLL": {
        // SCROLL is valid on any real visible node
        break;
      }

      default: {
        return {
          valid: false,
          reason: `Unrecognized action type: '${actionType}'.`
        };
      }
    }

    return { valid: true };
  }

  const ActionValidator = {
    validateAction,
    isNodeVisible,
    isNodeDisabled
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ActionValidator;
  }
  if (typeof window !== "undefined") {
    window.ActionValidator = ActionValidator;
  }
  if (typeof self !== "undefined") {
    self.ActionValidator = ActionValidator;
  }
  if (typeof global !== "undefined") {
    global.ActionValidator = ActionValidator;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
