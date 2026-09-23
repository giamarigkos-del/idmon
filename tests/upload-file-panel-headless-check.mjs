// Headless DOM simulation ΜΟΝΟ για το "Upload file" panel μέσα στο
// public/editor.html (Section P). Ίδια τεχνική με τα προηγούμενα headless
// tests -- εξάγουμε το πραγματικό κομμάτι κώδικα μέσω exact string slice.
//
// Τρέξιμο: node tests/upload-file-panel-headless-check.mjs

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

const START_MARKER = '  // Section P: upload αρχείου (.txt/.md/.pdf)';
const END_MARKER = 'el("uploadFileBtn").addEventListener("click", renderUploadFilePanel);';
const startIdx = editorSource.indexOf(START_MARKER);
const endIdx = editorSource.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  console.error("Δεν βρέθηκε το 'Upload file' block στο editor.html -- έχουν αλλάξει τα markers;");
  process.exit(1);
}
const panelCode = editorSource.slice(startIdx, endIdx + END_MARKER.length);

const STRINGS = {
  loading: "Loading…",
  uploadFileTitle: "📤 Upload a file",
  uploadFileIntro: "Upload a .txt, .md, or .pdf file…",
  fileLabel: "File",
  titleOptionalLabel: "Title (optional)",
  titleOptionalPlaceholder: "Leave empty to use the filename",
  uploadFileSubmitBtn: "Upload",
  uploadingFile: "Uploading…",
  fileRequiredError: "Choose a file first.",
  uploadFileErrorPrefix: "Could not upload file: ",
};

function buildHarness(fetchImpl) {
  const preamble = `
    function t(key) { return window.__strings[key] || key; }
    function escapeHtml(str) { return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
    function el(id) { return document.getElementById(id); }
    function fetch(url, options) { return window.__mockFetch(url, options); }
    var WORKSPACE_ID = "ws-test";
    // null -- Guest/Developer flow (χωρίς λογαριασμό), ίδια σύμβαση με το
    // google-drive-panel-headless-check.mjs μετά το audit fix του OAuth IDOR.
    var SESSION_TOKEN = null;
    var tuiEditorInstance = null;
    var currentSelectedId = null;
    function loadDocuments() { return window.__loadDocuments(); }
    function openPreview(id) { window.__openPreviewCalledWith = id; }
  `;
  const html = `<!DOCTYPE html><html><body>
    <div id="mainPanel"></div>
    <button id="uploadFileBtn"></button>
    <script>${preamble}\n${panelCode}\nwindow.renderUploadFilePanel = renderUploadFilePanel;</script>
  </body></html>`;

  const dom = new JSDOM(html, {
    url: "https://idmon.app/editor.html",
    runScripts: "dangerously",
  });
  const { window } = dom;
  window.__strings = STRINGS;
  window.__mockFetch = fetchImpl;
  window.__loadDocuments = async () => {};
  window.__openPreviewCalledWith = null;
  return window;
}

// Το <input type="file">.files είναι κανονικά read-only -- σε πραγματικό
// browser γεμίζει μόνο από τον χρήστη. Εδώ το παρακάμπτουμε με
// defineProperty, τυπική τεχνική για headless testing file inputs.
function setFile(window, inputEl, file) {
  Object.defineProperty(inputEl, "files", { value: file ? [file] : [], configurable: true });
}

async function testRendersForm() {
  console.log("\n[renderUploadFilePanel -- αρχική εμφάνιση]");
  const window = buildHarness(async () => ({ ok: true, json: async () => ({ ok: true, documentId: "x" }) }));
  await window.renderUploadFilePanel();
  assert(!!window.document.getElementById("uploadFileInput"), "υπάρχει file input");
  assert(window.document.getElementById("uploadFileInput").accept === ".txt,.md,.pdf", "το accept περιορίζεται σε .txt/.md/.pdf");
  assert(!!window.document.getElementById("uploadFileTitleInput"), "υπάρχει προαιρετικό πεδίο τίτλου");
  assert(!!window.document.getElementById("uploadFileSubmitBtn"), "υπάρχει κουμπί υποβολής");
}

async function testNoFileShowsError() {
  console.log("\n[Υποβολή χωρίς αρχείο -- εμφανίζει σφάλμα, ΔΕΝ καλεί fetch]");
  let fetchCalled = false;
  const window = buildHarness(async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ ok: true, documentId: "x" }) };
  });
  await window.renderUploadFilePanel();
  window.document.getElementById("uploadFileSubmitBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(!fetchCalled, "ΔΕΝ καλεί το /upload-file χωρίς επιλεγμένο αρχείο");
  assert(window.document.getElementById("uploadFileStatus").textContent.includes("Choose a file"), "δείχνει μήνυμα σφάλματος");
}

async function testSuccessfulSubmitCallsCorrectEndpointAndHeaders() {
  console.log("\n[Επιτυχής υποβολή -- σωστό endpoint, ΧΩΡΙΣ Content-Type header, ανοίγει preview]");
  let capturedUrl = null;
  let capturedOptions = null;
  const window = buildHarness(async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, json: async () => ({ ok: true, documentId: "policy-abcd1234", title: "Policy" }) };
  });
  await window.renderUploadFilePanel();
  const fakeFile = new window.File(["Κάποιο περιεχόμενο"], "policy.txt", { type: "text/plain" });
  setFile(window, window.document.getElementById("uploadFileInput"), fakeFile);
  window.document.getElementById("uploadFileSubmitBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(capturedUrl === "/upload-file", "καλεί το σωστό endpoint");
  assert(capturedOptions.method === "POST", "χρησιμοποιεί POST");
  assert(!("Content-Type" in capturedOptions.headers), "ΔΕΝ στέλνει δικό του Content-Type (αφήνει τον browser να βάλει το σωστό multipart boundary)");
  assert(capturedOptions.headers["X-Workspace-Id"] === "ws-test", "στέλνει το σωστό X-Workspace-Id");
  assert(capturedOptions.body instanceof window.FormData, "στέλνει FormData, όχι JSON");
  assert(window.__openPreviewCalledWith === "policy-abcd1234", "ανοίγει preview του νέου εγγράφου μετά την επιτυχία");
}

async function testErrorResponseShowsMessage() {
  console.log("\n[Το backend απορρίπτει το αρχείο (π.χ. μη υποστηριζόμενος τύπος) -- εμφανίζει το μήνυμα, ξανα-ενεργοποιεί το κουμπί]");
  const window = buildHarness(async () => ({ ok: false, json: async () => ({ error: 'Unsupported file type ".docx"' }) }));
  await window.renderUploadFilePanel();
  const fakeFile = new window.File(["binary"], "policy.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  setFile(window, window.document.getElementById("uploadFileInput"), fakeFile);
  window.document.getElementById("uploadFileSubmitBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(window.document.getElementById("uploadFileStatus").textContent.includes("Unsupported file type"), "δείχνει το μήνυμα λάθους του backend");
  assert(!window.document.getElementById("uploadFileSubmitBtn").disabled, "το κουμπί ξανα-ενεργοποιείται μετά το σφάλμα");
}

async function run() {
  await testRendersForm();
  await testNoFileShowsError();
  await testSuccessfulSubmitCallsCorrectEndpointAndHeaders();
  await testErrorResponseShowsMessage();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
