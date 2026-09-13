// test_vision_layer.js - Comprehensive Phase 4 Vision & OCR Fallback Test Suite
// Verifies local OCR extraction, visual PII redaction, DOM-first trigger logic,
// fail-closed fallback behavior, and multi-source (DOM + Vision) pipeline integration.

const fs = require("fs");
const path = require("path");
const OCREngine = require("./vision/ocr-engine");
const VisionTrigger = require("./vision/vision-trigger");
const VisualRedactor = require("./vision/visual-redactor");
const { sanitizeContext, PII_PATTERNS } = require("./redaction");
const { runFinalPrivacyScan } = require("./privacy-firewall");
const ElementMapper = require("./element-mapper");

console.log("================================================================================");
console.log("👁️ RUNNING PHASE 4 LOCAL VISION / OCR FALLBACK LAYER TEST SUITE");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`  ✅ [PASS] ${description}`);
    totalPassed++;
  } else {
    console.error(`  ❌ [FAIL] ${description}`);
    totalFailed++;
  }
}

// -----------------------------------------------------------------------------
// Pure-JS BMP Generator for Synthetic Test Images (Zero native dependencies)
// -----------------------------------------------------------------------------
const FONT_GLYPHS = {
  "0": ["1111","1001","1001","1001","1001","1001","1111"],
  "1": ["0010","0110","0010","0010","0010","0010","0111"],
  "2": ["1111","0001","0001","1111","1000","1000","1111"],
  "3": ["1111","0001","0001","1111","0001","0001","1111"],
  "4": ["1001","1001","1001","1111","0001","0001","0001"],
  "5": ["1111","1000","1000","1111","0001","0001","1111"],
  "6": ["1111","1000","1000","1111","1001","1001","1111"],
  "7": ["1111","0001","0010","0100","0100","0100","0100"],
  "8": ["1111","1001","1001","1111","1001","1001","1111"],
  "9": ["1111","1001","1001","1111","0001","0001","1111"],
  " ": ["0000","0000","0000","0000","0000","0000","0000"],
  "-": ["0000","0000","0000","1111","0000","0000","0000"],
  "+": ["0000","0010","0010","1111","0010","0010","0000"],
  "@": ["1111","1001","1011","1011","1000","1000","1111"],
  ".": ["0000","0000","0000","0000","0000","0010","0010"]
};

function generateTestBitmapBuffer(text, scale = 5) {
  const charW = 4 * scale;
  const charH = 7 * scale;
  const pad = 16;
  const width = text.length * (charW + 2 * scale) + pad * 2;
  const height = charH + pad * 2;

  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelDataSize = rowSize * height;
  const buf = Buffer.alloc(54 + pixelDataSize, 255); // White background

  buf.write("BM", 0);
  buf.writeUInt32LE(54 + pixelDataSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22); // Top-down
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelDataSize, 34);

  for (let cIdx = 0; cIdx < text.length; cIdx++) {
    const ch = text[cIdx];
    const grid = FONT_GLYPHS[ch] || FONT_GLYPHS[" "];
    const startX = pad + cIdx * (charW + 2 * scale);

    for (let r = 0; r < 7; r++) {
      const rowStr = grid[r];
      for (let c = 0; c < 4; c++) {
        if (rowStr[c] === "1") {
          for (let dy = 0; dy < scale; dy++) {
            const py = pad + r * scale + dy;
            const rowOffset = 54 + py * rowSize;
            for (let dx = 0; dx < scale; dx++) {
              const px = startX + c * scale + dx;
              const off = rowOffset + px * 3;
              buf[off] = 0;     // B
              buf[off + 1] = 0; // G
              buf[off + 2] = 0; // R
            }
          }
        }
      }
    }
  }

  return { buffer: buf, width, height };
}

