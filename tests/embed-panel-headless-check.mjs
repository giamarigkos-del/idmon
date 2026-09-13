// Headless DOM simulation ΜΟΝΟ για το νέο embed panel μέσα στο
// public/editor.html (Section I). Το editor.html στο σύνολό του εξαρτάται
// από εξωτερικά CDN scripts (TOAST UI Editor, marked.js) που δεν είναι
// διαθέσιμα σε sandboxed δίκτυο -- γι' αυτό εξάγουμε ΜΟΝΟ το πραγματικό,
// νέο κομμάτι κώδικα (embedScriptTag/patchEmbedDomains/renderEmbedContent/
// wireEmbedEvents/renderEmbedPanel) μέσω exact string slice, και το τρέχουμε
// με ελάχιστα stubs (t/escapeHtml/HEADERS/el) που ήδη υπάρχουν στο ίδιο
// αρχείο -- η ΙΔΙΑ σύμβαση interface, όχι reimplementation της λογικής.
//
// Τρέξιμο: node tests/embed-panel-headless-check.mjs

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

const START_MARKER = "  // Section I: πάνελ embed layer";
const END_MARKER = 'el("embedBtn").addEventListener("click", renderEmbedPanel);';
const startIdx = editorSource.indexOf(START_MARKER);
const endIdx = editorSource.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  console.error("Δεν βρέθηκε το embed panel block στο editor.html -- έχουν αλλάξει τα markers;");
  process.exit(1);
}
const embedPanelCode = editorSource.slice(startIdx, endIdx + END_MARKER.length);

// Ελάχιστο, στοχευμένο i18n dict -- ΜΟΝΟ τα keys που όντως χρησιμοποιεί
// το εξαγμένο κομμάτι κώδικα, όχι ολόκληρο το TRANSLATIONS dict.
const STRINGS = {
  loading: "Loading…",
  embedTitle: "🔗 Embed on your site",
  embedIntro: "Add your website's domain…",
  embedNoDomainsHint: "Add at least one domain to get your embed script.",
  embedDomainPlaceholder: "yourdomain.gr",
  embedAddDomainBtn: "Add",
  embedRemoveDomainAria: "Remove domain",
  embedScriptLabel: "Paste this in your site's HTML:",
  embedCopyBtn: "Copy",
  embedCopiedMsg: "✓ Copied.",
  embedLoadError: "Could not load embed settings.",
  embedSaveErrorPrefix: "Save error: ",
  embedDomainEmptyError: "Enter a domain first.",
  embedScriptRefreshHint: "If you change settings later, copy this script again.",
};

const DEFAULT_SETTINGS = {
  accentColor: "#6B7280",
  botName: "Assistant",
  logoUrl: null,
  notifyEmail: null,
  contactLabel: null,
  contactUrl: null,
  contactPhone: null,
};

// renderEmbedPanel κάνει ΔΥΟ παράλληλα fetch (Promise.all): /embed/domains
// και /workspace/settings. Αυτό το helper δρομολογεί κάθε mock fetch στη
// σωστή απάντηση ανάλογα με το URL, ώστε κάθε test να ορίζει μόνο ό,τι
// πραγματικά χρειάζεται.
function makeFetchImpl({ domains, settings, onPatch } = {}) {
  return async (url, options) => {
    if (url.includes("/workspace/settings")) {
      return { ok: true, json: async () => settings || DEFAULT_SETTINGS };
    }
    if (url.includes("/embed/domains")) {
      if (options && options.method === "PATCH") {
        return onPatch(JSON.parse(options.body));
      }
      return domains || { ok: true, json: async () => ({ embedId: "emb-abc123", domains: [] }) };
    }
    throw new Error("Απρόσμενο URL στο mock fetch: " + url);
  };
}

