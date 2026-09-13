// Integration tests για GET/PATCH /embed/domains (Section I: embed layer,
// domain allow-list).
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στο project: node tests/embed-domains.mjs
//
// Κάνει το δικό του signup (νέο τυχαίο email) ώστε να έχει ένα καθαρό
// workspace, χωρίς προϋπάρχοντα domains, χωρίς να αγγίζει πραγματικά
// δεδομένα.

const BASE_URL = "http://127.0.0.1:8787";
const TEST_EMAIL = `embed-test-${Date.now()}@example.com`;
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

async function getDomains(sessionToken) {
  return fetch(`${BASE_URL}/embed/domains`, {
    headers: { "X-Session-Token": sessionToken },
  });
}

async function patchDomains(sessionToken, domains) {
  return fetch(`${BASE_URL}/embed/domains`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
    body: JSON.stringify({ domains }),
  });
}

async function testEmptyByDefault(sessionToken, expectedEmbedId) {
  console.log("\n[GET /embed/domains -- νέος λογαριασμός, καμία δήλωση domain ακόμα]");
  const res = await getDomains(sessionToken);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.embedId === expectedEmbedId, "επιστρέφει το σωστό embedId του λογαριασμού");
  assert(Array.isArray(data.domains) && data.domains.length === 0, "domains είναι άδεια λίστα");
}

async function testAddValidDomains(sessionToken) {
  console.log("\n[PATCH /embed/domains -- δύο έγκυρα domains]");
  const res = await patchDomains(sessionToken, ["Pelatis.gr", "https://www.pelatis.gr/"]);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(
    JSON.stringify(data.domains) === JSON.stringify(["pelatis.gr", "www.pelatis.gr"]),
    "και τα δύο domains καθαρίστηκαν σωστά (lowercase, χωρίς https://, χωρίς /) και ταξινομήθηκαν"
  );
}

async function testInvalidDomainRejected(sessionToken) {
  console.log("\n[PATCH /embed/domains -- ένα άκυρο domain ανάμεσα σε έγκυρα]");
  const res = await patchDomains(sessionToken, ["pelatis.gr", "not a domain"]);
  const data = await res.json();
  assert(res.status === 400, "status 400 (ολόκληρο το request απορρίπτεται, όχι μερική αποδοχή)");
  assert(typeof data.error === "string", "επιστρέφει μήνυμα λάθους");
}

async function testTooManyDomainsRejected(sessionToken) {
  console.log("\n[PATCH /embed/domains -- υπερβολικός αριθμός domains]");
  const tooMany = Array.from({ length: 11 }, (_, i) => `site${i}.gr`);
  const res = await patchDomains(sessionToken, tooMany);
  assert(res.status === 400, "status 400 (πάνω από το όριο των 10)");
}

async function testUnchangedAfterRejectedPatch(sessionToken) {
  console.log("\n[GET /embed/domains -- επιβεβαίωση ότι τα προηγούμενα απορριφθέντα PATCH ΔΕΝ άλλαξαν τίποτα]");
  const res = await getDomains(sessionToken);
  const data = await res.json();
  assert(
    JSON.stringify(data.domains) === JSON.stringify(["pelatis.gr", "www.pelatis.gr"]),
    "η λίστα παραμένει ακριβώς όπως μετά το πρώτο επιτυχημένο PATCH"
  );
}

async function testReplaceClearsOldList(sessionToken) {
  console.log("\n[PATCH /embed/domains -- νέα λίστα αντικαθιστά πλήρως την παλιά]");
  const res = await patchDomains(sessionToken, ["allo-site.gr"]);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(
    JSON.stringify(data.domains) === JSON.stringify(["allo-site.gr"]),
    "η παλιά λίστα (pelatis.gr/www.pelatis.gr) αντικαταστάθηκε πλήρως, δεν προστέθηκε από πάνω"
  );
}

async function testEmptyArrayClearsAll(sessionToken) {
  console.log("\n[PATCH /embed/domains -- άδεια λίστα σβήνει τα πάντα]");
  const res = await patchDomains(sessionToken, []);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.domains.length === 0, "domains είναι πάλι άδεια λίστα");
}

async function testMissingSession() {
  console.log("\n[GET /embed/domains -- χωρίς X-Session-Token ούτε X-Workspace-Id]");
  const res = await fetch(`${BASE_URL}/embed/domains`);
  assert(res.status === 400, "status 400 (κανένα workspace δεν μπορεί να λυθεί)");
}

async function run() {
  console.log(`Test email: ${TEST_EMAIL}`);
  const signupData = await signup();
  await testEmptyByDefault(signupData.sessionToken, signupData.embedId);
  await testAddValidDomains(signupData.sessionToken);
  await testInvalidDomainRejected(signupData.sessionToken);
  await testTooManyDomainsRejected(signupData.sessionToken);
  await testUnchangedAfterRejectedPatch(signupData.sessionToken);
  await testReplaceClearsOldList(signupData.sessionToken);
  await testEmptyArrayClearsAll(signupData.sessionToken);
  await testMissingSession();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
