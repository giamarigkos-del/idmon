// Headless DOM simulation του chat στο public/home.html (η demo σελίδα, πρώην index.html) --
// ΔΕΝ χρειάζεται wrangler dev. Φορτώνει τον ΠΡΑΓΜΑΤΙΚΟ κώδικα του home.html
// και του shared.js μέσα σε jsdom (όχι reimplementation) και ελέγχει ότι το
// ιστορικό συζήτησης συμπεριφέρεται ΙΔΙΑ με το widget των πελατών.
//
// Τρέξιμο: node tests/demo-chat-history-headless-check.mjs
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
const indexHtml = readFileSync(new URL("../public/home.html", import.meta.url), "utf8");

function makeSSEBody(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      };
    },
  };
}

// Φορτώνει το home.html με το shared.js "ενσωματωμένο" (αντί για <script src>).
// queryFetch(url, options) καλείται ΜΟΝΟ για /query/stream -- τα υπόλοιπα
// (ρυθμίσεις workspace, λίστα εγγράφων) απαντώνται με κενά αποτελέσματα.
async function loadPage(queryFetch) {
  const html = indexHtml.replace('<script src="/shared.js"></script>', () => `<script>${sharedSource}</script>`);
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://idmon.app/home.html",
    beforeParse(window) {
      window.localStorage.setItem("workspaceId", "ws-test");
      window.TextDecoder = TextDecoder;
      window.fetch = async (url, options) => {
        if (String(url).includes("/query/stream")) return queryFetch(url, options);
        if (String(url).includes("/workspace/settings")) return { ok: true, json: async () => ({}) };
        if (String(url).includes("/documents")) return { ok: true, json: async () => ({ documents: [] }) };
        return { ok: true, json: async () => ({}) };
      };
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  return dom.window;
}

async function ask(window, text) {
  const input = window.document.getElementById("questionInput");
  input.value = text;
  window.document.getElementById("askBtn").click();
  await new Promise((r) => setTimeout(r, 20));
}

function answering(bodies, answerFor) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return {
      ok: true,
      status: 200,
      body: makeSSEBody([
        { type: "chunk", text: answerFor(body.question) },
        { type: "done", isFallback: false, primarySource: null, relatedSections: [] },
      ]),
    };
  };
}

async function testFirstQuestionNoHistory() {
  console.log("\n[Demo chat -- η ΠΡΩΤΗ ερώτηση στέλνεται χωρίς πεδίο history]");
  const bodies = [];
  const window = await loadPage(answering(bodies, (q) => "Απάντηση " + q));
  await ask(window, "Τι ώρες είστε ανοιχτά;");
  assert(bodies.length === 1, "έγινε μία κλήση στο /query/stream");
  assert(!("history" in bodies[0]), "το body ΔΕΝ έχει πεδίο history");
  assert(bodies[0].question === "Τι ώρες είστε ανοιχτά;", "η ερώτηση στέλνεται κανονικά");
}

async function testSecondQuestionSendsHistory() {
  console.log("\n[Demo chat -- η ΔΕΥΤΕΡΗ ερώτηση στέλνει την πρώτη ανταλλαγή]");
  const bodies = [];
  const window = await loadPage(answering(bodies, (q) => "Απάντηση " + q));
  await ask(window, "Τι ώρες είστε ανοιχτά;");
  await ask(window, "Και το Σάββατο;");
  const h = bodies[1].history;
  assert(Array.isArray(h) && h.length === 2, "στέλνει 2 μηνύματα ιστορικού");
  assert(h[0].role === "user" && h[0].text === "Τι ώρες είστε ανοιχτά;", "πρώτο: ο χρήστης");
  assert(h[1].role === "assistant" && h[1].text === "Απάντηση Τι ώρες είστε ανοιχτά;", "δεύτερο: ο βοηθός (ρόλος assistant, όχι bot)");
  assert(bodies[1].question === "Και το Σάββατο;", "η νέα ερώτηση στέλνεται ξεχωριστά");
  assert(window.document.querySelectorAll("#thread .msg").length === 4, "στην οθόνη φαίνονται και οι 4 φούσκες");
}

async function testCapAndTruncation() {
  console.log("\n[Demo chat -- όριο 6 μηνυμάτων και 500 χαρακτήρων]");
  const bodies = [];
  const window = await loadPage(answering(bodies, (q) => "β".repeat(2000)));
  for (let i = 1; i <= 6; i++) await ask(window, "Ερώτηση " + i);
  const last = bodies[5].history;
  assert(last.length === 6, "στην 6η ερώτηση το ιστορικό είναι 6 μηνύματα");
  assert(last[0].text === "Ερώτηση 3", "ξεκινά από την 3η ερώτηση");
  assert(last[1].text.length === 500, "η απάντηση στο ιστορικό κόβεται στους 500");
}

async function testFailedAndLimitNotRemembered() {
  console.log("\n[Demo chat -- σφάλμα δικτύου και μήνυμα ορίου ΔΕΝ μπαίνουν στο ιστορικό]");
  const bodies = [];
  let call = 0;
  const window = await loadPage(async (url, options) => {
    bodies.push(JSON.parse(options.body));
    call++;
    if (call === 2) throw new Error("network down");
    if (call === 3) return { ok: false, status: 429, json: async () => ({ limitReached: true }) };
    return { ok: true, status: 200, body: makeSSEBody([{ type: "chunk", text: "ΟΚ" }, { type: "done", isFallback: false }]) };
  });
  await ask(window, "Ερώτηση 1");
  await ask(window, "Ερώτηση 2 (σφάλμα)");
  await ask(window, "Ερώτηση 3 (όριο)");
  await ask(window, "Ερώτηση 4");
  const h = bodies[3].history;
  assert(h.length === 2 && h[0].text === "Ερώτηση 1", "στην 4η ερώτηση το ιστορικό έχει μόνο την 1η επιτυχημένη ανταλλαγή");
}

(async () => {
  await testFirstQuestionNoHistory();
  await testSecondQuestionSendsHistory();
  await testCapAndTruncation();
  await testFailedAndLimitNotRemembered();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
