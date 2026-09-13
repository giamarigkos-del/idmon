// Headless DOM simulation ΜΟΝΟ για το analytics panel μέσα στο
// public/editor.html (Section K). Ίδια τεχνική με το
// embed-panel-headless-check.mjs -- εξάγουμε το πραγματικό κομμάτι κώδικα
// μέσω exact string slice και το τρέχουμε με ελάχιστα stubs.
//
// Τρέξιμο: node tests/analytics-panel-headless-check.mjs

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

const START_MARKER = "  // Section K: πάνελ analytics";
const END_MARKER = 'el("analyticsBtn").addEventListener("click", renderAnalyticsPanel);';
const startIdx = editorSource.indexOf(START_MARKER);
const endIdx = editorSource.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  console.error("Δεν βρέθηκε το analytics panel block στο editor.html -- έχουν αλλάξει τα markers;");
  process.exit(1);
}
const analyticsPanelCode = editorSource.slice(startIdx, endIdx + END_MARKER.length);

const STRINGS = {
  loading: "Loading…",
  analyticsTitle: "📊 Analytics",
  analyticsIntro: "See how many questions your assistant answers.",
  totalQuestionsLabel: "Total questions",
  totalFallbackLabel: "Unanswered",
  fallbackRateLabel: "Unanswered rate",
  analytics7Days: "7 days",
  analytics30Days: "30 days",
  analytics90Days: "90 days",
  analyticsLoadError: "Could not load analytics.",
  analyticsNoData: "No questions yet in this period.",
  analyticsChartCaption: "Daily questions (red = unanswered)",
};

function makeEmptyDaily(days) {
  const today = new Date();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    out.push({ date: d.toISOString().slice(0, 10), total: 0, fallback: 0 });
  }
  return out;
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
  const html = `<!DOCTYPE html><html><body>
    <div id="mainPanel"></div>
    <button id="analyticsBtn"></button>
    <script>${preamble}\n${analyticsPanelCode}\nwindow.renderAnalyticsPanel = renderAnalyticsPanel;</script>
  </body></html>`;

  const dom = new JSDOM(html, {
    url: "https://operations-portal-rag.giamarigkos.workers.dev/editor.html",
    runScripts: "dangerously",
  });
  const { window } = dom;
  window.__strings = STRINGS;
  window.__mockFetch = fetchImpl;
  return window;
}

async function testRendersNumbers() {
  console.log("\n[renderAnalyticsPanel -- εμφανίζει τα σωστά νούμερα]");
  const daily = makeEmptyDaily(30);
  daily[daily.length - 1] = { date: daily[daily.length - 1].date, total: 10, fallback: 4 };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ totalQuestions: 10, totalFallback: 4, fallbackRate: 40, daily }),
  });
  const window = buildHarness(fetchImpl);
  await window.renderAnalyticsPanel();
  const main = window.document.getElementById("mainPanel");
  assert(main.textContent.includes("10"), "εμφανίζει το totalQuestions (10)");
  assert(main.textContent.includes("4"), "εμφανίζει το totalFallback (4)");
  assert(main.textContent.includes("40%"), "εμφανίζει το fallbackRate (40%)");
}

async function testRendersCorrectNumberOfBars() {
  console.log("\n[renderAnalyticsPanel -- σωστός αριθμός bars στο chart]");
  const daily = makeEmptyDaily(30);
  daily[daily.length - 1].total = 5;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ totalQuestions: 5, totalFallback: 0, fallbackRate: 0, daily }),
  });
  const window = buildHarness(fetchImpl);
  await window.renderAnalyticsPanel();
  const main = window.document.getElementById("mainPanel");
  assert(main.querySelectorAll(".analytics-bar-col").length === 30, "30 bars για 30 ημέρες");
}

async function testNoDataMessageWhenAllZero() {
  console.log("\n[renderAnalyticsPanel -- όλες οι ημέρες μηδενικές, δείχνει 'no data']");
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ totalQuestions: 0, totalFallback: 0, fallbackRate: 0, daily: makeEmptyDaily(30) }),
  });
  const window = buildHarness(fetchImpl);
  await window.renderAnalyticsPanel();
  const main = window.document.getElementById("mainPanel");
  assert(main.textContent.includes("No questions yet"), "δείχνει το μήνυμα 'no data'");
  assert(main.querySelectorAll(".analytics-bar-col").length === 0, "καμία μπάρα όταν δεν υπάρχουν δεδομένα");
}

async function testRangeButtonSwitchesDays() {
  console.log("\n[Κλικ στο '7 days' -- ξαναφορτώνει με days=7]");
  let lastUrl = null;
  const fetchImpl = async (url) => {
    lastUrl = url;
    const days = url.includes("days=7") ? 7 : 30;
    return { ok: true, json: async () => ({ totalQuestions: 0, totalFallback: 0, fallbackRate: 0, daily: makeEmptyDaily(days) }) };
  };
  const window = buildHarness(fetchImpl);
  await window.renderAnalyticsPanel();
  assert(lastUrl.includes("days=30"), "αρχικό φόρτωμα με days=30 (default)");

  const main = window.document.getElementById("mainPanel");
  const sevenBtn = [...main.querySelectorAll(".analytics-range-btn")].find((b) => b.textContent.includes("7 days"));
  assert(!!sevenBtn, "υπάρχει κουμπί '7 days'");
  sevenBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(lastUrl.includes("days=7"), "μετά το κλικ, νέο fetch με days=7");
  const activeBtn = main.querySelector(".analytics-range-btn.active");
  assert(!!activeBtn && activeBtn.textContent.includes("7 days"), "το '7 days' κουμπί γίνεται active");
}

async function testLoadErrorShowsMessage() {
  console.log("\n[GET /analytics/summary αποτυγχάνει -- μήνυμα λάθους, όχι crash]");
  const fetchImpl = async () => ({ ok: false, json: async () => ({ error: "server error" }) });
  const window = buildHarness(fetchImpl);
  await window.renderAnalyticsPanel();
  const main = window.document.getElementById("mainPanel");
  assert(main.textContent.includes("Could not load analytics"), "δείχνει το μήνυμα φόρτωσης λάθους");
}

async function run() {
  await testRendersNumbers();
  await testRendersCorrectNumberOfBars();
  await testNoDataMessageWhenAllZero();
  await testRangeButtonSwitchesDays();
  await testLoadErrorShowsMessage();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