function buildHarness(fetchImpl) {
  const preamble = `
    function t(key) { return window.__strings[key] || key; }
    function escapeHtml(str) { return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
    function el(id) { return document.getElementById(id); }
    function fetch(url, options) { return window.__mockFetch(url, options); }
    var HEADERS = { "Content-Type": "application/json", "X-Workspace-Id": "ws-test" };
    var tuiEditorInstance = null;
    var currentSelectedId = null;
  `;
  // ΟΧΙ window.eval() -- σε jsdom, function declarations μέσα σε
  // window.eval() ΔΕΝ γίνονται πραγματικά προσβάσιμες ως window.xxx από
  // έξω (διαφορετική συμπεριφορά από πραγματικό browser). Αντ' αυτού,
  // βάζουμε τον κώδικα μέσα σε ΠΡΑΓΜΑΤΙΚΟ <script> tag στο αρχικό HTML,
  // με runScripts:"outside-only" -- έτσι εκτελείται σαν κανονικό σελίδας
  // script, και οι function declarations γίνονται πραγματικά global.
  const html = `<!DOCTYPE html><html><body>
    <div id="mainPanel"></div>
    <button id="embedBtn"></button>
    <script>${preamble}\n${embedPanelCode}\nwindow.renderEmbedPanel = renderEmbedPanel;</script>
  </body></html>`;

  const dom = new JSDOM(html, {
    url: "https://operations-portal-rag.giamarigkos.workers.dev/editor.html",
    runScripts: "dangerously",
  });
  const { window } = dom;
  window.__strings = STRINGS;
  window.navigator.clipboard = { writeText: async () => {} };
  window.__mockFetch = fetchImpl;
  return window;
}

async function testRendersHintWhenNoDomains() {
  console.log("\n[renderEmbedPanel -- κανένα domain ακόμα]");
  const fetchImpl = makeFetchImpl({
    domains: { ok: true, json: async () => ({ embedId: "emb-abc123", domains: [] }) },
  });
  const window = buildHarness(fetchImpl);
  await window.renderEmbedPanel();
  const main = window.document.getElementById("mainPanel");
  assert(main.innerHTML.includes("Add at least one domain"), "δείχνει το hint μήνυμα όταν δεν υπάρχει domain");
  assert(!main.querySelector("#embedCopyBtn"), "ΔΕΝ εμφανίζεται το script tag χωρίς κανένα domain");
}

async function testRendersScriptWhenDomainExists() {
  console.log("\n[renderEmbedPanel -- υπάρχει ήδη domain]");
  const fetchImpl = makeFetchImpl({
    domains: { ok: true, json: async () => ({ embedId: "emb-abc123", domains: ["pelatis.gr"] }) },
  });
  const window = buildHarness(fetchImpl);
  await window.renderEmbedPanel();
  const main = window.document.getElementById("mainPanel");
  assert(!!main.querySelector("#embedCopyBtn"), "εμφανίζεται το κουμπί αντιγραφής όταν υπάρχει domain");
  const codeText = main.querySelector("#embedScriptCode").textContent;
  assert(codeText.includes("data-embed-id=\"emb-abc123\""), "το script tag περιέχει το σωστό embedId");
  assert(codeText.includes("/widget.js"), "το script tag δείχνει στο widget.js");
  assert(codeText.trim().endsWith("</script>"), "το script tag κλείνει σωστά (χωρίς να σπάει το πραγματικό HTML)");
  assert(!!main.querySelector('[data-domain="pelatis.gr"]'), "το domain εμφανίζεται στη λίστα");
}

async function testScriptTagIncludesSettings() {
  console.log("\n[renderEmbedPanel -- το script tag κουβαλάει branding + επικοινωνία]");
  const fetchImpl = makeFetchImpl({
    domains: { ok: true, json: async () => ({ embedId: "emb-abc123", domains: ["pelatis.gr"] }) },
    settings: {
      accentColor: "#123ABC",
      botName: "Βοηθός Πωλήσεων",
      contactLabel: "Μίλα μαζί μας",
      contactUrl: "https://wa.me/306912345678",
      contactPhone: "+30 210 1234567",
    },
  });
  const window = buildHarness(fetchImpl);
  await window.renderEmbedPanel();
  const codeText = window.document.getElementById("embedScriptCode").textContent;
  assert(codeText.includes('data-accent-color="#123ABC"'), "το script tag περιέχει το ρυθμισμένο χρώμα");
  assert(codeText.includes('data-bot-name="Βοηθός Πωλήσεων"'), "το script tag περιέχει το ρυθμισμένο όνομα bot");
  assert(codeText.includes('data-contact-label="Μίλα μαζί μας"'), "το script tag περιέχει το contact label");
  assert(codeText.includes('data-contact-url="https://wa.me/306912345678"'), "το script tag περιέχει το contact url");
  assert(codeText.includes('data-contact-phone="+30 210 1234567"'), "το script tag περιέχει το τηλέφωνο");
}

async function testScriptTagOmitsEmptyContactFields() {
  console.log("\n[renderEmbedPanel -- χωρίς ρυθμισμένη επικοινωνία, το script tag ΔΕΝ έχει data-contact-*]");
  const fetchImpl = makeFetchImpl({
    domains: { ok: true, json: async () => ({ embedId: "emb-abc123", domains: ["pelatis.gr"] }) },
    settings: DEFAULT_SETTINGS,
  });
  const window = buildHarness(fetchImpl);
  await window.renderEmbedPanel();
  const codeText = window.document.getElementById("embedScriptCode").textContent;
  assert(!codeText.includes("data-contact-"), "κανένα data-contact-* attribute όταν δεν έχει ρυθμιστεί επικοινωνία");
}

