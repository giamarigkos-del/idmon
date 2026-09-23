// Headless DOM simulation του πάνελ "Δοκιμαστικό ερώτημα" του public/editor.html
// (Βήμα 1β: νήμα συζήτησης + ιστορικό + κουμπί "Νέα συζήτηση") -- ΔΕΝ χρειάζεται
// wrangler dev. Χρησιμοποιεί τον ΠΡΑΓΜΑΤΙΚΟ κώδικα: κόβει από το editor.html το
// HTML του πάνελ και το JS του ανάμεσα στους δείκτες test-q-panel:start/end και
// "Βήμα 1β: test panel ιστορικό" ΑΡΧΗ/ΤΕΛΟΣ, και τα τρέχει μέσα σε jsdom μαζί
// με το πραγματικό shared.js. Όχι reimplementation.
//
// Τρέξιμο: node tests/test-panel-history-headless-check.mjs
// (χρειάζεται `npm install jsdom`, όπως και τα υπόλοιπα headless tests.)

import { JSDOM } from "jsdom";
import { readFileSync } from "fs";

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

const sharedSource = readFileSync(new URL("../public/shared.js", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../public/editor.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function between(source, startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  const e = source.indexOf(endMarker);
  if (s === -1 || e === -1 || e < s) {
    console.log(`✗ Δεν βρέθηκαν οι δείκτες ${startMarker} / ${endMarker} στο editor.html`);
    process.exit(1);
  }
  return source.slice(s + startMarker.length, e);
}

const panelHtml = between(editorSource, "<!-- test-q-panel:start -->", "<!-- test-q-panel:end -->");
const panelJs = between(
  editorSource,
  "// --- Βήμα 1β: test panel ιστορικό -- ΑΡΧΗ ---",
  "// --- Βήμα 1β: test panel ιστορικό -- ΤΕΛΟΣ ---"
);

// queryFetch(url, options) καλείται μόνο για το /query.
async function loadPanel(queryFetch) {
  const html = `<!DOCTYPE html><html><body>${panelHtml}
<script>${sharedSource}</script>
<script>
  const el = (id) => document.getElementById(id);
  window.__fallbackReloads = 0;
  function loadFallbackQuestions() { window.__fallbackReloads++; }
</script>
<script>${panelJs}</script>
</body></html>`;
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://idmon.app/editor.html",
    beforeParse(window) {
      window.localStorage.setItem("workspaceId", "ws-test");
      window.TextDecoder = TextDecoder;
      window.fetch = async (url, options) => {
        if (String(url).includes("/query")) return queryFetch(url, options);
        return { ok: true, status: 200, json: async () => ({}) };
      };
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  // Ρητή ελληνική γλώσσα ώστε τα κείμενα να είναι προβλέψιμα.
  return dom.window;
}

async function ask(window, text) {
  const input = window.document.getElementById("testQInput");
  input.value = text;
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 15));
}

function okResponse(data) {
  return { ok: true, status: 200, json: async () => data };
}

function answering(bodies, answerFor, extra = {}) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return okResponse({ answer: answerFor(body.question), isFallback: false, primarySource: null, relatedSections: [], ...extra });
  };
}

const exchanges = (w) => w.document.querySelectorAll("#testQOutput .test-q-exchange");

async function testInitialState() {
  console.log("\n[Αρχική κατάσταση]");
  const w = await loadPanel(answering([], () => "x"));
  assert(exchanges(w).length === 0, "το νήμα είναι άδειο");
  assert(w.document.getElementById("testQNewBtn").style.display === "none", "το κουμπί \"Νέα συζήτηση\" είναι κρυμμένο");
}

async function testFirstQuestion() {
  console.log("\n[Πρώτη ερώτηση -- χωρίς πεδίο history, φαίνεται στο νήμα]");
  const bodies = [];
  const w = await loadPanel(answering(bodies, (q) => "Απάντηση για " + q, { primarySource: { title: "Έγγραφο Α", score: 0.87, documentId: "d1" } }));
  await ask(w, "Τι ώρες είστε ανοιχτά;");
  assert(bodies.length === 1 && !("history" in bodies[0]), "το body ΔΕΝ έχει πεδίο history στην πρώτη ερώτηση");
  assert(exchanges(w).length === 1, "εμφανίζεται μία ανταλλαγή στο νήμα");
  const ex = exchanges(w)[0];
  assert(ex.querySelector(".test-q-question").textContent === "Τι ώρες είστε ανοιχτά;", "η ερώτηση φαίνεται στο νήμα");
  assert(ex.querySelector(".test-q-answer").textContent.includes("Απάντηση για Τι ώρες"), "η απάντηση φαίνεται στο νήμα");
  assert(ex.querySelector(".test-q-meta").textContent.includes("Έγγραφο Α"), "η γραμμή πηγής/σχετικότητας εμφανίζεται");
  assert(!!ex.querySelector(".test-q-details pre"), "οι τεχνικές λεπτομέρειες υπάρχουν ανά ανταλλαγή");
  assert(w.document.getElementById("testQInput").value === "", "το πεδίο καθαρίζει μετά την αποστολή");
  assert(!w.document.getElementById("testQInput").disabled, "το πεδίο ξαναενεργοποιείται");
  assert(w.document.getElementById("testQNewBtn").style.display !== "none", "το κουμπί \"Νέα συζήτηση\" εμφανίζεται");
}

