// Headless DOM simulation ΜΟΝΟ για την ενότητα "Account" (export/delete)
// μέσα στο settings panel του public/editor.html (Section P). Ίδια τεχνική
// με το analytics-panel-headless-check.mjs -- εξάγουμε το πραγματικό κομμάτι
// κώδικα μέσω exact string slice και το τρέχουμε με ελάχιστα stubs.
//
// Τρέξιμο: node tests/account-section-headless-check.mjs

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

const START_MARKER = "  async function renderSettingsPanel() {";
const END_MARKER = 'el("settingsBtn").addEventListener("click", renderSettingsPanel);';
const startIdx = editorSource.indexOf(START_MARKER);
const endIdx = editorSource.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  console.error("Δεν βρέθηκε το renderSettingsPanel block στο editor.html -- έχουν αλλάξει τα markers;");
  process.exit(1);
}
const settingsPanelCode = editorSource.slice(startIdx, endIdx + END_MARKER.length);

const STRINGS = {
  loading: "Loading…",
  widgetSettings: "Widget settings",
  widgetSettingsIntro: "Customize how the widget looks and behaves.",
  botNameLabel: "Bot name",
  accentColorLabel: "Accent color",
  logoUrlLabel: "Logo URL",
  notifyEmailLabel: "Notify email",
  notifyEmailHint: "Get notified when the bot can't answer.",
  contactSectionTitle: "Human handoff",
  contactSectionIntro: "Give visitors a way to reach a real person.",
  contactLabelLabel: "Contact label",
  contactLabelPlaceholder: "e.g. Chat with us",
  contactUrlLabel: "Contact URL",
  contactUrlPlaceholder: "https://…",
  contactUrlHint: "Any link scheme works.",
  contactPhoneLabel: "Contact phone",
  contactPhonePlaceholder: "+30…",
  saveSettingsBtn: "Save settings",
  settingsSaved: "Saved!",
  settingsSaveErrorPrefix: "Error: ",
  settingsLoadError: "Could not load settings.",
  accountSectionTitle: "Account",
  exportDataBtn: "Export my data",
  deleteAccountBtn: "Delete my account",
  deleteAccountWarning: "This permanently deletes your account, all documents, and settings. This cannot be undone.",
  passwordLabel: "Password",
  confirmDeleteAccountBtn: "Permanently delete",
  cancel: "Cancel",
  deleteAccountPasswordRequired: "Enter your password to confirm.",
  checking: "Checking…",
};

const DEFAULT_SETTINGS = {
  botName: "Assistant", accentColor: "#6B7280", logoUrl: null, notifyEmail: null,
  contactLabel: null, contactUrl: null, contactPhone: null,
};

function buildHarness({ fetchImpl, sessionToken }) {
  const preamble = `
    function t(key) { return window.__strings[key] || key; }
    function escapeHtml(str) { return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
    function el(id) { return document.getElementById(id); }
    function fetch(url, options) { return window.__mockFetch(url, options); }
    var HEADERS = { "Content-Type": "application/json", "X-Workspace-Id": "ws-test", ${sessionToken ? `"X-Session-Token": "${sessionToken}",` : ""} };
    var SESSION_TOKEN = ${sessionToken ? `"${sessionToken}"` : "null"};
    var tuiEditorInstance = null;
    var currentSelectedId = null;
    function enterNewDocumentMode() {}
    window.localStorage.setItem("sessionToken", SESSION_TOKEN || "");
    window.localStorage.setItem("workspaceId", "ws-test");
    window.localStorage.setItem("emailVerified", "1");
    window.URL.createObjectURL = window.__mockCreateObjectURL;
    window.URL.revokeObjectURL = function() {};
  `;
  const html = `<!DOCTYPE html><html><body>
    <div id="mainPanel"></div>
    <button id="settingsBtn"></button>
    <button id="newDocBtn"></button>
    <script>${preamble}\n${settingsPanelCode}\nwindow.renderSettingsPanel = renderSettingsPanel;</script>
  </body></html>`;

  const dom = new JSDOM(html, {
    url: "https://idmon.app/editor.html",
    runScripts: "dangerously",
  });
  const { window } = dom;
  window.__strings = STRINGS;
  window.__mockFetch = fetchImpl;
  window.__mockCreateObjectURL = () => "blob:mock-url";
  return window;
}

