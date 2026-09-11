// server/verify_e2e_payload.js
// Simulates end-to-end Perception + Anonymous Element Mapper + Privacy Firewall pipeline
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const http = require('http');

const SERVER_URL = 'http://localhost:3000/agent/act';
const ROOT_DIR = path.resolve(__dirname, '..');
const PII_FORM_HTML = path.join(ROOT_DIR, 'pii_form.html');
const ELEMENT_MAPPER_JS = path.join(ROOT_DIR, 'element-mapper.js');
const REDACTION_JS = path.join(ROOT_DIR, 'redaction.js');
const CONTENT_SCRIPT_JS = path.join(ROOT_DIR, 'content_script.js');
const PRIVACY_FIREWALL_JS = path.join(ROOT_DIR, 'privacy-firewall.js');
const OUTPUT_FILE = path.join(ROOT_DIR, 'verification_payload_example.json');

const { runFinalPrivacyScan } = require(PRIVACY_FIREWALL_JS);

async function runVerification() {
  console.log('================================================================================');
  console.log('🧪 RUNNING END-TO-END PIPELINE VERIFICATION TEST (WITH ANONYMOUS IDs & FIREWALL)');
  console.log('================================================================================');

  const htmlContent = fs.readFileSync(PII_FORM_HTML, 'utf8');
  const mapperCode = fs.readFileSync(ELEMENT_MAPPER_JS, 'utf8');
  const redactionCode = fs.readFileSync(REDACTION_JS, 'utf8');
  const contentScriptCode = fs.readFileSync(CONTENT_SCRIPT_JS, 'utf8');

  const dom = new JSDOM(htmlContent, {
    url: 'file:///c:/Users/RUDRA/OneDrive/Desktop/FOLDERS/coding/SIH%202026/pii_form.html',
    runScripts: 'dangerously'
  });

  const { window } = dom;

  // Shim layout and visibility methods for JSDOM environment
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    get() { return this.parentElement || window.document.body; }
  });
  window.Element.prototype.getBoundingClientRect = function() {
    return { width: 200, height: 40, top: 10, left: 10, bottom: 50, right: 210 };
  };

  // Mock chrome runtime for content script
  let registeredMessageListener = null;
  window.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => { registeredMessageListener = fn; }
      },
      sendMessage: (msg, callback) => {
        if (callback) callback({ status: 'mock_ack' });
      }
    }
  };

  // Execute element-mapper.js, redaction.js, then content_script.js in exact manifest order
  window.eval(mapperCode);
  window.eval(redactionCode);
  window.eval(contentScriptCode);

  console.log('✅ Injected element-mapper.js, redaction.js, and content_script.js into JSDOM.');

  // Trigger TASK_ANNOUNCEMENT message to content script
  console.log('🚀 Simulating TASK_ANNOUNCEMENT dispatched from background worker...');
  let contentScriptResponse = null;

  await new Promise((resolve) => {
    registeredMessageListener(
      { type: 'TASK_ANNOUNCEMENT', goal: 'Verify KYC Profile details and submit verified form.' },
      { tab: null },
      (response) => {
        contentScriptResponse = response;
        resolve();
      }
    );
  });

  console.log('📥 Received response from Content Script:');
  console.log(`   Status: ${contentScriptResponse.status}`);
  console.log(`   Message: ${contentScriptResponse.message}`);
  console.log(`   Redactions Count: ${contentScriptResponse.sanitizedContext.redactions.length}`);

  const sanitizedContext = contentScriptResponse.sanitizedContext;

  // VERIFY ANONYMOUS IDs: Ensure elements use anonymous IDs (el_001, ...) and NO CSS selectors
  console.log('\n--------------------------------------------------------------------------------');
  console.log('🔍 VERIFYING ANONYMOUS ELEMENT MAPPING:');
  console.log('--------------------------------------------------------------------------------');
  const elements = sanitizedContext.elements || [];
  let anonymousIdPassed = true;
  let noSelectorPassed = true;

  for (const el of elements) {
    if (!el.id || !/^el_\d{3}$/.test(el.id)) {
      console.error(`  ❌ Element missing valid anonymous id:`, el);
      anonymousIdPassed = false;
    }
    if ('selector' in el) {
      console.error(`  ❌ Element leaked real CSS selector over the wire:`, el.selector);
      noSelectorPassed = false;
    }
  }

  if (anonymousIdPassed) {
    console.log(`  ✅ [PASS] All ${elements.length} elements use sequential anonymous IDs (el_001..el_${String(elements.length).padStart(3, '0')}).`);
  }
  if (noSelectorPassed) {
    console.log(`  ✅ [PASS] Real CSS selectors completely absent from outgoing elements array (held locally only).`);
  }

  // Assemble serverPayload as background.js does
  const serverPayload = {
    action: 'INITIATE_TASK',
    goal: 'Verify KYC Profile details and submit verified form.',
    activeTab: {
      id: 101,
      url: 'file:///c:/Users/RUDRA/OneDrive/Desktop/FOLDERS/coding/SIH%202026/pii_form.html',
      title: dom.window.document.title
    },
    context: {
      url: sanitizedContext.url,
      title: sanitizedContext.title,
      totalElements: sanitizedContext.totalElements,
      elements: sanitizedContext.elements,
      redactions: sanitizedContext.redactions
    },
    timestamp: new Date().toISOString()
  };

  // EXECUTE PRIVACY FIREWALL: Verify final gate check
  console.log('\n--------------------------------------------------------------------------------');
  console.log('🛡️ RUNNING FAIL-CLOSED PRIVACY FIREWALL ON SERVER PAYLOAD:');
  console.log('--------------------------------------------------------------------------------');
  const firewallResult = runFinalPrivacyScan(serverPayload);
  if (firewallResult.blocked) {
    console.error('  ❌ [FAIL] Privacy Firewall BLOCKED the payload! Violations:', firewallResult.violations);
    process.exit(1);
  } else {
    console.log('  ✅ [PASS] Privacy Firewall scan PASSED (zero PII violations detected).');
  }

  // VERIFY 11-ELEMENT STRUCTURE AND REDACTION SCOPING
  console.log('\n--------------------------------------------------------------------------------');
  console.log('🔍 VERIFYING ELEMENT EXTRACTION & REDACTION SCOPING:');
  console.log('--------------------------------------------------------------------------------');
  let structurePassed = true;

  const formControls = elements.filter(el => ['input', 'textarea', 'select'].includes(el.tag));

  if (elements.length >= 11 && formControls.length === 8) {
    console.log(`  ✅ [PASS] Element count verified: ${elements.length} elements total with all 8 form controls preserved.`);
  } else {
    console.error(`  ❌ [FAIL] Expected at least 11 elements with 8 form controls, found ${elements.length} (controls: ${formControls.length}).`);
    structurePassed = false;
  }

  const hasLabelTag = elements.some(el => el.tag === 'label');
  if (!hasLabelTag) {
    console.log(`  ✅ [PASS] No standalone <label> elements present in payload.`);
  } else {
    console.error(`  ❌ [FAIL] Found standalone <label> elements in payload.`);
    structurePassed = false;
  }

  let formLabelsValid = true;
  for (const fc of formControls) {
    if (typeof fc.label !== 'string' || !fc.label.trim()) {
      console.error(`  ❌ [FAIL] Form control ${fc.id} missing valid label property:`, fc);
      formLabelsValid = false;
    }
    if ('text' in fc) {
      console.error(`  ❌ [FAIL] Form control ${fc.id} should not have text property:`, fc);
      formLabelsValid = false;
    }
  }
  if (formLabelsValid) {
    console.log(`  ✅ [PASS] All ${formControls.length} form controls carry label property without text property.`);
  } else {
    structurePassed = false;
  }

  // Deduplication check
  const redSet = new Set();
  let noDupes = true;
  for (const r of sanitizedContext.redactions) {
    const key = `${r.id}::${r.category}`;
    if (redSet.has(key)) {
      console.error(`  ❌ [FAIL] Duplicate redaction detected: ${key}`);
      noDupes = false;
    }
    redSet.add(key);
  }
  if (noDupes) {
    console.log(`  ✅ [PASS] Zero duplicate entries in redactions log (${sanitizedContext.redactions.length} unique entries).`);
  } else {
    structurePassed = false;
  }

  // Address heuristic scoping check: must not flag email or label
  const emailElement = elements.find(el => el.type === 'email');
  const emailAddressRedacted = sanitizedContext.redactions.some(r => r.id === emailElement?.id && r.category === 'address');
  if (!emailAddressRedacted && emailElement?.label === 'Email Address') {
    console.log(`  ✅ [PASS] Address heuristic never fired on email field or static label text.`);
  } else {
    console.error(`  ❌ [FAIL] Address heuristic incorrectly fired on email field or label!`);
    structurePassed = false;
  }

  // Sensitive flag check
  let sensitiveFlagPassed = true;
  for (const r of sanitizedContext.redactions) {
    const el = elements.find(e => e.id === r.id);
    if (el && el.sensitive !== true) {
      console.error(`  ❌ [FAIL] Redacted element ${el.id} (${r.category}) missing sensitive: true flag!`);
      sensitiveFlagPassed = false;
    }
  }
  if (sensitiveFlagPassed) {
    console.log(`  ✅ [PASS] All redacted elements have sensitive: true reflecting redaction outcome.`);
  } else {
    structurePassed = false;
  }

  const payloadString = JSON.stringify(serverPayload, null, 2);

  // Send request to server if running
  console.log('\n--------------------------------------------------------------------------------');
  console.log('📤 Dispatching POST /agent/act to live Express server at http://localhost:3000...');
  console.log('--------------------------------------------------------------------------------');

  try {
    const serverResponse = await new Promise((resolve, reject) => {
      const postData = JSON.stringify(serverPayload);
      const req = http.request(
        'http://localhost:3000/agent/act',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 2000
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('Request timed out after 2000ms'));
      });
      req.on('error', (err) => reject(err));
      req.write(postData);
      req.end();
    });

    console.log(`✅ Server responded with HTTP ${serverResponse.statusCode}`);
    console.log(`   Server message: ${serverResponse.body.message}`);
  } catch (err) {
    console.log(`ℹ️ Note: Live server on http://localhost:3000 (${err.message}).`);
  }

  // Save the captured actual POST /agent/act request body as verification_payload_example.json
  fs.writeFileSync(OUTPUT_FILE, payloadString, 'utf8');
  console.log(`\n💾 Saved captured actual POST payload to: ${OUTPUT_FILE}`);

  // ZERO LEAKAGE AUDIT: Check against all raw PII secrets in pii_form.html
  console.log('\n--------------------------------------------------------------------------------');
  console.log('🔒 ZERO-LEAKAGE PRIVACY AUDIT (Scanning payload for raw secrets):');
  console.log('--------------------------------------------------------------------------------');

  const RAW_SECRETS = [
    'Jane Doe Synthetic',
    'jane.doe@synthetic-test.org',
    '+91 98765 43210',
    '98765 43210',
    '9876543210',
    'SuperSecretDemoPass99!',
    '123 Synthetic Tech Park',
    'Block B, New Delhi',
    'ABCDE1234F',
    '2345-6789-0123',
    '234567890123',
    '4532-0151-1283-0366',
    '4532015112830366'
  ];

  let leaks = 0;
  for (const secret of RAW_SECRETS) {
    if (payloadString.includes(secret)) {
      console.error(`  ❌ [LEAK] Raw secret found in payload: "${secret}"`);
      leaks++;
    } else {
      console.log(`  ✅ [SECURE] Zero occurrence of: "${secret}"`);
    }
  }

  // Confirm Typed Redaction Placeholders exist
  console.log('\n🛡️ CHECKING REDACTION PLACEHOLDERS IN PAYLOAD:');
  const expectedPlaceholders = [
    'PERSON_1',
    'EMAIL_1',
    'PHONE_1',
    'ADDRESS_1',
    'PAN_1',
    'AADHAAR_1'
  ];

  for (const ph of expectedPlaceholders) {
    if (payloadString.includes(ph)) {
      console.log(`  ✅ [FOUND] Placeholder ${ph} present in payload`);
    } else {
      console.warn(`  ⚠️ [NOTE] Placeholder ${ph} not matched directly in payload`);
    }
  }

  // Verify placeholder field recorded in redactions log
  const expectedRedactionPlaceholders = [
    'PERSON_1',
    'EMAIL_1',
    'PHONE_1',
    'PASSWORD_1',
    'ADDRESS_1',
    'PAN_1',
    'AADHAAR_1',
    'CARD_1'
  ];
  let placeholdersRecorded = true;
  for (const ph of expectedRedactionPlaceholders) {
    const found = sanitizedContext.redactions.some(r => r.placeholder === ph);
    if (found) {
      console.log(`  ✅ [FOUND] Placeholder ${ph} recorded in redactions log`);
    } else {
      console.error(`  ❌ [FAIL] Placeholder ${ph} missing from redactions log!`);
      placeholdersRecorded = false;
    }
  }
  if (!placeholdersRecorded) {
    structurePassed = false;
  }

  console.log('================================================================================');
  if (leaks === 0 && anonymousIdPassed && noSelectorPassed && structurePassed) {
    console.log('🎉 ZERO-LEAKAGE, 11-ELEMENT STRUCTURE & ANONYMOUS MAPPING VERIFIED: Airtight!');
  } else {
    console.error(`💥 AUDIT FAILED.`);
    process.exit(1);
  }
  console.log('================================================================================');
}

runVerification().catch((err) => {
  console.error('Error running verification:', err);
  process.exit(1);
});
