// Integration test για τα ευρήματα του πλήρους audit, Σεπτέμβριος 2026:
//
//   #1 TTL fix -- πραγματικοί λογαριασμοί (Account) δεν πρέπει ΠΟΤΕ να
//      παίρνουν λήξη στα έγγραφά τους, σε αντίθεση με Guest workspaces που
//      συνεχίζουν να παίρνουν την προσωρινή λήξη 7 ημερών όπως πριν.
//   #2 OAuth IDOR fix -- /oauth/google/start πρέπει να απορρίπτει requests
//      χωρίς έγκυρο session_token/workspace_id, όχι να δέχεται τυφλά
//      οποιοδήποτε workspace_id.
//   #4 Restore validation -- POST /document/{id}/restore πρέπει να
//      απορρίπτει έγγραφα που δεν είναι ήδη "deleted".
//
// ΔΕΝ ελέγχει το #5 (PBKDF2 password_iterations) εδώ -- αυτό χρειάζεται ένα
// υπάρχον λογαριασμό με το ΠΑΛΙΟ (100000) iterations count ήδη αποθηκευμένο
// στη D1 για να δοκιμαστεί σωστά το backward-compat path, κάτι που δεν
// μπορεί να δημιουργηθεί μέσω του δημόσιου API (κάθε νέο signup παίρνει
// αυτόματα το νέο 600000). Αν θες να το δοκιμάσεις χειροκίνητα: κάνε ένα
// νέο signup, μετά wrangler d1 execute --local ... "UPDATE users SET
// password_iterations = 100000 WHERE email = '...'", και επιβεβαίωσε ότι το
// login ΣΥΝΕΧΙΖΕΙ να δουλεύει κανονικά.
//
// Πώς τρέχει:
//   1. wrangler dev
//   2. node tests/account-ttl-and-audit-fixes.mjs

