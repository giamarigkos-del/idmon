// Integration tests για GET /analytics/summary (Section K: analytics).
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στο project: node tests/analytics.mjs
//
// ΣΗΜΕΙΩΣΗ: κάνει πραγματικά calls στο Gemini API (κάθε /query χρειάζεται
// embedding της ερώτησης πριν καν ελέγξει αν υπάρχουν σχετικά έγγραφα),
// χρειάζεται έγκυρο GEMINI_API_KEY στο .dev.vars.
//
// Κάνει το δικό του signup (νέο τυχαίο email) ώστε να έχει ένα ΚΑΘΑΡΟ
// workspace χωρίς προϋπάρχοντα analytics -- τα νούμερα που περιμένουμε
// είναι προβλέψιμα (100% fallback, αφού το workspace δεν έχει ΚΑΝΕΝΑ
// ανεβασμένο έγγραφο).

const BASE_URL = "http://127.0.0.1:8787";
const TEST_EMAIL = `analytics-test-${Date.now()}@example.com`;
const TEST_PASSWORD = "correct-horse-battery-staple";

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

async function askQuestion(sessionToken, question) {
  return fetch(`${BASE_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
    body: JSON.stringify({ question }),
  });
}

async function getSummary(sessionToken, days) {
  const qs = days !== undefined ? `?days=${days}` : "";
  return fetch(`${BASE_URL}/analytics/summary${qs}`, {
    headers: { "X-Session-Token": sessionToken },
  });
}

async function testMissingWorkspace() {
  console.log("\n[GET /analytics/summary -- χωρίς session/workspace]");
  const res = await fetch(`${BASE_URL}/analytics/summary`);
  assert(res.status === 400, "status 400");
}

async function testEmptySummaryBeforeAnyQuery(sessionToken) {
  console.log("\n[GET /analytics/summary -- νέο workspace, καμία ερώτηση ακόμα]");
  const res = await getSummary(sessionToken);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.totalQuestions === 0, "totalQuestions = 0");
  assert(data.totalFallback === 0, "totalFallback = 0");
  assert(data.fallbackRate === 0, "fallbackRate = 0 (όχι διαίρεση με το μηδέν)");
  assert(Array.isArray(data.daily) && data.daily.length === 30, "daily array έχει 30 ημέρες (default)");
}

async function testRecordsThreeQuestionsAsFallback(sessionToken) {
  console.log("\n[POST /query x3 -- workspace χωρίς έγγραφα, όλα fallback]");
  for (const q of ["ερώτηση 1", "ερώτηση 2", "ερώτηση 3"]) {
    const res = await askQuestion(sessionToken, q);
    const data = await res.json();
    assert(res.status === 200, `status 200 για "${q}"`);
    assert(data.isFallback === true, `"${q}" είναι fallback (καμία τεκμηρίωση στο workspace)`);
  }
}

async function testSummaryReflectsRecordedQuestions(sessionToken) {
  console.log("\n[GET /analytics/summary -- μετά τις 3 ερωτήσεις]");
  const res = await getSummary(sessionToken);
  const data = await res.json();
  assert(data.totalQuestions === 3, "totalQuestions = 3");
  assert(data.totalFallback === 3, "totalFallback = 3 (όλες fallback)");
  assert(data.fallbackRate === 100, "fallbackRate = 100%");

  const today = new Date().toISOString().slice(0, 10);
  const todayEntry = data.daily[data.daily.length - 1];
  assert(todayEntry.date === today, "η τελευταία ημέρα του daily array είναι σήμερα (χρονολογική σειρά παλιό→νέο)");
  assert(todayEntry.total === 3, "η σημερινή ημέρα έχει total=3");
  assert(todayEntry.fallback === 3, "η σημερινή ημέρα έχει fallback=3");

  const otherDays = data.daily.slice(0, -1);
  assert(
    otherDays.every((d) => d.total === 0 && d.fallback === 0),
    "όλες οι υπόλοιπες ημέρες είναι μηδενικές"
  );
}

async function testDaysParameterRespected(sessionToken) {
  console.log("\n[GET /analytics/summary?days=7]");
  const res = await getSummary(sessionToken, 7);
  const data = await res.json();
  assert(data.daily.length === 7, "daily array έχει ακριβώς 7 ημέρες");
}

async function testDaysParameterClampedToMax(sessionToken) {
  console.log("\n[GET /analytics/summary?days=500 -- πάνω από το όριο]");
  const res = await getSummary(sessionToken, 500);
  const data = await res.json();
  assert(data.daily.length === 90, "clamped στο μέγιστο (90 ημέρες)");
}

async function testDaysParameterClampedToMin(sessionToken) {
  console.log("\n[GET /analytics/summary?days=0 -- κάτω από το όριο]");
  const res = await getSummary(sessionToken, 0);
  const data = await res.json();
  assert(data.daily.length === 1, "clamped στο ελάχιστο (1 ημέρα)");
}

async function run() {
  console.log(`Test email: ${TEST_EMAIL}`);
  await testMissingWorkspace();

  const signupData = await signup();
  const sessionToken = signupData.sessionToken;

  await testEmptySummaryBeforeAnyQuery(sessionToken);
  await testRecordsThreeQuestionsAsFallback(sessionToken);
  await testSummaryReflectsRecordedQuestions(sessionToken);
  await testDaysParameterRespected(sessionToken);
  await testDaysParameterClampedToMax(sessionToken);
  await testDaysParameterClampedToMin(sessionToken);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
