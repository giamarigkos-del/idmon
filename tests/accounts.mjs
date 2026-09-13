// Integration tests για τα νέα /account/* endpoints (Section H: λογαριασμοί
// πελατών + sessions).
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στον φάκελο του project: node tests/accounts.mjs
//
// Χρησιμοποιεί ένα τυχαίο email ανά run (βασισμένο σε timestamp) ώστε να μην
// συγκρούεται ποτέ με προηγούμενα runs ή πραγματικούς λογαριασμούς.

const BASE_URL = "http://127.0.0.1:8787";
const TEST_EMAIL = `test-${Date.now()}@example.com`;
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

async function testSignup() {
  console.log("\n[POST /account/signup -- νέος λογαριασμός]");
  const res = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.ok === true, "ok === true");
  assert(typeof data.sessionToken === "string" && data.sessionToken.length === 64, "sessionToken είναι 64-char hex (32 bytes)");
  assert(typeof data.workspaceId === "string" && data.workspaceId.startsWith("ws-"), "workspaceId έχει το σωστό prefix");
  assert(typeof data.embedId === "string" && data.embedId.startsWith("emb-"), "embedId έχει το σωστό prefix");
  return data;
}

async function testDuplicateSignup() {
  console.log("\n[POST /account/signup -- ίδιο email δεύτερη φορά]");
  const res = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  assert(res.status === 409, "status 409 (email υπάρχει ήδη)");
}

async function testWeakPassword() {
  console.log("\n[POST /account/signup -- πολύ σύντομο password]");
  const res = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `weak-${Date.now()}@example.com`, password: "123" }),
  });
  assert(res.status === 400, "status 400");
}

async function testLoginWrongPassword() {
  console.log("\n[POST /account/login -- λάθος password]");
  const res = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: "totally-wrong-password" }),
  });
  assert(res.status === 401, "status 401");
}

async function testLoginUnknownEmail() {
  console.log("\n[POST /account/login -- email που δεν υπάρχει]");
  const res = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `nobody-${Date.now()}@example.com`, password: "whatever123" }),
  });
  assert(res.status === 401, "status 401 (ίδιο μήνυμα με λάθος password -- δεν αποκαλύπτουμε ποιο emails υπάρχουν)");
}

async function testLoginCorrect(expectedWorkspaceId, expectedEmbedId) {
  console.log("\n[POST /account/login -- σωστά στοιχεία]");
  const res = await fetch(`${BASE_URL}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.workspaceId === expectedWorkspaceId, "επιστρέφει το ΙΔΙΟ workspaceId με το signup");
  assert(data.embedId === expectedEmbedId, "επιστρέφει το ΙΔΙΟ embedId με το signup");
  assert(typeof data.sessionToken === "string", "νέο sessionToken δημιουργήθηκε");
  return data.sessionToken;
}

async function testSessionResolvesWorkspace(sessionToken, expectedWorkspaceId) {
  console.log("\n[GET /workspace/settings -- με X-Session-Token, ΧΩΡΙΣ X-Workspace-Id]");
  // Σκόπιμα ΔΕΝ στέλνουμε X-Workspace-Id εδώ -- το session πρέπει από μόνο
  // του να λύσει σε ποιο workspace ανήκει το token.
  const res = await fetch(`${BASE_URL}/workspace/settings`, {
    headers: { "X-Session-Token": sessionToken },
  });
  assert(res.status === 200, "status 200 (το session αρκεί, δεν χρειάζεται X-Workspace-Id)");
}

async function testForgedWorkspaceIdIgnoredWhenSessionPresent(sessionToken) {
  console.log("\n[PATCH /workspace/settings -- προσπάθεια να 'πλαστογραφηθεί' άλλο workspace]");
  // Στέλνουμε ΚΑΙ session token ΚΑΙ ένα ψεύτικο X-Workspace-Id. Το session
  // πρέπει να κερδίζει -- το backend ΔΕΝ πρέπει να εμπιστευτεί το header.
  // ΣΚΟΠΙΜΑ δεν ελέγχουμε το πραγματικό "efood-ops-demo" workspace εδώ (δεν
  // θέλουμε το test να αγγίζει ποτέ πραγματικά demo δεδομένα) -- αντ' αυτού
  // επιβεβαιώνουμε έμμεσα, διαβάζοντας πίσω μέσω του ΙΔΙΟΥ session.
  const marker = `forged-test-${Date.now()}`;
  const patchRes = await fetch(`${BASE_URL}/workspace/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Session-Token": sessionToken,
      "X-Workspace-Id": "efood-ops-demo",
    },
    body: JSON.stringify({ botName: marker }),
  });
  assert(patchRes.status === 200, "status 200 (το request πέτυχε)");

  const getRes = await fetch(`${BASE_URL}/workspace/settings`, {
    headers: { "X-Session-Token": sessionToken },
  });
  const data = await getRes.json();
  assert(data.botName === marker, "το botName γράφτηκε στο ΔΙΚΟ ΜΟΥ workspace (μέσω session), όχι στο efood-ops-demo από το ψεύτικο header");
}

async function testLogoutInvalidatesSession(sessionToken) {
  console.log("\n[POST /account/logout, μετά χρήση του ίδιου token]");
  const logoutRes = await fetch(`${BASE_URL}/account/logout`, {
    method: "POST",
    headers: { "X-Session-Token": sessionToken },
  });
  assert(logoutRes.status === 200, "logout status 200");

  const afterRes = await fetch(`${BASE_URL}/workspace/settings`, {
    headers: { "X-Session-Token": sessionToken },
  });
  assert(afterRes.status === 400, "το ίδιο token μετά το logout πλέον ΔΕΝ δουλεύει (400, καμία fallback σε workspace)");
}

async function run() {
  console.log(`Test email: ${TEST_EMAIL}`);
  const signupData = await testSignup();
  await testDuplicateSignup();
  await testWeakPassword();
  await testLoginWrongPassword();
  await testLoginUnknownEmail();
  const loginToken = await testLoginCorrect(signupData.workspaceId, signupData.embedId);
  await testSessionResolvesWorkspace(loginToken, signupData.workspaceId);
  await testForgedWorkspaceIdIgnoredWhenSessionPresent(loginToken);
  await testLogoutInvalidatesSession(loginToken);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