const BASE_URL = "http://127.0.0.1:8787";
const EMAIL = `ttl-test-${Date.now()}@example.com`;
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
  const testIp = `test-ttl-ip-${Date.now()}`;

  // -------------------------------------------------------------------
  // #1 TTL fix: πραγματικός λογαριασμός -- expiresAt πρέπει να είναι null
  // -------------------------------------------------------------------
  console.log(`\n[#1 TTL -- πραγματικός λογαριασμός: signup + upload]`);
  const signupRes = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: ipHeaders(testIp),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const signupData = await signupRes.json();
  const sessionToken = signupData.sessionToken;
  assert(signupRes.status === 200, "signup status 200");

  const accountDocId = `ttl-account-doc-${Date.now()}`;
  const accountUploadRes = await fetch(`${BASE_URL}/upload`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
    body: JSON.stringify({
      documentId: accountDocId,
      title: "TTL test -- account",
      text: "Αυτό το έγγραφο ανήκει σε πραγματικό λογαριασμό, δεν πρέπει να λήγει ποτέ.",
    }),
  });
  assert(accountUploadRes.status === 200, "upload status 200 (account)");

  const accountDocRes = await fetch(`${BASE_URL}/document/${accountDocId}`, {
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
  });
  const accountDocData = await accountDocRes.json();
  assert(accountDocData.expiresAt === null, "expiresAt είναι null για πραγματικό λογαριασμό (το bug ήταν εδώ)");

  // -------------------------------------------------------------------
  // #1 TTL fix: Guest workspace -- η συμπεριφορά ΔΕΝ πρέπει να άλλαξε
  // -------------------------------------------------------------------
  console.log(`\n[#1 TTL -- Guest workspace: η 7ήμερη λήξη πρέπει να ΣΥΝΕΧΙΣΕΙ να ισχύει]`);
  const guestWorkspaceId = `ws-guest-test-${Date.now()}`;
  const guestDocId = `ttl-guest-doc-${Date.now()}`;
  const guestUploadRes = await fetch(`${BASE_URL}/upload`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Workspace-Id": guestWorkspaceId }),
    body: JSON.stringify({
      documentId: guestDocId,
      title: "TTL test -- guest",
      text: "Αυτό το έγγραφο ανήκει σε ανώνυμο Guest, πρέπει να λήγει σε 7 μέρες όπως πάντα.",
    }),
  });
  assert(guestUploadRes.status === 200, "upload status 200 (guest)");

  const guestDocRes = await fetch(`${BASE_URL}/document/${guestDocId}`, {
    headers: ipHeaders(testIp, { "X-Workspace-Id": guestWorkspaceId }),
  });
  const guestDocData = await guestDocRes.json();
  assert(guestDocData.expiresAt !== null, "expiresAt ΔΕΝ είναι null για Guest workspace -- η παλιά συμπεριφορά έμεινε ίδια");

  // -------------------------------------------------------------------
  // #2 OAuth IDOR fix
  // -------------------------------------------------------------------
  console.log(`\n[#2 OAuth IDOR -- /oauth/google/start χωρίς κανένα param]`);
  const noParamRes = await fetch(`${BASE_URL}/oauth/google/start`, { redirect: "manual" });
  assert(noParamRes.status === 400, "status 400 χωρίς session_token/workspace_id (πριν δεν υπήρχε καν αυτός ο έλεγχος)");

  console.log(`\n[#2 OAuth IDOR -- /oauth/google/start με ΑΝΥΠΑΡΚΤΟ session_token]`);
  const badSessionRes = await fetch(
    `${BASE_URL}/oauth/google/start?session_token=this-token-does-not-exist`,
    { redirect: "manual" }
  );
  assert(badSessionRes.status === 400, "status 400 με άκυρο session_token -- ΔΕΝ δέχεται τυφλά κανένα workspace");

  console.log(`\n[#2 OAuth IDOR -- backward-compat: raw workspace_id ΣΥΝΕΧΙΖΕΙ να δουλεύει για Guest/Developer]`);
  const guestOauthRes = await fetch(
    `${BASE_URL}/oauth/google/start?workspace_id=${encodeURIComponent(guestWorkspaceId)}`,
    { redirect: "manual" }
  );
  // 302 (redirect προς Google) αν είναι ρυθμισμένα τα Google secrets τοπικά,
  // αλλιώς μπορεί να αποτύχει αργότερα στο ίδιο flow -- το σημαντικό εδώ
  // είναι ότι ΔΕΝ γυρνάει 400 σαν να έλειπε το param.
  assert(guestOauthRes.status !== 400, "raw workspace_id (χωρίς session) ΔΕΝ απορρίπτεται σαν λείπον param -- backward compatible");

  // -------------------------------------------------------------------
  // #4 Restore validation
  // -------------------------------------------------------------------
  console.log(`\n[#4 Restore validation -- restore σε ΔΗΜΟΣΙΕΥΜΕΝΟ (όχι deleted) έγγραφο]`);
  const publishRes = await fetch(`${BASE_URL}/document/${accountDocId}/publish`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
  });
  assert(publishRes.status === 200, "publish status 200 (προετοιμασία)");

  const restorePublishedRes = await fetch(`${BASE_URL}/document/${accountDocId}/restore`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
  });
  assert(restorePublishedRes.status === 400, "restore σε published έγγραφο απορρίπτεται με 400 (πριν το δεχόταν σιωπηλά)");

  console.log(`\n[#4 Restore validation -- restore σε ΠΡΑΓΜΑΤΙΚΑ deleted έγγραφο δουλεύει κανονικά]`);
  const deleteRes = await fetch(`${BASE_URL}/document/${accountDocId}/delete`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
  });
  assert(deleteRes.status === 200, "delete status 200 (προετοιμασία)");

  const restoreDeletedRes = await fetch(`${BASE_URL}/document/${accountDocId}/restore`, {
    method: "POST",
    headers: ipHeaders(testIp, { "X-Session-Token": sessionToken }),
  });
  const restoreDeletedData = await restoreDeletedRes.json();
  assert(restoreDeletedRes.status === 200, "restore σε deleted έγγραφο δουλεύει κανονικά, status 200");
  assert(restoreDeletedData.status === "draft", "το restored έγγραφο πάει σε draft, όπως πάντα");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
