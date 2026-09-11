// server/planner.js - Swappable Rule-Based Mock Action Planner
// Generates structured actions adhering to action-schema.js without arbitrary code execution.
const { ACTION_TYPES, CONTROL_ACTIONS } = require("../action-schema");

/**
 * Evaluates sanitized DOM context and user goal to determine the next single action.
 * Structured so that this function can be easily swapped for an LLM API call in the future.
 * 
 * @param {Object} context - Sanitized perception context ({ url, title, elements, redactions })
 * @param {string} goal - User's natural language goal (e.g. "Submit Verified Profile")
 * @param {Array} [history=[]] - List of past actions executed in this loop session
 * @returns {Object} Structured action object matching action-schema.js
 */
function planNextAction(context, goal = "", history = []) {
  const elements = context?.elements || [];
  const normalizedGoal = (goal || "").trim().toLowerCase();

  // If no elements are present, we cannot act on DOM
  if (!elements || elements.length === 0) {
    return {
      action: ACTION_TYPES.WAIT,
      reason: "No elements found in context to act upon"
    };
  }

  // Check if goal was already completed (confirmation message or final submit clicked)
  const hasConfirmationScreen = history.length > 0 && elements.some((el) => {
    const text = (el.text || el.label || "").toLowerCase();
    return text.includes("verification complete") || text.includes("successfully submitted");
  });

  const alreadyClickedFinalSubmit = history.some(
    (h) => {
      const act = h?.action || h;
      const isClick = act.action === ACTION_TYPES.CLICK;
      const isSuccess = h.result?.success || h.status === "success" || h.success;
      const isFinalBtn = act.target === "btn-submit-pii" || (act.reason && /submit verified profile|final step/i.test(act.reason));
      return isClick && isSuccess && isFinalBtn;
    }
  );

  // 1. Goal: "Submit", "Submit Verified Profile", "Submit KYC", etc.
  if (normalizedGoal.includes("submit") || normalizedGoal.includes("verify") || normalizedGoal.includes("profile")) {
    // If confirmation screen is reached or final submit was already executed, signal DONE
    if (hasConfirmationScreen || alreadyClickedFinalSubmit) {
      return {
        action: CONTROL_ACTIONS.DONE,
        reason: "Goal achieved: Verified profile submitted successfully across all steps."
      };
    }

    // Step A: Check for final submit button on current page
    const finalSubmitBtn = elements.find((el) => {
      const isButton = el.tag === "button" || el.type === "button" || el.type === "submit";
      const text = (el.text || el.label || el.value || "").toLowerCase();
      const isFinal = text.includes("submit verified profile") || text.includes("submit profile") || el.name === "submit" || (el.id && el.id.includes("btn-submit"));
      return isButton && isFinal && !text.includes("continue") && !text.includes("next");
    });

    if (finalSubmitBtn) {
      return {
        action: ACTION_TYPES.CLICK,
        target: finalSubmitBtn.id,
        reason: `Final step reached: clicking '${finalSubmitBtn.text || finalSubmitBtn.label || "Submit"}' (${finalSubmitBtn.id}).`
      };
    }

    // Step B: Check for step progression button (e.g. Next / Continue) on current page
    const nextStepBtn = elements.find((el) => {
      const isButton = el.tag === "button" || el.type === "button" || el.type === "submit";
      const text = (el.text || el.label || el.value || "").toLowerCase();
      return isButton && (text.includes("continue") || text.includes("next") || text.includes("step"));
    });

    if (nextStepBtn) {
      return {
        action: ACTION_TYPES.CLICK,
        target: nextStepBtn.id,
        reason: `Progressing multi-step form: clicking '${nextStepBtn.text || nextStepBtn.label || "Continue"}' (${nextStepBtn.id}).`
      };
    }

    // Step C: Fallback to any button matching submit / verify / profile
    const fallbackBtn = elements.find((el) => {
      const isButton = el.tag === "button" || el.type === "button" || el.type === "submit";
      const text = (el.text || el.label || el.value || "").toLowerCase();
      return isButton && (text.includes("submit") || text.includes("verify") || text.includes("profile"));
    });

    if (fallbackBtn) {
      if (history.length > 0) {
        return {
          action: CONTROL_ACTIONS.DONE,
          reason: `Goal achieved: Action button (${fallbackBtn.id}) was successfully triggered.`
        };
      }
      return {
        action: ACTION_TYPES.CLICK,
        target: fallbackBtn.id,
        reason: `Goal requested form submission; clicking matching button '${fallbackBtn.text || fallbackBtn.label || "Submit"}' (${fallbackBtn.id}).`
      };
    }
  }

  // 2. Goal: Explicit Click on a named target
  if (normalizedGoal.startsWith("click ") || normalizedGoal.includes("press ")) {
    const targetQuery = normalizedGoal.replace(/^(click|press)\s+/i, "").trim();
    const candidate = elements.find((el) => {
      const text = (el.text || el.label || el.value || "").toLowerCase();
      return text.includes(targetQuery) || (el.name && el.name.toLowerCase().includes(targetQuery));
    });

    if (candidate) {
      const hasClicked = history.some((h) => (h.target === candidate.id || h?.action?.target === candidate.id));
      if (hasClicked) {
        return {
          action: CONTROL_ACTIONS.DONE,
          reason: `Goal achieved: Clicked requested target '${targetQuery}' (${candidate.id}).`
        };
      }

      return {
        action: ACTION_TYPES.CLICK,
        target: candidate.id,
        reason: `Target '${targetQuery}' matches element ${candidate.id}.`
      };
    }
  }

  // 3. Goal: Navigate
  if (normalizedGoal.startsWith("navigate to ") || normalizedGoal.startsWith("go to ")) {
    const navUrl = goal.replace(/^(navigate to|go to)\s+/i, "").trim();
    const hasNavigated = history.some((h) => (h.action === ACTION_TYPES.NAVIGATE || h?.action?.action === ACTION_TYPES.NAVIGATE));
    if (hasNavigated) {
      return {
        action: CONTROL_ACTIONS.DONE,
        reason: `Goal achieved: Navigation to '${navUrl}' completed.`
      };
    }
    return {
      action: ACTION_TYPES.NAVIGATE,
      value: navUrl,
      reason: `User goal requested navigation to '${navUrl}'.`
    };
  }

  // 4. Goal: Wait
  if (normalizedGoal.includes("wait")) {
    return {
      action: ACTION_TYPES.WAIT,
      reason: "User goal requested wait delay."
    };
  }

  // 5. Fallback: If no sensible action can be determined, return WAIT rather than guessing
  return {
    action: ACTION_TYPES.WAIT,
    reason: "no actionable target found"
  };
}

module.exports = {
  planNextAction
};
