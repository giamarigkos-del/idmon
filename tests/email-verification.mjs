// Integration tests για το email verification flow: signup στέλνει email
// επιβεβαίωσης, /account/verify-email, /account/resend-verification.
//
// Πώς τρέχει:
//   1. wrangler dev
//   2. node tests/email-verification.mjs
//
// ΣΗΜΕΙΩΣΗ (ίδιος περιορισμός με το password-reset.mjs): το πραγματικό
// verify token φτάνει ΜΟΝΟ μέσω email. Το `wrangler secret put` βάζει το
// RESEND_API_KEY στο ΠΑΡΑΓΩΓΗΣ Worker -- ΔΕΝ είναι αυτόματα διαθέσιμο στο
// τοπικό `wrangler dev` εκτός αν το προσθέσεις ΚΑΙ στο .dev.vars. Αν δεν
// είναι εκεί, sendEmailViaResend απλά δεν κάνει τίποτα (no-op, ΔΕΝ σκάει) --
// οπότε αυτό το test δεν στέλνει πραγματικά emails όσο τρέχεις τοπικά, εκτός
// αν το έχεις προσθέσει επίτηδες. Το test ελέγχει τα πάντα ΓΥΡΩ από το
// happy path (validation, rate limiting, session requirement) αλλά ΟΧΙ το
// ίδιο το "πάτησα τον σύνδεσμο από το email" -- αυτό χρειάζεται χειροκίνητο
// live έλεγχο, όπως κάναμε με το password reset.

const BASE_URL = "http://127.0.0.1:8787";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function ipHeaders(testIp, extra = {}) {
  return { "Content-Type": "application/json; charset=utf-8", "CF-Connecting-IP": testIp, ...extra };
}

async function signup(email, testIp) {
  const res = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
  return { res, data: await res.json() };
}

async function testSignupStartsUnverified() {
  const testIp = `test-verify-signup-ip-${Date.now()}`;
  console.log(`\n[Signup -- νέος λογαριασμός ξεκινάει emailVerified: false]`);

  const email = `verify-signup-${Date.now()}@example.com`;
  const { res, data } = await signup(email, testIp);

  assert(res.status === 200, "status 200");
  assert(data.ok === true, "ok: true");
  assert(data.emailVerified === false, "emailVerified: false αμέσως μετά το signup");

  return { email, sessionToken: data.sessionToken };
}

async function testLoginReflectsVerificationStatus(email) {
  const testIp = `test-verify-login-ip-${Date.now()}`;
  console.log(`\n[Login -- βλέπει το ίδιο emailVerified status]`);

  const res = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
  const data = await res.json();
  assert(data.emailVerified === false, "το login βλέπει emailVerified: false, ίδιο με το signup");
}

async function testVerifyEmailInvalidToken() {
  const testIp = `test-verify-invalid-ip-${Date.now()}`;
  console.log(`\n[/account/verify-email -- άκυρο/ανύπαρκτο token]`);

  const res = await fetch(`${BASE_URL}/account/verify-email`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ token: "this-token-does-not-exist" }),
  });
  const data = await res.json();
  assert(res.status === 400, "status 400");
  assert(/invalid|expired/i.test(data.error || ""), "μήνυμα λάθους αναφέρει άκυρο/ληγμένο token");
}

async function testVerifyEmailRateLimit() {
  const testIp = `test-verify-limit-ip-${Date.now()}`;
  console.log(`\n[Rate limit στο /account/verify-email -- IP: ${testIp}]`);

  let lastStatus;
  for (let i = 1; i <= 5; i++) {
    const res = await fetch(`${BASE_URL}/account/verify-email`, {
      method: "POST",
      headers: ipHeaders(testIp),
      body: JSON.stringify({ token: `garbage-${i}` }),
    });
    lastStatus = res.status;
  }
  assert(lastStatus === 400, "οι πρώτες 5 άκυρες προσπάθειες παίρνουν 400");

  const sixthRes = await fetch(`${BASE_URL}/account/verify-email`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ token: "garbage-6" }),
  });
  assert(sixthRes.status === 429, "η 6η μπλοκάρεται με 429");
}

async function testResendVerificationRequiresSession() {
  const testIp = `test-resend-nosession-ip-${Date.now()}`;
  console.log(`\n[/account/resend-verification -- χωρίς X-Session-Token]`);

  const res = await fetch(`${BASE_URL}/account/resend-verification`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({}),
  });
  assert(res.status === 401, "status 401 (απαιτεί ενεργό session)");
}

async function testResendVerificationWithSession(sessionToken) {
  const testIp = `test-resend-session-ip-${Date.now()}`;
  console.log(`\n[/account/resend-verification -- με έγκυρο session ανεπιβεβαίωτου λογαριασμού]`);

  const res = await fetch(`${BASE_URL}/account/resend-verification`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
    body: JSON.stringify({ lang: "en" }),
  });
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.ok === true, "ok: true");
  assert(!data.alreadyVerified, "δεν σηματοδοτεί alreadyVerified (ο λογαριασμός είναι πράγματι ανεπιβεβαίωτος)");
}

async function run() {
  const { email, sessionToken } = await testSignupStartsUnverified();
  await testLoginReflectsVerificationStatus(email);
  await testVerifyEmailInvalidToken();
  await testVerifyEmailRateLimit();
  await testResendVerificationRequiresSession();
  await testResendVerificationWithSession(sessionToken);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
