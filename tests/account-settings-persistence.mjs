// Integration test: επιβεβαιώνει ότι οι ρυθμίσεις widget (accentColor κλπ,
// Section G) ΠΡΑΓΜΑΤΙΚΑ αποθηκεύονται ανά account -- όχι μόνο μέσα στο ίδιο
// session, αλλά και μετά από logout/login (νέο session token, ίδιο account),
// ΚΑΙ ότι δύο διαφορετικοί λογαριασμοί δεν βλέπουν ποτέ ο ένας τις ρυθμίσεις
// του άλλου.
//
// Το accounts.mjs ήδη ελέγχει ότι ένα session γράφει/διαβάζει σωστά μέσα στο
// ΙΔΙΟ workspace (και ότι ένα πλαστό X-Workspace-Id header αγνοείται όταν
// υπάρχει session). Αυτό εδώ καλύπτει αυτό που ΔΕΝ καλύπτει εκείνο: αν η
// αλλαγή "μένει" μετά από ένα πραγματικό logout+login, και αν δύο ξεχωριστοί
// λογαριασμοί είναι όντως απομονωμένοι.
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στον φάκελο του project: node tests/account-settings-persistence.mjs
//
// Δύο τυχαία emails ανά run (βασισμένα σε timestamp) -- δεν αγγίζει ποτέ
// πραγματικούς λογαριασμούς ή το efood-ops-demo workspace.

const BASE_URL = "http://127.0.0.1:8787";
const EMAIL_A = `persist-a-${Date.now()}@example.com`;
const EMAIL_B = `persist-b-${Date.now()}@example.com`;
const PASSWORD = "correct-horse-battery-staple";
const COLOR_A = "#1E90FF";
const COLOR_B = "#FF4500";

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

async function signup(email) {
  const res = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json();
  return data.sessionToken;
}

async function login(email) {
  const res = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json();
  return data.sessionToken;
}

async function getAccentColor(sessionToken) {
  const res = await fetch(`${BASE_URL}/workspace/settings`, {
    headers: { "X-Session-Token": sessionToken },
  });
  const data = await res.json();
  return data.accentColor;
}

async function patchAccentColor(sessionToken, color) {
  return fetch(`${BASE_URL}/workspace/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Session-Token": sessionToken },
    body: JSON.stringify({ accentColor: color }),
  });
}

async function testPersistsAcrossLogoutLogin() {
  console.log(`\n[Λογαριασμός A: ${EMAIL_A}]`);
  const sessionA1 = await signup(EMAIL_A);
  assert(typeof sessionA1 === "string", "signup επέστρεψε session token");

  const patchRes = await patchAccentColor(sessionA1, COLOR_A);
  assert(patchRes.status === 200, "PATCH accentColor status 200");

  console.log("\n[Logout, μετά ΝΕΟ login -- νέο session token, ίδιος λογαριασμός]");
  await fetch(`${BASE_URL}/account/logout`, {
    method: "POST",
    headers: { "X-Session-Token": sessionA1 },
  });
  const sessionA2 = await login(EMAIL_A);
  assert(sessionA2 !== sessionA1, "το νέο session token είναι πραγματικά διαφορετικό από το παλιό");

  const colorAfterRelogin = await getAccentColor(sessionA2);
  assert(colorAfterRelogin === COLOR_A, "το accentColor ΕΠΙΒΙΩΝΕΙ μετά από logout+login (δεν ήταν απλά cached στο παλιό session)");

  return sessionA2;
}

async function testIsolationBetweenAccounts(sessionA) {
  console.log(`\n[Λογαριασμός B: ${EMAIL_B}]`);
  const sessionB = await signup(EMAIL_B);

  const defaultColorB = await getAccentColor(sessionB);
  assert(defaultColorB === "#111111", "νέος λογαριασμός B ξεκινάει με το ΠΡΟΕΠΙΛΕΓΜΕΝΟ χρώμα (μαύρο), όχι το χρώμα του A");

  await patchAccentColor(sessionB, COLOR_B);
  const colorBAfterPatch = await getAccentColor(sessionB);
  assert(colorBAfterPatch === COLOR_B, "το B αποθήκευσε το δικό του χρώμα");

  const colorAStillIntact = await getAccentColor(sessionA);
  assert(colorAStillIntact === COLOR_A, "το χρώμα του A ΔΕΝ άλλαξε από την αλλαγή του B (πλήρης απομόνωση μεταξύ λογαριασμών)");
}

async function run() {
  console.log(`Test accounts: ${EMAIL_A} / ${EMAIL_B}`);
  const sessionA = await testPersistsAcrossLogoutLogin();
  await testIsolationBetweenAccounts(sessionA);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
