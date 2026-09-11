// action-schema.js - Shared Structured Action Protocol (Manifest V3 & Server)
// Defines the strict, safe action schema for the observe-act loop.
// ARBITRARY JS EXECUTION IS STRICTLY FORBIDDEN: Only predetermined action types are allowed.

(function (global) {
  // Exactly 8 executable action types
  const ACTION_TYPES = Object.freeze({
    CLICK: "CLICK",
    TYPE: "TYPE",
    SELECT: "SELECT",
    CHECK: "CHECK",
    UNCHECK: "UNCHECK",
    SCROLL: "SCROLL",
    NAVIGATE: "NAVIGATE",
    WAIT: "WAIT"
  });

  // Loop control action types (non-DOM actions)
  const CONTROL_ACTIONS = Object.freeze({
    DONE: "DONE"
  });

  const ALLOWED_ACTION_LIST = Object.freeze(Object.values(ACTION_TYPES));

  /**
   * Checks whether an action type string is one of the 8 allowed executable actions.
   * @param {string} action
   * @returns {boolean}
   */
  function isAllowedAction(action) {
    if (typeof action !== "string") return false;
    return ALLOWED_ACTION_LIST.includes(action.toUpperCase());
  }

  /**
   * Checks whether an action represents a completion signal.
   * @param {string} action
   * @returns {boolean}
   */
  function isCompletionAction(action) {
    if (typeof action !== "string") return false;
    return action.toUpperCase() === CONTROL_ACTIONS.DONE;
  }

  /**
   * Validates an action object against the structural protocol specification:
   * {
   *   "action": "CLICK" | "TYPE" | "SELECT" | "CHECK" | "UNCHECK" | "SCROLL" | "NAVIGATE" | "WAIT",
   *   "target": "el_003", // required for all except NAVIGATE/WAIT
   *   "value": "some text", // required for TYPE/SELECT, optional otherwise
   *   "reason": "short justification"
   * }
   * 
   * @param {any} actionObj - The action payload received from the planner
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateActionSchema(actionObj) {
    if (!actionObj || typeof actionObj !== "object" || Array.isArray(actionObj)) {
      return { valid: false, reason: "Action payload must be a non-null object." };
    }

    const actionType = typeof actionObj.action === "string" ? actionObj.action.toUpperCase() : null;

    // Handle completion signal
    if (actionType === CONTROL_ACTIONS.DONE) {
      return { valid: true };
    }

    // Must be one of the 8 allowed executable actions
    if (!actionType || !ALLOWED_ACTION_LIST.includes(actionType)) {
      return {
        valid: false,
        reason: `Unsupported action type: '${actionObj.action}'. Allowed actions are: ${ALLOWED_ACTION_LIST.join(", ")}.`
      };
    }

    // Target validation: required for all except NAVIGATE and WAIT
    const requiresTarget = actionType !== ACTION_TYPES.NAVIGATE && actionType !== ACTION_TYPES.WAIT;
    if (requiresTarget) {
      if (!actionObj.target || typeof actionObj.target !== "string") {
        return {
          valid: false,
          reason: `Action '${actionType}' requires a valid string 'target' (anonymous ID).`
        };
      }
      if (!/^el_\d+$/i.test(actionObj.target.trim())) {
        return {
          valid: false,
          reason: `Target '${actionObj.target}' is not a valid anonymous element ID format (e.g. 'el_001').`
        };
      }
    }

    // Value validation: required for TYPE and SELECT
    if (actionType === ACTION_TYPES.TYPE) {
      if (typeof actionObj.value !== "string") {
        return {
          valid: false,
          reason: "Action 'TYPE' requires a string 'value'."
        };
      }
    }

    if (actionType === ACTION_TYPES.SELECT) {
      if (actionObj.value === undefined || actionObj.value === null || typeof actionObj.value !== "string") {
        return {
          valid: false,
          reason: "Action 'SELECT' requires a string 'value' matching option value or text."
        };
      }
    }

    if (actionType === ACTION_TYPES.NAVIGATE) {
      if (!actionObj.value || typeof actionObj.value !== "string") {
        return {
          valid: false,
          reason: "Action 'NAVIGATE' requires a URL string in 'value'."
        };
      }
    }

    return { valid: true };
  }

  const ActionSchema = {
    ACTION_TYPES,
    CONTROL_ACTIONS,
    ALLOWED_ACTION_LIST,
    isAllowedAction,
    isCompletionAction,
    validateActionSchema
  };

  // Export for CommonJS (Node.js/Server), Browser Window, and Service Worker
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ActionSchema;
  }
  if (typeof window !== "undefined") {
    window.ActionSchema = ActionSchema;
  }
  if (typeof self !== "undefined") {
    self.ActionSchema = ActionSchema;
  }
  if (typeof global !== "undefined") {
    global.ActionSchema = ActionSchema;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
