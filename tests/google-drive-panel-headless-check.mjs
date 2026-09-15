// Headless DOM simulation ΜΟΝΟ για το "Google Drive" panel μέσα στο
// public/editor.html (Section N). Ίδια τεχνική με τα προηγούμενα headless
// tests -- εξάγουμε το πραγματικό κομμάτι κώδικα μέσω exact string slice.
//
// Τρέξιμο: node tests/google-drive-panel-headless-check.mjs

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

const START_MARKER = "  // Section N: εισαγωγή από Google Drive";
const END_MARKER = 'el("googleDriveBtn").addEventListener("click", () => renderGoogleDrivePanel());';
const startIdx = editorSource.indexOf(START_MARKER);
const endIdx = editorSource.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  console.error("Δεν βρέθηκε το 'Google Drive' block στο editor.html -- έχουν αλλάξει τα markers;");
  process.exit(1);
}
const panelCode = editorSource.slice(startIdx, endIdx + END_MARKER.length);

const STRINGS = {
  loading: "Loading…",
  googleDriveTitle: "📁 Import from Google Drive",
  googleDriveConnectIntro: "Connect your Google Drive account…",
  googleDriveConnectBtn: "Connect Google Drive",
  googleDriveConnectedAs: "Connected as {email}",
  googleDriveChangeAccountBtn: "Change account",
  googleDriveDisconnectBtn: "Disconnect",
  googleDriveDisconnecting: "Disconnecting…",
  googleDriveDisconnectErrorPrefix: "Could not disconnect: ",
  googleDriveLoadError: "Could not load your Google Drive files.",
  googleDriveNoFiles: "No Google Docs or Sheets found in your Drive.",
  googleDriveModifiedPrefix: "Modified",
  googleDriveImportBtn: "Import selected ({count})",
  googleDriveImporting: "Importing…",
  googleDriveImportErrorPrefix: "Import failed: ",
  googleDriveImportSummary: "Imported {success} of {total} files as drafts.",
  googleDriveImportFailedPrefix: "Could not import: ",
  notFoundDefault: "Not found",
};

function buildHarness(fetchImpl) {
  const preamble = `
    function t(key, vars) {
      let str = (window.__strings && window.__strings[key]) || key;
      if (vars) { for (const name in vars) { str = str.split("{" + name + "}").join(vars[name]); } }
      return str;
    }
    function escapeHtml(str) { return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
    function el(id) { return document.getElementById(id); }
    function fetch(url, options) { return window.__mockFetch(url, options); }
    function timeAgo(iso) { return "2 days ago"; }
    var HEADERS = { "Content-Type": "application/json", "X-Workspace-Id": "ws-test" };
    var WORKSPACE_ID = "ws-test";
    var tuiEditorInstance = null;
    var currentSelectedId = null;
    function loadDocuments() { return window.__loadDocuments(); }
    function navigateTo(url) { window.__navigatedTo = url; }
  `;
  const html = `<!DOCTYPE html><html><body>
    <div id="mainPanel"></div>
    <button id="googleDriveBtn"></button>
    <script>${preamble}\n${panelCode}\nwindow.renderGoogleDrivePanel = renderGoogleDrivePanel;</script>
  </body></html>`;

  const dom = new JSDOM(html, {
    url: "https://operations-portal-rag.giamarigkos.workers.dev/editor.html",
    runScripts: "dangerously",
  });
  const { window } = dom;
  window.__strings = STRINGS;
  window.__mockFetch = fetchImpl;
  window.__loadDocuments = async () => {};
  window.__navigatedTo = null;
  return window;
}

