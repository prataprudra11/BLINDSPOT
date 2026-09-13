// background.js - Chrome Extension Service Worker (Manifest V3)
console.log("[Background Service Worker] Initializing service worker...");

// Import Modules for Service Worker context
try {
  importScripts("action-schema.js", "privacy-firewall.js");
} catch (err) {
  console.warn("[Background] Service worker importScripts note:", err.message);
}

const SERVER_URL = "http://localhost:3000/agent/act";
const MAX_LOOP_STEPS = 10;

// Lifecycle listener: onInstalled
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[Background] Extension installed/updated. Reason:", details.reason);
});

// Primary Message Dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] 📥 Message received from:", sender.tab ? `Tab ${sender.tab.id} (${sender.tab.url})` : "Popup / Extension UI", message);

  // 1. Handshake from Content Script
  if (message.type === "CONTENT_SCRIPT_READY") {
    console.log("[Background] 🤝 Content script registered from tab:", sender.tab?.id, message.url);
    sendResponse({
      status: "acknowledged",
      message: "Background received content script registration.",
      workerTime: new Date().toISOString()
    });
    return false;
  }

  // 2. Start Task requested from Popup (Observe-Redact-Reason-Act Loop)
  if (message.type === "START_TASK") {
    console.log("[Background] 🚀 START_TASK received with goal:", message.goal);
    handleStartTask(message.goal, sendResponse);
    return true; // Keep message channel open for async response
  }

  // 3. Progress Updates from Offscreen Document OCR Engine
  if (message.type === "OCR_PROGRESS_UPDATE") {
    console.log(`[Background] ⏳ [OCR Progress] ${message.status}: ${message.progress}%`);
    return false;
  }

  // 4. Error Events from Offscreen Document OCR Engine
  if (message.type === "OCR_ERROR_EVENT") {
    console.error(`[Background] ❌ [OCR Worker Error Event]:`, message.error);
    return false;
  }

  // 5. Fallback for unhandled messages
  console.warn("[Background] ⚠️ Unhandled message type:", message.type);
  sendResponse({ status: "error", error: "Unhandled message type" });
  return false;
});

/**
 * Sends telemetry updates to Popup UI if currently open.
 */
function notifyPopupProgress(update) {
  try {
    chrome.runtime.sendMessage({
      type: "LOOP_STEP_UPDATE",
      ...update,
      timestamp: new Date().toISOString()
    }, () => {
      if (chrome.runtime.lastError) {
        // Popup may be closed, ignore
      }
    });
  } catch (_) {}
}

/**
 * Contacts content script on a tab to extract and sanitize DOM.
 * If disconnected or not yet injected, auto-injects all required scripts.
 */