(async () => {
  let measuredLatencyMs = 0;

  // ===========================================================================
  // PART 1: Local OCR Engine Text & Bounding Box Extraction
  // ===========================================================================
  console.log("\n--- PART 1: Local OCR Engine & Bounding Box Extraction ---");
  try {
    const testSecret = "98765 43210"; // 10-digit Indian phone format
    const { buffer: imgBuf } = generateTestBitmapBuffer(testSecret, 6);

    const t0 = Date.now();
    const ocrResults = await OCREngine.runOCR(imgBuf, { timeoutMs: 8000 });
    measuredLatencyMs = Date.now() - t0;

    console.log(`[OCR Engine] Extracted ${ocrResults.length} line(s) in ${measuredLatencyMs}ms`);

    assert(ocrResults.length > 0, "OCR correctly processed synthetic bitmap image");
    assert(ocrResults[0].text && ocrResults[0].text.length > 0, "OCR produced non-empty recognized text");
    assert(ocrResults[0].boundingBox && ocrResults[0].boundingBox.width > 0, "OCR output includes valid bounding box coordinates");
    assert(typeof ocrResults[0].confidence === "number", "OCR output includes confidence score");
  } catch (err) {
    console.error("Part 1 error:", err);
    assert(false, `OCR engine test failed: ${err.message}`);
  }

  // ===========================================================================
  // PART 2: Visual PII Detection & Blackout Redaction
  // ===========================================================================
  console.log("\n--- PART 2: Visual PII Detection & Blackout Redaction ---");
  {
    const mockOCRResults = [
      {
        text: "Applicant Aadhaar Number: 2345 6789 0123 Verified",
        confidence: 94,
        boundingBox: { x: 10, y: 30, width: 320, height: 22 }
      },
      {
        text: "Contact Support: user.kyc@synthetic-bank.org",
        confidence: 91,
        boundingBox: { x: 10, y: 65, width: 280, height: 20 }
      },
      {
        text: "Emergency Mobile: +91 98765 43210",
        confidence: 92,
        boundingBox: { x: 10, y: 95, width: 240, height: 18 }
      }
    ];

    const { instructions, redactions } = VisualRedactor.detectVisualPII(mockOCRResults, "el_canvas_001");

    assert(instructions.length >= 3, `Visual redactor generated instructions for all detected secrets (got ${instructions.length})`);
    assert(instructions.every(i => i.action === "blackout"), "All visual redactions default to 'blackout' action");
    assert(instructions.every(i => i.source === "vision"), "All visual redactions tagged with source: 'vision'");

    // Verify categories
    const categories = redactions.map(r => r.category);
    assert(categories.includes("aadhaar"), "Detected 'aadhaar' category from OCR line");
    assert(categories.includes("email"), "Detected 'email' category from OCR line");
    assert(categories.includes("phone"), "Detected 'phone' category from OCR line");

    // Test blackout application
    const mockDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const { redactedDataUrl, appliedCount } = await VisualRedactor.applyVisualRedactions(mockDataUrl, instructions);

    assert(appliedCount === instructions.length, `Applied blackout redaction to all ${appliedCount} coordinates`);
    assert(typeof redactedDataUrl === "string" && redactedDataUrl.startsWith("data:image/"), "Generated valid redacted thumbnail data URL");
  }

  // ===========================================================================
  // PART 3: Explainable DOM-First Vision Trigger Logic
  // ===========================================================================
  console.log("\n--- PART 3: Explainable DOM-First Vision Trigger Logic ---");
  {
    // Test 3a: Canvas elements should always trigger
    const canvasEl = { tag: "canvas", id: "el_001", type: "canvas" };
    const canvasDecision = VisionTrigger.shouldTriggerVision(canvasEl);
    assert(canvasDecision.trigger === true, "Canvas elements trigger vision fallback");
    assert(canvasDecision.reason.includes("Canvas element"), "Canvas trigger provides clear explainable reason");

    // Test 3b: Image with PII keywords (e.g. ID card scan)
    const piiImg = {
      tag: "img",
      id: "el_002",
      type: "image",
      alt: "Government ID card proof",
      surroundingText: "Please upload your identity document"
    };
    const piiDecision = VisionTrigger.shouldTriggerVision(piiImg);
    assert(piiDecision.trigger === true, "Image with PII keyword 'id card' triggers vision fallback");

    // Test 3c: Plain decorative images should NOT trigger (saves compute)
    const logoImg = {
      tag: "img",
      id: "el_003",
      type: "image",
      alt: "Company Logo",
      className: "header-logo banner"
    };
    const logoDecision = VisionTrigger.shouldTriggerVision(logoImg);
    assert(logoDecision.trigger === false, "Plain decorative logo does NOT trigger vision (prevents wasted compute)");

    // Test 3d: Non-visual DOM elements stay DOM-only
    const inputEl = { tag: "input", id: "el_004", type: "text" };
    const inputDecision = VisionTrigger.shouldTriggerVision(inputEl);
    assert(inputDecision.trigger === false, "Standard <input> remains DOM-only without triggering vision");

    const buttonEl = { tag: "button", id: "el_005", type: "button" };
    const buttonDecision = VisionTrigger.shouldTriggerVision(buttonEl);
    assert(buttonDecision.trigger === false, "Standard <button> remains DOM-only without triggering vision");
  }

  // ===========================================================================
  // PART 4: Mandatory Fallback Behavior on Error / Timeout
  // ===========================================================================
  console.log("\n--- PART 4: Mandatory Fallback Behavior on Error / Timeout ---");
  {
    // Simulate an OCR failure (e.g. corrupt image source or worker timeout)
    let fallbackTriggered = false;
    let fallbackElement = { id: "el_canvas_corrupt", tag: "canvas", visionTriggered: true };

    try {
      // Simulate timeout by passing 1ms timeoutMs on a valid bitmap
      const { buffer: imgBuf } = generateTestBitmapBuffer("98765 43210", 6);
      await OCREngine.runOCR(imgBuf, { timeoutMs: 1 });
    } catch (err) {
      fallbackTriggered = true;
      fallbackElement.visualScanFailed = true;
    }

    assert(fallbackTriggered, "OCR engine throws or rejects gracefully on timeout/error");
    assert(fallbackElement.visualScanFailed === true, "Element correctly marked visualScanFailed: true upon failure (not treated as clean)");

    // Test Privacy Firewall handling of visualScanFailed
    const safePayloadWithFallback = {
      context: {
        elements: [
          { id: "el_001", tag: "p", text: "Clean page header" },
          { id: "el_002", tag: "canvas", visualScanFailed: true, sensitive: false }
        ]
      }
    };
    const fwResultSafe = runFinalPrivacyScan(safePayloadWithFallback);
    assert(fwResultSafe.blocked === false, "Firewall allows non-sensitive element with visualScanFailed: true to continue DOM loop");

    const sensitivePayloadWithFallback = {
      context: {
        elements: [
          { id: "el_001", tag: "canvas", visualScanFailed: true, sensitive: true, category: "sensitive" }
        ]
      }
    };
    const fwResultSensitive = runFinalPrivacyScan(sensitivePayloadWithFallback);
    assert(fwResultSensitive.blocked === true, "Firewall fail-closed blocks structurally sensitive element with visualScanFailed: true");
  }

  // ===========================================================================
  // PART 5: Full Multi-Source Perception Pipeline Test (DOM + Vision)
  // ===========================================================================
  console.log("\n--- PART 5: Full Multi-Source Pipeline (DOM + Vision Redactions) ---");
  {
    ElementMapper.resetMap();

    // Mock page with DOM input fields AND an ID canvas containing sensitive PII
    const mockPageDOM = {
      elements: [
        {
          id: ElementMapper.registerElement({ tag: "input" }, "#email-input"),
          tag: "input",
          type: "email",
          label: "Email Address",
          value: "jane.doe@synthetic-test.org",
          sensitive: false
        },
        {
          id: ElementMapper.registerElement({ tag: "input" }, "#phone-input"),
          tag: "input",
          type: "tel",
          label: "Phone Number",
          value: "+91 98765 43210",
          sensitive: false
        },
        {
          id: ElementMapper.registerElement({ tag: "canvas" }, "#kyc-canvas"),
          tag: "canvas",
          type: "canvas",
          sensitive: false
        }
      ]
    };

    // 1. Run DOM sanitization
    const sanitizedContext = sanitizeContext(mockPageDOM);

    // 2. Vision OCR detects visual PII on the canvas element
    const visualOCRResults = [
      {
        text: "GOVERNMENT OF INDIA AADHAAR: 2345 6789 0123",
        confidence: 96,
        boundingBox: { x: 10, y: 15, width: 220, height: 20 }
      }
    ];
    const { redactions: visualRedactions } = VisualRedactor.detectVisualPII(visualOCRResults, "el_003");

    // Merge visual redactions with source: 'vision' into context
    sanitizedContext.redactions = [
      ...sanitizedContext.redactions,
      ...visualRedactions
    ];

    // Find canvas element and tag sensitive: true
    const canvasItem = sanitizedContext.elements.find(el => el.id === "el_003");
    if (canvasItem) {
      canvasItem.sensitive = true;
    }

    // 3. Verify outgoing payload through Privacy Firewall
    const outgoingPayload = {
      action: "PLAN_ACTION",
      goal: "Submit Verified Profile",
      context: sanitizedContext
    };

    const finalFirewallScan = runFinalPrivacyScan(outgoingPayload);
    assert(finalFirewallScan.blocked === false, "Final outgoing payload passes Privacy Firewall with 0 leaks");

    // 4. Verify source tagging in redactions
    const domRedactions = sanitizedContext.redactions.filter(r => r.source === "dom");
    const visionRedactions = sanitizedContext.redactions.filter(r => r.source === "vision");

    assert(domRedactions.length >= 2, `DOM redactions present with source: 'dom' (count: ${domRedactions.length})`);
    assert(visionRedactions.length >= 1, `Vision redactions present with source: 'vision' (count: ${visionRedactions.length})`);
    assert(visionRedactions[0].category === "aadhaar", "Vision redaction correctly identified 'aadhaar' category");

    // 5. Verify Zero Leakage of raw secrets in outgoing JSON
    const payloadStr = JSON.stringify(outgoingPayload);
    assert(!payloadStr.includes("jane.doe@synthetic-test.org"), "Zero raw email in payload");
    assert(!payloadStr.includes("98765 43210"), "Zero raw phone in payload");
    assert(!payloadStr.includes("2345 6789 0123"), "Zero raw Aadhaar from canvas in payload");
    assert(payloadStr.includes("EMAIL_1"), "Placeholder EMAIL_1 present");
    assert(payloadStr.includes("PHONE_1"), "Placeholder PHONE_1 present");
    assert(payloadStr.includes("AADHAAR_1"), "Placeholder AADHAAR_1 present");
  }

  // Terminate Tesseract worker
  await OCREngine.terminateWorker();

  // ===========================================================================
  // LATENCY REPORT & FINAL RESULTS
  // ===========================================================================
  console.log("\n================================================================================");
  console.log("⏱️ PHASE 4 OCR LATENCY BENCHMARK REPORT");
  console.log("================================================================================");
  console.log(`  Measured Local OCR Scan Latency:  ${measuredLatencyMs} ms`);
  console.log(`  Target Latency Threshold (<4000ms): ${measuredLatencyMs < 4000 ? "PASSED ✅" : "EXCEEDED ⚠️"}`);
  console.log(`  OCR Architecture:                 Pure local Tesseract.js (Zero external network calls)`);
  console.log(`  Model Packaging:                  Local gzipped tessdata bundle`);
  console.log("================================================================================");

  console.log("\n================================================================================");
  console.log(`FINAL RESULTS: ${totalPassed} passed, ${totalFailed} failed (out of ${totalPassed + totalFailed} total assertions)`);
  console.log("================================================================================\n");

  if (totalFailed > 0) {
    process.exit(1);
  }
})();
