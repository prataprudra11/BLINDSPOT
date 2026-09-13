console.log("[Offscreen OCR] 🚀 offscreen.js script loaded and initialized in offscreen document.");

try {
  const testWasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  console.log("[Offscreen OCR] ✅ WebAssembly.Module compilation test passed in offscreen document.");
} catch (wasmErr) {
  console.error("[Offscreen OCR] ❌ WebAssembly compilation blocked or failed in offscreen document:", wasmErr);
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[Offscreen OCR] 📨 onMessage received in offscreen document. Type:", message?.type, "from sender:", sender);
    if (message.type === "OFFSCREEN_PROCESS_OCR" || message.type === "PROCESS_VISION_OCR") {
      const startTime = Date.now();
      const elementId = message.elementId || "unknown";
      const dataUrl = message.dataUrl;
      const timeoutMs = message.timeoutMs || 25000;

      console.log(`[Offscreen OCR] 🔍 Processing visual OCR request for ${elementId}... (dataUrl len: ${dataUrl ? dataUrl.length : 0}, timeout: ${timeoutMs}ms)`);

      (async () => {
        try {
          if (!dataUrl) {
            throw new Error("No image dataUrl provided for OCR processing.");
          }

          // 1. Run local Tesseract OCR
          const ocrResults = await window.OCREngine.runOCR(dataUrl, { timeoutMs });
          const ocrLatency = Date.now() - startTime;

          // 2. Detect visual PII matches using shared canonical patterns
          const { instructions, redactions } = window.VisualRedactor.detectVisualPII(ocrResults, elementId);

          // 3. Generate redacted image thumbnail
          const { redactedDataUrl, appliedCount } = await window.VisualRedactor.applyVisualRedactions(dataUrl, instructions);

          console.log(`[Offscreen OCR] ✅ OCR complete for ${elementId} (${ocrLatency}ms): ${redactions.length} visual redaction(s) detected.`);

          const rawText = ocrResults.rawText || (Array.isArray(ocrResults) ? ocrResults.map(r => r.text).join("\n") : "");
          const confidence = ocrResults.confidence !== undefined ? ocrResults.confidence : (Array.isArray(ocrResults) && ocrResults.length > 0 ? ocrResults[0].confidence : 0);

          sendResponse({
            success: true,
            elementId: elementId,
            rawText: rawText,
            confidence: confidence,
            ocrLatencyMs: ocrLatency,
            instructions: instructions,
            redactions: redactions,
            originalDataUrl: dataUrl,
            redactedDataUrl: redactedDataUrl,
            appliedCount: appliedCount
          });
        } catch (err) {
          console.error(`[Offscreen OCR] ❌ OCR failed or timed out for ${elementId}:`, {
            name: err?.name,
            message: err?.message,
            stack: err?.stack,
            fullError: err
          });
          sendResponse({
            success: false,
            elementId: elementId,
            error: err ? (err.message || String(err)) : "Unknown offscreen error",
            errorName: err?.name,
            errorStack: err?.stack,
            visualScanFailed: true
          });
        }
      })();

      return true; // Keep message channel open for asynchronous response
    }
  });
}
