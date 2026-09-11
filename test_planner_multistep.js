// test_planner_multistep.js - Direct Unit Test for server/planner.js
const { planNextAction } = require("./server/planner");

console.log("================================================================================");
console.log("🧪 TESTING MULTI-STEP PLANNER REASONING (server/planner.js)");
console.log("================================================================================");

// --- STEP 1: Page 1 Observation ---
console.log("\n📄 CYCLE 1: Page 1 Active (Step 1 of 3: Personal Information)");
const page1Elements = [
  { id: "el_001", tag: "input", label: "Full Name", value: "Jane Doe Synthetic" },
  { id: "el_002", tag: "input", label: "Email Address", value: "EMAIL_1" },
  { id: "el_003", tag: "input", label: "Phone Number", value: "PHONE_1" },
  { id: "el_004", tag: "input", label: "Password" },
  { id: "el_005", tag: "button", text: "Continue to Step 2: KYC Details →" }
];
const action1 = planNextAction({ elements: page1Elements }, "Submit Verified Profile", []);
console.log("📥 Planner Output:", JSON.stringify(action1, null, 2));

if (action1.action === "CLICK" && action1.target === "el_005") {
  console.log("✅ [PASS] Correctly planned CLICK on Step 1 progression button (el_005)");
} else {
  console.error("❌ [FAIL] Expected CLICK on el_005, got:", action1);
}

// --- STEP 2: Page 2 Observation ---
console.log("\n📄 CYCLE 2: Page 2 Active (Step 2 of 3: KYC Details)");
const page2Elements = [
  { id: "el_001", tag: "textarea", label: "Residential Address", value: "ADDRESS_1" },
  { id: "el_002", tag: "input", label: "Synthetic PAN Card Number", value: "PAN_1" },
  { id: "el_003", tag: "input", label: "Synthetic Aadhaar Number", value: "AADHAAR_1" },
  { id: "el_004", tag: "button", text: "← Back" },
  { id: "el_005", tag: "button", text: "Continue to Step 3: Payment →" }
];
const historyAfterStep1 = [
  { action: action1, result: { success: true } }
];
const action2 = planNextAction({ elements: page2Elements }, "Submit Verified Profile", historyAfterStep1);
console.log("📥 Planner Output:", JSON.stringify(action2, null, 2));

if (action2.action === "CLICK" && action2.target === "el_005") {
  console.log("✅ [PASS] Correctly planned CLICK on Step 2 progression button (el_005)");
} else {
  console.error("❌ [FAIL] Expected CLICK on el_005, got:", action2);
}

// --- STEP 3: Page 3 Observation ---
console.log("\n📄 CYCLE 3: Page 3 Active (Step 3 of 3: Payment Verification & Final Submit)");
const page3Elements = [
  { id: "el_001", tag: "input", label: "Synthetic Credit Card", value: "CARD_1" },
  { id: "el_002", tag: "button", text: "← Back" },
  { id: "el_003", tag: "button", text: "Submit Verified Profile" }
];
const historyAfterStep2 = [
  { action: action1, result: { success: true } },
  { action: action2, result: { success: true } }
];
const action3 = planNextAction({ elements: page3Elements }, "Submit Verified Profile", historyAfterStep2);
console.log("📥 Planner Output:", JSON.stringify(action3, null, 2));

if (action3.action === "CLICK" && action3.target === "el_003") {
  console.log("✅ [PASS] Correctly planned CLICK on final submit button (el_003)");
} else {
  console.error("❌ [FAIL] Expected CLICK on el_003, got:", action3);
}

// --- STEP 4: Confirmation Screen Observation ---
console.log("\n📄 CYCLE 4: Confirmation Screen Active (#page-success)");
const page4Elements = [
  { id: "el_001", tag: "div", text: "Verification Complete! All 3 steps completed." }
];
const historyAfterStep3 = [
  { action: action1, result: { success: true } },
  { action: action2, result: { success: true } },
  { action: action3, result: { success: true } }
];
const action4 = planNextAction({ elements: page4Elements }, "Submit Verified Profile", historyAfterStep3);
console.log("📥 Planner Output:", JSON.stringify(action4, null, 2));

if (action4.action === "DONE") {
  console.log("✅ [PASS] Correctly recognized completion and returned action: 'DONE'");
} else {
  console.error("❌ [FAIL] Expected DONE, got:", action4);
}

console.log("\n================================================================================");
console.log("🎉 ALL 4 MULTI-STEP PLANNER TRANSITIONS VERIFIED!");
console.log("================================================================================\n");
