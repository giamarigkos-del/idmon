// Headless DOM simulation του public/landing.html (Section O: forgot/reset
// password UI) -- ΔΕΝ χρειάζεται wrangler dev, τρέχει εντελώς αυτόνομα.
// Χρησιμοποιεί τον ΠΡΑΓΜΑΤΙΚΟ κώδικα του αρχείου (readFileSync, όχι
// reimplementation): το πραγματικό <body> markup + το πραγματικό inline
// <script> + το πραγματικό shared.js -- landing.html δεν εξαρτάται από
// εξωτερικά CDN scripts, οπότε μπορεί να φορτωθεί ολόκληρο.
//
// Τρέξιμο: node tests/landing-password-reset-headless-check.mjs

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

const landingSource = readFileSync(new URL("../public/landing.html", import.meta.url), "utf8");
const sharedJsSource = readFileSync(new URL("../public/shared.js", import.meta.url), "utf8");

const bodyMatch = landingSource.match(/<body>([\s\S]*?)<script>window\.__IS_LANDING_PAGE__/);
const inlineScriptMatches = [...landingSource.matchAll(/<script>([\s\S]*?)<\/script>/g)];
// Το 2ο <script>...</script> block (index 1) είναι το ΚΥΡΙΟ inline script --
// το 1ο είναι μόνο η γραμμή window.__IS_LANDING_PAGE__ = true.
const inlineScript = inlineScriptMatches[1][1];

if (!bodyMatch || !inlineScript) {
  console.error("Δεν βρέθηκε το body ή το inline script στο landing.html -- έχει αλλάξει η δομή;");
  process.exit(1);
}
const bodyHtml = bodyMatch[1];

