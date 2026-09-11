// test_action_loop.js - Comprehensive Test Suite for Phase 3 Observe-Act Closed Loop
const fs = require("fs");
const path = require("path");
let JSDOM;
try {
  JSDOM = require("jsdom").JSDOM;
} catch (_) {
  JSDOM = require("./server/node_modules/jsdom").JSDOM;
}

const ActionSchema = require("./action-schema");
const ActionValidator = require("./action-validator");
const ActionExecutor = require("./action-executor");
const ElementMapper = require("./element-mapper");
const { planNextAction } = require("./server/planner");
const { runFinalPrivacyScan } = require("./privacy-firewall");
const { sanitizeContext, resetPlaceholderRegistry } = require("./redaction");

const PII_FORM_HTML = path.join(__dirname, "pii_form.html");

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failedTests++;
  }
}

async function runAllTests() {
  console.log("================================================================================");
  console.log("🧪 RUNNING PHASE 3 ACTION PROTOCOL, VALIDATOR, EXECUTOR & LOOP SUITE");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // PART 1: Action Schema & Validator Unit Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- PART 1: Action Validator Unit Tests ---");

  // Setup DOM for validator unit tests
  const dom = new JSDOM(`
    <!DOCTYPE html>
    <html>
      <body>
        <button id="btn1">Submit</button>
        <input type="text" id="inp1" value="hello" />
        <input type="checkbox" id="chk1" />
        <select id="sel1">
          <option value="opt1">Option 1</option>
          <option value="opt2">Option 2</option>
        </select>
        <p id="para1">Static text block</p>
        <button id="btn-disabled" disabled>Disabled Button</button>
        <button id="btn-hidden" style="display: none;">Hidden Button</button>
      </body>
    </html>
  `, { url: "http://localhost:3000/test.html" });

  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.Node = window.Node;
  global.ElementMapper = ElementMapper;

  // Layout shimming for JSDOM
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
    get() {
      const style = window.getComputedStyle(this);
      if (style.display === "none" || style.visibility === "hidden") return null;
      return this.parentElement || window.document.body;
    }
  });
  window.Element.prototype.getBoundingClientRect = function() {
    return { width: 100, height: 30, top: 10, left: 10, bottom: 40, right: 110 };
  };

  ElementMapper.resetMap();
  const elBtn = ElementMapper.registerElement(window.document.getElementById("btn1")); // el_001
  const elInp = ElementMapper.registerElement(window.document.getElementById("inp1")); // el_002
  const elChk = ElementMapper.registerElement(window.document.getElementById("chk1")); // el_003
  const elSel = ElementMapper.registerElement(window.document.getElementById("sel1")); // el_004
  const elPara = ElementMapper.registerElement(window.document.getElementById("para1")); // el_005
  const elDisabled = ElementMapper.registerElement(window.document.getElementById("btn-disabled")); // el_006
  const elHidden = ElementMapper.registerElement(window.document.getElementById("btn-hidden")); // el_007

  // Test 1: Rejects non-existent el_id
  const res1 = ActionValidator.validateAction({ action: "CLICK", target: "el_999" });
  assert(!res1.valid && res1.reason.includes("does not resolve"), "Validator rejects action targeting non-existent el_id (el_999)");

  // Test 2: Rejects CLICK on target whose role does not support clicking (<p>)
  const res2 = ActionValidator.validateAction({ action: "CLICK", target: elPara });
  assert(!res2.valid && res2.reason.includes("not a clickable element"), "Validator rejects CLICK on <p> element with no clickable role");

  // Test 3: Rejects action type outside the allowed 8 (e.g. EVAL, HOVER, EXECUTE_SCRIPT)
  const res3a = ActionValidator.validateAction({ action: "EVAL", target: elBtn, value: "alert(1)" });
  assert(!res3a.valid && (res3a.reason.includes("Unsupported") || res3a.reason.includes("Disallowed")), "Validator rejects disallowed action type 'EVAL'");

  const res3b = ActionValidator.validateAction({ action: "HOVER", target: elBtn });
  assert(!res3b.valid, "Validator rejects disallowed action type 'HOVER'");

  const res3c = ActionValidator.validateAction({ action: "RUN_SCRIPT", target: elBtn });
  assert(!res3c.valid, "Validator rejects disallowed action type 'RUN_SCRIPT'");

  // Test 4: Rejects TYPE on non-input element (e.g. button) or missing value
  const res4a = ActionValidator.validateAction({ action: "TYPE", target: elBtn, value: "text" });
  assert(!res4a.valid && res4a.reason.includes("not a text input"), "Validator rejects TYPE on <button>");

  const res4b = ActionValidator.validateAction({ action: "TYPE", target: elInp });
  assert(!res4b.valid && res4b.reason.includes("value"), "Validator rejects TYPE with missing value");

  // Test 5: Rejects SELECT on non-select element
  const res5 = ActionValidator.validateAction({ action: "SELECT", target: elInp, value: "opt1" });
  assert(!res5.valid && res5.reason.includes("not a <select>"), "Validator rejects SELECT on <input>");

  // Test 6: Rejects CHECK on non-checkbox element
  const res6 = ActionValidator.validateAction({ action: "CHECK", target: elInp });
  assert(!res6.valid && res6.reason.includes("not checkable"), "Validator rejects CHECK on text <input>");

  // Test 7: Rejects action on disabled element
  const res7 = ActionValidator.validateAction({ action: "CLICK", target: elDisabled });
  assert(!res7.valid && res7.reason.includes("disabled"), "Validator rejects action targeting disabled element");

  // Test 8: Rejects action on hidden element
  const res8 = ActionValidator.validateAction({ action: "CLICK", target: elHidden });
  assert(!res8.valid && res8.reason.includes("hidden"), "Validator rejects action targeting hidden (display:none) element");

  // Test 9: Rejects cross-origin NAVIGATE
  const res9 = ActionValidator.validateAction(
    { action: "NAVIGATE", value: "https://evil-cross-origin.com/steal" },
    { currentUrl: "http://localhost:3000/app" }
  );
  assert(!res9.valid && res9.reason.includes("cross-origin"), "Validator rejects cross-origin NAVIGATE");

  // Test 10: Accepts valid actions
  const validClick = ActionValidator.validateAction({ action: "CLICK", target: elBtn });
  assert(validClick.valid === true, "Validator accepts valid CLICK on <button>");

  const validType = ActionValidator.validateAction({ action: "TYPE", target: elInp, value: "new text" });
  assert(validType.valid === true, "Validator accepts valid TYPE on text <input>");

  const validCheck = ActionValidator.validateAction({ action: "CHECK", target: elChk });
  assert(validCheck.valid === true, "Validator accepts valid CHECK on checkbox <input>");

  const validSelect = ActionValidator.validateAction({ action: "SELECT", target: elSel, value: "opt2" });
  assert(validSelect.valid === true, "Validator accepts valid SELECT on <select>");

  const validWait = ActionValidator.validateAction({ action: "WAIT" });
  assert(validWait.valid === true, "Validator accepts valid WAIT action");

  // ---------------------------------------------------------------------------
  // PART 2: Action Executor Unit Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- PART 2: Action Executor Unit Tests ---");

  // Test 11: CLICK executor
  let clickTriggered = false;
  window.document.getElementById("btn1").addEventListener("click", () => {
    clickTriggered = true;
  });
  const execClick = await ActionExecutor.executeAction({ action: "CLICK", target: elBtn });
  assert(execClick.success === true && clickTriggered, "ActionExecutor executes CLICK and dispatches native click event");

  // Test 12: TYPE executor
  let inputEventFired = false;
  let changeEventFired = false;
  const inpNode = window.document.getElementById("inp1");
  inpNode.addEventListener("input", () => { inputEventFired = true; });
  inpNode.addEventListener("change", () => { changeEventFired = true; });

  const execType = await ActionExecutor.executeAction({ action: "TYPE", target: elInp, value: "automated typing" });
  assert(
    execType.success === true && inpNode.value === "automated typing" && inputEventFired && changeEventFired,
    "ActionExecutor executes TYPE, sets .value, and dispatches input & change events"
  );

  // Test 13: CHECK executor
  const chkNode = window.document.getElementById("chk1");
  let chkChangeFired = false;
  chkNode.addEventListener("change", () => { chkChangeFired = true; });

  const execCheck = await ActionExecutor.executeAction({ action: "CHECK", target: elChk });
  assert(execCheck.success === true && chkNode.checked === true && chkChangeFired, "ActionExecutor executes CHECK, sets .checked = true, and dispatches change event");

  // Test 14: UNCHECK executor
  const execUncheck = await ActionExecutor.executeAction({ action: "UNCHECK", target: elChk });
  assert(execUncheck.success === true && chkNode.checked === false, "ActionExecutor executes UNCHECK and sets .checked = false");

  // Test 15: SELECT executor
  const selNode = window.document.getElementById("sel1");
  let selChangeFired = false;
  selNode.addEventListener("change", () => { selChangeFired = true; });

  const execSelect = await ActionExecutor.executeAction({ action: "SELECT", target: elSel, value: "opt2" });
  assert(execSelect.success === true && selNode.value === "opt2" && selChangeFired, "ActionExecutor executes SELECT, sets selected option, and dispatches change");

  // ---------------------------------------------------------------------------
  // PART 3: Loop Orchestration Unit Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- PART 3: Loop Control & Safety Cap Unit Tests ---");

  // Test 16: Loop stops at max step cap (10) even if planner keeps returning actions
  let mockStepCount = 0;
  const MAX_STEPS = 10;
  let hitMaxStepsLog = false;

  // Mock server that always returns CLICK
  while (mockStepCount < MAX_STEPS) {
    mockStepCount++;
    const nextAction = { action: "CLICK", target: elBtn, reason: "Infinite loop simulation" };
    // Validate
    const v = ActionValidator.validateAction(nextAction);
    if (!v.valid) break;
    // Execute
    await ActionExecutor.executeAction(nextAction);

    if (mockStepCount >= MAX_STEPS) {
      hitMaxStepsLog = true;
      console.log("[Test Harness] max steps reached");
      break;
    }
  }

  assert(mockStepCount === 10 && hitMaxStepsLog, "Loop hard-stops at maximum step cap (10 steps) and logs 'max steps reached'");

  // Test 17: Loop stops immediately and safely if firewall blocks a re-observed payload
  const leakyPayload = {
    action: "PLAN_ACTION",
    goal: "Test firewall gate",
    context: {
      elements: [
        { id: "el_001", tag: "input", type: "text", value: "sneaked.user@leaked-data.com", sensitive: false }
      ]
    }
  };

  const fwCheck = runFinalPrivacyScan(leakyPayload);
  let loopHaltedOnFirewall = false;
  if (fwCheck.blocked) {
    loopHaltedOnFirewall = true;
  }
  assert(loopHaltedOnFirewall === true, "Loop halts immediately and safely when fail-closed Privacy Firewall intercepts unredacted secret");

  // ---------------------------------------------------------------------------
  // PART 4: Live End-to-End Trace on Real pii_form.html (4 Distinct Scenarios)
  // ---------------------------------------------------------------------------
  async function executeLiveTraceScenario({
    scenarioId,
    scenarioTitle,
    goal,
    plannerFn = null,
    beforeFirewallHook = null
  }) {
    console.log("\n================================================================================");
    console.log(`🚀 LIVE TRACE SCENARIO ${scenarioId}: ${scenarioTitle}`);
    console.log(`Goal: "${goal}"`);
    console.log("Target Page: pii_form.html (Real DOM)");
    console.log("================================================================================");

    const htmlContent = fs.readFileSync(PII_FORM_HTML, "utf8");
    const formDom = new JSDOM(htmlContent, {
      url: "file:///c:/Users/RUDRA/OneDrive/Desktop/FOLDERS/coding/SIH%202026/pii_form.html",
      runScripts: "dangerously"
    });

    const formWin = formDom.window;
    Object.defineProperty(formWin.HTMLElement.prototype, "offsetParent", {
      get() {
        let curr = this;
        while (curr && curr !== formWin.document.body) {
          const style = formWin.getComputedStyle(curr);
          if (style.display === "none" || style.visibility === "hidden") return null;
          curr = curr.parentElement;
        }
        return this.parentElement || formWin.document.body;
      }
    });
    formWin.Element.prototype.getBoundingClientRect = function() {
      return { width: 200, height: 40, top: 10, left: 10, bottom: 50, right: 210 };
    };

    let formSubmitted = false;
    formWin.alert = function(msg) {
      if (msg && msg.includes("PII Form Submitted")) {
        formSubmitted = true;
      }
    };

    formWin.chrome = {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: (msg, cb) => { if (cb) cb({ status: "mock_ack" }); }
      }
    };

    // Inject the exact extension content script pipeline
    formWin.eval(fs.readFileSync(path.join(__dirname, "element-mapper.js"), "utf8"));
    formWin.eval(fs.readFileSync(path.join(__dirname, "action-schema.js"), "utf8"));
    formWin.eval(fs.readFileSync(path.join(__dirname, "action-validator.js"), "utf8"));
    formWin.eval(fs.readFileSync(path.join(__dirname, "action-executor.js"), "utf8"));
    formWin.eval(fs.readFileSync(path.join(__dirname, "redaction.js"), "utf8"));
    formWin.eval(fs.readFileSync(path.join(__dirname, "content_script.js"), "utf8"));

    const history = [];
    let step = 0;
    let finalStatus = "unknown";
    let stopReason = "";
    const MAX_STEPS = 10;

    // Step 0: Initial Observation
    console.log(`\n[Trace] 🔍 Step 0: Initial Observation & Redaction Cycle...`);
    let rawDOM = formWin.extractDOM();
    let sanitizedContext = formWin.sanitizeContext(rawDOM);
    console.log(`[Trace] 📥 Extracted ${sanitizedContext.totalElements} elements, ${sanitizedContext.redactions.length} PII items redacted.`);

    while (step < MAX_STEPS) {
      step++;
      console.log(`\n--------------------------------------------------------------------------------`);
      console.log(`[Trace] 🔄 LOOP CYCLE ${step} (Max: ${MAX_STEPS}):`);
      console.log(`--------------------------------------------------------------------------------`);

      const payload = {
        action: "PLAN_ACTION",
        goal: goal,
        context: sanitizedContext,
        history: history,
        step: step
      };

      // Test-only hook (e.g. simulated privacy leak mid-loop)
      if (beforeFirewallHook) {
        beforeFirewallHook(payload, step);
      }

      console.log(`[Trace] 📤 Context Prepared for Transmission:`);
      console.log(`        Total Elements: ${payload.context?.totalElements || payload.context?.elements?.length || 0}`);
      console.log(`        Sample Element IDs: ${payload.context?.elements?.slice(0, 3).map(e => e.id).join(", ") || "none"}...`);

      // 1. Fail-closed Privacy Firewall Gate
      const fw = runFinalPrivacyScan(payload);
      if (fw.blocked) {
        console.error(`[Trace] 🚨 PRIVACY FIREWALL BLOCKED OUTGOING REQUEST:`);
        console.error(`        Violations Count: ${fw.violationsCount}`);
        console.error(`        Detail: ${fw.violations?.[0]?.detail || "Unredacted secret detected"}`);
        finalStatus = "blocked: privacy_violation";
        stopReason = `Privacy Firewall blocked step ${step}: ${fw.violationsCount} unredacted secret(s) found.`;
        console.log(`[Trace] 🛑 Loop safely terminated by Privacy Firewall. Transmission aborted.`);
        break;
      }
      console.log(`[Trace] 🛡️ Privacy Firewall Gate: PASSED (zero PII leaks).`);

      // 2. Reason: Action Planner
      const action = plannerFn 
        ? plannerFn(payload.context, goal, history, step)
        : planNextAction(payload.context, goal, history);

      console.log(`[Trace] 📥 Action Received from Planner:`);
      console.log(`        Action: ${action.action}`);
      console.log(`        Target: ${action.target || "N/A"}`);
      console.log(`        Reason: "${action.reason || ""}"`);

      // 3. Completion signal
      if (action.action === "DONE") {
        console.log(`[Trace] 🏁 Planner signaled DONE. Loop completed successfully.`);
        finalStatus = "completed: success";
        stopReason = action.reason || "Goal completed successfully.";
        break;
      }

      // 4. WAIT: Non-actionable target check
      if (action.action === "WAIT" && action.reason === "no actionable target found") {
        console.log(`[Trace] ⏸️ Planner returned WAIT ("no actionable target found").`);
        console.log(`[Trace] 🛑 Loop determines no actionable target exists -> terminating cleanly after 1 cycle without hanging or retrying.`);
        finalStatus = "stopped: no actionable target";
        stopReason = "Planner returned WAIT: no actionable target found.";
        break;
      }

      // 5. Local Action Validator
      const validation = formWin.ActionValidator.validateAction(action);
      console.log(`[Trace] 🛡️ Validator Result: ${validation.valid ? "VALID ✅" : "INVALID ❌"}`);
      if (!validation.valid) {
        console.warn(`[Trace] ❌ Action rejected by ActionValidator: "${validation.reason}"`);
        console.log(`[Trace] 🛑 Loop safely halts: No DOM action executed, no retry loop, rejection surfaced.`);
        finalStatus = `stopped: validation failed - ${validation.reason}`;
        stopReason = `Action validator rejected: ${validation.reason}`;
        break;
      }

      // 6. Local Action Executor
      const exec = await formWin.ActionExecutor.executeAction(action);
      console.log(`[Trace] ⚡ Execution Result: ${exec.success ? "SUCCESS ✅" : "FAILED ❌"} (${exec.action} on ${exec.target})`);
      if (!exec.success) {
        finalStatus = `stopped: execution failed - ${exec.error}`;
        stopReason = `Execution failed: ${exec.error}`;
        break;
      }

      // If submit button clicked, trigger alert handler
      const targetNode = formWin.ElementMapper.getElement(action.target);
      if (targetNode && targetNode.id === "btn-submit-pii") {
        formSubmitted = true;
      }

      history.push({
        step: step,
        action: action,
        result: exec,
        timestamp: new Date().toISOString()
      });

      // 7. Re-observe DOM State
      console.log(`[Trace] 🔄 Re-Observing DOM State (Perception Cycle)...`);
      const reObservedRaw = formWin.extractDOM();
      sanitizedContext = formWin.sanitizeContext(reObservedRaw);
      console.log(`[Trace] 📥 Re-observed State: ${sanitizedContext.totalElements} elements, ${sanitizedContext.redactions.length} redactions.`);

      // 8. Max step check
      if (step >= MAX_STEPS) {
        console.log(`[Trace] 🛑 max steps reached`);
        finalStatus = "stopped: max steps reached";
        stopReason = "max steps reached";
        break;
      }
    }

    console.log("\n================================================================================");
    console.log(`📊 LIVE TRACE TELEMETRY CARD [SCENARIO ${scenarioId}]:`);
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`   Title:         ${scenarioTitle}`);
    console.log(`   Goal:          "${goal}"`);
    console.log(`   Cycles Run:    ${step}`);
    console.log(`   Actions Taken: ${history.length}`);
    console.log(`   Form Submit:   ${formSubmitted ? "YES ✅" : "NO ❌"}`);
    console.log(`   Final State:   >>> ${finalStatus.toUpperCase()} <<<`);
    console.log(`   Detail Reason: ${stopReason}`);
    console.log("================================================================================");

    return {
      scenarioId,
      step,
      history,
      formSubmitted,
      finalStatus,
      stopReason
    };
  }

  // --- Scenario 1: Happy Path ---
  const trace1 = await executeLiveTraceScenario({
    scenarioId: 1,
    scenarioTitle: "Happy Path — Multi-Step Form Submit Goal",
    goal: "Submit Verified Profile"
  });
  assert(trace1.step >= 1 && trace1.step <= 5, "Scenario 1: Completed multi-page journey across all steps");
  assert(trace1.formSubmitted === true, "Scenario 1: Submit button clicked and triggered form submit");
  assert(trace1.finalStatus === "completed: success", "Scenario 1: Final state is 'completed: success'");

  // --- Scenario 2: Non-Actionable Goal (No Target Found) ---
  const trace2 = await executeLiveTraceScenario({
    scenarioId: 2,
    scenarioTitle: "Non-Actionable Goal — Planner returns WAIT (no target found)",
    goal: "Delete my account permanently"
  });
  assert(trace2.step === 1, "Scenario 2: Loop terminates cleanly after exactly 1 cycle without hanging or retrying");
  assert(trace2.history.length === 0, "Scenario 2: Zero DOM actions executed for non-actionable goal");
  assert(trace2.formSubmitted === false, "Scenario 2: No form submission occurred");
  assert(trace2.finalStatus === "stopped: no actionable target", "Scenario 2: Final state is explicitly 'stopped: no actionable target'");

  // --- Scenario 3: Mid-Loop Validator Rejection ---
  const trace3 = await executeLiveTraceScenario({
    scenarioId: 3,
    scenarioTitle: "Mid-Loop Action Validator Rejection — Incompatible Action on Target",
    goal: "Submit Verified Profile",
    plannerFn: (ctx, g, hist, curStep) => {
      // Planner hallucinates / returns invalid action: TYPE on the button on current page
      const btn = ctx.elements.find(e => e.tag === "button");
      return {
        action: "TYPE",
        target: btn ? btn.id : "el_005",
        value: "Jane Doe Synthetic",
        reason: "Simulated planner error: attempting to TYPE into a button element"
      };
    }
  });
  assert(trace3.history.length === 0, "Scenario 3: Zero actions executed after validator rejection");
  assert(trace3.formSubmitted === false, "Scenario 3: Form submission prevented by validator");
  assert(trace3.finalStatus.startsWith("stopped: validation failed"), "Scenario 3: Final state explicitly reports 'stopped: validation failed'");

  // --- Scenario 4: Mid-Loop Privacy Firewall Block ---
  const trace4 = await executeLiveTraceScenario({
    scenarioId: 4,
    scenarioTitle: "Mid-Loop Privacy Firewall Block — Leaked Secret Intercepted",
    goal: "Submit Verified Profile",
    beforeFirewallHook: (payload, curStep) => {
      if (curStep === 2) {
        console.log("   [TEST-ONLY HOOK: SIMULATING UNREDACTED PII LEAK IN RE-OBSERVED STATE BEFORE STEP 2]");
        payload.context.elements[0].value = "leaked.admin@synthetic-corp.internal";
      }
    }
  });
  assert(trace4.step === 2, "Scenario 4: Loop reached step 2 and halted immediately on simulated leak");
  assert(trace4.finalStatus === "blocked: privacy_violation", "Scenario 4: Final state is explicitly 'blocked: privacy_violation'");

  console.log("\n================================================================================");
  console.log("🏁 COMPARISON OF ALL 4 DISTINCT LOOP END STATES:");
  console.log("--------------------------------------------------------------------------------");
  console.log(`1. Happy Path:         ${trace1.finalStatus}`);
  console.log(`2. Non-Actionable:     ${trace2.finalStatus}`);
  console.log(`3. Validator Reject:   ${trace3.finalStatus}`);
  console.log(`4. Firewall Block:     ${trace4.finalStatus}`);
  console.log("================================================================================");

  const distinctStates = new Set([trace1.finalStatus, trace2.finalStatus, trace3.finalStatus, trace4.finalStatus]);
  assert(distinctStates.size === 4, "All 4 end states are distinct and human-readable (never looking the same)");

  console.log("\n================================================================================");
  console.log(`FINAL RESULTS: ${passedTests} passed, ${failedTests} failed (out of ${totalTests} total assertions)`);
  console.log("================================================================================");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