async function testSecondQuestionSendsHistory() {
  console.log("\n[Δεύτερη ερώτηση -- στέλνει την πρώτη ανταλλαγή ως ιστορικό]");
  const bodies = [];
  const w = await loadPanel(answering(bodies, (q) => "Απάντηση για " + q));
  await ask(w, "Τι ώρες είστε ανοιχτά;");
  await ask(w, "Και το Σάββατο;");
  const h = bodies[1].history;
  assert(Array.isArray(h) && h.length === 2, "στέλνει 2 μηνύματα ιστορικού");
  assert(h[0].role === "user" && h[0].text === "Τι ώρες είστε ανοιχτά;", "πρώτο: ο χρήστης");
  assert(h[1].role === "assistant" && h[1].text === "Απάντηση για Τι ώρες είστε ανοιχτά;", "δεύτερο: ο βοηθός (ρόλος assistant)");
  assert(bodies[1].question === "Και το Σάββατο;", "η νέα ερώτηση στέλνεται ξεχωριστά");
  assert(exchanges(w).length === 2, "το νήμα έχει 2 ανταλλαγές (η πρώτη ΔΕΝ σβήστηκε)");
}

async function testCapAndTruncation() {
  console.log("\n[Όριο 6 μηνυμάτων και 500 χαρακτήρων]");
  const bodies = [];
  const w = await loadPanel(answering(bodies, () => "β".repeat(2000)));
  for (let i = 1; i <= 6; i++) await ask(w, "Ερώτηση " + i);
  const last = bodies[5].history;
  assert(last.length === 6, "στην 6η ερώτηση το ιστορικό είναι 6 μηνύματα (όχι 10)");
  assert(last[0].text === "Ερώτηση 3", "ξεκινά από την 3η ερώτηση");
  assert(last[1].text.length === 500, "η απάντηση στο ιστορικό κόβεται στους 500");
  assert(exchanges(w).length === 6, "αλλά το νήμα στην οθόνη δείχνει και τις 6 ανταλλαγές");
}

async function testNewConversation() {
  console.log("\n[Κουμπί \"Νέα συζήτηση\" -- καθαρίζει νήμα ΚΑΙ ιστορικό]");
  const bodies = [];
  const w = await loadPanel(answering(bodies, (q) => "Α-" + q));
  await ask(w, "Ερώτηση 1");
  await ask(w, "Ερώτηση 2");
  w.document.getElementById("testQNewBtn").click();
  assert(exchanges(w).length === 0, "το νήμα αδειάζει");
  assert(w.document.getElementById("testQNewBtn").style.display === "none", "το κουμπί κρύβεται ξανά");
  await ask(w, "Ερώτηση 3");
  assert(!("history" in bodies[2]), "η ερώτηση μετά τη \"Νέα συζήτηση\" ΔΕΝ στέλνει ιστορικό");
  await ask(w, "Ερώτηση 4");
  assert(bodies[3].history.length === 2 && bodies[3].history[0].text === "Ερώτηση 3", "και το νέο ιστορικό ξεκινά από την ερώτηση 3, όχι από τις παλιές");
}

async function testErrorsNotRemembered() {
  console.log("\n[Σφάλματα -- δείχνουν καθαρό μήνυμα και ΔΕΝ μπαίνουν στο ιστορικό]");
  const bodies = [];
  let call = 0;
  const w = await loadPanel(async (url, options) => {
    bodies.push(JSON.parse(options.body));
    call++;
    if (call === 2) return { ok: true, status: 200, json: async () => { throw new Error("Unexpected token '<'"); } };
    if (call === 3) return { ok: false, status: 429, json: async () => ({ error: "Monthly message limit reached for this workspace.", limitReached: true }) };
    return okResponse({ answer: "ΟΚ", isFallback: false, primarySource: null });
  });
  await ask(w, "Ερώτηση 1");
  await ask(w, "Ερώτηση 2 (HTML αντί για JSON)");
  const secondText = exchanges(w)[1].textContent;
  assert(!secondText.includes("Unexpected token"), "ΔΕΝ εμφανίζεται ωμό τεχνικό σφάλμα JS");
  assert(secondText.includes("❌"), "εμφανίζεται καθαρό μήνυμα σφάλματος");
  await ask(w, "Ερώτηση 3 (όριο)");
  assert(exchanges(w)[2].textContent.includes("Monthly message limit"), "το μήνυμα ορίου του server εμφανίζεται");
  await ask(w, "Ερώτηση 4");
  const h = bodies[3].history;
  assert(h.length === 2 && h[0].text === "Ερώτηση 1", "στην 4η ερώτηση το ιστορικό έχει μόνο την 1η επιτυχημένη ανταλλαγή");
  assert(exchanges(w).length === 4, "όλες οι απόπειρες φαίνονται στο νήμα");
}

