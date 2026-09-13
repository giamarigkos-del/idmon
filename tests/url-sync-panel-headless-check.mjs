// Headless DOM simulation ΜΟΝΟ για το "Πρόσθεσε από URL" panel μέσα στο
// public/editor.html (Section M). Ίδια τεχνική με τα προηγούμενα headless
// tests -- εξάγουμε το πραγματικό κομμάτι κώδικα μέσω exact string slice.
//
// Τρέξιμο: node tests/url-sync-panel-headless-check.mjs

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

const editorSource = readFileSync(new URL("../public/editor.html", import.meta.url), "utf8");

const START_MARKER = '  // Section M: "Πρόσθεσε από URL"';
const END_MARKER = 'el("addFromUrlBtn").addEventListener("click", renderAddFromUrlPanel);';
const startIdx = editorSource.indexOf(START_MARKER);
const endIdx = editorSource.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  console.error("Δεν βρέθηκε το 'Πρόσθεσε από URL' block στο editor.html -- έχουν αλλάξει τα markers;");
  process.exit(1);
}
const panelCode = editorSource.slice(startIdx, endIdx + END_MARKER.length);

const STRINGS = {
  loading: "Loading…",
  addFromUrlTitle: "🔗 Add document from URL",
  addFromUrlIntro: "Paste a link…",
  urlLabel: "Page URL",
  titleOptionalLabel: "Title (optional)",
  titleOptionalPlaceholder: "Leave empty to use the page's own title",
  addFromUrlSubmitBtn: "Fetch page",
  addingFromUrl: "Fetching…",
  urlRequiredError: "Enter a URL first.",
  addFromUrlErrorPrefix: "Could not add from URL: ",
};

function buildHarness(fetchImpl) {
  const preamble = `
    function t(key) { return window.__strings[key] || key; }
    function escapeHtml(str) { return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
    function el(id) { return document.getElementById(id); }
    function fetch(url, options) { return window.__mockFetch(url, options); }
    var HEADERS = { "Content-Type": "application/json", "X-Workspace-Id": "ws-test" };
    var tuiEditorInstance = null;
    var currentSelectedId = null;
    function loadDocuments() { return window.__loadDocuments(); }
    function openPreview(id) { window.__openPreviewCalledWith = id; }
  `;
  const html = `<!DOCTYPE html><html><body>
    <div id="mainPanel"></div>
    <button id="addFromUrlBtn"></button>
    <script>${preamble}\n${panelCode}\nwindow.renderAddFromUrlPanel = renderAddFromUrlPanel;</script>
  </body></html>`;

  const dom = new JSDOM(html, {
    url: "https://operations-portal-rag.giamarigkos.workers.dev/editor.html",
    runScripts: "dangerously",
  });
  const { window } = dom;
  window.__strings = STRINGS;
  window.__mockFetch = fetchImpl;
  window.__loadDocuments = async () => {};
  window.__openPreviewCalledWith = null;
  return window;
}

async function testRendersForm() {
  console.log("\n[renderAddFromUrlPanel -- αρχική εμφάνιση]");
  const window = buildHarness(async () => ({ ok: true, json: async () => ({ ok: true, documentId: "x" }) }));
  await window.renderAddFromUrlPanel();
  assert(!!window.document.getElementById("syncUrlInput"), "υπάρχει πεδίο URL");
  assert(!!window.document.getElementById("syncTitleInput"), "υπάρχει προαιρετικό πεδίο τίτλου");
  assert(!!window.document.getElementById("syncUrlSubmitBtn"), "υπάρχει κουμπί υποβολής");
}

async function testEmptyUrlShowsError() {
  console.log("\n[Υποβολή χωρίς URL -- εμφανίζει σφάλμα, ΔΕΝ καλεί fetch]");
  let fetchCalled = false;
  const window = buildHarness(async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ ok: true, documentId: "x" }) };
  });
  await window.renderAddFromUrlPanel();
  window.document.getElementById("syncUrlSubmitBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(!fetchCalled, "ΔΕΝ καλεί το /upload-from-url με κενό URL");
  assert(window.document.getElementById("syncUrlStatus").textContent.includes("Enter a URL"), "δείχνει μήνυμα σφάλματος");
}

async function testSuccessfulSubmitCallsCorrectEndpoint() {
  console.log("\n[Επιτυχής υποβολή -- σωστό endpoint + body, ανοίγει preview]");
  let capturedUrl = null;
  let capturedBody = null;
  const window = buildHarness(async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true, documentId: "faq-abcd1234", title: "FAQ" }) };
  });
  await window.renderAddFromUrlPanel();
  window.document.getElementById("syncUrlInput").value = "https://example.gr/faq";
  window.document.getElementById("syncTitleInput").value = "  ";
  window.document.getElementById("syncUrlSubmitBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(capturedUrl === "/upload-from-url", "καλεί το σωστό endpoint");
  assert(capturedBody.url === "https://example.gr/faq", "στέλνει το σωστό URL");
  assert(capturedBody.title === undefined, "δεν στέλνει κενό/whitespace τίτλο (undefined)");
  assert(window.__openPreviewCalledWith === "faq-abcd1234", "ανοίγει preview του νέου εγγράφου μετά την επιτυχία");
}

async function testErrorResponseShowsMessage() {
  console.log("\n[Το backend απορρίπτει το URL -- εμφανίζει το μήνυμα λάθους, ξανα-ενεργοποιεί το κουμπί]");
  const window = buildHarness(async () => ({ ok: false, json: async () => ({ error: "Invalid URL" }) }));
  await window.renderAddFromUrlPanel();
  window.document.getElementById("syncUrlInput").value = "not-a-real-url";
  window.document.getElementById("syncUrlSubmitBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(window.document.getElementById("syncUrlStatus").textContent.includes("Invalid URL"), "δείχνει το μήνυμα λάθους του backend");
  assert(!window.document.getElementById("syncUrlSubmitBtn").disabled, "το κουμπί ξανα-ενεργοποιείται μετά το σφάλμα");
}

async function run() {
  await testRendersForm();
  await testEmptyUrlShowsError();
  await testSuccessfulSubmitCallsCorrectEndpoint();
  await testErrorResponseShowsMessage();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
