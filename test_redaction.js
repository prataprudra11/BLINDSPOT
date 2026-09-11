// test_redaction.js - Test Suite for redaction.js
const { sanitizeContext } = require("./redaction.js");

console.log("================================================================================");
console.log("🔒 Running Privacy Firewall Test Suite (redaction.js)");
console.log("================================================================================\n");

// 5 Test Cases matching the requirements:
const mockExtractedDOM = {
  url: "https://demo.internal/account/profile",
  title: "Account Settings & KYC Demo",
  extractedAt: "2026-09-05T14:40:00.000Z",
  totalElements: 5,
  elements: [
    // Case 1: Fake email in a heading
    {
      selector: "header > h2.user-heading",
      tag: "h2",
      type: "heading",
      text: "Welcome back, test.user@example.com! Manage your preferences.",
      sensitive: false
    },
    // Case 2: Fake phone number in paragraph text
    {
      selector: "div.support-box > p",
      tag: "p",
      type: "text block",
      text: "For urgent assistance, reach out at 9999999999 directly.",
      sensitive: false
    },
    // Case 3: Fake 16-digit card number in a text block
    {
      selector: "#billing-section > p.card-info",
      tag: "p",
      type: "text block",
      text: "Primary card ending on file: 4111111111111111",
      sensitive: false
    },
    // Case 4: Fake Aadhaar-style 12-digit number in a text block
    {
      selector: "#kyc-card > div.id-row",
      tag: "p",
      type: "text block",
      text: "Aadhaar / National ID recorded: 234567891012 verified",
      sensitive: false
    },
    // Case 5: Password element with sensitive: true from Stage 1 (with an accidental value)
    {
      selector: "#password-input",
      tag: "input",
      type: "password",
      text: "Enter Password",
      value: "SecretPassword123!", // Secret value that MUST be fully purged
      sensitive: true,
      category: "password"
    }
  ]
};

// Raw PII values to strictly verify absence in the final output
const RAW_PII_SECRETS = [
  "test.user@example.com",
  "9999999999",
  "4111111111111111",
  "234567891012",
  "SecretPassword123!"
];

// Execute Sanitization
const sanitizedResult = sanitizeContext(mockExtractedDOM);
const outputJSONString = JSON.stringify(sanitizedResult, null, 2);

// -----------------------------------------------------------------------------
// Print Sanitized Output for Inspection
// -----------------------------------------------------------------------------
console.log("📄 SANITIZED CONTEXT OUTPUT:");
console.log(outputJSONString);
console.log("\n--------------------------------------------------------------------------------");

// -----------------------------------------------------------------------------
// Verification Checks
// -----------------------------------------------------------------------------
console.log("🛡️ VERIFICATION CHECKS:\n");

let allPassed = true;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    console.error(`  ❌ [FAIL] ${label}`);
    allPassed = false;
  }
}

// Check 1: Typed instance-numbered placeholders substituted
check(
  "Email placeholder EMAIL_1 present",
  outputJSONString.includes("EMAIL_1")
);
check(
  "Phone placeholder PHONE_1 present",
  outputJSONString.includes("PHONE_1")
);
check(
  "Card placeholder CARD_1 present",
  outputJSONString.includes("CARD_1")
);
check(
  "Aadhaar placeholder AADHAAR_1 present",
  outputJSONString.includes("AADHAAR_1")
);
check(
  "Password element text redacted to PASSWORD_1",
  outputJSONString.includes("PASSWORD_1")
);
check(
  "Redaction log entries include assigned placeholder field",
  sanitizedResult.redactions.every(r => typeof r.placeholder === "string" && r.placeholder.length > 0)
);

// Check 2: Redactions log categories
const categoriesFound = sanitizedResult.redactions.map(r => r.category);
check(
  "Redaction log captured 'email' category",
  categoriesFound.includes("email")
);
check(
  "Redaction log captured 'phone' category",
  categoriesFound.includes("phone")
);
check(
  "Redaction log captured 'card' category",
  categoriesFound.includes("card")
);
check(
  "Redaction log captured 'aadhaar' category",
  categoriesFound.includes("aadhaar")
);
check(
  "Redaction log captured 'password' category",
  categoriesFound.includes("password")
);

// Check 3: Sensitive password element has no "value" property
const passwordElement = sanitizedResult.elements.find(el => el.selector === "#password-input");
check(
  "Password element completely purged of 'value' property",
  passwordElement && !("value" in passwordElement)
);

// Check 4: Zero Raw PII leakage anywhere in the output
let leakedSecrets = [];
for (const secret of RAW_PII_SECRETS) {
  if (outputJSONString.includes(secret)) {
    leakedSecrets.push(secret);
  }
}
check(
  "Zero raw PII text leaked in output string",
  leakedSecrets.length === 0
);

if (leakedSecrets.length > 0) {
  console.error("  ⚠️ LEAK DETECTED:", leakedSecrets);
}

// -----------------------------------------------------------------------------
// Check 5: Instance Numbering & Deduplication Test (Requirement 6)
// Verifies identical raw values receive the SAME placeholder number,
// and different raw values receive sequential numbers (EMAIL_1, EMAIL_2).
// -----------------------------------------------------------------------------
console.log("\n🧪 Running Placeholder Instance-Numbering Test Case:");
const duplicateAndSequentialDOM = {
  url: "https://demo.internal/dedupe-test",
  title: "Deduplication & Sequential Numbering Test",
  totalElements: 3,
  elements: [
    {
      id: "el_001",
      tag: "p",
      type: "text block",
      text: "Primary email: alice@example.com on file",
      sensitive: false
    },
    {
      id: "el_002",
      tag: "p",
      type: "text block",
      text: "Confirmation sent to alice@example.com earlier",
      sensitive: false
    },
    {
      id: "el_003",
      tag: "p",
      type: "text block",
      text: "Secondary email: bob.smith@work.org registered",
      sensitive: false
    }
  ]
};

const dedupResult = sanitizeContext(duplicateAndSequentialDOM);
const el1Text = dedupResult.elements[0].text;
const el2Text = dedupResult.elements[1].text;
const el3Text = dedupResult.elements[2].text;

check(
  "Identical raw email receives the SAME placeholder (EMAIL_1) across elements",
  el1Text.includes("EMAIL_1") && el2Text.includes("EMAIL_1")
);
check(
  "Distinct raw email of same category receives sequential placeholder (EMAIL_2)",
  el3Text.includes("EMAIL_2")
);

console.log("\n================================================================================");
if (allPassed) {
  console.log("🎉 ALL PRIVACY FIREWALL TESTS PASSED SUCCESSFULLY!");
} else {
  console.error("💥 SOME TESTS FAILED. CHECK LOGS ABOVE.");
  process.exit(1);
}
console.log("================================================================================");