function fetchQueue(responses) {
  let i = 0;
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.blob) {
      return { ok: r.status < 300, status: r.status, blob: async () => new window_Blob() };
    }
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  impl.calls = calls;
  return impl;
}

// GET /account/export επιστρέφει ένα αρχείο, όχι JSON -- χρειάζεται ένα
// ελάχιστο Blob-like αντικείμενο για το .blob() να δουλέψει στο jsdom.
class window_Blob {}

async function test1_noAccountSectionForGuest() {
  console.log("\n[Χωρίς SESSION_TOKEN (Guest/Developer) -- ΔΕΝ εμφανίζεται καθόλου η ενότητα Account]");
  const fetchImpl = fetchQueue([{ status: 200, body: DEFAULT_SETTINGS }]);
  const window = buildHarness({ fetchImpl, sessionToken: null });
  await window.renderSettingsPanel();
  const main = window.document.getElementById("mainPanel");
  assert(window.document.getElementById("exportDataBtn") === null, "δεν υπάρχει κουμπί export");
  assert(window.document.getElementById("showDeleteAccountBtn") === null, "δεν υπάρχει κουμπί delete");
}

async function test2_accountSectionForRealAccount() {
  console.log("\n[Με SESSION_TOKEN (πραγματικός λογαριασμός) -- εμφανίζεται η ενότητα Account]");
  const fetchImpl = fetchQueue([{ status: 200, body: DEFAULT_SETTINGS }]);
  const window = buildHarness({ fetchImpl, sessionToken: "tok-123" });
  await window.renderSettingsPanel();
  assert(window.document.getElementById("exportDataBtn") !== null, "υπάρχει κουμπί export");
  assert(window.document.getElementById("showDeleteAccountBtn") !== null, "υπάρχει κουμπί delete");
  assert(window.document.getElementById("deleteAccountConfirm").style.display === "none", "η φόρμα επιβεβαίωσης είναι αρχικά κρυφή");
}

async function test3_exportCallsCorrectEndpoint() {
  console.log("\n[Κλικ \"Export my data\" -- σωστό endpoint, με session header]");
  const fetchImpl = fetchQueue([{ status: 200, body: DEFAULT_SETTINGS }, { status: 200, blob: true }]);
  const window = buildHarness({ fetchImpl, sessionToken: "tok-123" });
  await window.renderSettingsPanel();
  window.document.getElementById("exportDataBtn").click();
  await new Promise((r) => setTimeout(r, 20));

  const exportCall = fetchImpl.calls.find((c) => c.url === "/account/export");
  assert(!!exportCall, "έγινε κλήση στο /account/export");
}

async function test4_showAndCancelDeleteConfirm() {
  console.log("\n[Κλικ \"Delete my account\" -- εμφανίζει επιβεβαίωση, Cancel την κρύβει ξανά]");
  const fetchImpl = fetchQueue([{ status: 200, body: DEFAULT_SETTINGS }]);
  const window = buildHarness({ fetchImpl, sessionToken: "tok-123" });
  await window.renderSettingsPanel();
  const doc = window.document;

  doc.getElementById("showDeleteAccountBtn").click();
  assert(doc.getElementById("deleteAccountConfirm").style.display === "block", "εμφανίζεται η φόρμα επιβεβαίωσης");
  assert(doc.getElementById("showDeleteAccountBtn").style.display === "none", "κρύβεται το αρχικό κουμπί");

  doc.getElementById("cancelDeleteAccountBtn").click();
  assert(doc.getElementById("deleteAccountConfirm").style.display === "none", "το Cancel κρύβει ξανά τη φόρμα");
  assert(doc.getElementById("showDeleteAccountBtn").style.display === "block", "το αρχικό κουμπί ξαναφαίνεται");
}

