// Integration tests για τα νέα /workspace/settings endpoints (Section G:
// widget customization + email ειδοποίησης).
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στον φάκελο του project: node tests/widget-settings.mjs
//
// Χρησιμοποιεί ένα τυχαίο workspaceId ανά run (σαν guest workspace) ώστε να
// μην πειράζει ποτέ πραγματικά δεδομένα -- καθαρό test, καμία εξάρτηση σε
// προϋπάρχον state.

const BASE_URL = "http://127.0.0.1:8787";
const TEST_WORKSPACE_ID = `test-settings-${Date.now()}`;
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "X-Workspace-Id": TEST_WORKSPACE_ID };

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

async function testMissingWorkspaceHeader() {
  console.log("\n[GET /workspace/settings χωρίς X-Workspace-Id]");
  const res = await fetch(`${BASE_URL}/workspace/settings`);
  assert(res.status === 400, "status 400");
}

async function testDefaults() {
  console.log("\n[GET /workspace/settings -- νέο workspace, χωρίς προηγούμενο save]");
  const res = await fetch(`${BASE_URL}/workspace/settings`, { headers: HEADERS });
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.accentColor === "#6B7280", "default accentColor = #6B7280");
  assert(data.botName === "Assistant", "default botName = Assistant");
  assert(data.logoUrl === null, "default logoUrl = null");
  assert(data.notifyEmail === null, "default notifyEmail = null");
  assert(data.contactLabel === null, "default contactLabel = null");
  assert(data.contactUrl === null, "default contactUrl = null");
  assert(data.contactPhone === null, "default contactPhone = null");
}

async function testPatchAndReread() {
  console.log("\n[PATCH /workspace/settings -- αλλαγή έγκυρων τιμών]");
  const payload = {
    accentColor: "#123ABC",
    botName: "Βοηθός Πωλήσεων",
    logoUrl: "https://example.com/logo.png",
    notifyEmail: "owner@example.com",
    contactLabel: "Μίλα μαζί μας στο WhatsApp",
    contactUrl: "https://wa.me/306912345678",
    contactPhone: "+30 210 1234567",
  };
  const patchRes = await fetch(`${BASE_URL}/workspace/settings`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  const patched = await patchRes.json();
  assert(patchRes.status === 200, "PATCH status 200");
  assert(patched.accentColor === "#123ABC", "PATCH response έχει το νέο accentColor");

  const getRes = await fetch(`${BASE_URL}/workspace/settings`, { headers: HEADERS });
  const reread = await getRes.json();
  assert(reread.botName === "Βοηθός Πωλήσεων", "GET μετά το PATCH βλέπει το νέο botName (persist σε KV)");
  assert(reread.notifyEmail === "owner@example.com", "GET μετά το PATCH βλέπει το νέο notifyEmail");
  assert(reread.contactLabel === "Μίλα μαζί μας στο WhatsApp", "GET μετά το PATCH βλέπει το νέο contactLabel");
  assert(reread.contactUrl === "https://wa.me/306912345678", "GET μετά το PATCH βλέπει το νέο contactUrl");
  assert(reread.contactPhone === "+30 210 1234567", "GET μετά το PATCH βλέπει το νέο contactPhone");
}

async function testWhitelistIgnoresUnknownFields() {
  console.log("\n[PATCH /workspace/settings -- άγνωστο πεδίο αγνοείται]");
  const res = await fetch(`${BASE_URL}/workspace/settings`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ isAdmin: true, apiKeyOverride: "hacked" }),
  });
  const data = await res.json();
  assert(res.status === 200, "status 200 (δεν σκάει σε άγνωστα πεδία)");
  assert(data.isAdmin === undefined, "το άγνωστο πεδίο 'isAdmin' δεν αποθηκεύεται");
  assert(data.apiKeyOverride === undefined, "το άγνωστο πεδίο 'apiKeyOverride' δεν αποθηκεύεται");
}

async function testInvalidAccentColor() {
  console.log("\n[PATCH /workspace/settings -- μη έγκυρο accentColor]");
  const res = await fetch(`${BASE_URL}/workspace/settings`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ accentColor: "not-a-color" }),
  });
  assert(res.status === 400, "status 400 για μη-hex χρώμα");
}

async function testInvalidEmail() {
  console.log("\n[PATCH /workspace/settings -- μη έγκυρο notifyEmail]");
  const res = await fetch(`${BASE_URL}/workspace/settings`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ notifyEmail: "not-an-email" }),
  });
  assert(res.status === 400, "status 400 για άκυρο email");
}

async function testInvalidContactUrl() {
  console.log("\n[PATCH /workspace/settings -- contactUrl χωρίς scheme]");
  const res = await fetch(`${BASE_URL}/workspace/settings`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ contactUrl: "wa.me/306912345678" }),
  });
  assert(res.status === 400, "status 400 όταν λείπει το scheme (π.χ. https://, mailto:, tel:)");
}

async function testValidContactUrlSchemes() {
  console.log("\n[PATCH /workspace/settings -- διάφορα έγκυρα contactUrl schemes]");
  for (const url of ["mailto:owner@example.com", "tel:+306912345678", "https://wa.me/306912345678"]) {
    const res = await fetch(`${BASE_URL}/workspace/settings`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ contactUrl: url }),
    });
    assert(res.status === 200, `status 200 για ${url}`);
  }
}

async function testContactLabelTooLong() {
  console.log("\n[PATCH /workspace/settings -- πολύ μακρύ contactLabel]");
  const res = await fetch(`${BASE_URL}/workspace/settings`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ contactLabel: "x".repeat(41) }),
  });
  assert(res.status === 400, "status 400 (όριο 40 χαρακτήρων)");
}

async function run() {
  console.log(`Test workspace: ${TEST_WORKSPACE_ID}`);
  await testMissingWorkspaceHeader();
  await testDefaults();
  await testPatchAndReread();
  await testWhitelistIgnoresUnknownFields();
  await testInvalidAccentColor();
  await testInvalidEmail();
  await testInvalidContactUrl();
  await testValidContactUrlSchemes();
  await testContactLabelTooLong();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
