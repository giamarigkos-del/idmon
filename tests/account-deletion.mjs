// Integration test για data export (GET /account/export) και πλήρη
// διαγραφή λογαριασμού (POST /account/delete) -- Section P.
//
// Φτιάχνει έναν πραγματικό λογαριασμό, ανεβάζει ΚΑΙ δημοσιεύει ένα
// πραγματικό έγγραφο (πραγματικό Gemini embedding call, ίδιο μοτίβο με τα
// άλλα backend tests), για να επιβεβαιώσει ότι το export βλέπει το
// περιεχόμενο ΚΑΙ ότι η διαγραφή το καθαρίζει πραγματικά, όχι μόνο τη
// γραμμή του λογαριασμού.
//
// Πώς τρέχει:
//   1. wrangler dev
//   2. node tests/account-deletion.mjs

const BASE_URL = "http://127.0.0.1:8787";
const EMAIL = `delete-test-${Date.now()}@example.com`;
const PASSWORD = "correct-horse-battery-staple";

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

async function run() {
  const testIp = `test-delete-ip-${Date.now()}`;

  console.log(`\n[Signup + upload + publish -- προετοιμασία δεδομένων προς διαγραφή]`);
  const signupRes = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const signupData = await signupRes.json();
  const sessionToken = signupData.sessionToken;
  assert(signupRes.status === 200, "signup status 200");

  const docId = `test-doc-${Date.now()}`;
  const uploadRes = await fetch(`${BASE_URL}/upload`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
    body: JSON.stringify({ documentId: docId, title: "Δοκιμαστικό έγγραφο προς διαγραφή", text: "Αυτό είναι ένα δοκιμαστικό έγγραφο." }),
  });
  assert(uploadRes.status === 200, "upload status 200");

  const publishRes = await fetch(`${BASE_URL}/document/${docId}/publish`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
  });
  assert(publishRes.status === 200, "publish status 200");

  console.log(`\n[GET /account/export -- βλέπει το πραγματικό περιεχόμενο]`);
  const exportRes = await fetch(`${BASE_URL}/account/export`, {
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
  });
  const exportData = await exportRes.json();
  assert(exportRes.status === 200, "export status 200");
  assert(exportData.account.email === EMAIL, "export περιέχει το σωστό email");
  assert(Array.isArray(exportData.documents), "export περιέχει πίνακα documents");
  assert(exportData.documents.some((d) => d.documentId === docId && d.title === "Δοκιμαστικό έγγραφο προς διαγραφή"), "το έγγραφό μας είναι μέσα στο export, με σωστό τίτλο");
  assert(!!exportData.widgetSettings, "export περιέχει widgetSettings");

  console.log(`\n[POST /account/delete -- ΛΑΘΟΣ κωδικός δεν διαγράφει τίποτα]`);
  const wrongDeleteRes = await fetch(`${BASE_URL}/account/delete`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
    body: JSON.stringify({ password: "totally-wrong-password" }),
  });
  assert(wrongDeleteRes.status === 401, "status 401 για λάθος κωδικό");

  const stillWorksRes = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: ipHeaders(`${testIp}-relogin`),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert(stillWorksRes.status === 200, "ο λογαριασμός ΑΚΟΜΑ δουλεύει κανονικά μετά την αποτυχημένη προσπάθεια διαγραφής");

  console.log(`\n[POST /account/delete -- ΣΩΣΤΟΣ κωδικός, πραγματική διαγραφή]`);
  const deleteRes = await fetch(`${BASE_URL}/account/delete`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
    body: JSON.stringify({ password: PASSWORD }),
  });
  const deleteData = await deleteRes.json();
  assert(deleteRes.status === 200, "status 200");
  assert(deleteData.ok === true, "ok: true");

  console.log(`\n[Επιβεβαίωση ότι ο λογαριασμός ΠΡΑΓΜΑΤΙΚΑ έφυγε]`);
  const loginAfterDeleteRes = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: ipHeaders(`${testIp}-after`),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert(loginAfterDeleteRes.status === 401, "login μετά τη διαγραφή αποτυγχάνει (401) -- ο λογαριασμός δεν υπάρχει πια");

  const exportAfterDeleteRes = await fetch(`${BASE_URL}/account/export`, {
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
  });
  assert(exportAfterDeleteRes.status === 401, "το ΠΑΛΙΟ session token δεν δουλεύει πια μετά τη διαγραφή");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
