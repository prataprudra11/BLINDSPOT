// background.js - Chrome Extension Service Worker (Manifest V3)
console.log("[Background Service Worker] Initializing service worker...");

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

      // Step 2: Ping / message content script in the active tab
      console.log("[Background] Step 2: Sending TASK_ANNOUNCEMENT to content script on tab", activeTab.id);
      try {
        const contentScriptResponse = await new Promise((resolve) => {
          chrome.tabs.sendMessage(
            activeTab.id, 
            { type: "TASK_ANNOUNCEMENT", goal: goal }, 
            (res) => {
              if (chrome.runtime.lastError) {
                console.warn("[Background] ⚠️ Content script communication note:", chrome.runtime.lastError.message);
                resolve({ error: chrome.runtime.lastError.message });
              } else {
                resolve(res);
              }
            }
          );
        });

        console.log("[Background] 📥 Response from content script:", contentScriptResponse?.status);
        if (contentScriptResponse?.sanitizedContext) {
          sanitizedContext = contentScriptResponse.sanitizedContext;
        }
        resultPayload.steps.push({ 
          step: "content_script_message", 
          status: contentScriptResponse?.status || "no_status",
          totalElements: sanitizedContext?.totalElements || 0,
          redactionsCount: sanitizedContext?.redactions?.length || 0
        });
      } catch (contentErr) {
        console.warn("[Background] Error communicating with content script:", contentErr.message);
        resultPayload.steps.push({ step: "content_script_message", error: contentErr.message });
      }
    }

    // Step 3: Send POST request to backend server
    console.log(`[Background] Step 3: Dispatching POST request to ${SERVER_URL}...`);
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

    console.log("[Background] 📤 Request payload for server:", JSON.stringify(serverPayload, null, 2));

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