async function requestSanitizedDOMFromTab(tabId, goal) {
  const trySendMessage = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: "TASK_ANNOUNCEMENT", goal: goal },
        (res) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        }
      );
    });

  let response = await trySendMessage();

  // If connection failed, auto-inject complete pipeline in dependency order
  if (response?.error) {
    console.log(`[Background] 🔄 Content script unreachable on Tab ${tabId} (${response.error}). Auto-injecting scripts...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: [
          "element-mapper.js",
          "action-schema.js",
          "action-validator.js",
          "action-executor.js",
          "redaction.js",
          "vision/vision-trigger.js",
          "content_script.js"
        ]
      });
      await new Promise((r) => setTimeout(r, 250));
      response = await trySendMessage();
      console.log("[Background] 📥 Response after auto-injection:", response?.status);
    } catch (injectErr) {
      console.warn(`[Background] Auto-injection failed on Tab ${tabId}:`, injectErr.message);
    }
  }

  return response;
}

/**
 * Dispatches an action execution request to the active tab's content script.
 */
async function executeActionInTab(tabId, action, settleMs = 300) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "EXECUTE_ACTION", action: action, settleMs: settleMs },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      }
    );
  });
}

/**
 * Ensures an offscreen document exists in MV3 for offline OCR tasks.
 */
async function ensureOffscreenDocument() {
  if (typeof chrome === "undefined" || !chrome.offscreen) {
    console.warn("[Background] chrome.offscreen API is not available in this environment.");
    return false;
  }
  try {
    if (typeof chrome.offscreen.hasDocument === "function") {
      const existing = await chrome.offscreen.hasDocument();
      console.log("[Background] 🔍 chrome.offscreen.hasDocument() check:", existing);
      if (existing) return true;
    }
    console.log("[Background] 📄 Calling chrome.offscreen.createDocument({ url: 'vision/offscreen.html', reasons: ['BLOBS', 'DOM_PARSER'], justification: 'Process local OCR for canvas and images' })...");
    await chrome.offscreen.createDocument({
      url: "vision/offscreen.html",
      reasons: ["BLOBS", "DOM_PARSER"],
      justification: "Process local OCR for canvas and images"
    });
    console.log("[Background] ✅ chrome.offscreen.createDocument() resolved successfully.");
    return true;
  } catch (err) {
    console.error("[Background] ❌ Could not create offscreen document:", {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
      fullError: err
    });
    return false;
  }
}

/**
 * Scans perception context for elements flagged visionTriggered: true.
 * Executes OCR in offscreen document and updates redactions with source: 'vision'.
 * Purges raw pixel data URL from outgoing context.
 */
async function processVisualElements(context) {
  if (!context || !Array.isArray(context.elements)) return;

  const visualCandidates = context.elements.filter((el) => el && el.visionTriggered && el.visualDataUrl);
  if (visualCandidates.length === 0) return;

  console.log(`[Background] 👁️ Triggering Phase 4 Visual OCR for ${visualCandidates.length} visual element(s)...`);
  const offscreenReady = await ensureOffscreenDocument();

  for (const el of visualCandidates) {
    const dataUrl = el.visualDataUrl;
    // ALWAYS purge dataUrl so raw pixel data is never leaked or transmitted to server
    delete el.visualDataUrl;

    if (!offscreenReady) {
      el.visualScanFailed = true;
      console.warn(`[Background] ⚠️ Offscreen document not ready; marked ${el.id} as visualScanFailed: true`);
      continue;
    }

    try {
      console.log(`[Background] 📤 Dispatching OFFSCREEN_PROCESS_OCR for ${el.id} (dataUrl length: ${dataUrl ? dataUrl.length : 0})...`);
      const response = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn(`[Background] ⏱️ 28000ms diagnostic timeout reached waiting for OCR on ${el.id}`);
          resolve({ success: false, error: "Offscreen OCR timeout", timeout: true });
        }, 28000);

        chrome.runtime.sendMessage(
          { type: "OFFSCREEN_PROCESS_OCR", elementId: el.id, dataUrl: dataUrl, timeoutMs: 25000 },
          (res) => {
            clearTimeout(timeout);
            const lastErr = chrome.runtime.lastError;
            console.log(`[Background] 📥 Raw callback received from sendMessage for ${el.id}:`, {
              res: res,
              lastError: lastErr ? { message: lastErr.message } : null
            });
            if (lastErr) {
              resolve({ success: false, error: lastErr.message, isLastError: true });
            } else {
              resolve(res || { success: false, error: "Empty offscreen response (res was falsy)" });
            }
          }
        );
      });

      console.log(`[Background] 🔍 Parsed response for ${el.id}:`, response);

      if (response && response.success) {
        const rawText = response.rawText !== undefined ? response.rawText : "";
        const confidence = response.confidence !== undefined ? response.confidence : "N/A";
        console.log(`[RAW OCR OUTPUT] Text:`, rawText, `| Confidence:`, confidence);
        console.log(`[Background] ✅ Visual OCR complete for ${el.id} (${response.ocrLatencyMs}ms)`);
        if (Array.isArray(response.redactions) && response.redactions.length > 0) {
          context.redactions = context.redactions || [];
          for (const r of response.redactions) {
            context.redactions.push({ ...r, source: "vision" });
          }
          el.sensitive = true;
        }

        // Broadcast visual redaction before/after to popup for visual audit
        notifyPopupProgress({
          type: "VISUAL_REDACTION_UPDATE",
          elementId: el.id,
          originalDataUrl: response.originalDataUrl,
          redactedDataUrl: response.redactedDataUrl,
          redactions: response.redactions
        });
      } else {
        el.visualScanFailed = true;
        console.error(`[Background] ⚠️ Visual scan failed on ${el.id}. Full response:`, response);
        console.error(`[Background] ⚠️ Detailed failure report for ${el.id}:`, {
          errorField: response?.error,
          messageField: response?.message,
          name: response?.name,
          stack: response?.stack,
          keys: response ? Object.keys(response) : null,
          rawJson: JSON.stringify(response)
        });
      }
    } catch (err) {
      el.visualScanFailed = true;
      console.error(`[Background] ⚠️ Visual scan exception on ${el.id}:`, {
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
        fullError: err
      });
    }
  }
}

/**
 * Orchestrates the complete Phase 3/4 closed loop:
 * observe -> redact (DOM + Vision) -> reason -> act -> re-observe
 */
async function handleStartTask(goal, sendResponse) {
  const resultPayload = {
    goal: goal,
    steps: [],
    history: [],
    stepCount: 0,
    maxSteps: MAX_LOOP_STEPS,
    status: "running",
    stopReason: "",
    error: null
  };

  let sanitizedContext = null;
  let activeTab = null;

  try {
    // Step 1: Query current active tab
    console.log("[Background] Step 1: Locating active tab...");
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs && tabs.length > 0 ? tabs[0] : null;

    if (!activeTab) {
      throw new Error("No active browser tab located.");
    }

    console.log(`[Background] ✅ Active tab located: ID=${activeTab.id}, URL=${activeTab.url}`);
    resultPayload.steps.push({
      step: "tab_query",
      status: "success",
      tabId: activeTab.id,
      url: activeTab.url,
      title: activeTab.title
    });

    // Step 2: Extract initial perception state
    console.log("[Background] Step 2: Requesting initial sanitized DOM from Tab", activeTab.id);
    const initialPerception = await requestSanitizedDOMFromTab(activeTab.id, goal);

    if (!initialPerception?.sanitizedContext) {
      const errorMsg = initialPerception?.error || "Content script did not return DOM perception.";
      throw new Error(`Could not extract DOM from page (${errorMsg}). Please refresh the tab.`);
    }

    sanitizedContext = initialPerception.sanitizedContext;
    await processVisualElements(sanitizedContext);
    console.log(`[Background] 📥 Initial perception: ${sanitizedContext.totalElements} elements, ${sanitizedContext.redactions?.length || 0} redactions.`);

    resultPayload.steps.push({
      step: "initial_perception",
      status: "success",
      totalElements: sanitizedContext.totalElements,
      redactionsCount: sanitizedContext.redactions?.length || 0
    });

    notifyPopupProgress({
      step: 0,
      maxSteps: MAX_LOOP_STEPS,
      status: "initialized",
      message: `Initial page scanned: ${sanitizedContext.totalElements} elements.`
    });

    // ========================================================================
    // Step 3: Re-Observation Loop (Max 10 steps safety cap)
    // ========================================================================
    let stepCount = 0;
    const history = [];

    while (stepCount < MAX_LOOP_STEPS) {
      console.log(`\n================================================================================`);
      console.log(`[Background] 🔄 STARTING LOOP CYCLE (Step ${stepCount + 1} / ${MAX_LOOP_STEPS})`);
      console.log(`================================================================================`);

      // 3a. Fallback visual perception processing (if visual elements present)
      await processVisualElements(sanitizedContext);

      // 3b. Prepare Outgoing Server Payload
      const serverPayload = {
        action: "PLAN_ACTION",
        goal: goal,
        activeTab: { id: activeTab.id, url: activeTab.url, title: activeTab.title },
        context: sanitizedContext ? {
          url: sanitizedContext.url,
          title: sanitizedContext.title,
          totalElements: sanitizedContext.totalElements,
          elements: sanitizedContext.elements,
          redactions: sanitizedContext.redactions
        } : null,
        history: history,
        step: stepCount,
        timestamp: new Date().toISOString()
      };

      // 3b. Fail-Closed Privacy Firewall Gate check before transmission
      console.log(`[Background] 🛡️ Running Privacy Firewall on outgoing payload (Step ${stepCount + 1})...`);
      const scanner = typeof runFinalPrivacyScan === "function"
        ? runFinalPrivacyScan
        : (typeof self !== "undefined" && self.runFinalPrivacyScan ? self.runFinalPrivacyScan : null);

      if (scanner) {
        const firewallResult = scanner(serverPayload);
        if (firewallResult.blocked) {
          console.error("[Background] 🚨 PRIVACY FIREWALL BLOCKED OUTGOING REQUEST:", firewallResult);
          resultPayload.status = "blocked";
          resultPayload.stopReason = `Privacy Firewall blocked transmission: ${firewallResult.violationsCount} unredacted secret(s) found.`;
          resultPayload.steps.push({
            step: "privacy_firewall",
            status: "blocked",
            stepNumber: stepCount + 1,
            violationsCount: firewallResult.violationsCount,
            violations: firewallResult.violations
          });

          notifyPopupProgress({
            step: stepCount,
            maxSteps: MAX_LOOP_STEPS,
            status: "blocked",
            message: resultPayload.stopReason
          });

          sendResponse({
            status: "blocked",
            message: resultPayload.stopReason,
            data: resultPayload
          });
          return; // FAIL-CLOSED ABORT
        }
      }

      // 3c. Reason: Request next action from server planner
      console.log(`[Background] 📡 Dispatching POST request to ${SERVER_URL}...`);
      let serverResponse;
      try {
        const postRes = await fetch(SERVER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(serverPayload)
        });

        if (!postRes.ok) {
          throw new Error(`Server returned HTTP ${postRes.status}: ${postRes.statusText}`);
        }
        serverResponse = await postRes.json();
      } catch (netErr) {
        console.error("[Background] ❌ Server communication error:", netErr.message);
        resultPayload.status = "error";
        resultPayload.stopReason = `Server error: ${netErr.message}`;
        resultPayload.error = netErr.message;
        notifyPopupProgress({
          step: stepCount,
          maxSteps: MAX_LOOP_STEPS,
          status: "error",
          message: resultPayload.stopReason
        });
        sendResponse({ status: "error", message: resultPayload.stopReason, data: resultPayload });
        return;
      }

      let plannedAction;
      if (serverResponse && typeof serverResponse.action === "object" && serverResponse.action !== null) {
        plannedAction = serverResponse.action;
      } else if (serverResponse && typeof serverResponse.action === "string" && serverResponse.target) {
        // Handle flattened response fallback
        plannedAction = {
          action: serverResponse.action,
          target: serverResponse.target,
          value: serverResponse.value,
          reason: serverResponse.reason
        };
      } else {
        plannedAction = serverResponse?.action || serverResponse;
      }
      console.log(`[Background] 📥 Server returned planned action:`, plannedAction);

      // 3d. Check for Completion or Wait Signals
      if (plannedAction.action === "DONE") {
        console.log("[Background] 🏁 Planner signaled completion (DONE). Loop finishing.");
        resultPayload.status = "completed";
        resultPayload.stopReason = plannedAction.reason || "Goal achieved successfully.";
        resultPayload.steps.push({
          step: "loop_action",
          stepNumber: stepCount + 1,
          action: plannedAction,
          status: "done"
        });

        notifyPopupProgress({
          step: stepCount,
          maxSteps: MAX_LOOP_STEPS,
          status: "completed",
          lastAction: "DONE",
          message: resultPayload.stopReason
        });
        break; // Goal completed!
      }

      if (plannedAction.action === "WAIT" && plannedAction.reason === "no actionable target found") {
        console.log("[Background] ⏸️ Planner returned WAIT: no actionable target found.");
        resultPayload.status = "idle";
        resultPayload.stopReason = "Planner returned WAIT: no actionable target found.";
        resultPayload.steps.push({
          step: "loop_action",
          stepNumber: stepCount + 1,
          action: plannedAction,
          status: "wait"
        });

        notifyPopupProgress({
          step: stepCount,
          maxSteps: MAX_LOOP_STEPS,
          status: "idle",
          lastAction: "WAIT",
          message: resultPayload.stopReason
        });
        break;
      }

      // 3e. Execute Action in Tab via Content Script
      stepCount++;
      resultPayload.stepCount = stepCount;

      console.log(`[Background] ⚡ Executing Step ${stepCount}:`, plannedAction.action, plannedAction.target || "");
      const execResponse = await executeActionInTab(activeTab.id, plannedAction, 300);

      // 3f. Handle Validator Rejection
      if (execResponse.valid === false) {
        console.warn(`[Background] ❌ ActionValidator rejected action on Step ${stepCount}:`, execResponse.reason);
        resultPayload.status = "rejected";
        resultPayload.stopReason = `Action validator rejected: ${execResponse.reason}`;
        resultPayload.steps.push({
          step: "action_execution",
          stepNumber: stepCount,
          action: plannedAction,
          status: "rejected",
          rejectionReason: execResponse.reason
        });

        notifyPopupProgress({
          step: stepCount,
          maxSteps: MAX_LOOP_STEPS,
          status: "rejected",
          lastAction: `${plannedAction.action} ${plannedAction.target || ""}`.trim(),
          rejectionReason: execResponse.reason,
          message: `Validator rejected: ${execResponse.reason}`
        });
        break; // Never proceed on invalid action
      }

      // 3g. Handle Execution Failure
      if (!execResponse.success) {
        const execErr = execResponse.executionError || execResponse.error || "Unknown execution error";
        console.error(`[Background] ❌ Action execution failed on Step ${stepCount}:`, execErr);
        resultPayload.status = "failed";
        resultPayload.stopReason = `Execution failed: ${execErr}`;
        resultPayload.steps.push({
          step: "action_execution",
          stepNumber: stepCount,
          action: plannedAction,
          status: "failed",
          error: execErr
        });

        notifyPopupProgress({
          step: stepCount,
          maxSteps: MAX_LOOP_STEPS,
          status: "failed",
          lastAction: `${plannedAction.action} ${plannedAction.target || ""}`.trim(),
          message: `Execution failed: ${execErr}`
        });
        break;
      }

      // 3h. Success: Record to history and update state with re-observed context
      console.log(`[Background] ✅ Step ${stepCount} executed successfully.`);
      history.push({
        step: stepCount,
        action: plannedAction,
        result: execResponse.executionResult,
        timestamp: new Date().toISOString()
      });

      resultPayload.steps.push({
        step: "action_execution",
        stepNumber: stepCount,
        action: plannedAction,
        status: "success",
        executionResult: execResponse.executionResult
      });

      // Update perception context from re-observed DOM
      sanitizedContext = execResponse.sanitizedContext;

      notifyPopupProgress({
        step: stepCount,
        maxSteps: MAX_LOOP_STEPS,
        status: "step_complete",
        lastAction: `${plannedAction.action} ${plannedAction.target || ""}`.trim(),
        elementsCount: sanitizedContext?.totalElements || 0,
        message: `Step ${stepCount} complete: ${plannedAction.action} on ${plannedAction.target || ""}`
      });

      // 3i. Hard cap check
      if (stepCount >= MAX_LOOP_STEPS) {
        console.log("[Background] 🛑 Maximum steps cap (10) reached. max steps reached.");
        resultPayload.status = "max_steps_reached";
        resultPayload.stopReason = "max steps reached";
        notifyPopupProgress({
          step: stepCount,
          maxSteps: MAX_LOOP_STEPS,
          status: "max_steps",
          message: "max steps reached"
        });
        break;
      }
    }

    resultPayload.history = history;

    const isSuccess = resultPayload.status === "completed";
    sendResponse({
      status: isSuccess ? "success" : (resultPayload.status === "blocked" ? "blocked" : (resultPayload.status === "rejected" ? "rejected" : "error")),
      message: resultPayload.stopReason || `Loop finished after ${stepCount} step(s).`,
      data: resultPayload
    });

  } catch (err) {
    console.error("[Background] ❌ Error in handleStartTask:", err);
    resultPayload.status = "error";
    resultPayload.error = err.message;
    resultPayload.stopReason = err.message;
    sendResponse({
      status: "error",
      message: err.message,
      data: resultPayload
    });
  }
}