async function testBusyGuard() {
  console.log("\n[Αν μια ερώτηση εκκρεμεί, δεύτερο Enter αγνοείται]");
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const w = await loadPanel(async () => {
    calls++;
    await gate;
    return okResponse({ answer: "ΟΚ", isFallback: false });
  });
  const input = w.document.getElementById("testQInput");
  input.value = "Πρώτη";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  assert(input.disabled, "το πεδίο είναι απενεργοποιημένο όσο εκκρεμεί η ερώτηση");
  input.value = "Δεύτερη";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  assert(calls === 1, "έγινε ΜΙΑ μόνο κλήση");
  release();
  await new Promise((r) => setTimeout(r, 15));
  assert(!input.disabled, "το πεδίο ξαναενεργοποιείται όταν έρθει η απάντηση");
}

async function testNewConversationWhilePending() {
  console.log("\n[\"Νέα συζήτηση\" ενώ εκκρεμεί ερώτηση -- η καθυστερημένη απάντηση δεν μπαίνει στη νέα συζήτηση]");
  const bodies = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let call = 0;
  const w = await loadPanel(async (url, options) => {
    bodies.push(JSON.parse(options.body));
    call++;
    if (call === 1) await gate;
    return okResponse({ answer: "Α" + call, isFallback: false });
  });
  const input = w.document.getElementById("testQInput");
  input.value = "Παλιά ερώτηση";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  w.document.getElementById("testQNewBtn").click();
  release();
  await new Promise((r) => setTimeout(r, 20));
  await ask(w, "Νέα ερώτηση");
  assert(!("history" in bodies[1]), "η νέα ερώτηση ΔΕΝ κουβαλά την απάντηση της παλιάς συζήτησης");
}

async function testFallbackReloadsList() {
  console.log("\n[Fallback απάντηση -- ανανεώνεται η λίστα \"Unanswered questions\"]");
  let call = 0;
  const w = await loadPanel(async () => {
    call++;
    return okResponse({ answer: "Δεν γνωρίζω.", isFallback: call === 1, primarySource: null });
  });
  await ask(w, "Άγνωστη ερώτηση");
  assert(w.__fallbackReloads === 1, "η loadFallbackQuestions κλήθηκε μία φορά");
  assert(exchanges(w)[0].querySelector(".test-q-answer.fallback") !== null, "η απάντηση φαίνεται με το στυλ fallback");
  await ask(w, "Γνωστή ερώτηση");
  assert(w.__fallbackReloads === 1, "ΔΕΝ ξανακλήθηκε για κανονική απάντηση");
}

async function testInputHandling() {
  console.log("\n[Είσοδος: κενό, άλλα πλήκτρα, HTML στην ερώτηση]");
  const bodies = [];
  const w = await loadPanel(answering(bodies, () => "ΟΚ"));
  await ask(w, "   ");
  assert(bodies.length === 0, "κενή ερώτηση δεν στέλνεται");
  const input = w.document.getElementById("testQInput");
  input.value = "κάτι";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert(bodies.length === 0, "άλλο πλήκτρο (όχι Enter) δεν στέλνει");
  await ask(w, "<b>έντονο</b><img src=x onerror=alert(1)>");
  const q = exchanges(w)[0].querySelector(".test-q-question");
  assert(q.textContent === "<b>έντονο</b><img src=x onerror=alert(1)>", "η ερώτηση εμφανίζεται ως κείμενο");
  assert(q.querySelector("b") === null && q.querySelector("img") === null, "καμία HTML ετικέτα δεν ενεργοποιείται μέσα στην ερώτηση");
}

(async () => {
  await testInitialState();
  await testFirstQuestion();
  await testSecondQuestionSendsHistory();
  await testCapAndTruncation();
  await testNewConversation();
  await testErrorsNotRemembered();
  await testBusyGuard();
  await testNewConversationWhilePending();
  await testFallbackReloadsList();
  await testInputHandling();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
