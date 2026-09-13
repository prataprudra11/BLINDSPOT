// vision/ocr-engine.js - Local OCR Engine using bundled Tesseract.js
// Runs purely local OCR without remote CDN calls or model downloads.

(function (global) {
  const isNode = typeof module !== "undefined" && module.exports;
  const path = isNode ? require("path") : null;
  const Tesseract = isNode 
    ? require("tesseract.js") 
    : (global.Tesseract || (typeof window !== "undefined" ? window.Tesseract : null));

  let cachedWorker = null;

  /**
   * Initializes or returns a shared offline Tesseract worker.
   */
  async function getWorker(customOptions = {}) {
    if (cachedWorker) return cachedWorker;

    let workerOptions = {
      cacheMethod: "none",
      workerBlobURL: false, // CRITICAL: in MV3 Chrome extensions, blob URLs cause NetworkError on importScripts
      ...customOptions
    };

    if (isNode) {
      const localLangPath = path.join(__dirname, "vendor", "tessdata");
      workerOptions.langPath = workerOptions.langPath || localLangPath;
    } else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      workerOptions.workerPath = workerOptions.workerPath || chrome.runtime.getURL("vision/vendor/worker.min.js");
      workerOptions.corePath = workerOptions.corePath || chrome.runtime.getURL("vision/vendor/tesseract-core.wasm.js");
      workerOptions.langPath = workerOptions.langPath || chrome.runtime.getURL("vision/vendor/tessdata");
    }

    workerOptions.errorHandler = workerOptions.errorHandler || ((err) => {
      console.error("[OCR Engine] ❌ Tesseract worker internal event/error:", err);
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({
            type: "OCR_ERROR_EVENT",
            error: err ? (err.message || String(err)) : "Unknown Tesseract worker error"
          });
        } catch (_) {}
      }
    });

    if (!workerOptions.logger) {
      workerOptions.logger = (m) => {
        if (m && m.status) {
          const pct = Math.round((m.progress || 0) * 100);
          console.log(`[OCR Engine] ⏳ ${m.status}: ${pct}%`);
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            try {
              chrome.runtime.sendMessage({
                type: "OCR_PROGRESS_UPDATE",
                status: m.status,
                progress: pct,
                timestamp: Date.now()
              }, () => {
                if (chrome.runtime.lastError) {} // Ignore if popup/listeners closed
              });
            } catch (_) {}
          }
        }
      };
    }

    console.log("[OCR Engine] 🛠️ Initializing Tesseract worker with options:", {
      workerPath: workerOptions.workerPath,
      corePath: workerOptions.corePath,
      langPath: workerOptions.langPath,
      workerBlobURL: workerOptions.workerBlobURL
    });

    const initStart = Date.now();
    cachedWorker = await Tesseract.createWorker("eng", 1, workerOptions);
    console.log(`[OCR Engine] ✅ Tesseract worker initialized successfully in ${Date.now() - initStart}ms.`);
    return cachedWorker;
  }

  /**
   * Terminates the cached worker (used during shutdown or test cleanup).
   */
  async function terminateWorker() {
    if (cachedWorker) {
      try {
        await cachedWorker.terminate();
      } catch (_) {}
      cachedWorker = null;
    }
  }

  /**
   * Runs local OCR on a given image source with timeout protection.
   * 
   * @param {HTMLCanvasElement|HTMLImageElement|string|Buffer} imageSource - The target image
   * @param {Object} [options] - Options including timeoutMs
   * @returns {Promise<Array<{ text: string, confidence: number, boundingBox: {x: number, y: number, width: number, height: number} }>>}
   */
  async function runOCR(imageSource, options = {}) {
    const timeoutMs = options.timeoutMs || 25000;

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`OCR scan timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const ocrExecution = (async () => {
        const ocrStartTime = Date.now();
        const worker = await getWorker(options.workerOptions);
        console.log(`[OCR Engine] 🔍 Starting recognize() call...`);
        const ret = await worker.recognize(imageSource, {}, { text: true, blocks: true });
        console.log(`[OCR Engine] ✅ recognize() completed in ${Date.now() - ocrStartTime}ms.`);
        
        const results = [];
        const blocks = ret?.data?.blocks || [];

        for (const block of blocks) {
          const paragraphs = block.paragraphs || [];
          for (const para of paragraphs) {
            const lines = para.lines || [];
            for (const line of lines) {
              const text = (line.text || "").trim();
              if (!text) continue;

              const bbox = line.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
              results.push({
                text: text,
                confidence: Math.round(line.confidence || ret.data.confidence || 0),
                boundingBox: {
                  x: bbox.x0,
                  y: bbox.y0,
                  width: Math.max(0, bbox.x1 - bbox.x0),
                  height: Math.max(0, bbox.y1 - bbox.y0)
                },
                words: (line.words || []).map(w => ({
                  text: (w.text || "").trim(),
                  confidence: Math.round(w.confidence || 0),
                  boundingBox: {
                    x: w.bbox?.x0 || 0,
                    y: w.bbox?.y0 || 0,
                    width: Math.max(0, (w.bbox?.x1 || 0) - (w.bbox?.x0 || 0)),
                    height: Math.max(0, (w.bbox?.y1 || 0) - (w.bbox?.y0 || 0))
                  }
                }))
              });
            }
          }
        }

        // Fallback: If no lines were parsed but top-level text is present
        if (results.length === 0 && ret?.data?.text && ret.data.text.trim()) {
          results.push({
            text: ret.data.text.trim(),
            confidence: Math.round(ret.data.confidence || 0),
            boundingBox: { x: 0, y: 0, width: 100, height: 40 },
            words: []
          });
        }

        // Expose raw unrecognized text and confidence on the results array
        results.rawText = ret?.data?.text || results.map(r => r.text).join("\n");
        results.confidence = ret?.data?.confidence !== undefined ? Math.round(ret.data.confidence) : (results.length > 0 ? results[0].confidence : 0);

        return results;
      })();

      const results = await Promise.race([ocrExecution, timeoutPromise]);
      return results;
    } catch (err) {
      await terminateWorker();
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const OCREngine = {
    runOCR,
    getWorker,
    terminateWorker
  };

  if (isNode) {
    module.exports = OCREngine;
  }
  if (typeof window !== "undefined") {
    window.OCREngine = OCREngine;
  }
  if (global) {
    global.OCREngine = OCREngine;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
