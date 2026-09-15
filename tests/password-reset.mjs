// Integration tests για rate limiting (login/developer-login/signup/
// forgot-password) και το password reset flow (Section O).
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στο project: node tests/password-reset.mjs
//
// ΣΗΜΕΙΩΣΗ για CF-Connecting-IP: το backend κάνει rate limit ανά IP,
// διαβάζοντας το header CF-Connecting-IP. Σε πραγματική κίνηση, η Cloudflare
// ΠΑΝΤΑ αντικαθιστά αυτό το header στο edge -- ένας πραγματικός επισκέπτης
// ΔΕΝ μπορεί να το πλαστογραφήσει. Τοπικά (wrangler dev) δεν υπάρχει edge,
// οπότε το test ΣΤΕΛΝΕΙ το δικό του, μοναδικό header ανά test -- έτσι τα
// rate-limit buckets ΔΕΝ μπλέκονται μεταξύ των tests (ή με το accounts.mjs),
// και δεν αφήνουμε "μπλοκαρισμένο" IP για 15 λεπτά μετά το τρέξιμο.
//
// ΣΗΜΕΙΩΣΗ για το πλήρες reset flow: το πραγματικό token φτάνει ΜΟΝΟ μέσω
// email (Resend). Χωρίς πραγματικό RESEND_API_KEY στο .dev.vars, το test
// δεν μπορεί να διαβάσει το πραγματικό token -- γι' αυτό ελέγχει τα πάντα
// ΓΥΡΩ από το happy path (validation, rate limiting, invalid token) αλλά
// ΟΧΙ το "πάτησα τον σύνδεσμο από το email και άλλαξε ο κωδικός" ίδιο. Αυτό
// χρειάζεται ένα χειροκίνητο πέρασμα με πραγματικό Resend key.

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

async function testLoginRateLimit() {
  const testIp = `test-login-ip-${Date.now()}`;
  console.log(`\n[Rate limit στο /account/login -- IP: ${testIp}]`);

  const email = `ratelimit-login-${Date.now()}@example.com`;
  await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: ipHeaders(`signup-${testIp}`),
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });

  let lastStatus;
  for (let i = 1; i <= 5; i++) {
    const res = await fetch(`${BASE_URL}/account/login`, {
      method: "POST",
      headers: ipHeaders(testIp),
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
    lastStatus = res.status;
  }
  assert(lastStatus === 401, "οι πρώτες 5 λάθος προσπάθειες παίρνουν 401 (κανονικό \"λάθος κωδικός\")");

  const sixthRes = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ email, password: "wrong-password" }),
  });
  assert(sixthRes.status === 429, "η 6η προσπάθεια μπλοκάρεται με 429 (ΠΡΙΝ καν ελεγχθεί ο κωδικός)");

  const correctPasswordRes = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
  assert(correctPasswordRes.status === 429, "ακόμα κι ο ΣΩΣΤΟΣ κωδικός μπλοκάρεται όσο ισχύει το rate limit");
}

async function testDeveloperLoginRateLimit() {
  const testIp = `test-devlogin-ip-${Date.now()}`;
  console.log(`\n[Rate limit στο /developer-login -- IP: ${testIp}]`);

  let lastStatus;
  for (let i = 1; i <= 5; i++) {
    const res = await fetch(`${BASE_URL}/developer-login`, {
      method: "POST",
      headers: ipHeaders(testIp),
      body: JSON.stringify({ password: "definitely-wrong" }),
    });
    lastStatus = res.status;
  }
  assert(lastStatus === 401, "οι πρώτες 5 λάθος προσπάθειες παίρνουν 401");

  const sixthRes = await fetch(`${BASE_URL}/developer-login`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ password: "definitely-wrong" }),
  });
  assert(sixthRes.status === 429, "η 6η προσπάθεια μπλοκάρεται με 429");
}

async function testForgotPasswordGenericResponse() {
  const testIp = `test-forgot-ip-${Date.now()}`;
  console.log(`\n[/account/forgot-password -- ΙΔΙΟ μήνυμα για υπαρκτό και ανύπαρκτο email]`);

  const email = `forgot-flow-${Date.now()}@example.com`;
  await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: ipHeaders(`signup-${testIp}`),
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });

  const resExisting = await fetch(`${BASE_URL}/account/forgot-password`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ email }),
  });
  const dataExisting = await resExisting.json();

  const resMissing = await fetch(`${BASE_URL}/account/forgot-password`, {
    method: "POST",
    headers: ipHeaders(`${testIp}-2`),
    body: JSON.stringify({ email: `nobody-${Date.now()}@example.com` }),
  });
  const dataMissing = await resMissing.json();

  assert(resExisting.status === 200 && resMissing.status === 200, "status 200 και στις δύο περιπτώσεις");
  assert(dataExisting.ok === true && dataMissing.ok === true, "ok:true και στις δύο περιπτώσεις");
  assert(dataExisting.message === dataMissing.message, "ΑΚΡΙΒΩΣ το ίδιο μήνυμα -- δεν αποκαλύπτει ποιο email υπάρχει");
}

async function testForgotPasswordRateLimit() {
  const testIp = `test-forgot-limit-ip-${Date.now()}`;
  console.log(`\n[Rate limit στο /account/forgot-password -- IP: ${testIp}]`);

  let lastStatus;
  for (let i = 1; i <= 5; i++) {
    const res = await fetch(`${BASE_URL}/account/forgot-password`, {
      method: "POST",
      headers: ipHeaders(testIp),
      body: JSON.stringify({ email: `whatever-${i}@example.com` }),
    });
    lastStatus = res.status;
  }
  assert(lastStatus === 200, "οι πρώτες 5 κλήσεις περνάνε κανονικά");

  const sixthRes = await fetch(`${BASE_URL}/account/forgot-password`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ email: "whatever-6@example.com" }),
  });
  assert(sixthRes.status === 429, "η 6η μπλοκάρεται με 429");
}

async function testResetPasswordInvalidToken() {
  const testIp = `test-reset-invalid-ip-${Date.now()}`;
  console.log(`\n[/account/reset-password -- άκυρο/ανύπαρκτο token]`);

  const res = await fetch(`${BASE_URL}/account/reset-password`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ token: "this-token-does-not-exist", newPassword: "brand-new-password-123" }),
  });
  const data = await res.json();
  assert(res.status === 400, "status 400");
  assert(/invalid|expired/i.test(data.error || ""), "μήνυμα λάθους αναφέρει άκυρο/ληγμένο token");
}

async function testResetPasswordShortPassword() {
  const testIp = `test-reset-short-ip-${Date.now()}`;
  console.log(`\n[/account/reset-password -- πολύ σύντομος νέος κωδικός]`);

  const res = await fetch(`${BASE_URL}/account/reset-password`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ token: "irrelevant-here", newPassword: "short" }),
  });
  assert(res.status === 400, "status 400 -- ελέγχεται ΠΡΙΝ καν κοιτάξει αν υπάρχει το token");
}

async function run() {
  await testLoginRateLimit();
  await testDeveloperLoginRateLimit();
  await testForgotPasswordGenericResponse();
  await testForgotPasswordRateLimit();
  await testResetPasswordInvalidToken();
  await testResetPasswordShortPassword();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
