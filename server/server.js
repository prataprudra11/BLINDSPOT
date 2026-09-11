// server/server.js - Minimal Express Backend for Chrome Extension
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS so the Chrome Extension (chrome-extension://* or localhost) can make requests
app.use(cors());

// Parse JSON request bodies
app.use(express.json());

// Serve demo portal files (pii_form.html, dashboard.html) directly
app.use(express.static(path.join(__dirname, "..")));

const { planNextAction } = require("./planner");

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[Server] [${timestamp}] 📥 ${req.method} ${req.originalUrl}`);
  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  console.log("[Server] Health check pinged.");
  res.json({
    status: "ok",
    server: "Agent Backend Server",
    timestamp: new Date().toISOString()
  });
});

// Primary POST /agent/act endpoint - Returns structured next action
app.post("/agent/act", (req, res) => {
  const incomingData = req.body || {};
  const timestamp = new Date().toISOString();

  console.log("--------------------------------------------------");
  console.log(`[Server] 🎯 Received /agent/act request at ${timestamp}`);
  console.log("[Server] Incoming Goal:", incomingData.goal || "(none)");
  console.log(`[Server] Elements received: ${incomingData.context?.elements?.length || 0}`);
  console.log("--------------------------------------------------");

  // Handle direct PING tests from popup
  if (incomingData.action === "PING_TEST") {
    return res.status(200).json({
      status: "success",
      message: "Server acknowledged ping test.",
      receivedAt: timestamp,
      echo: incomingData
    });
  }

  // Plan next action if context and goal are provided
  if (incomingData.context || incomingData.goal) {
    const plannedAction = planNextAction(
      incomingData.context,
      incomingData.goal,
      incomingData.history || []
    );

    console.log("[Server] 💡 Planned Next Action:", JSON.stringify(plannedAction, null, 2));

    const responsePayload = {
      status: "success",
      message: "Server planned next action.",
      receivedAt: timestamp,
      action: plannedAction,
      ...plannedAction
    };

    return res.status(200).json(responsePayload);
  }

  // Fallback echo response
  const responsePayload = {
    status: "success",
    message: "Server acknowledged and echoed agent action request.",
    receivedAt: timestamp,
    echo: incomingData
  };

  return res.status(200).json(responsePayload);
});

// Start the server
app.listen(PORT, () => {
  console.log("==================================================");
  console.log(`🚀 Agent Backend Server listening on http://localhost:${PORT}`);
  console.log(`📡 Ready for extension POST requests at http://localhost:${PORT}/agent/act`);
  console.log("==================================================");
});
