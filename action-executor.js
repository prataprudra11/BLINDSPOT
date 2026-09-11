// action-executor.js - Local Action Executor (Manifest V3 & Server/Node)
// Safely executes validator-approved structured actions on live DOM elements.
// ARBITRARY JS STRINGS ARE NEVER EXECUTED.

(function (global) {
  /**
   * Helper: Resolves ElementMapper from available scope.
   */
  function getMapper() {
    if (typeof ElementMapper !== "undefined") return ElementMapper;
    if (global && global.ElementMapper) return global.ElementMapper;
    if (typeof window !== "undefined" && window.ElementMapper) return window.ElementMapper;
    return null;
  }

  /**
   * Executes a validated action against the live DOM.
   * 
   * @param {Object} action - Structured action object
   * @param {Object} [options] - Execution options (custom mapper, waitMs, etc.)
   * @returns {Promise<{ success: boolean, action: string, target?: string, timestamp: string, error?: string }>}
   */
  async function executeAction(action, options = {}) {
    const timestamp = new Date().toISOString();
    const actionType = (action?.action || "").toUpperCase();

    try {
      // 1. Completion signal
      if (actionType === "DONE") {
        console.log(`[Action Executor] [${timestamp}] 🏁 Action: DONE (Goal reached).`);
        return {
          success: true,
          action: "DONE",
          timestamp
        };
      }

      // 2. WAIT Action
      if (actionType === "WAIT") {
        const delay = typeof options.waitMs === "number" ? options.waitMs : 500;
        console.log(`[Action Executor] [${timestamp}] ⏳ Action: WAIT (${delay}ms)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          success: true,
          action: "WAIT",
          timestamp
        };
      }

      // 3. NAVIGATE Action
      if (actionType === "NAVIGATE") {
        console.log(`[Action Executor] [${timestamp}] 🧭 Action: NAVIGATE -> ${action.value}`);
        if (typeof window !== "undefined" && window.location) {
          window.location.href = action.value;
        }
        return {
          success: true,
          action: "NAVIGATE",
          value: action.value,
          timestamp
        };
      }

      // 4. Resolve DOM element for target-based actions
      const mapper = options.mapper || getMapper();
      const node = mapper ? mapper.getElement(action.target) : null;

      if (!node) {
        throw new Error(`Target '${action.target}' could not be resolved from ElementMapper.`);
      }

      // 5. Dispatch DOM Operations
      const win = (node.ownerDocument && node.ownerDocument.defaultView) || (typeof window !== "undefined" ? window : globalThis);
      const Evt = win.Event || (typeof Event !== "undefined" ? Event : null);
      const MouseEvt = win.MouseEvent || (typeof MouseEvent !== "undefined" ? MouseEvent : Evt);

      switch (actionType) {
        case "CLICK": {
          console.log(`[Action Executor] [${timestamp}] 🖱️ Action: CLICK on ${action.target} (<${node.tagName.toLowerCase()}>)`);
          if (typeof node.click === "function") {
            node.click();
          } else if (MouseEvt) {
            node.dispatchEvent(new MouseEvt("click", { bubbles: true, cancelable: true, view: win }));
          }
          break;
        }

        case "TYPE": {
          console.log(`[Action Executor] [${timestamp}] ⌨️ Action: TYPE on ${action.target} (length: ${action.value?.length || 0})`);
          node.value = action.value;
          if (Evt) {
            node.dispatchEvent(new Evt("input", { bubbles: true }));
            node.dispatchEvent(new Evt("change", { bubbles: true }));
          }
          break;
        }

        case "SELECT": {
          console.log(`[Action Executor] [${timestamp}] 🔽 Action: SELECT on ${action.target} (val: '${action.value}')`);
          if (node.options && node.options.length > 0) {
            let matched = false;
            for (let i = 0; i < node.options.length; i++) {
              const opt = node.options[i];
              if (opt.value === action.value || opt.text === action.value) {
                node.selectedIndex = i;
                matched = true;
                break;
              }
            }
            if (!matched) {
              node.value = action.value;
            }
          } else {
            node.value = action.value;
          }
          if (Evt) {
            node.dispatchEvent(new Evt("change", { bubbles: true }));
          }
          break;
        }

        case "CHECK": {
          console.log(`[Action Executor] [${timestamp}] ☑️ Action: CHECK on ${action.target}`);
          node.checked = true;
          if (Evt) {
            node.dispatchEvent(new Evt("change", { bubbles: true }));
          }
          break;
        }

        case "UNCHECK": {
          console.log(`[Action Executor] [${timestamp}] ⬜ Action: UNCHECK on ${action.target}`);
          node.checked = false;
          if (Evt) {
            node.dispatchEvent(new Evt("change", { bubbles: true }));
          }
          break;
        }

        case "SCROLL": {
          console.log(`[Action Executor] [${timestamp}] 📜 Action: SCROLL to ${action.target}`);
          if (typeof node.scrollIntoView === "function") {
            try {
              node.scrollIntoView({ behavior: "smooth", block: "center" });
            } catch (_) {
              node.scrollIntoView();
            }
          }
          break;
        }

        default:
          throw new Error(`Unsupported action execution type: '${actionType}'`);
      }

      return {
        success: true,
        action: actionType,
        target: action.target,
        timestamp
      };
    } catch (err) {
      console.error(`[Action Executor] [${timestamp}] ❌ Execution failure:`, err.message);
      return {
        success: false,
        action: actionType,
        target: action?.target,
        error: err.message,
        timestamp
      };
    }
  }

  const ActionExecutor = {
    executeAction
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ActionExecutor;
  }
  if (typeof window !== "undefined") {
    window.ActionExecutor = ActionExecutor;
  }
  if (typeof self !== "undefined") {
    self.ActionExecutor = ActionExecutor;
  }
  if (typeof global !== "undefined") {
    global.ActionExecutor = ActionExecutor;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
