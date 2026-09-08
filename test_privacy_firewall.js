// test_privacy_firewall.js - Unit Test Suite for Fail-Closed Privacy Firewall & Element Mapper
const { runFinalPrivacyScan } = require("./privacy-firewall.js");
const ElementMapper = require("./element-mapper.js");

console.log("================================================================================");
console.log("🛡️ RUNNING FAIL-CLOSED PRIVACY FIREWALL & ELEMENT MAPPER TEST SUITE");
console.log("================================================================================\n");

let allPassed = true;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    console.error(`  ❌ [FAIL] ${label}`);
    allPassed = false;
  }
}

// ============================================================================
// PART 1: Element Mapper Dynamic Reset & Anonymous ID Verification
// ============================================================================
console.log("--- PART 1: Element Mapper Unit Tests ---");

ElementMapper.resetMap();
check("ElementMapper starts empty after reset", ElementMapper.getMapSize() === 0);

const mockNodeA = { nodeName: "INPUT", id: "username" };
const mockNodeB = { nodeName: "BUTTON", id: "submit" };

const idA = ElementMapper.registerElement(mockNodeA, "#username");
const idB = ElementMapper.registerElement(mockNodeB, "#submit");

check("Registers first element as el_001", idA === "el_001");
check("Registers second element as el_002", idB === "el_002");
check("Map size is 2 after registration", ElementMapper.getMapSize() === 2);
check("getElement('el_001') resolves to original mockNodeA", ElementMapper.getElement("el_001") === mockNodeA);
check("getElement('el_002') resolves to original mockNodeB", ElementMapper.getElement("el_002") === mockNodeB);
check("Local selector stored in memory", ElementMapper.getLocalSelector("el_001") === "#username");

// TEST DYNAMIC RESET: Verify stale references are eliminated on fresh scan
ElementMapper.resetMap();
check("resetMap() clears element map completely", ElementMapper.getMapSize() === 0);
check("getElement returns null after reset", ElementMapper.getElement("el_001") === null);

const freshNode = { nodeName: "FORM", id: "checkout" };
const freshId = ElementMapper.registerElement(freshNode, "#checkout");
check("Counter resets back to el_001 on fresh perception scan", freshId === "el_001");

// ============================================================================
// PART 2: Privacy Firewall Interception Tests (Sneaking PII past redaction)
// ============================================================================
console.log("\n--- PART 2: Fail-Closed Privacy Firewall Interception Tests ---");

// Test Case 1: Legitimate Sanitized Payload (Should PASS)
const cleanSanitizedPayload = {
  action: "INITIATE_TASK",
  goal: "Verify clean sanitized elements",
  context: {
    url: "https://demo.internal/clean",
    title: "Clean Page",
    totalElements: 2,
    elements: [
      { id: "el_001", tag: "input", type: "text", text: "Full Name", value: "[REDACTED:name]" },
      { id: "el_002", tag: "input", type: "email", text: "Email Address", value: "[REDACTED:email]" }
    ],
    redactions: [
      { id: "el_001", category: "name", confidence: 0.7 },
      { id: "el_002", category: "email", confidence: 1.0 }
    ]
  }
};

const cleanScan = runFinalPrivacyScan(cleanSanitizedPayload);
check("Clean sanitized payload passes firewall (blocked: false)", cleanScan.blocked === false && cleanScan.success === true);

// Test Case 2: Sneak raw Email past redaction
const sneakedEmailPayload = {
  action: "INITIATE_TASK",
  context: {
    elements: [
      { id: "el_001", tag: "p", type: "text block", text: "Notice sent to john.doe@secret-leak.org yesterday." }
    ]
  }
};
const emailScan = runFinalPrivacyScan(sneakedEmailPayload);
check("Blocks sneaked raw email", emailScan.blocked === true && emailScan.reason === "privacy_violation");
check("Identifies email category in violations", emailScan.violations?.some(v => v.category === "email"));