async function testNotConnectedShowsConnectButton() {
  console.log("\n[Δεν είναι συνδεδεμένο -- δείχνει κουμπί σύνδεσης, ΟΧΙ λίστα αρχείων]");
  let capturedUrl = null;
  const window = buildHarness(async (url) => {
    capturedUrl = url;
    return { ok: false, status: 404, json: async () => ({ error: "not connected" }) };
  });
  await window.renderGoogleDrivePanel();

  assert(capturedUrl === "/connections/google-drive/files", "καλεί το σωστό endpoint");
  assert(!!window.document.getElementById("googleDriveConnectBtn"), "δείχνει το κουμπί σύνδεσης");
  assert(!window.document.getElementById("googleDriveFileList"), "ΔΕΝ δείχνει λίστα αρχείων");
}

async function testConnectButtonNavigatesToOAuthStart() {
  console.log("\n[Κλικ στο κουμπί σύνδεσης -- πλοηγείται στο σωστό OAuth URL]");
  const window = buildHarness(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  await window.renderGoogleDrivePanel();

  window.document.getElementById("googleDriveConnectBtn").dispatchEvent(new window.Event("click", { bubbles: true }));

  assert(
    window.__navigatedTo === "/oauth/google/start?workspace_id=ws-test",
    "πλοηγείται στο σωστό workspace_id"
  );
}

async function testConnectedShowsFileListWithCheckboxes() {
  console.log("\n[Συνδεδεμένο -- δείχνει λίστα αρχείων με checkboxes]");
  const window = buildHarness(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      files: [
        { id: "f1", name: "Doc One", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00Z" },
        { id: "f2", name: "Sheet Two", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-01-02T00:00:00Z" },
      ],
    }),
  }));
  await window.renderGoogleDrivePanel();

  const checkboxes = window.document.querySelectorAll(".drive-file-checkbox");
  assert(checkboxes.length === 2, "δείχνει 2 γραμμές αρχείων με checkbox");
  const importBtn = window.document.getElementById("googleDriveImportBtn");
  assert(importBtn.disabled === true, "το κουμπί εισαγωγής είναι απενεργοποιημένο χωρίς επιλογή");
}

async function testSelectingFilesEnablesImportAndCallsCorrectEndpoint() {
  console.log("\n[Επιλογή αρχείων -- ενεργοποιεί το κουμπί, στέλνει σωστό body στο import]");
  let importCapturedBody = null;
  const window = buildHarness(async (url, options) => {
    if (url === "/connections/google-drive/files") {
      return {
        ok: true, status: 200,
        json: async () => ({ files: [
          { id: "f1", name: "Doc One", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00Z" },
        ] }),
      };
    }
    if (url === "/connections/google-drive/import") {
      importCapturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ imported: [{ documentId: "doc-one-abcd", title: "Doc One" }], failed: [] }) };
    }
    throw new Error("unexpected fetch to " + url);
  });
  await window.renderGoogleDrivePanel();

  const checkbox = window.document.querySelector(".drive-file-checkbox");
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));

  const importBtn = window.document.getElementById("googleDriveImportBtn");
  assert(!importBtn.disabled, "το κουμπί εισαγωγής ενεργοποιείται μετά την επιλογή");
  assert(importBtn.textContent.includes("1"), "το κουμπί δείχνει τον σωστό αριθμό επιλεγμένων");

  importBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(importCapturedBody !== null, "καλεί το /connections/google-drive/import");
  assert(importCapturedBody.files.length === 1, "στέλνει το επιλεγμένο αρχείο");
  assert(importCapturedBody.files[0].id === "f1", "στέλνει το σωστό fileId");
  assert(importCapturedBody.files[0].mimeType === "application/vnd.google-apps.document", "στέλνει το mimeType (χρειάζεται στο backend export)");

  const status = window.document.getElementById("googleDriveStatus");
  assert(status.textContent.includes("1"), "δείχνει μήνυμα επιτυχίας με τον σωστό αριθμό");
}

