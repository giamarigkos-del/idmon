// Integration tests για CORS middleware + POST /embed/{embedId}/query
// (Section I: embed layer).
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στο project: node tests/embed-query.mjs
//
// ΣΗΜΕΙΩΣΗ: αυτό το test κάνει πραγματικά calls στο Gemini API (η ερώτηση
// πρέπει να γίνει embedding πριν καν ελέγξουμε αν υπάρχουν σχετικά
// έγγραφα) -- χρειάζεται έγκυρο GEMINI_API_KEY secret, όπως και τα
// υπόλοιπα tests που αγγίζουν το /query.
//
// Το test workspace δεν έχει κανένα ανεβασμένο έγγραφο -- δεν χρειάζεται
// για να ελέγξουμε το CORS/routing, το bot απλά θα απαντήσει με το γενικό
// "fallback" μήνυμα, που είναι απόλυτα φυσιολογικό εδώ.

const BASE_URL = "http://127.0.0.1:8787";
const TEST_EMAIL = `embed-query-test-${Date.now()}@example.com`;
const TEST_PASSWORD = "correct-horse-battery-staple";
const ALLOWED_ORIGIN = "https://allowed-example.gr";
const DISALLOWED_ORIGIN = "https://evil-example.gr";

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

async function signup() {
  const res = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  return res.json();
}

async function setAllowedDomain(sessionToken) {
  const res = await fetch(`${BASE_URL}/embed/domains`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
    body: JSON.stringify({ domains: ["allowed-example.gr"] }),
  });
  if (res.status !== 200) throw new Error("Setup failed: could not set allowed domain");
}

async function preflight(embedId, origin) {
  return fetch(`${BASE_URL}/embed/${embedId}/query`, {
    method: "OPTIONS",
    headers: origin ? { Origin: origin } : {},
  });
}

async function postQuery(embedId, origin) {
  return fetch(`${BASE_URL}/embed/${embedId}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ question: "Τι ώρες είναι ανοιχτό το κατάστημα;" }),
  });
}

async function testPreflightAllowedOrigin(embedId) {
  console.log("\n[OPTIONS /embed/{embedId}/query -- επιτρεπόμενο origin]");
  const res = await preflight(embedId, ALLOWED_ORIGIN);
  assert(res.status === 204, "status 204");
  assert(
    res.headers.get("Access-Control-Allow-Origin") === ALLOWED_ORIGIN,
    "επιστρέφει Access-Control-Allow-Origin ΙΔΙΟ με το origin"
  );
}

async function testPreflightDisallowedOrigin(embedId) {
  console.log("\n[OPTIONS /embed/{embedId}/query -- ΜΗ επιτρεπόμενο origin]");
  const res = await preflight(embedId, DISALLOWED_ORIGIN);
  assert(res.status === 204, "status 204 (το request απαντιέται, αλλά χωρίς CORS headers)");
  assert(
    res.headers.get("Access-Control-Allow-Origin") === null,
    "ΔΕΝ επιστρέφει Access-Control-Allow-Origin -- ο browser θα μπλοκάρει μόνος του"
  );
}

async function testQueryAllowedOrigin(embedId) {
  console.log("\n[POST /embed/{embedId}/query -- επιτρεπόμενο origin]");
  const res = await postQuery(embedId, ALLOWED_ORIGIN);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(
    res.headers.get("Access-Control-Allow-Origin") === ALLOWED_ORIGIN,
    "επιστρέφει Access-Control-Allow-Origin ΙΔΙΟ με το origin"
  );
  assert(typeof data.answer === "string", "επιστρέφει έγκυρη απάντηση (fallback αναμενόμενο, χωρίς ανεβασμένα έγγραφα)");
}

async function testQueryDisallowedOrigin(embedId) {
  console.log("\n[POST /embed/{embedId}/query -- ΜΗ επιτρεπόμενο origin]");
  const res = await postQuery(embedId, DISALLOWED_ORIGIN);
  assert(res.status === 403, "status 403");
  assert(
    res.headers.get("Access-Control-Allow-Origin") === null,
    "ΔΕΝ επιστρέφει Access-Control-Allow-Origin"
  );
}

async function testQueryMissingOrigin(embedId) {
  console.log("\n[POST /embed/{embedId}/query -- χωρίς Origin header καθόλου (π.χ. script, όχι browser)]");
  const res = await postQuery(embedId, null);
  assert(res.status === 403, "status 403 (απαιτείται Origin)");
}

async function testUnknownEmbedId() {
  console.log("\n[POST /embed/{embedId}/query -- άγνωστο embedId]");
  const res = await postQuery("emb-does-not-exist", ALLOWED_ORIGIN);
  assert(res.status === 404, "status 404");
}

async function run() {
  console.log(`Test email: ${TEST_EMAIL}`);
  const signupData = await signup();
  await setAllowedDomain(signupData.sessionToken);
  const { embedId } = signupData;

  await testPreflightAllowedOrigin(embedId);
  await testPreflightDisallowedOrigin(embedId);
  await testQueryAllowedOrigin(embedId);
  await testQueryDisallowedOrigin(embedId);
  await testQueryMissingOrigin(embedId);
  await testUnknownEmbedId();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