// Test Case 3: Sneak raw Luhn-valid Card past redaction
const sneakedCardPayload = {
  action: "INITIATE_TASK",
  context: {
    elements: [
      { id: "el_001", tag: "p", type: "text block", text: "Charged to card 4532 0151 1283 0366 successfully." }
    ]
  }
};
const cardScan = runFinalPrivacyScan(sneakedCardPayload);
check("Blocks sneaked raw Luhn-valid card number", cardScan.blocked === true && cardScan.reason === "privacy_violation");
check("Identifies card category in violations", cardScan.violations?.some(v => v.category === "card"));

// Test Case 4: Sneak raw Indian Mobile Number past redaction
const sneakedPhonePayload = {
  action: "INITIATE_TASK",
  context: {
    elements: [
      { id: "el_001", tag: "span", type: "text", text: "Call dispatch at +91 9876543210 immediately." }
    ]
  }
};
const phoneScan = runFinalPrivacyScan(sneakedPhonePayload);
check("Blocks sneaked raw Indian phone number", phoneScan.blocked === true && phoneScan.reason === "privacy_violation");
check("Identifies phone category in violations", phoneScan.violations?.some(v => v.category === "phone"));

// Test Case 5: Sneak raw UIDAI Aadhaar number past redaction
const sneakedAadhaarPayload = {
  action: "INITIATE_TASK",
  context: {
    elements: [
      { id: "el_001", tag: "p", type: "text", text: "KYC ID: 2345 6789 0123 registered." }
    ]
  }
};
const aadhaarScan = runFinalPrivacyScan(sneakedAadhaarPayload);
check("Blocks sneaked raw Aadhaar number", aadhaarScan.blocked === true && aadhaarScan.reason === "privacy_violation");
check("Identifies aadhaar category in violations", aadhaarScan.violations?.some(v => v.category === "aadhaar"));

// Test Case 6: Sneak raw Indian PAN card number past redaction
const sneakedPanPayload = {
  action: "INITIATE_TASK",
  context: {
    elements: [
      { id: "el_001", tag: "p", type: "text", text: "Tax identifier: ABCDE1234F on record." }
    ]
  }
};
const panScan = runFinalPrivacyScan(sneakedPanPayload);
check("Blocks sneaked raw PAN card", panScan.blocked === true && panScan.reason === "privacy_violation");
check("Identifies pan category in violations", panScan.violations?.some(v => v.category === "pan"));

// Test Case 7: Sensitive password element retained forbidden .value property
const sneakedPasswordValuePayload = {
  action: "INITIATE_TASK",
  context: {
    elements: [
      { id: "el_001", tag: "input", type: "password", text: "[REDACTED:sensitive]", sensitive: true, value: "MySuperSecret99!" }
    ]
  }
};
const passwordScan = runFinalPrivacyScan(sneakedPasswordValuePayload);
check("Blocks sensitive element with leaked .value property", passwordScan.blocked === true);
check("Identifies password violation", passwordScan.violations?.some(v => v.category === "password"));

// Test Case 8: False positive check (Random order ID, SKU, Date should NOT be blocked)
const nonPiiPayload = {
  action: "INITIATE_TASK",
  context: {
    elements: [
      { id: "el_001", tag: "p", type: "text block", text: "Your order ID is 4567891230, arrives on 12/09/2026." },
      { id: "el_002", tag: "p", type: "text block", text: "Warehouse SKU 1234567890123456 has 5 items in stock." }
    ]
  }
};
const falsePositiveScan = runFinalPrivacyScan(nonPiiPayload);
check("Does not block non-PII order IDs, dates, and non-Luhn SKUs", falsePositiveScan.blocked === false);

console.log("\n================================================================================");
if (allPassed) {
  console.log("🎉 ALL PRIVACY FIREWALL & ELEMENT MAPPER TESTS PASSED (100%)!");
} else {
  console.error("💥 SOME TESTS FAILED. CHECK LOGS ABOVE.");
  process.exitCode = 1;
}
console.log("================================================================================");
