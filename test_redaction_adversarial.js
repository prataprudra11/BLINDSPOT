/**
 * ADVERSARIAL TEST SUITE — Stage 2 Redaction Module
 * ---------------------------------------------------
 * This is NOT a "does it work" test. It's a "can I break it" test.
 * It targets the two failure modes that actually matter for judges:
 *   1. FALSE NEGATIVES  -> real PII slips through unredacted (privacy breach)
 *   2. FALSE POSITIVES  -> normal text gets wrongly redacted (looks broken/unusable)
 *
 * HOW TO USE:
 *   1. Save this file in the SAME folder as redaction.js
 *      (e.g. c:\Users\RUDRA\OneDrive\Desktop\FOLDERS\coding\SIH 2026\)
 *   2. Run:  node test_redaction_adversarial.js
 *   3. Read the FAIL lines carefully — each one tells you exactly
 *      what input broke it and how.
 *
 * NOTE ON THE IMPORT LINE BELOW:
 *   This assumes redaction.js exports a function via
 *   `module.exports = sanitizeContext` or
 *   `module.exports = { sanitizeContext }`.
 *   If your actual export differs, adjust the `require` block
 *   (search for "ADJUST THIS" below) to match your real export shape.
 */

const path = require('path');
const redactionModule = require(path.join(__dirname, 'redaction.js'));

// ---- ADJUST THIS if your export shape is different ----
const sanitizeContext =
  typeof redactionModule === 'function'
    ? redactionModule
    : redactionModule.sanitizeContext || redactionModule.default;

if (typeof sanitizeContext !== 'function') {
  console.error('❌ Could not find sanitizeContext function in redaction.js exports.');
  console.error('   Check what redaction.js does with module.exports and adjust the require line in this file.');
  process.exit(1);
}
// ---------------------------------------------------------

let passCount = 0;
let failCount = 0;
const failures = [];

function makeInput(text, sensitive = false, extra = {}) {
  return {
    url: 'https://demo.internal/test',
    title: 'Adversarial Test Page',
    extractedAt: new Date().toISOString(),
    totalElements: 1,
    elements: [
      {
        selector: 'div.test-el',
        tag: 'div',
        type: 'text block',
        text,
        sensitive,
        ...extra
      }
    ]
  };
}

/**
 * check(name, input, assertFn)
 * assertFn receives the sanitized output and should return true/false.
 * expectRedact: whether we EXPECT the raw text to be gone.
 */
function check(name, rawInput, expectRaw) {
  let result;
  try {
    result = sanitizeContext(makeInput(rawInput));
  } catch (err) {
    failCount++;
    failures.push(`[CRASH] "${name}" — threw error: ${err.message}`);
    return;
  }

  const outputText = JSON.stringify(result);
  const stillLeaking = outputText.includes(rawInput.trim());

  if (expectRaw === 'SHOULD_REDACT') {
    if (stillLeaking) {
      failCount++;
      failures.push(`[LEAK] "${name}" — raw PII "${rawInput}" still present in output!\n         Output: ${outputText.slice(0, 300)}`);
    } else {
      passCount++;
      console.log(`  ✅ [PASS-REDACT] ${name}`);
    }
  } else if (expectRaw === 'SHOULD_KEEP') {
    if (!stillLeaking) {
      failCount++;
      failures.push(`[OVER-REDACT] "${name}" — non-PII text "${rawInput}" was wrongly redacted!\n         Output: ${outputText.slice(0, 300)}`);
    } else {
      passCount++;
      console.log(`  ✅ [PASS-KEEP] ${name}`);
    }
  }
}

console.log('='.repeat(80));
console.log('🔴 ADVERSARIAL TEST SUITE — Stage 2 Redaction Module');
console.log('='.repeat(80));

console.log('\n--- Category A: Multiple PII types in ONE string ---');
check('email + phone in same sentence', 'Email me at ruidyyyyyy@gmail.com or call 9876543210', 'SHOULD_REDACT');
check('card + aadhaar in same sentence', 'Card 4111 1111 1111 1111 and Aadhaar 1234 5678 9012', 'SHOULD_REDACT');
check('valid card with spaces (Luhn test)', 'Payment card 4532 0151 1283 0366 charged successfully', 'SHOULD_REDACT');