async function testAddDomainSendsCorrectPatch() {
  console.log("\n[Προσθήκη domain -- σωστό PATCH body]");
  let patchBody = null;
  const fetchImpl = makeFetchImpl({
    domains: { ok: true, json: async () => ({ embedId: "emb-abc123", domains: [] }) },
    onPatch: (body) => {
      patchBody = body;
      return { ok: true, json: async () => ({ embedId: "emb-abc123", domains: ["newsite.gr"] }) };
    },
  });
  const window = buildHarness(fetchImpl);
  await window.renderEmbedPanel();
  window.document.getElementById("embedNewDomainInput").value = "newsite.gr";
  window.document.getElementById("embedAddDomainBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(JSON.stringify(patchBody.domains) === JSON.stringify(["newsite.gr"]), "στέλνει PATCH με τη σωστή, πλήρη λίστα");
  const main = window.document.getElementById("mainPanel");
  assert(!!main.querySelector('[data-domain="newsite.gr"]'), "το νέο domain εμφανίζεται μετά την επιτυχή προσθήκη");
}

async function testEmptyDomainShowsError() {
  console.log("\n[Προσθήκη κενού domain -- εμφανίζει σφάλμα, ΔΕΝ στέλνει PATCH]");
  let patchCalled = false;
  const fetchImpl = makeFetchImpl({
    domains: { ok: true, json: async () => ({ embedId: "emb-abc123", domains: [] }) },
    onPatch: (body) => {
      patchCalled = true;
      return { ok: true, json: async () => ({ embedId: "emb-abc123", domains: [] }) };
    },
  });
  const window = buildHarness(fetchImpl);
  await window.renderEmbedPanel();
  window.document.getElementById("embedNewDomainInput").value = "   ";
  window.document.getElementById("embedAddDomainBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(!patchCalled, "ΔΕΝ καλεί το PATCH endpoint με κενό domain");
  assert(window.document.getElementById("embedStatus").textContent.includes("Enter a domain"), "δείχνει μήνυμα σφάλματος");
}

async function testRemoveDomain() {
  console.log("\n[Αφαίρεση domain -- σωστό PATCH body χωρίς το αφαιρεμένο]");
  let patchBody = null;
  const fetchImpl = makeFetchImpl({
    domains: { ok: true, json: async () => ({ embedId: "emb-abc123", domains: ["a.gr", "b.gr"] }) },
    onPatch: (body) => {
      patchBody = body;
      return { ok: true, json: async () => ({ embedId: "emb-abc123", domains: ["b.gr"] }) };
    },
  });
  const window = buildHarness(fetchImpl);
  await window.renderEmbedPanel();
  window.document.querySelector('.embed-remove-domain-btn[data-domain="a.gr"]').dispatchEvent(
    new window.Event("click", { bubbles: true })
  );
  await new Promise((r) => setTimeout(r, 0));

  assert(JSON.stringify(patchBody.domains) === JSON.stringify(["b.gr"]), "το PATCH στέλνει τη λίστα ΧΩΡΙΣ το αφαιρεμένο domain");
  assert(!window.document.querySelector('[data-domain="a.gr"]'), "το αφαιρεμένο domain εξαφανίζεται από τη λίστα");
  assert(!!window.document.querySelector('[data-domain="b.gr"]'), "το υπόλοιπο domain παραμένει");
}

async function testLoadErrorShowsMessage() {
  console.log("\n[GET /embed/domains αποτυγχάνει -- δείχνει μήνυμα λάθους, όχι crash]");
  const fetchImpl = makeFetchImpl({
    domains: { ok: false, json: async () => ({ error: "server error" }) },
  });
  const window = buildHarness(fetchImpl);
  await window.renderEmbedPanel();
  const main = window.document.getElementById("mainPanel");
  assert(main.textContent.includes("Could not load embed settings"), "δείχνει το μήνυμα φόρτωσης λάθους");
}

async function run() {
  await testRendersHintWhenNoDomains();
  await testRendersScriptWhenDomainExists();
  await testScriptTagIncludesSettings();
  await testScriptTagOmitsEmptyContactFields();
  await testAddDomainSendsCorrectPatch();
  await testEmptyDomainShowsError();
  await testRemoveDomain();
  await testLoadErrorShowsMessage();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
