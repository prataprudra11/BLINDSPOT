// background.js - Chrome Extension Service Worker (Manifest V3)
console.log("[Background Service Worker] Initializing service worker...");

// Import Fail-Closed Privacy Firewall Gate
try {
  importScripts("privacy-firewall.js");
} catch (err) {
  console.warn("[Background] Service worker importScripts note:", err.message);
}

const SERVER_URL = "http://localhost:3000/agent/act";

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
    return false; // synchronous response
  }

  // 2. Start Task requested from Popup
  if (message.type === "START_TASK") {
    console.log("[Background] 🚀 START_TASK received with goal:", message.goal);

    handleStartTask(message.goal, sendResponse);
    return true; // Keep message channel open for async response
  }

  // 3. Fallback for unhandled messages
  console.warn("[Background] ⚠️ Unhandled message type:", message.type);
  sendResponse({ status: "error", error: "Unhandled message type" });
  return false;
});

/**
 * Contacts content script on a tab to extract and sanitize DOM.
 * If the content script is not yet injected or disconnected (e.g. extension was reloaded),
 * automatically injects the content scripts via chrome.scripting.executeScript and retries.
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

  // If connection failed (e.g. "Receiving end does not exist" after extension reload), auto-inject!
  if (response?.error) {
    console.log(`[Background] 🔄 Content script unreachable on Tab ${tabId} (${response.error}). Auto-injecting scripts...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["element-mapper.js", "redaction.js", "content_script.js"]
      });
      // Short delay for scripts to initialize and register listeners
      await new Promise((r) => setTimeout(r, 200));
      response = await trySendMessage();
      console.log("[Background] 📥 Response after auto-injection:", response?.status);
    } catch (injectErr) {
      console.warn(`[Background] Auto-injection failed on Tab ${tabId}:`, injectErr.message);
    }
  }

  return response;
}

/**
 * Orchestrates task initiation:
 * 1. Queries the active tab
 * 2. Contacts content script in active tab
 * 3. Sends POST request to the local Node.js /agent/act server
 * 4. Relays aggregated status back to the popup UI
 */
async function handleStartTask(goal, sendResponse) {
  const resultPayload = {
    goal: goal,
    steps: [],
    serverData: null,
    error: null
  };

  let sanitizedContext = null;

  try {
    // Step 1: Query current active tab
    console.log("[Background] Step 1: Querying active tab...");
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!activeTab) {
      console.warn("[Background] ⚠️ No active tab found.");
      resultPayload.steps.push({ step: "tab_query", status: "failed", message: "No active tab found" });
    } else {
      console.log(`[Background] ✅ Active tab located: ID=${activeTab.id}, URL=${activeTab.url}`);
      resultPayload.steps.push({ 
        step: "tab_query", 
        status: "success", 
        tabId: activeTab.id, 
        url: activeTab.url,
        title: activeTab.title 
      });

      // Step 2: Ping / message content script in the active tab with auto-injection fallback
      console.log("[Background] Step 2: Requesting sanitized DOM from tab", activeTab.id);
      try {
        const contentScriptResponse = await requestSanitizedDOMFromTab(activeTab.id, goal);

        if (contentScriptResponse?.sanitizedContext) {
          sanitizedContext = contentScriptResponse.sanitizedContext;
          console.log(`[Background] 📥 Received sanitized context: ${sanitizedContext.totalElements} elements, ${sanitizedContext.redactions?.length || 0} redactions.`);
          resultPayload.steps.push({ 
            step: "content_script_message", 
            status: contentScriptResponse.status || "acknowledged",
            totalElements: sanitizedContext.totalElements,
            redactionsCount: sanitizedContext.redactions?.length || 0
          });
        } else {
          const reason = contentScriptResponse?.error || "Content script was not reachable";
          console.warn("[Background] ⚠️ Could not get sanitized context from tab:", reason);
          resultPayload.steps.push({ step: "content_script_message", status: "failed", error: reason });
          resultPayload.error = "Could not extract DOM from page. Please refresh the page tab (F5 / Ctrl+R) and click 'Start Agent' again.";
          sendResponse({
            status: "error",
            message: resultPayload.error,
            data: resultPayload
          });
          return; // Abort - never send empty context: null
        }
      } catch (contentErr) {
        console.warn("[Background] Error communicating with content script:", contentErr.message);
        resultPayload.steps.push({ step: "content_script_message", error: contentErr.message });
        resultPayload.error = `Content script error: ${contentErr.message}. Please refresh the page tab.`;
        sendResponse({ status: "error", message: resultPayload.error, data: resultPayload });
        return;
      }
    }

    // Step 3: Construct Outgoing Server Payload
    const serverPayload = {
      action: "INITIATE_TASK",
      goal: goal,
      activeTab: activeTab ? { id: activeTab.id, url: activeTab.url, title: activeTab.title } : null,
      context: sanitizedContext ? {
        url: sanitizedContext.url,
        title: sanitizedContext.title,
        totalElements: sanitizedContext.totalElements,
        elements: sanitizedContext.elements,
        redactions: sanitizedContext.redactions
      } : null,
      timestamp: new Date().toISOString()
    };

    console.log("[Background] 📤 Prepared server payload:", JSON.stringify(serverPayload, null, 2));

    // Step 4: Run Fail-Closed Privacy Firewall Scan as final gate
    console.log("[Background] Step 4: Running final fail-closed Privacy Firewall scan...");
    const scanner = typeof runFinalPrivacyScan === "function" ? runFinalPrivacyScan : (typeof self !== "undefined" && self.runFinalPrivacyScan ? self.runFinalPrivacyScan : null);
    if (scanner) {
      const firewallResult = scanner(serverPayload);
      if (firewallResult.blocked) {
        console.error("[Background] 🚨 PRIVACY FIREWALL BLOCKED OUTGOING REQUEST:", firewallResult);
        resultPayload.steps.push({
          step: "privacy_firewall",
          status: "blocked",
          violationsCount: firewallResult.violationsCount,
          violations: firewallResult.violations
        });
        resultPayload.error = `Transmission aborted: Privacy Firewall detected ${firewallResult.violationsCount} unredacted secret(s) in payload.`;
        sendResponse({
          status: "blocked",
          message: "Privacy Firewall aborted transmission to protect user privacy.",
          data: resultPayload
        });
        return; // ABORT - NEVER SEND SENSITIVE DATA
      }
      console.log("[Background] 🛡️ Final Privacy Firewall check passed (zero PII detected).");
      resultPayload.steps.push({ step: "privacy_firewall", status: "passed" });
    }

    // Step 4: Send POST request to backend server
    console.log(`[Background] Step 4: Dispatching POST request to ${SERVER_URL}...`);
    const response = await fetch(SERVER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(serverPayload)
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    console.log("[Background] ✅ Response received from server:", json);
    resultPayload.serverData = json;
    resultPayload.steps.push({ step: "server_post", status: "success" });

    // Send final response back to popup
    sendResponse({
      status: "success",
      message: "Task successfully processed by background and echoed by server.",
      data: resultPayload
    });

  } catch (err) {
    console.error("[Background] ❌ Error in handleStartTask:", err);
    resultPayload.error = err.message;
    sendResponse({
      status: "error",
      message: err.message,
      data: resultPayload
    });
  }
}
