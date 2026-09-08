// popup.js - Chrome Extension Popup Script
console.log("[Popup] Script loaded and initialized.");

document.addEventListener("DOMContentLoaded", () => {
  const taskGoalInput = document.getElementById("taskGoal");
  const startBtn = document.getElementById("startBtn");
  const btnSpinner = document.getElementById("btnSpinner");
  const pingServerBtn = document.getElementById("pingServerBtn");
  const clearLogsBtn = document.getElementById("clearLogsBtn");
  const logsConsole = document.getElementById("logsConsole");
  const statusBadge = document.getElementById("statusBadge");
  const statusText = document.getElementById("statusText");

  // Helper: Append a formatted log entry to the UI console
  function logToUI(message, type = "info") {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement("div");
    entry.className = `log-entry log-${type}`;

    const timeSpan = document.createElement("span");
    timeSpan.className = "log-time";
    timeSpan.textContent = `[${timeStr}]`;

    const msgSpan = document.createElement("span");
    msgSpan.className = "log-msg";
    msgSpan.textContent = message;

    entry.appendChild(timeSpan);
    entry.appendChild(msgSpan);
    logsConsole.appendChild(entry);
    logsConsole.scrollTop = logsConsole.scrollHeight;

    console.log(`[Popup Console] [${type.toUpperCase()}] ${message}`);
  }

  // Helper: Update the top status pill badge
  function updateStatus(status, label) {
    statusBadge.className = `status-badge status-${status}`;
    statusText.textContent = label;
  }

  // Helper: Toggle button loading state
  function setLoading(isLoading) {
    if (isLoading) {
      startBtn.disabled = true;
      btnSpinner.classList.remove("hidden");
      updateStatus("running", "Running");
    } else {
      startBtn.disabled = false;
      btnSpinner.classList.add("hidden");
    }
  }

  // 1. Handle "Start Agent" Button Click
  startBtn.addEventListener("click", () => {
    const goal = taskGoalInput.value.trim();
    if (!goal) {
      logToUI("Please enter a valid task goal first.", "warn");
      taskGoalInput.focus();
      return;
    }

    logToUI(`Initiating task: "${goal}"`, "info");
    console.log("[Popup] 🚀 Dispatching START_TASK to background service worker with goal:", goal);
    setLoading(true);

    chrome.runtime.sendMessage(
      {
        type: "START_TASK",
        goal: goal,
        timestamp: new Date().toISOString()
      },
      (response) => {
        setLoading(false);

        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message;
          console.error("[Popup] ❌ Error contacting background service worker:", errorMsg);
          logToUI(`Background error: ${errorMsg}`, "error");
          updateStatus("error", "Error");
          return;
        }

        console.log("[Popup] 📥 Received response from background worker:", response);

        if (response && response.status === "success") {
          logToUI(`Background completed task orchestration.`, "success");
          
          // Log details of intermediate steps
          if (response.data && response.data.steps) {
            response.data.steps.forEach(stepItem => {
              if (stepItem.step === "tab_query") {
                logToUI(`Active Tab: ${stepItem.title || stepItem.url || 'Tab ' + stepItem.tabId}`, "info");
              } else if (stepItem.step === "content_script_message") {
                const csStatus = stepItem.response?.status || stepItem.error || "no response";
                logToUI(`Content Script status: ${csStatus}`, stepItem.error ? "warn" : "info");
              } else if (stepItem.step === "server_post") {
                logToUI(`Server Echo: ${response.data.serverData?.message || "200 OK"}`, "success");
              }
            });
          }

          updateStatus("success", "Done");
        } else {
          const errMsg = response?.message || "Unknown error occurred";
          logToUI(`Task failed: ${errMsg}`, "error");
          updateStatus("error", "Failed");
        }
      }
    );
  });

  // 2. Handle "Ping Server" Direct Connectivity Check
  pingServerBtn.addEventListener("click", async () => {
    logToUI("Testing direct connection to http://localhost:3000/agent/act...", "info");
    console.log("[Popup] Pinging local Express server directly from popup...");

    try {
      const pingPayload = {
        action: "PING_TEST",
        client: "popup_direct",
        timestamp: new Date().toISOString()
      };

      const res = await fetch("http://localhost:3000/agent/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pingPayload)
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      }

      const data = await res.json();
      console.log("[Popup] ✅ Direct server response:", data);
      logToUI(`Server reachable! Status: ${data.status}`, "success");
    } catch (err) {
      console.warn("[Popup] ⚠️ Direct server ping error:", err.message);
      logToUI(`Server unreachable (${err.message}). Is 'npm start' running in /server?`, "warn");
    }
  });

  // 3. Clear Logs
  clearLogsBtn.addEventListener("click", () => {
    logsConsole.innerHTML = "";
    logToUI("Logs cleared.", "system");
    updateStatus("idle", "Idle");
  });
});
