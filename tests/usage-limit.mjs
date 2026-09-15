// Integration test για το βασικό μηνιαίο όριο μηνυμάτων ανά workspace
// (Section N -- checkAndIncrementUsage στο index.js). ΔΕΝ ελέγχει pricing
// tiers (δεν υπάρχουν ακόμα), μόνο ότι το φρένο κόστους δουλεύει: μετά το
// όριο, οι ερωτήσεις απορρίπτονται με 429 ΠΡΙΝ φτάσουν καν στο Gemini.
//
// Πώς τρέχει:
//   1. Πρόσθεσε στο .dev.vars (δημιουργείται αν δεν υπάρχει):
//        MONTHLY_MESSAGE_LIMIT_OVERRIDE=3
//      (μόνο τοπικά -- ΠΟΤΕ στο wrangler.toml/production, βλ. σχόλιο στο
//      index.js πάνω από το checkAndIncrementUsage)
//   2. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   3. Σε άλλο τερματικό, μέσα στο project: node tests/usage-limit.mjs
//   4. Μετά το test, αφαίρεσε ξανά τη γραμμή από το .dev.vars αν δεν τη
//      χρειάζεσαι πια -- χωρίς αυτήν, το wrangler dev γυρνάει στο κανονικό
//      όριο παραγωγής (3000).
//
// Χρησιμοποιεί δικό του, τυχαίο workspace (νέο signup) ώστε ο μετρητής να
// ξεκινάει πάντα από το μηδέν -- καμία εξάρτηση σε προϋπάρχον state.
//
// ΣΗΜΕΙΩΣΗ: με MONTHLY_MESSAGE_LIMIT_OVERRIDE=3, κάνει 4 πραγματικά calls
// στο Gemini (τα πρώτα 3 επιτρεπόμενα + 1 ακόμα για να δει το reject),
// χρειάζεται έγκυρο GEMINI_API_KEY στο .dev.vars.

const BASE_URL = "http://127.0.0.1:8787";
const TEST_EMAIL = `usage-limit-${Date.now()}@example.com`;
const TEST_PASSWORD = "correct-horse-battery-staple";
const EXPECTED_LIMIT = 3; // πρέπει να ταιριάζει με το MONTHLY_MESSAGE_LIMIT_OVERRIDE στο .dev.vars

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
  const data = await res.json();
  return data.sessionToken;
}

async function askOnce(sessionToken, n) {
  const res = await fetch(`${BASE_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Session-Token": sessionToken },
    body: JSON.stringify({ question: `Δοκιμαστική ερώτηση αρ. ${n}` }),
  });
  return res;
}

async function run() {
  console.log(`Test account: ${TEST_EMAIL}`);
  console.log(`Αναμενόμενο όριο (MONTHLY_MESSAGE_LIMIT_OVERRIDE): ${EXPECTED_LIMIT}\n`);

  const sessionToken = await signup();

  console.log(`[${EXPECTED_LIMIT} ερωτήσεις ΜΕΣΑ στο όριο]`);
  for (let i = 1; i <= EXPECTED_LIMIT; i++) {
    const res = await askOnce(sessionToken, i);
    assert(res.status === 200, `ερώτηση #${i} περνάει κανονικά (status 200)`);
  }

  console.log(`\n[1 ερώτηση ΠΑΝΩ από το όριο]`);
  const overLimitRes = await askOnce(sessionToken, EXPECTED_LIMIT + 1);
  const overLimitData = await overLimitRes.json();
  assert(overLimitRes.status === 429, "status 429 (το όριο χτυπήθηκε)");
  assert(overLimitData.limitReached === true, "η απάντηση σηματοδοτεί limitReached: true");

  console.log(`\n[Το efood-ops-demo workspace ΔΕΝ έχει όριο -- δεν το αγγίζουμε εδώ, το ξέρουμε από τον κώδικα (PROTECTED_WORKSPACE_ID exemption)]`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