async function test5_deleteRequiresPassword() {
  console.log("\n[Επιβεβαίωση διαγραφής ΧΩΡΙΣ κωδικό -- ΔΕΝ καλεί το backend]");
  const fetchImpl = fetchQueue([{ status: 200, body: DEFAULT_SETTINGS }]);
  const window = buildHarness({ fetchImpl, sessionToken: "tok-123" });
  await window.renderSettingsPanel();
  const doc = window.document;

  doc.getElementById("showDeleteAccountBtn").click();
  doc.getElementById("confirmDeleteAccountBtn").click();
  await new Promise((r) => setTimeout(r, 20));

  assert(fetchImpl.calls.filter((c) => c.url === "/account/delete").length === 0, "δεν κάλεσε /account/delete χωρίς κωδικό");
  assert(doc.getElementById("deleteAccountStatus").textContent === "Enter your password to confirm.", "δείχνει το μήνυμα validation");
}

async function test6_deleteWithWrongPassword() {
  console.log("\n[Επιβεβαίωση διαγραφής με ΛΑΘΟΣ κωδικό -- δείχνει το μήνυμα λάθους του backend, ΔΕΝ καθαρίζει localStorage]");
  const fetchImpl = fetchQueue([{ status: 200, body: DEFAULT_SETTINGS }, { status: 401, body: { error: "Incorrect password" } }]);
  const window = buildHarness({ fetchImpl, sessionToken: "tok-123" });
  await window.renderSettingsPanel();
  const doc = window.document;

  doc.getElementById("showDeleteAccountBtn").click();
  doc.getElementById("deleteAccountPassword").value = "wrong-password";
  doc.getElementById("confirmDeleteAccountBtn").click();
  await new Promise((r) => setTimeout(r, 20));

  assert(doc.getElementById("deleteAccountStatus").textContent === "Incorrect password", "δείχνει το μήνυμα λάθους από το backend");
  assert(window.localStorage.getItem("sessionToken") === "tok-123", "ΔΕΝ καθάρισε το localStorage μετά από αποτυχία");
}

async function test7_deleteSuccessClearsLocalStorage() {
  console.log("\n[Επιβεβαίωση διαγραφής -- επιτυχία: σωστό body, καθαρίζει localStorage]");
  const fetchImpl = fetchQueue([{ status: 200, body: DEFAULT_SETTINGS }, { status: 200, body: { ok: true } }]);
  const window = buildHarness({ fetchImpl, sessionToken: "tok-123" });
  await window.renderSettingsPanel();
  const doc = window.document;

  doc.getElementById("showDeleteAccountBtn").click();
  doc.getElementById("deleteAccountPassword").value = "correct-password";
  doc.getElementById("confirmDeleteAccountBtn").click();
  await new Promise((r) => setTimeout(r, 20));

  const deleteCall = fetchImpl.calls.find((c) => c.url === "/account/delete");
  assert(!!deleteCall, "έγινε κλήση στο /account/delete");
  assert(deleteCall.body.password === "correct-password", "στέλνει τον κωδικό στο body");
  assert(window.localStorage.getItem("sessionToken") === null, "καθάρισε το sessionToken μετά την επιτυχία");
}

async function run() {
  await test1_noAccountSectionForGuest();
  await test2_accountSectionForRealAccount();
  await test3_exportCallsCorrectEndpoint();
  await test4_showAndCancelDeleteConfirm();
  await test5_deleteRequiresPassword();
  await test6_deleteWithWrongPassword();
  await test7_deleteSuccessClearsLocalStorage();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