// Φτιάχνει ένα φρέσκο, απομονωμένο DOM για κάθε test -- με fetch mock και
// δικό του URL (ώστε να ελέγξουμε και το ?resetToken=... σενάριο).
function loadLandingPage({ url = "http://localhost/landing.html", fetchImpl } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`, {
    url,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.fetch = fetchImpl || (async () => { throw new Error("fetch not mocked"); });

  window.eval("window.__IS_LANDING_PAGE__ = true;");
  window.eval(sharedJsSource);
  window.eval(inlineScript);
  return window;
}

function fetchQueue(responses) {
  let i = 0;
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  impl.calls = calls;
  return impl;
}

function test1_forgotLinkVisibility() {
  console.log("\n[Το \"Ξέχασες τον κωδικό;\" εμφανίζεται ΜΟΝΟ στο tab Σύνδεση]");
  const window = loadLandingPage();
  const doc = window.document;
  const forgotLink = doc.getElementById("forgotLink");

  assert(forgotLink.style.display === "none", "κρυφό στην αρχική κατάσταση (default tab = Εγγραφή)");

  doc.getElementById("loginTabBtn").click();
  assert(forgotLink.style.display === "block", "εμφανίζεται όταν διαλέγεις το tab Σύνδεση");

  doc.getElementById("signupTabBtn").click();
  assert(forgotLink.style.display === "none", "ξανακρύβεται αν γυρίσεις στο tab Εγγραφή");
}

async function test2_forgotPasswordSubmit() {
  console.log("\n[Υποβολή \"Ξέχασες τον κωδικό\" -- σωστό endpoint/body, γενικό μήνυμα επιτυχίας]");
  const fetchImpl = fetchQueue([{ status: 200, body: { ok: true } }]);
  const window = loadLandingPage({ fetchImpl });
  const doc = window.document;

  doc.getElementById("loginTabBtn").click();
  doc.getElementById("forgotLink").click();
  assert(doc.getElementById("forgotForm").classList.contains("show"), "εμφανίζεται η φόρμα forgot-password");
  assert(!doc.getElementById("accountForm").classList.contains("show"), "κρύβεται η φόρμα account");

  doc.getElementById("forgotEmail").value = "someone@example.com";
  doc.getElementById("forgotSubmitBtn").click();
  await new Promise((r) => setTimeout(r, 20));

  assert(fetchImpl.calls.length === 1, "έγινε ακριβώς ένα fetch call");
  assert(fetchImpl.calls[0].url === "/account/forgot-password", "σωστό endpoint");
  assert(fetchImpl.calls[0].body.email === "someone@example.com", "στέλνει το σωστό email");
  assert(doc.getElementById("forgotSuccess").classList.contains("show"), "εμφανίζεται το γενικό μήνυμα επιτυχίας");
}

async function test3_resetPasswordValidation() {
  console.log("\n[Reset password -- validation ΠΡΙΝ καν καλέσει το backend]");
  const fetchImpl = fetchQueue([{ status: 200, body: { ok: true, sessionToken: "x", workspaceId: "y", embedId: "z" } }]);
  const window = loadLandingPage({ url: "http://localhost/landing.html?resetToken=abc123", fetchImpl });
  const doc = window.document;

  assert(doc.getElementById("resetForm").classList.contains("show"), "η φόρμα reset εμφανίζεται αυτόματα με ?resetToken=...");
  assert(doc.getElementById("choiceGrid").style.display === "none", "το choiceGrid (Developer/Guest/Account) κρύβεται");

  doc.getElementById("resetNewPassword").value = "short";
  doc.getElementById("resetConfirmPassword").value = "short";
  doc.getElementById("resetSubmitBtn").click();
  await new Promise((r) => setTimeout(r, 20));
  assert(fetchImpl.calls.length === 0, "ΔΕΝ καλεί το backend αν ο κωδικός είναι πολύ σύντομος");
  assert(doc.getElementById("resetError").classList.contains("show"), "δείχνει σφάλμα για σύντομο κωδικό");

  doc.getElementById("resetNewPassword").value = "longenoughpassword1";
  doc.getElementById("resetConfirmPassword").value = "somethingelse";
  doc.getElementById("resetSubmitBtn").click();
  await new Promise((r) => setTimeout(r, 20));
  assert(fetchImpl.calls.length === 0, "ΔΕΝ καλεί το backend αν οι κωδικοί δεν ταιριάζουν");
}

async function test4_resetPasswordSuccess() {
  console.log("\n[Reset password -- επιτυχία: σωστό token/body, αποθηκεύει session]");
  const fetchImpl = fetchQueue([{ status: 200, body: { ok: true, sessionToken: "tok-1", workspaceId: "ws-1", embedId: "emb-1" } }]);
  const window = loadLandingPage({ url: "http://localhost/landing.html?resetToken=the-real-token", fetchImpl });
  const doc = window.document;

  doc.getElementById("resetNewPassword").value = "longenoughpassword1";
  doc.getElementById("resetConfirmPassword").value = "longenoughpassword1";
  doc.getElementById("resetSubmitBtn").click();
  await new Promise((r) => setTimeout(r, 20));

  assert(fetchImpl.calls.length === 1, "έγινε ένα fetch call");
  assert(fetchImpl.calls[0].url === "/account/reset-password", "σωστό endpoint");
  assert(fetchImpl.calls[0].body.token === "the-real-token", "στέλνει το ΣΩΣΤΟ token από το URL");
  assert(fetchImpl.calls[0].body.newPassword === "longenoughpassword1", "στέλνει τον νέο κωδικό");
  assert(window.localStorage.getItem("sessionToken") === "tok-1", "αποθηκεύει το νέο sessionToken");
  assert(window.localStorage.getItem("workspaceId") === "ws-1", "αποθηκεύει το workspaceId");
}

function test5_developerFormHiddenByDefault() {
  console.log("\n[Το \"Developer\" ΔΕΝ είναι πια ορατό δημόσιο κουμπί]");
  const window = loadLandingPage();
  const doc = window.document;

  assert(doc.getElementById("devBtn") === null, "δεν υπάρχει καν το κουμπί devBtn στο DOM");
  assert(!doc.getElementById("devForm").classList.contains("show"), "η φόρμα Developer είναι κρυφή χωρίς το ?developer=1");
  assert(doc.getElementById("choiceGrid").style.display !== "none", "το κανονικό choiceGrid (Account/Guest) παραμένει ορατό");
}

function test6_developerFormViaHiddenUrl() {
  console.log("\n[Το ?developer=1 δείχνει τη φόρμα Developer απευθείας]");
  const window = loadLandingPage({ url: "http://localhost/landing.html?developer=1" });
  const doc = window.document;

  assert(doc.getElementById("devForm").classList.contains("show"), "η φόρμα Developer εμφανίζεται με ?developer=1");
  assert(doc.getElementById("choiceGrid").style.display === "none", "το κανονικό choiceGrid κρύβεται");
}

async function run() {
  test1_forgotLinkVisibility();
  await test2_forgotPasswordSubmit();
  await test3_resetPasswordValidation();
  await test4_resetPasswordSuccess();
  test5_developerFormHiddenByDefault();
  test6_developerFormViaHiddenUrl();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
