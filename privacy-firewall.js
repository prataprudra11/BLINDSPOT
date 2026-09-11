// privacy-firewall.js - Fail-Closed Secondary Privacy Firewall Gate (Manifest V3)
// Runs as an independent second check directly before any network transmission (POST /agent/act).
// Re-scans the full serialized JSON payload against strict PII validators.
// If ANY raw secret slipped past earlier stages, transmission is aborted immediately.

(function (global) {
  /**
   * Luhn (Mod-10 Checksum) validator for financial payment cards.
   */
  function isValidLuhnCard(numberStr) {
    if (typeof numberStr !== "string") return false;
    const clean = numberStr.replace(/\D/g, "");
    if (clean.length < 13 || clean.length > 19) return false;

    let sum = 0;
    let shouldDouble = false;

    for (let i = clean.length - 1; i >= 0; i--) {
      let digit = parseInt(clean.charAt(i), 10);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }

    return sum % 10 === 0;
  }

  /**
   * Independent firewall rules for the final gate.
   * Matches raw PII text while deliberately ignoring safe [REDACTED:...] placeholders.
   */
  const FIREWALL_RULES = [
    // 1. Credit / Debit Cards (16 digits with optional spaces/dashes, verified via Luhn)
    {
      category: "card",
      regex: /\b(?:\d{4}[-\s]+){3}\d{4}\b|\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{16}\b/g,
      validate: isValidLuhnCard
    },
    // 2. Aadhaar Numbers (12 digits, strictly starting with [2-9] per UIDAI rules)
    {
      category: "aadhaar",
      regex: /\b[2-9]\d{3}[-\s]+\d{4}[-\s]+\d{4}\b|\b[2-9]\d{11}\b/g
    },
    // 3. Indian PAN Card (5 letters, 4 digits, 1 letter)
    {
      category: "pan",
      regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g
    },
    // 4. Phone Numbers (Indian mobile [6-9]xx, US/NANP, UK formats)
    {
      category: "phone",
      regex: /(?:\+44[\s.-]*(?:\d[\s.-]*){9,10}\b)|\b(?:\+91[\s.-]*|0[\s.-]*)?[6-9]\d{4}[\s.-]+\d{5}\b|\b(?:\+91[\s.-]*|0[\s.-]*)?[6-9]\d{2}[\s.-]+\d{3}[\s.-]+\d{4}\b|\b(?:\+91[\s.-]*|0[\s.-]*)?[6-9]\d{9}\b|(?:\+1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]+\d{4}\b/g
    },
    // 5. Email Addresses (RFC 5322 compatible)
    {
      category: "email",
      regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    }
  ];

  /**
   * Scans a full outgoing JSON payload before dispatch.
   * 
   * @param {Object|string} payload - The object or JSON string prepared for transmission
   * @returns {{ success: boolean, blocked: boolean, reason?: string, violations?: Array }}
   */
  function runFinalPrivacyScan(payload) {
    if (!payload) {
      return { success: true, blocked: false };
    }

    const payloadString = typeof payload === "string" ? payload : JSON.stringify(payload);
    const violations = [];

    // Rule Check 1: Sensitive element value purge verification
    // Parse object to check if any element with sensitive: true still has a 'value' property
    try {
      const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
      const elements = parsed?.context?.elements || parsed?.elements || [];
      if (Array.isArray(elements)) {
        for (const el of elements) {
          if (!el) continue;
          const isCredential = el.type === "password" || el.category === "password" || el.category === "payment";
          const isPlaceholder = typeof el.value === "string" && (
            /^(EMAIL|PHONE|PERSON|CARD|ADDRESS|PASSWORD|PAN|AADHAAR)_\d+$/i.test(el.value) ||
            /\b(EMAIL|PHONE|PERSON|CARD|ADDRESS|PASSWORD|PAN|AADHAAR)_\d+\b/.test(el.value) ||
            el.value.includes("[REDACTED:")
          );
          const hasUnredactedValue = typeof el.value === "string" && !isPlaceholder;
          if ((isCredential && "value" in el) || (el.sensitive === true && hasUnredactedValue)) {
            violations.push({
              category: el.category || (isCredential ? "password" : "sensitive"),
              elementId: el.id || el.selector || "unknown",
              detail: isCredential 
                ? "Credential element retained a forbidden 'value' property." 
                : "Element flagged sensitive:true retained an unredacted 'value' property."
            });
          }
        }
      }
    } catch (_) {
      // If parsing fails, string regexes below will still catch raw secrets
    }

    // Rule Check 2: Independent regex validation against full serialized JSON string
    for (const rule of FIREWALL_RULES) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(payloadString)) !== null) {
        const candidate = match[0];

        // If rule has an algorithmic validator (e.g. Luhn for credit cards), run it
        if (typeof rule.validate === "function") {
          if (!rule.validate(candidate)) {
            continue; // Candidate failed checksum; safe non-PII string (e.g. SKU, tracking)
          }
        }

        // NOTE: We record category and approximate location, NEVER the raw secret
        violations.push({
          category: rule.category,
          index: match.index,
          detail: `Unredacted ${rule.category} pattern detected in serialized payload.`
        });
      }
    }

    // Fail-Closed Gate: If ANY violation is present, BLOCK the payload
    if (violations.length > 0) {
      return {
        success: false,
        blocked: true,
        reason: "privacy_violation",
        violationsCount: violations.length,
        violations: violations
      };
    }

    return {
      success: true,
      blocked: false
    };
  }

  const PrivacyFirewall = {
    runFinalPrivacyScan,
    isValidLuhnCard,
    FIREWALL_RULES
  };

  // Environment exports (Service Worker self, Browser window, Node.js module)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      runFinalPrivacyScan,
      isValidLuhnCard,
      FIREWALL_RULES,
      PrivacyFirewall
    };
  }
  if (typeof window !== "undefined") {
    window.PrivacyFirewall = PrivacyFirewall;
    window.runFinalPrivacyScan = runFinalPrivacyScan;
  }
  if (typeof self !== "undefined") {
    self.PrivacyFirewall = PrivacyFirewall;
    self.runFinalPrivacyScan = runFinalPrivacyScan;
  }
  if (typeof global !== "undefined") {
    global.PrivacyFirewall = PrivacyFirewall;
    global.runFinalPrivacyScan = runFinalPrivacyScan;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
