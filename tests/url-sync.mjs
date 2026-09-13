// Integration tests για URL sync (Section M): POST /upload-from-url και
// POST /document/{id}/refresh-from-url.
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στο project: node tests/url-sync.mjs
//
// Χρησιμοποιεί το https://example.com ως πραγματικό, σταθερό, πάντα
// διαθέσιμο public URL (IANA reserved domain για ακριβώς τέτοια παραδείγματα
// -- ελάχιστο, προβλέψιμο περιεχόμενο, δεν αλλάζει ποτέ).

const BASE_URL = "http://127.0.0.1:8787";
const TEST_EMAIL = `url-sync-test-${Date.now()}@example.com`;
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

async function uploadFromUrl(sessionToken, url, title) {
  return fetch(`${BASE_URL}/upload-from-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
    body: JSON.stringify({ url, title }),
  });
}

async function getDocument(sessionToken, documentId) {
  return fetch(`${BASE_URL}/document/${encodeURIComponent(documentId)}`, {
    headers: { "X-Session-Token": sessionToken },
  });
}

async function testMissingUrl(sessionToken) {
  console.log("\n[POST /upload-from-url -- χωρίς url]");
  const res = await uploadFromUrl(sessionToken, "");
  assert(res.status === 400, "status 400");
}

async function testInvalidUrl(sessionToken) {
  console.log("\n[POST /upload-from-url -- άκυρο URL]");
  const res = await uploadFromUrl(sessionToken, "not-a-url-at-all");
  assert(res.status === 400, "status 400");
}

async function testUnsupportedScheme(sessionToken) {
  console.log("\n[POST /upload-from-url -- μη υποστηριζόμενο scheme]");
  const res = await uploadFromUrl(sessionToken, "ftp://example.com/file.txt");
  assert(res.status === 400, "status 400 (μόνο http/https)");
}

async function testMissingSession() {
  console.log("\n[POST /upload-from-url -- χωρίς session/workspace]");
  const res = await fetch(`${BASE_URL}/upload-from-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  assert(res.status === 400, "status 400");
}

async function testSuccessfulSync(sessionToken) {
  console.log("\n[POST /upload-from-url -- πραγματικό, σταθερό public URL]");
  const res = await uploadFromUrl(sessionToken, "https://example.com", "Παράδειγμα σελίδας");
  const data = await res.json();
  if (res.status !== 200) {
    console.log("  ℹ Απάντηση backend:", JSON.stringify(data));
  }
  assert(res.status === 200, "status 200");
  assert(data.ok === true, "ok === true");
  assert(typeof data.documentId === "string" && data.documentId.length > 0, "επιστρέφει έγκυρο documentId");
  assert(data.wordCount > 0, "επιστρέφει θετικό wordCount");
  return data.documentId;
}

async function testDocumentStartsAsDraft(sessionToken, documentId) {
  console.log("\n[GET /document/{id} -- το νέο έγγραφο έχει πραγματικό, εξαγμένο κείμενο]");
  const res = await getDocument(sessionToken, documentId);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.text && data.text.length > 0, "το κείμενο δεν είναι κενό");
  assert(!data.text.includes("<html"), "το κείμενο ΔΕΝ περιέχει raw HTML tags");
  assert(data.sourceUrl.startsWith("https://example.com"), "το sourceUrl αποθηκεύτηκε σωστά");
}

async function testRefreshWithoutSourceUrlFails(sessionToken) {
  console.log("\n[POST /document/{id}/refresh-from-url -- έγγραφο ΧΩΡΙΣ sourceUrl]");
  // Δημιουργούμε ένα κανονικό (χειροκίνητο) έγγραφο, χωρίς sourceUrl.
  const uploadRes = await fetch(`${BASE_URL}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
    body: JSON.stringify({ documentId: `manual-doc-${Date.now()}`, text: "Απλό χειροκίνητο κείμενο δοκιμής." }),
  });
  const uploadData = await uploadRes.json();
  const res = await fetch(`${BASE_URL}/document/${uploadData.documentId}/refresh-from-url`, {
    method: "POST",
    headers: { "X-Session-Token": sessionToken },
  });
  assert(res.status === 400, "status 400 (κανένα sourceUrl για να ανανεώσει)");
}

async function testRefreshExistingUrlDoc(sessionToken, documentId) {
  console.log("\n[POST /document/{id}/refresh-from-url -- ξαναδιαβάζει το ίδιο URL]");
  const res = await fetch(`${BASE_URL}/document/${documentId}/refresh-from-url`, {
    method: "POST",
    headers: { "X-Session-Token": sessionToken },
  });
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.ok === true, "ok === true");
  assert(data.status === "draft", "παραμένει draft (δεν ήταν ποτέ δημοσιευμένο)");
}

async function testRefreshUnknownDocument(sessionToken) {
  console.log("\n[POST /document/{id}/refresh-from-url -- άγνωστο documentId]");
  const res = await fetch(`${BASE_URL}/document/does-not-exist-${Date.now()}/refresh-from-url`, {
    method: "POST",
    headers: { "X-Session-Token": sessionToken },
  });
  assert(res.status === 404, "status 404");
}

async function run() {
  console.log(`Test email: ${TEST_EMAIL}`);
  const signupData = await signup();
  const sessionToken = signupData.sessionToken;

  await testMissingUrl(sessionToken);
  await testInvalidUrl(sessionToken);
  await testUnsupportedScheme(sessionToken);
  await testMissingSession();
  const documentId = await testSuccessfulSync(sessionToken);
  await testDocumentStartsAsDraft(sessionToken, documentId);
  await testRefreshWithoutSourceUrlFails(sessionToken);
  await testRefreshExistingUrlDoc(sessionToken, documentId);
  await testRefreshUnknownDocument(sessionToken);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
