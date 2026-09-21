// End-to-end test του ιστορικού συζήτησης (Βήμα 1) με ΠΡΑΓΜΑΤΙΚΟ Gemini και
// ΠΡΑΓΜΑΤΙΚΟ Vectorize -- ελέγχει το ερώτημα που δεν μπορούν να απαντήσουν τα
// mocks: "δουλεύει όντως το follow-up, και όχι μόνο περνάει το ιστορικό;"
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: npx wrangler dev
//   2. Σε άλλο τερματικό, μέσα στο project: node tests/history-e2e.mjs
//
// Φτιάχνει ένα προσωρινό account με δύο μικρά έγγραφα (ωράριο, επιστροφές),
// κάνει ~8 ερωτήσεις (μετράνε στο μηνιαίο όριο του test account) και στο
// τέλος ΔΙΑΓΡΑΦΕΙ το account (μαζί με τα vectors του στο Vectorize).
// Αν το .dev.vars έχει πολύ χαμηλό MONTHLY_MESSAGE_LIMIT_OVERRIDE, το test
// θα σου το πει -- σβήσ' το προσωρινά.

const BASE_URL = "http://127.0.0.1:8787";
const TEST_EMAIL = `history-e2e-${Date.now()}@example.com`;
const TEST_PASSWORD = "correct-horse-battery-staple";
const ALLOWED_ORIGIN = "https://allowed-example.gr";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectSSEEvents(response) {
  const events = [];
  if (!response.body) return events;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = rawEvent.trim();
      if (!line.startsWith("data:")) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) continue;
      events.push(JSON.parse(jsonStr));
    }
  }
  return events;
}

const jsonHeaders = (token) => ({ "Content-Type": "application/json", "X-Session-Token": token });

