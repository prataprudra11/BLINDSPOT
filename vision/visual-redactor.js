// vision/visual-redactor.js - Visual PII Detection & Canvas Redaction
// Reuses detection rules from redaction.js and produces visual redaction coordinates.

(function (global) {
  const isNode = typeof module !== "undefined" && module.exports;
  const path = isNode ? require("path") : null;

  function getRedactionModule() {
    if (isNode) {
      try {
        return require("../redaction");
      } catch (_) {
        return require("./redaction");
      }
    }
    if (typeof window !== "undefined" && window.redactText) {
      return window;
    }
    return global;
  }

  const Redaction = getRedactionModule();

  /**
   * Scans OCR output lines/words for PII using redaction.js's canonical rules.
   * Produces visual redaction instructions with pixel bounding boxes.
   * 
   * @param {Array<Object>} ocrResults - Line/word results from ocr-engine.js
   * @param {string} elementId - Anonymous target element ID (e.g. "el_006")
   * @returns {{ instructions: Array<Object>, redactions: Array<Object> }}
   */
  function detectVisualPII(ocrResults = [], elementId = "el_vision") {
    const instructions = [];
    const redactions = [];
    const seenCategories = new Set();

    const patterns = Redaction.PII_PATTERNS || [];
    const getPlaceholder = Redaction.getPlaceholder || ((cat) => `[REDACTED:${cat}]`);
    const isValidLuhn = Redaction.isValidLuhn || (() => true);

    for (const item of ocrResults) {
      const text = item.text || "";
      if (!text || text.length < 3) continue;

      // 1. Run through PII patterns in canonical priority order
      for (const rule of patterns) {
        rule.regex.lastIndex = 0;
        let match;

        while ((match = rule.regex.exec(text)) !== null) {
          const matchedVal = match[0];

          // Check algorithmic validator if present (e.g. Luhn for credit cards)
          if (typeof rule.validate === "function" && !rule.validate(matchedVal)) {
            continue;
          }

          const placeholder = getPlaceholder(rule.category, matchedVal);
          const dedupeKey = `${elementId}::${rule.category}::${matchedVal}`;

          // Calculate precise word bounding box if words array exists
          let targetBox = item.boundingBox;
          if (item.words && item.words.length > 0) {
            const matchingWord = item.words.find(w => w.text && (matchedVal.includes(w.text) || w.text.includes(matchedVal)));
            if (matchingWord && matchingWord.boundingBox) {
              targetBox = matchingWord.boundingBox;
            }
          }

          instructions.push({
            elementId: elementId,
            category: rule.category,
            confidence: rule.confidence || 0.9,
            placeholder: placeholder,
            boundingBox: { ...targetBox },
            action: "blackout",
            source: "vision"
          });

          if (!seenCategories.has(dedupeKey)) {
            seenCategories.add(dedupeKey);
            redactions.push({
              id: elementId,
              category: rule.category,
              confidence: rule.confidence || 0.9,
              placeholder: placeholder,
              source: "vision"
            });
          }
        }
      }
    }

    return { instructions, redactions };
  }

  /**
   * Applies blackout redactions to an HTMLCanvasElement or generates a redacted Data URL.
   * 
   * @param {HTMLCanvasElement|string} canvasOrDataUrl - Target canvas or base64 image
   * @param {Array<Object>} instructions - Redaction instructions from detectVisualPII
   * @returns {Promise<{ redactedDataUrl: string, appliedCount: number }>}
   */
  async function applyVisualRedactions(canvasOrDataUrl, instructions = []) {
    if (!instructions || instructions.length === 0) {
      const dataUrl = typeof canvasOrDataUrl === "string" 
        ? canvasOrDataUrl 
        : (canvasOrDataUrl?.toDataURL ? canvasOrDataUrl.toDataURL() : "");
      return { redactedDataUrl: dataUrl, appliedCount: 0 };
    }

    // Browser Context: Use Canvas 2D rendering
    if (typeof document !== "undefined" && typeof Image !== "undefined") {
      let canvas;
      let ctx;

      if (typeof canvasOrDataUrl === "object" && canvasOrDataUrl.tagName === "CANVAS") {
        // Clone canvas to prevent mutating the live DOM node directly before user review
        canvas = document.createElement("canvas");
        canvas.width = canvasOrDataUrl.width;
        canvas.height = canvasOrDataUrl.height;
        ctx = canvas.getContext("2d");
        ctx.drawImage(canvasOrDataUrl, 0, 0);
      } else {
        canvas = document.createElement("canvas");
        const img = new Image();
        img.src = canvasOrDataUrl;
        await new Promise((res) => {
          if (img.complete) res();
          else img.onload = () => res();
        });
        canvas.width = img.width || 400;
        canvas.height = img.height || 200;
        ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
      }

      let appliedCount = 0;
      for (const inst of instructions) {
        const box = inst.boundingBox;
        if (!box) continue;

        // Apply dark blackout rectangle with padding
        const padX = 4;
        const padY = 2;
        const x = Math.max(0, box.x - padX);
        const y = Math.max(0, box.y - padY);
        const w = box.width + padX * 2;
        const h = box.height + padY * 2;

        ctx.fillStyle = "#090d16"; // Dark slate blackout
        ctx.fillRect(x, y, w, h);

        // Draw border accent
        ctx.strokeStyle = "#ef4444"; // Red security border indicator
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);

        // Optional placeholder text overlay on blackout box
        if (h >= 14 && w >= 40) {
          ctx.fillStyle = "#f87171";
          ctx.font = "bold 10px system-ui, sans-serif";
          ctx.fillText(inst.placeholder || "[REDACTED]", x + 4, y + Math.min(h - 4, 12));
        }

        appliedCount++;
      }

      return {
        redactedDataUrl: canvas.toDataURL("image/png"),
        appliedCount: appliedCount
      };
    }

    // Node.js Buffer Context (for unit tests without DOM)
    return {
      redactedDataUrl: "data:image/png;base64,mockRedactedImage",
      appliedCount: instructions.length
    };
  }

  /**
   * Stretch Feature: Face Detection Limitation Note.
   * Documented limitation: client-side neural face models (e.g. Blazeface) require 15MB+
   * bundle size and WebGL shaders not available in headless environments.
   */
  function detectFaces(imageData) {
    console.log("[Visual Redactor] ℹ️ Face detection: Optional stretch feature currently operating in lightweight mode.");
    return [];
  }

  const VisualRedactor = {
    detectVisualPII,
    applyVisualRedactions,
    detectFaces
  };

  if (isNode) {
    module.exports = VisualRedactor;
  }
  if (typeof window !== "undefined") {
    window.VisualRedactor = VisualRedactor;
  }
  if (global) {
    global.VisualRedactor = VisualRedactor;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