console.log('\n--- Category B: Obfuscated / spaced-out PII (common evasion patterns) ---');
check('email with spaces around @', 'contact john @ gmail . com for help', 'SHOULD_REDACT');
check('email with [at]/[dot] substitution', 'reach me at john[at]gmail[dot]com', 'SHOULD_REDACT');
check('phone split with extra spaces', 'call 98765  43210 now', 'SHOULD_REDACT');
check('phone with dashes/dots mixed', 'call 98765-43210 or 98765.43210', 'SHOULD_REDACT');

console.log('\n--- Category C: International / non-Indian formats ---');
check('US phone format', 'call (415) 555-2671 for support', 'SHOULD_REDACT');
check('UK phone format', 'ring +44 20 7946 0958', 'SHOULD_REDACT');
check('email with plus-addressing', 'signup+test@company.co.uk confirmed', 'SHOULD_REDACT');

console.log('\n--- Category D: FALSE POSITIVE checks (should NOT be redacted) ---');
check('random 10-digit order ID', 'Your order ID is 4567891230, track it online', 'SHOULD_KEEP');
check('12-digit tracking number', 'Tracking number: 100234567891 arrives Friday', 'SHOULD_KEEP');
check('16-digit-looking product SKU', 'SKU: 1234567890123456 is out of stock', 'SHOULD_KEEP');
check('normal sentence with numbers', 'The meeting is at 10:30 and room 204 is booked', 'SHOULD_KEEP');
check('plain text no PII at all', 'Welcome to your dashboard, manage settings here', 'SHOULD_KEEP');
check('date that looks like it could match digit patterns', 'Invoice date: 12/09/2026, due in 30 days', 'SHOULD_KEEP');

console.log('\n--- Category E: Malformed / edge-case input (should not crash) ---');
check('empty string', '', 'SHOULD_KEEP');
check('only whitespace', '     ', 'SHOULD_KEEP');
check('very long string with PII buried in middle', 'x'.repeat(500) + ' email me at buried@test.com ' + 'y'.repeat(500), 'SHOULD_REDACT');
check('special characters and emoji around PII', '📧 call me!! 9876543210 🔥🔥', 'SHOULD_REDACT');
check('HTML-ish text (should not choke on tags)', '<b>Call 9876543210</b> now', 'SHOULD_REDACT');

console.log('\n--- Category F: Case sensitivity and unusual casing ---');
check('uppercase email', 'CONTACT ME AT JOHN@GMAIL.COM TODAY', 'SHOULD_REDACT');
check('mixed case domain', 'Email: John@GMail.Com', 'SHOULD_REDACT');

console.log('\n--- Category G: Sensitive-flagged element WITHOUT matching regex text ---');
(function testSensitiveFlagOverride() {
  const input = makeInput('just a random label with no PII pattern', true, { value: 'secretpassword123' });
  let result;
  try {
    result = sanitizeContext(input);
  } catch (err) {
    failCount++;
    failures.push(`[CRASH] "sensitive:true override" — threw error: ${err.message}`);
    return;
  }
  const outputText = JSON.stringify(result);
  const valueLeaked = outputText.includes('secretpassword123');
  if (valueLeaked) {
    failCount++;
    failures.push('[LEAK] Element with sensitive:true but non-matching text still leaked its .value property!');
  } else {
    passCount++;
    console.log('  ✅ [PASS] sensitive:true flag correctly strips .value even with no regex match');
  }
})();

console.log('\n' + '='.repeat(80));
console.log(`RESULTS: ${passCount} passed, ${failCount} failed (out of ${passCount + failCount})`);
console.log('='.repeat(80));

if (failCount > 0) {
  console.log('\n🚨 FAILURES — read these carefully, each is a real gap:\n');
  failures.forEach((f, i) => console.log(`${i + 1}. ${f}\n`));
  process.exitCode = 1;
} else {
  console.log('\n🎉 No failures found in this adversarial pass — but keep adding cases as you think of them.');
}