async function ask(token, question, history) {
  const body = history ? { question, history } : { question };
  const res = await fetch(`${BASE_URL}/query`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) });
  const data = await res.json();
  if (res.status === 429 && data.limitReached) {
    console.log("\n❌ Χτύπησε το όριο μηνυμάτων του test account. Έλεγξε το MONTHLY_MESSAGE_LIMIT_OVERRIDE στο .dev.vars (σβήσ' το προσωρινά) και ξανατρέξε.");
    throw new Error("limit reached");
  }
  if (!res.ok) throw new Error(`/query status ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function uploadAndPublish(token, documentId, title, text) {
  const up = await fetch(`${BASE_URL}/upload`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify({ documentId, title, text }) });
  if (!up.ok) throw new Error(`upload ${documentId}: ${up.status} ${await up.text()}`);
  const pub = await fetch(`${BASE_URL}/document/${encodeURIComponent(documentId)}/publish`, { method: "POST", headers: jsonHeaders(token) });
  if (!pub.ok) throw new Error(`publish ${documentId}: ${pub.status} ${await pub.text()}`);
}

// Το Vectorize δεν είναι πάντα άμεσα συνεπές: ένα μόλις-δημοσιευμένο έγγραφο
// μπορεί να αργήσει λίγα δευτερόλεπτα να εμφανιστεί στις αναζητήσεις. Ρωτάμε
// (χωρίς ιστορικό) μέχρι να βρεθεί το ωράριο. Δεν μετράει ως test.
async function waitUntilIndexed(token) {
  for (let i = 0; i < 20; i++) {
    const data = await ask(token, "Τι ώρες είστε ανοιχτά;");
    if (!data.isFallback) return true;
    await sleep(3000);
  }
  return false;
}

async function run() {
  console.log(`Test email: ${TEST_EMAIL}`);

  const signupRes = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const signup = await signupRes.json();
  const token = signup.sessionToken;
  const embedId = signup.embedId;
  if (!token) throw new Error("signup απέτυχε: " + JSON.stringify(signup));

  try {
    await uploadAndPublish(
      token,
      "e2e-hours",
      "Ωράριο λειτουργίας",
      "Ωράριο λειτουργίας του καταστήματος. Δευτέρα έως Παρασκευή είμαστε ανοιχτά από τις 09:00 έως τις 17:00. Το Σάββατο είμαστε ανοιχτά από τις 10:00 έως τις 14:00. Την Κυριακή και τις επίσημες αργίες είμαστε κλειστά."
    );
    await uploadAndPublish(
      token,
      "e2e-returns",
      "Πολιτική επιστροφών",
      "Πολιτική επιστροφών. Μπορείτε να επιστρέψετε οποιοδήποτε προϊόν εντός 14 ημερών από την παραλαβή, αρκεί να είναι αχρησιμοποίητο και στην αρχική του συσκευασία. Η επιστροφή χρημάτων γίνεται εντός 5 εργάσιμων ημερών από τη στιγμή που παραλάβουμε το προϊόν."
    );

    console.log("\n[Αναμονή να ευρετηριαστούν τα έγγραφα στο Vectorize]");
    const indexed = await waitUntilIndexed(token);
    assert(indexed, "τα έγγραφα βρέθηκαν στην αναζήτηση (χωρίς ιστορικό)");
    if (!indexed) throw new Error("Τα έγγραφα δεν ευρετηριάστηκαν έγκαιρα, ξανατρέξε σε λίγο");

    // --- Follow-up ---------------------------------------------------------
    console.log("\n[Follow-up: \"Και το Σάββατο;\" ΜΕ ιστορικό]");
    const q1 = "Τι ώρες είστε ανοιχτά;";
    const a1 = await ask(token, q1);
    const history = [
      { role: "user", text: q1 },
      { role: "assistant", text: a1.answer },
    ];
    const followUp = await ask(token, "Και το Σάββατο;", history);
    console.log(`     απάντηση: ${followUp.answer.replace(/\s+/g, " ")}`);
    assert(!followUp.isFallback, "ΔΕΝ απαντά \"δεν γνωρίζω\"");
    assert(/10/.test(followUp.answer), "η απάντηση αναφέρει το ωράριο του Σαββάτου (10:00)");

    // Ενημερωτικά (ΔΕΝ είναι pass/fail -- η συμπεριφορά του LLM δεν είναι
    // 100% προβλέψιμη): τι θα γινόταν χωρίς ιστορικό.
    const control = await ask(token, "Και το Σάββατο;");
    console.log(`     [ενημερωτικό] ίδια ερώτηση ΧΩΡΙΣ ιστορικό: ${control.isFallback ? "\"δεν γνωρίζω\" (αναμενόμενο)" : control.answer.replace(/\s+/g, " ")}`);

    // --- Αλλαγή θέματος ----------------------------------------------------
    console.log("\n[Αλλαγή θέματος: ερώτηση για επιστροφές μέσα σε συζήτηση για ωράριο]");
    const switched = await ask(token, "Πώς μπορώ να επιστρέψω ένα προϊόν;", history);
    console.log(`     απάντηση: ${switched.answer.replace(/\s+/g, " ")}`);
    assert(!switched.isFallback, "ΔΕΝ απαντά \"δεν γνωρίζω\" (η αναζήτηση δεν θόλωσε από το προηγούμενο θέμα)");
    assert(/14/.test(switched.answer), "η απάντηση αναφέρει τις 14 ημέρες της πολιτικής επιστροφών");

    // --- Streaming (εσωτερικό) --------------------------------------------
    console.log("\n[POST /query/stream -- follow-up ΜΕ ιστορικό]");
    const streamRes = await fetch(`${BASE_URL}/query/stream`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ question: "Και το Σάββατο;", history }),
    });
    assert(streamRes.status === 200, "status 200");
    const events = await collectSSEEvents(streamRes);
    const streamedText = events.filter((e) => e.type === "chunk").map((e) => e.text).join("");
    const done = events.find((e) => e.type === "done");
    console.log(`     απάντηση: ${streamedText.replace(/\s+/g, " ")}`);
    assert(!!done && done.isFallback === false, "done event με isFallback:false");
    assert(/10/.test(streamedText), "το streamed κείμενο αναφέρει το ωράριο του Σαββάτου");

    // --- Embed (widget πελάτη) --------------------------------------------
    console.log("\n[POST /embed/{embedId}/query/stream -- follow-up ΜΕ ιστορικό (όπως το widget)]");
    await fetch(`${BASE_URL}/embed/domains`, {
      method: "PATCH",
      headers: jsonHeaders(token),
      body: JSON.stringify({ domains: ["allowed-example.gr"] }),
    });
    const embedRes = await fetch(`${BASE_URL}/embed/${embedId}/query/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ question: "Και το Σάββατο;", history }),
    });
    assert(embedRes.status === 200, "status 200");
    const embedEvents = await collectSSEEvents(embedRes);
    const embedText = embedEvents.filter((e) => e.type === "chunk").map((e) => e.text).join("");
    const embedDone = embedEvents.find((e) => e.type === "done");
    console.log(`     απάντηση: ${embedText.replace(/\s+/g, " ")}`);
    assert(!!embedDone && embedDone.isFallback === false, "done event με isFallback:false");
    assert(/10/.test(embedText), "το streamed κείμενο αναφέρει το ωράριο του Σαββάτου");
  } finally {
    console.log("\n[Καθαρισμός -- διαγραφή του test account και των vectors του]");
    try {
      const del = await fetch(`${BASE_URL}/account/delete`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      assert(del.ok, "το test account διαγράφηκε");
    } catch (err) {
      console.log("  ✗ ο καθαρισμός απέτυχε: " + err.message);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("\nΣφάλμα:", err.message);
  process.exit(1);
});
