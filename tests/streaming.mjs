// Integration tests για streaming (Section L): POST /query/stream και
// POST /embed/{embedId}/query/stream.
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στο project: node tests/streaming.mjs
//
// ΣΗΜΕΙΩΣΗ: πραγματικά calls στο Gemini (χρειάζεται .dev.vars). Το test
// workspace δεν έχει κανένα ανεβασμένο έγγραφο -- η απάντηση θα είναι
// πάντα το ίδιο, γνωστό fallback κείμενο, άρα προβλέψιμη χωρίς να
// χρειάζεται πραγματικό Gemini generation call για το ίδιο το κείμενο
// (μόνο για το embedding της ερώτησης).

const BASE_URL = "http://127.0.0.1:8787";
const TEST_EMAIL = `streaming-test-${Date.now()}@example.com`;
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

// Ίδιο SSE πρωτόκολλο/parsing με shared.js streamSSE() -- διαβάζει το
// stream μέχρι το τέλος και επιστρέφει όλα τα events μαζί.
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

async function signup() {
  const res = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  return res.json();
}

async function testQueryStreamContentType(sessionToken) {
  console.log("\n[POST /query/stream -- σωστό Content-Type + έγκυρα SSE events]");
  const res = await fetch(`${BASE_URL}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
    body: JSON.stringify({ question: "τι ώρες είστε ανοιχτά" }),
  });
  assert(res.status === 200, "status 200");
  assert(
    (res.headers.get("Content-Type") || "").includes("text/event-stream"),
    "Content-Type είναι text/event-stream"
  );

  const events = await collectSSEEvents(res);
  const chunkEvents = events.filter((e) => e.type === "chunk");
  const doneEvent = events.find((e) => e.type === "done");

  assert(chunkEvents.length > 0, "τουλάχιστον ένα chunk event");
  assert(!!doneEvent, "υπάρχει done event");
  assert(doneEvent.isFallback === true, "isFallback:true (workspace χωρίς έγγραφα)");

  const fullText = chunkEvents.map((e) => e.text).join("");
  assert(fullText.length > 0, "τα chunks μαζί δίνουν μη-κενό κείμενο");
}

async function testQueryStreamMissingWorkspace() {
  console.log("\n[POST /query/stream -- χωρίς session/workspace]");
  const res = await fetch(`${BASE_URL}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "test" }),
  });
  assert(res.status === 400, "status 400 (καμία σύγχυση με streaming -- κανονικό JSON error)");
}

async function testEmbedStreamAllowedOrigin(embedId) {
  console.log("\n[POST /embed/{embedId}/query/stream -- επιτρεπόμενο origin]");
  const res = await fetch(`${BASE_URL}/embed/${embedId}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ question: "τι ώρες είστε ανοιχτά" }),
  });
  assert(res.status === 200, "status 200");
  assert(
    res.headers.get("Access-Control-Allow-Origin") === ALLOWED_ORIGIN,
    "επιστρέφει το σωστό CORS header"
  );
  const events = await collectSSEEvents(res);
  assert(events.some((e) => e.type === "chunk"), "λαμβάνει τουλάχιστον ένα chunk event");
  assert(events.some((e) => e.type === "done"), "λαμβάνει done event");
}

async function testEmbedStreamDisallowedOrigin(embedId) {
  console.log("\n[POST /embed/{embedId}/query/stream -- ΜΗ επιτρεπόμενο origin]");
  const res = await fetch(`${BASE_URL}/embed/${embedId}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil-example.gr" },
    body: JSON.stringify({ question: "test" }),
  });
  assert(res.status === 403, "status 403 (απλό JSON error, όχι stream)");
  assert(res.headers.get("Access-Control-Allow-Origin") === null, "ΔΕΝ επιστρέφει CORS header");
}

async function testEmbedStreamPreflight(embedId) {
  console.log("\n[OPTIONS /embed/{embedId}/query/stream -- preflight δουλεύει και για το streaming path]");
  const res = await fetch(`${BASE_URL}/embed/${embedId}/query/stream`, {
    method: "OPTIONS",
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert(res.status === 204, "status 204");
  assert(
    res.headers.get("Access-Control-Allow-Origin") === ALLOWED_ORIGIN,
    "σωστό CORS header στο preflight"
  );
}

async function run() {
  console.log(`Test email: ${TEST_EMAIL}`);
  const signupData = await signup();
  const sessionToken = signupData.sessionToken;
  const embedId = signupData.embedId;

  await fetch(`${BASE_URL}/embed/domains`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
    body: JSON.stringify({ domains: ["allowed-example.gr"] }),
  });

  await testQueryStreamContentType(sessionToken);
  await testQueryStreamMissingWorkspace();
  await testEmbedStreamAllowedOrigin(embedId);
  await testEmbedStreamDisallowedOrigin(embedId);
  await testEmbedStreamPreflight(embedId);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