async function testClickingRowTogglesCheckbox() {
  console.log("\n[Κλικ πάνω στη γραμμή (όχι στο checkbox) -- toggles το checkbox]");
  const window = buildHarness(async () => ({
    ok: true, status: 200,
    json: async () => ({ files: [
      { id: "f1", name: "Doc One", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00Z" },
    ] }),
  }));
  await window.renderGoogleDrivePanel();

  const row = window.document.querySelector(".doc-row[data-id]");
  const checkbox = window.document.querySelector(".drive-file-checkbox");
  assert(!checkbox.checked, "αρχικά μη επιλεγμένο");
  row.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(checkbox.checked, "το κλικ στη γραμμή επιλέγει το checkbox");
}

async function testConnectedShowsEmailAndAccountActions() {
  console.log("\n[Συνδεδεμένο -- δείχνει το email και τα κουμπιά Change/Disconnect]");
  const window = buildHarness(async () => ({
    ok: true, status: 200,
    json: async () => ({
      files: [{ id: "f1", name: "Doc One", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00Z" }],
      connectedByEmail: "giamarigkos@gmail.com",
    }),
  }));
  await window.renderGoogleDrivePanel();

  assert(window.document.body.textContent.includes("giamarigkos@gmail.com"), "δείχνει το συνδεδεμένο email");
  assert(!!window.document.getElementById("googleDriveChangeAccountBtn"), "υπάρχει κουμπί αλλαγής λογαριασμού");
  assert(!!window.document.getElementById("googleDriveDisconnectBtn"), "υπάρχει κουμπί αποσύνδεσης");
}

async function testChangeAccountNavigatesToOAuthStart() {
  console.log("\n[Κλικ 'Change account' -- πλοηγείται ξανά στο OAuth start]");
  const window = buildHarness(async () => ({
    ok: true, status: 200,
    json: async () => ({ files: [], connectedByEmail: "x@gmail.com" }),
  }));
  await window.renderGoogleDrivePanel();
  window.document.getElementById("googleDriveChangeAccountBtn").dispatchEvent(new window.Event("click", { bubbles: true }));

  assert(
    window.__navigatedTo === "/oauth/google/start?workspace_id=ws-test",
    "πλοηγείται ξανά στο σωστό OAuth URL"
  );
}

async function testDisconnectCallsDeleteAndReturnsToConnectScreen() {
  console.log("\n[Κλικ 'Disconnect' -- καλεί DELETE, επιστρέφει στην οθόνη σύνδεσης]");
  let deleteCalledUrl = null;
  let deleteCalledMethod = null;
  let callCount = 0;
  const window = buildHarness(async (url, options) => {
    callCount++;
    if (url === "/connections/google-drive" && options && options.method === "DELETE") {
      deleteCalledUrl = url;
      deleteCalledMethod = options.method;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (url === "/connections/google-drive/files") {
      // Πρώτη κλήση: συνδεδεμένο. Μετά το disconnect: μη συνδεδεμένο.
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => ({ files: [], connectedByEmail: "x@gmail.com" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
    throw new Error("unexpected fetch to " + url);
  });
  await window.renderGoogleDrivePanel();
  window.document.getElementById("googleDriveDisconnectBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(deleteCalledUrl === "/connections/google-drive", "καλεί το σωστό endpoint");
  assert(deleteCalledMethod === "DELETE", "χρησιμοποιεί τη μέθοδο DELETE");
  assert(!!window.document.getElementById("googleDriveConnectBtn"), "μετά την αποσύνδεση δείχνει ξανά το κουμπί σύνδεσης");
}

async function run() {
  await testNotConnectedShowsConnectButton();
  await testConnectButtonNavigatesToOAuthStart();
  await testConnectedShowsFileListWithCheckboxes();
  await testSelectingFilesEnablesImportAndCallsCorrectEndpoint();
  await testClickingRowTogglesCheckbox();
  await testConnectedShowsEmailAndAccountActions();
  await testChangeAccountNavigatesToOAuthStart();
  await testDisconnectCallsDeleteAndReturnsToConnectScreen();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
