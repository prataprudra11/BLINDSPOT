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

  // Telemetry elements
  const telemetryStep = document.getElementById("telemetryStep");
  const telemetryAction = document.getElementById("telemetryAction");
  const telemetryRejectionBox = document.getElementById("telemetryRejectionBox");
  const telemetryRejection = document.getElementById("telemetryRejection");

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
      if (telemetryRejectionBox) telemetryRejectionBox.classList.add("hidden");
    } else {
      startBtn.disabled = false;
      btnSpinner.classList.add("hidden");
    }
  }

  // Helper: Update telemetry UI values
  function updateTelemetry(step, maxSteps, lastAction, rejection) {
    if (telemetryStep && step !== undefined) {
      telemetryStep.textContent = `${step} / ${maxSteps || 10}`;
    }
    if (telemetryAction && lastAction) {
      telemetryAction.textContent = lastAction;
    }
    if (telemetryRejectionBox && telemetryRejection) {
      if (rejection) {
        telemetryRejection.textContent = rejection;
        telemetryRejectionBox.classList.remove("hidden");
      } else {
        telemetryRejectionBox.classList.add("hidden");
      }
    }
  }

  // Listen for real-time progress updates broadcast by background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "LOOP_STEP_UPDATE") {
      updateTelemetry(message.step, message.maxSteps, message.lastAction, message.rejectionReason);

      if (message.rejectionReason) {
        logToUI(`⚠️ Validator Rejected: ${message.rejectionReason}`, "warn");
      } else if (message.message) {
        const logType = message.status === "failed" || message.status === "blocked" 
          ? "error" 
          : (message.status === "completed" ? "success" : "info");
        logToUI(message.message, logType);
      }
    }
  });

  // 1. Handle "Start Agent" Button Click (Initiates closed loop)
  startBtn.addEventListener("click", () => {
    const goal = taskGoalInput.value.trim();
    if (!goal) {
      logToUI("Please enter a valid task goal first.", "warn");
      taskGoalInput.focus();
      return;
    }

    logToUI(`Initiating task loop: "${goal}"`, "info");
    console.log("[Popup] 🚀 Dispatching START_TASK to background service worker with goal:", goal);
    setLoading(true);
    updateTelemetry(0, 10, "Starting...", null);

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

        console.log("[Popup] 📥 Final response from background worker:", response);

        const data = response?.data;
        const finalStep = data?.stepCount !== undefined ? data.stepCount : 0;
        const lastAction = data?.history && data.history.length > 0 
          ? `${data.history[data.history.length - 1].action.action} ${data.history[data.history.length - 1].action.target || ""}`.trim()
          : "Completed";

        updateTelemetry(finalStep, data?.maxSteps || 10, lastAction, data?.status === "rejected" ? data.stopReason : null);

        if (response && response.status === "success") {
          logToUI(`Loop finished successfully: ${response.message || "Goal completed"}`, "success");
          updateStatus("success", "Done");
        } else if (response && response.status === "blocked") {
          logToUI(`Privacy Firewall Blocked transmission: ${response.message}`, "error");
          updateStatus("error", "Blocked");
        } else {
          const errMsg = response?.message || "Loop stopped with error";
          logToUI(`Task ended: ${errMsg}`, data?.status === "rejected" ? "warn" : "error");
          updateStatus("error", data?.status === "rejected" ? "Rejected" : "Failed");
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
    updateTelemetry(0, 10, "None", null);
    updateStatus("idle", "Idle");
  });
});
