// Headless έλεγχος του κουμπιού "Αναβάθμιση", των καταστάσεων πληρωμής, της "συμφωνίας"
// με το Paddle (POST /billing/reconcile) και της διαχείρισης της ΥΠΑΡΧΟΥΣΑΣ συνδρομής
// (Αλλαγή σε Pro, portal) στο editor.html (Section R), με jsdom και ψεύτικο Paddle.js -- χωρίς browser,
// χωρίς δίκτυο, χωρίς wrangler.
// Χρήση (PowerShell, από τον φάκελο idmon):
//   node tests/upgrade-button-dom.mjs
// Προαιρετικά: $env:EDITOR_PATH και $env:SHARED_PATH για άλλες τοποθεσίες.
// Απαιτεί το πακέτο jsdom (npm install jsdom).
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const editorPath = path.resolve(process.env.EDITOR_PATH || "./public/editor.html");
const sharedPath = path.resolve(process.env.SHARED_PATH || "./public/shared.js");
const editorHtml = fs.readFileSync(editorPath, "utf8");
const sharedJs = fs.readFileSync(sharedPath, "utf8");

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POLL = { intervalMs: 60, maxTries: 4 }; // γρήγορο polling μόνο για τα tests
const PENDING_KEY = "idmonPaymentPending";
const TXN_ID = "txn_" + "0".repeat(25) + "1";

const OFFER_FREE = {
  environment: "sandbox",
  clientToken: "test_dummy_token",
  workspaceId: "ws-real",
  currentPlan: "free",
  offers: [
    { plan: "basic", priceId: "pri_basic_test", messages: 500, docs: 20 },
    { plan: "pro", priceId: "pri_pro_test", messages: 2500, docs: null },
  ],
};

function usageBody(overrides) {
  return { plan: "free", messagesUsed: 0, messagesLimit: 100, messagesLimitReached: false,
           docsUsed: 0, docsLimit: 5, docsLimitReached: false, ...overrides };
}

function pendingFlag(overrides) {
  return JSON.stringify({ plan: "pro", transactionId: TXN_ID, workspaceId: "ws-real", at: Date.now(), ...overrides });
}

// Χτίζει τη σελίδα: το shared.js μπαίνει inline, τα εξωτερικά scripts/CSS
// (CDN) αφαιρούνται και τα ελάχιστα globals που περιμένει ο editor ορίζονται
// ως stubs -- δεν τα χρειάζεται καμία λειτουργία του κουμπιού.
async function boot({ usage, lang = "en", session = true, paddle = "mock", paddleInitThrows = false, local = {}, reconcile = null, blockPopups = false }) {
  const html = editorHtml
    .replace(/<link[^>]*>/g, "")
    .replace('<script src="/shared.js"></script>', () => "<script>" + sharedJs + "</script>")
    .replace(/<script src="https?:[^>]*><\/script>/g, "");

  const calls = { initialize: [], environment: [], checkoutOpen: [], pricePreview: [], statusFetches: 0, allDocsClicks: 0, reconcile: [], preview: [], change: [], portal: [], opened: [], navigated: [] };
  const popup = { opener: "original-opener", location: { href: "" }, closed: false, close() { this.closed = true; } };
  let currentUsage = usage;
  // Ο "server" για το /billing/reconcile· κάθε test το αλλάζει ανάλογα με το σενάριο.
  const api = { setUsage: (u) => { currentUsage = u; } };
  const handlers = {
    reconcile: reconcile || (() => ({ status: 200, json: {} })),
    preview: () => ({ status: 200, json: {} }),
    change: () => ({ status: 200, json: {} }),
    portal: () => ({ status: 200, json: {} }),
  };

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://app.idmon.app/editor.html",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("workspaceId", "ws-real");
      if (session) window.localStorage.setItem("sessionToken", "tok123");
      window.localStorage.setItem("uiLang", lang);
      for (const [k, v] of Object.entries(local)) window.localStorage.setItem(k, v);
      window.__UPGRADE_POLL_CONFIG__ = POLL;
      window.open = (u, target) => { calls.opened.push({ u, target }); return blockPopups ? null : popup; };
      window.marked = { parse: (s) => s, use() {}, setOptions() {} };
      window.DOMPurify = { sanitize: (s) => s };
      window.toastui = { Editor: function () {} };
      window.fetch = async (url, init = {}) => {
        for (const name of ["portal", "change-plan/preview", "change-plan"]) {
          if (String(url) === "/billing/" + name) {
            const key = name === "portal" ? "portal" : name === "change-plan" ? "change" : "preview";
            calls[key].push({ body: init.body ? JSON.parse(init.body) : null, method: init.method, headers: init.headers, at: calls.opened.length });
            const r = handlers[key](calls[key].length, api);
            if (r === "throw") throw new TypeError("network down");
            if (r && r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
            return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
          }
        }
        if (String(url).startsWith("/billing/reconcile")) {
          const body = JSON.parse(init.body);
          calls.reconcile.push({ body, method: init.method, headers: init.headers });
          const r = handlers.reconcile(body, calls.reconcile.length, api);
          if (r === "throw") throw new TypeError("network down");
          return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
        }
        if (String(url).startsWith("/usage/status")) {
          calls.statusFetches++;
          return { ok: true, status: 200, json: async () => currentUsage };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      if (paddle === "mock") {
        window.Paddle = {
          Environment: { set: (e) => calls.environment.push(e) },
          Initialize: (opts) => {
            if (paddleInitThrows) throw new Error("init failed");
            calls.initialize.push(opts);
          },
          Checkout: { open: (opts) => calls.checkoutOpen.push(opts) },
          PricePreview: async (req) => {
            calls.pricePreview.push(req);
            return { data: { details: { lineItems: req.items.map((it) => ({
              price: { id: it.priceId },
              formattedTotals: { total: it.priceId === "pri_pro_test" ? "€73.16" : "€35.96" },
            })) } } };
          },
        };
      }
    },
  });
  await sleep(80);
  // Μετράει τα κλικ στο "All documents" (το χρησιμοποιεί το "Back to documents").
  dom.window.document.getElementById("topAllDocsBtn").addEventListener("click", () => calls.allDocsClicks++);
  dom.window.navigateTo = (u) => calls.navigated.push(u); // ο jsdom δεν μπορεί να αλλάξει σελίδα
  const returned = { popup };
  return { dom, window: dom.window, document: dom.window.document, calls, handlers, popup, setUsage: (u) => { currentUsage = u; } };
}

const btnVisible = (doc) => doc.getElementById("upgradeBtn").style.display !== "none";
const bannerVisible = (doc) => doc.getElementById("paymentPendingBanner").style.display !== "none";
const chooseButtons = (doc) => doc.querySelectorAll(".upgrade-choose-btn").length;
const stateView = (doc) => doc.getElementById("upgradeStateView");
const flag = (win) => win.localStorage.getItem(PENDING_KEY);

// Ανοίγει το πάνελ, διαλέγει πλάνο και προσομοιώνει checkout.completed.
async function openAndPay(t, plan = "pro") {
  t.document.getElementById("upgradeBtn").click();
  await sleep(80);
  t.document.querySelector(`.upgrade-choose-btn[data-plan="${plan}"]`).click();
  await sleep(50);
  t.calls.initialize[0].eventCallback({ name: "checkout.completed", data: { transaction_id: TXN_ID } });
}

console.log("free account, server offers basic and pro");
{
  const { window, document, calls } = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  check("button is visible", btnVisible(document));
  check("no pending banner", !bannerVisible(document));
  check("button text is English", document.getElementById("upgradeBtn").textContent === "Upgrade");
  check("Paddle.js is NOT loaded on page load (lazy)", !document.querySelector('script[src*="cdn.paddle.com"]') && calls.initialize.length === 0);

  document.getElementById("upgradeBtn").click();
  await sleep(80);
  const main = document.getElementById("mainPanel");
  const plans = Array.from(main.querySelectorAll(".upgrade-choose-btn")).map((b) => b.dataset.plan);
  check("panel shows basic and pro cards", plans.join() === "basic,pro", plans.join());
  check("panel shows current plan", main.textContent.includes("Current plan: Free"));
  check("panel shows limits from the server", main.textContent.includes("500 messages / month") && main.textContent.includes("2,500 messages / month") && main.textContent.includes("20 documents") && main.textContent.includes("Unlimited documents"));
  check("Paddle initialised with sandbox token", calls.initialize.length === 1 && calls.initialize[0].token === "test_dummy_token" && calls.environment.join() === "sandbox");
  check("prices come from Paddle price preview", main.textContent.includes("€35.96") && main.textContent.includes("€73.16"));

  main.querySelector('.upgrade-choose-btn[data-plan="pro"]').click();
  await sleep(50);
  const open = calls.checkoutOpen[0];
  check("checkout opened once", calls.checkoutOpen.length === 1);
  check("checkout uses the pro price id", open && open.items[0].priceId === "pri_pro_test" && open.items[0].quantity === 1);
  check("checkout carries workspace_id as custom data", open && open.customData && open.customData.workspace_id === "ws-real");
  check("checkout is an overlay in English", open && open.settings.displayMode === "overlay" && open.settings.locale === "en");
  window.close();
}

console.log("payment completed: pending state shows immediately, confirmed state once the server agrees");
{
  const t = await boot({ usage: usageBody({ messagesLimitReached: true, upgrade: OFFER_FREE }) });
  check("usage-limit banner is showing before payment", t.document.getElementById("usageLimitBanner").style.display === "flex");
  await openAndPay(t, "pro");
  // ΑΜΕΣΩΣ μετά το checkout.completed, πριν ο server επιβεβαιώσει:
  check("panel switches to the pending view", stateView(t.document) && stateView(t.document).dataset.state === "pending");
  check("no buy buttons left in the panel", chooseButtons(t.document) === 0);
  check("stale 'Current plan: Free' is gone", !t.document.getElementById("mainPanel").textContent.includes("Current plan"));
  check("pending message is shown", t.document.getElementById("mainPanel").textContent.includes("Payment received"));
  check("top-bar Upgrade button is hidden", !btnVisible(t.document));
  check("pending banner is visible", bannerVisible(t.document));
  const saved = JSON.parse(flag(t.window) || "null");
  check("browser remembers the payment for this workspace", saved && saved.workspaceId === "ws-real" && saved.plan === "pro", flag(t.window));
  check("...together with the Paddle transaction id", saved && saved.transactionId === TXN_ID);

  // Ο server "βλέπει" πλέον την ενεργή συνδρομή (το webhook τελείωσε).
  t.setUsage(usageBody({ plan: "pro", messagesLimit: 2500, messagesLimitReached: false, upgrade: null }));
  await sleep(250);
  check("panel switches to the confirmed view", stateView(t.document) && stateView(t.document).dataset.state === "confirmed");
  check("confirmed view names the new plan", t.document.getElementById("mainPanel").textContent.includes("Your plan is now Pro"));
  check("pending banner is hidden", !bannerVisible(t.document));
  check("usage-limit banner is cleared", t.document.getElementById("usageLimitBanner").style.display === "none");
  check("remembered payment is cleared", flag(t.window) === null);
  check("Upgrade button stays hidden", !btnVisible(t.document));
  const before = t.calls.statusFetches;
  await sleep(200);
  check("polling has stopped", t.calls.statusFetches === before);
  t.document.getElementById("upgradeBackBtn").click();
  check("'Back to documents' goes to the document list", t.calls.allDocsClicks === 1);
  t.window.close();
}

console.log("server never confirms (webhook delayed)");
{
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  await openAndPay(t, "basic");
  await sleep(POLL.intervalMs * (POLL.maxTries + 2));
  check("panel shows the slow message", stateView(t.document) && stateView(t.document).dataset.state === "slow");
  check("slow message is reassuring", t.document.getElementById("mainPanel").textContent.includes("Your payment went through"));
  check("buy buttons do NOT come back", chooseButtons(t.document) === 0);
  check("Upgrade button stays hidden", !btnVisible(t.document));
  check("pending banner stays visible", bannerVisible(t.document));
  check("payment is still remembered", flag(t.window) !== null);
  const before = t.calls.statusFetches;
  await sleep(200);
  check("polling stopped after the limit", t.calls.statusFetches === before);
  t.window.close();
}

console.log("reload while the payment is still pending");
{
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }), local: { [PENDING_KEY]: pendingFlag() } });
  check("Upgrade button is NOT offered again", !btnVisible(t.document));
  check("pending banner is visible", bannerVisible(t.document));
  // Ο server ενημερώνεται αφού έγινε το reload:
  t.setUsage(usageBody({ plan: "pro", upgrade: null }));
  await sleep(250);
  check("banner clears itself once the server confirms", !bannerVisible(t.document));
  check("remembered payment is cleared", flag(t.window) === null);
  t.window.close();
}

console.log("remembered payment that is too old, or belongs to another workspace");
{
  const old = await boot({ usage: usageBody({ upgrade: OFFER_FREE }), local: { [PENDING_KEY]: pendingFlag({ at: Date.now() - 11 * 60 * 1000 }) } });
  check("expired flag: Upgrade button is offered again", btnVisible(old.document));
  check("expired flag: no pending banner", !bannerVisible(old.document));
  check("expired flag is removed", flag(old.window) === null);
  old.window.close();

  const other = await boot({ usage: usageBody({ upgrade: OFFER_FREE }), local: { [PENDING_KEY]: pendingFlag({ workspaceId: "ws-someone-else" }) } });
  check("flag of another workspace is ignored", btnVisible(other.document) && !bannerVisible(other.document));
  other.window.close();
}

console.log("stale remembered payment when the server offers nothing");
{
  const t = await boot({ usage: usageBody({ plan: "pro", upgrade: null }), local: { [PENDING_KEY]: pendingFlag() } });
  check("flag is cleared, nothing to wait for", flag(t.window) === null);
  check("no banner, no button", !bannerVisible(t.document) && !btnVisible(t.document));
  t.window.close();
}

console.log("payment fails inside the checkout");
{
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.document.getElementById("upgradeBtn").click();
  await sleep(80);
  t.document.querySelector('.upgrade-choose-btn[data-plan="basic"]').click();
  await sleep(50);
  t.calls.initialize[0].eventCallback({ name: "checkout.payment_failed" });
  check("cards stay so the customer can retry", chooseButtons(t.document) === 2);
  check("failure message is shown", t.document.getElementById("upgradeStatus").textContent.startsWith("The payment didn't go through"), t.document.getElementById("upgradeStatus").textContent);
  check("nothing is remembered as paid", flag(t.window) === null);
  check("Upgrade button stays visible", btnVisible(t.document));
  t.window.close();
}

console.log("reconcile: the server asks Paddle, so a late webhook does not matter");
{
  // Ο server "εφαρμόζει" το πλάνο μέσω συμφωνίας· το webhook δεν έρχεται ποτέ.
  const t = await boot({ usage: usageBody({ messagesLimitReached: true, upgrade: OFFER_FREE }) });
  t.handlers.reconcile = () => { t.setUsage(usageBody({ plan: "basic", upgrade: null })); return { status: 200, json: { status: "applied", plan: "basic" } }; };
  await openAndPay(t, "basic");
  await sleep(300);
  check("reconcile was called with the transaction id", t.calls.reconcile.length >= 1 && t.calls.reconcile[0].body.transactionId === TXN_ID);
  check("it is a POST that carries the session token", t.calls.reconcile[0].method === "POST" && t.calls.reconcile[0].headers["X-Session-Token"] === "tok123");
  check("the confirmed view appears without any webhook", stateView(t.document) && stateView(t.document).dataset.state === "confirmed");
  check("reconcile stops after it succeeded", t.calls.reconcile.length === 1);
  t.window.close();
}
{
  // pending, pending, applied
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.handlers.reconcile = (b, n) => {
    if (n < 3) return { status: 200, json: { status: "pending" } };
    t.setUsage(usageBody({ plan: "basic", upgrade: null }));
    return { status: 200, json: { status: "applied", plan: "basic" } };
  };
  await openAndPay(t, "basic");
  await sleep(450);
  check("keeps asking while Paddle says pending, then confirms", t.calls.reconcile.length === 3 && stateView(t.document).dataset.state === "confirmed", "calls: " + t.calls.reconcile.length);
  t.window.close();
}
{
  // reconcile is refused (403): stop asking, but the webhook path still works
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.handlers.reconcile = () => ({ status: 403, json: { error: "nope" } });
  await openAndPay(t, "basic");
  await sleep(200);
  check("a refusal (403) is not retried", t.calls.reconcile.length === 1, "calls: " + t.calls.reconcile.length);
  check("the pending view stays meanwhile", stateView(t.document).dataset.state === "pending");
  t.setUsage(usageBody({ plan: "basic", upgrade: null })); // το webhook τελικά έρχεται
  await sleep(200);
  check("the webhook path still confirms", stateView(t.document).dataset.state === "confirmed");
  t.window.close();
}
{
  // 503 (key problem): also not retried, page unaffected
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.handlers.reconcile = () => ({ status: 503, json: { error: "unavailable" } });
  await openAndPay(t, "basic");
  await sleep(POLL.intervalMs * 2.5);
  check("503 (billing unavailable) is not retried and does not break the page", t.calls.reconcile.length === 1 && stateView(t.document).dataset.state === "pending", "calls: " + t.calls.reconcile.length);
  t.window.close();
}
{
  // temporary problems are retried: 502, 429 and a network error
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.handlers.reconcile = (b, n) => (n === 1 ? { status: 502, json: {} } : n === 2 ? { status: 429, json: {} } : n === 3 ? "throw" : { status: 200, json: { status: "pending" } });
  await openAndPay(t, "basic");
  await sleep(450);
  check("502, 429 and network errors are retried", t.calls.reconcile.length >= 4, "calls: " + t.calls.reconcile.length);
  t.window.close();
}
{
  // Paddle says the payment was not completed / server says up to date: stop
  for (const status of ["not_completed", "up_to_date", "applied"]) {
    const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
    t.handlers.reconcile = () => ({ status: 200, json: { status } });
    await openAndPay(t, "basic");
    await sleep(300);
    check(`reconcile status "${status}" ends the asking`, t.calls.reconcile.length === 1);
    t.window.close();
  }
}
{
  // no transaction id in the event: nothing to reconcile, webhook path unchanged
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.document.getElementById("upgradeBtn").click();
  await sleep(80);
  t.document.querySelector('.upgrade-choose-btn[data-plan="basic"]').click();
  await sleep(50);
  t.calls.initialize[0].eventCallback({ name: "checkout.completed" });
  await sleep(200);
  check("no transaction id: reconcile is never called", t.calls.reconcile.length === 0);
  t.setUsage(usageBody({ plan: "basic", upgrade: null }));
  await sleep(200);
  check("...and the webhook path still confirms", stateView(t.document).dataset.state === "confirmed");
  t.window.close();
}
{
  // reload while pending: the remembered transaction id resumes the reconcile
  const t = await boot({
    usage: usageBody({ upgrade: OFFER_FREE }),
    local: { [PENDING_KEY]: pendingFlag() },
    reconcile: (b, n, api) => { api.setUsage(usageBody({ plan: "basic", upgrade: null })); return { status: 200, json: { status: "applied", plan: "basic" } }; },
  });
  await sleep(300);
  check("after a reload, reconcile resumes with the remembered transaction id", t.calls.reconcile.length === 1 && t.calls.reconcile[0].body.transactionId === TXN_ID);
  check("...and the banner clears once it is applied", !bannerVisible(t.document) && flag(t.window) === null);
  t.window.close();
}
{
  // old flag format (no transaction id) still works
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }), local: { [PENDING_KEY]: pendingFlag({ transactionId: undefined }) } });
  await sleep(150);
  check("an older remembered payment without transaction id does not call reconcile", t.calls.reconcile.length === 0 && bannerVisible(t.document));
  t.window.close();
}
{
  // never confirmed: reconcile is capped by the same 30 second limit
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.handlers.reconcile = () => ({ status: 200, json: { status: "pending" } });
  await openAndPay(t, "basic");
  await sleep(POLL.intervalMs * (POLL.maxTries + 3));
  check("reconcile asks at most once per polling round", t.calls.reconcile.length === POLL.maxTries, "calls: " + t.calls.reconcile.length);
  check("still ends in the slow message with no buy buttons", stateView(t.document).dataset.state === "slow" && chooseButtons(t.document) === 0);
  t.window.close();
}


const SUB_MANAGE = { canManage: true, canChangeToPro: true };
const visible = (doc, id) => doc.getElementById(id).style.display !== "none";
const text = (doc) => doc.getElementById("mainPanel").textContent;
const PREVIEW_OK = { status: 200, json: { toPlan: "pro", currency: "EUR", chargeToday: "2990", recurring: "5900", nextBilledAt: "2026-10-19T19:00:00Z" } };

console.log("existing subscription: which buttons the server allows");
{
  const both = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  check("basic + active: both buttons visible", visible(both.document, "manageSubBtn") && visible(both.document, "changePlanBtn"));
  check("Upgrade (new checkout) stays hidden, so no second subscription", !btnVisible(both.document));
  check("English labels", both.document.getElementById("manageSubBtn").textContent === "Manage subscription" && both.document.getElementById("changePlanBtn").textContent === "Switch to Pro");
  both.window.close();
  const proOnly = await boot({ usage: usageBody({ plan: "pro", upgrade: null, manage: { canManage: true, canChangeToPro: false } }) });
  check("pro: only Manage subscription", visible(proOnly.document, "manageSubBtn") && !visible(proOnly.document, "changePlanBtn"));
  proOnly.window.close();
  const none = await boot({ usage: usageBody({ plan: "free", upgrade: OFFER_FREE, manage: null }) });
  check("no live subscription: neither button", !visible(none.document, "manageSubBtn") && !visible(none.document, "changePlanBtn"));
  none.window.close();
  const old = await boot({ usage: usageBody({ plan: "basic", upgrade: null }) });
  check("older backend without the manage field: neither button", !visible(old.document, "manageSubBtn") && !visible(old.document, "changePlanBtn"));
  old.window.close();
  const el = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }), lang: "el" });
  check("Greek labels", el.document.getElementById("manageSubBtn").textContent === "Διαχείριση συνδρομής" && el.document.getElementById("changePlanBtn").textContent === "Αλλαγή σε Pro");
  el.window.close();
}

console.log("switch to Pro: preview first, change only after an explicit confirmation");
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.preview = () => PREVIEW_OK;
  t.handlers.change = (n, api) => { api.setUsage(usageBody({ plan: "pro", upgrade: null, manage: { canManage: true, canChangeToPro: false } })); return { status: 200, delayMs: 80, json: { status: "applied", plan: "pro" } }; };
  t.document.getElementById("changePlanBtn").click();
  await sleep(80);
  check("clicking asks the server for a PREVIEW (POST, session token, plan pro)", t.calls.preview.length === 1 && t.calls.preview[0].method === "POST" && t.calls.preview[0].body.plan === "pro" && t.calls.preview[0].headers["X-Session-Token"] === "tok123");
  check("the amount charged today is shown", t.document.getElementById("changePlanToday").textContent.includes("29.90"), t.document.getElementById("changePlanToday").textContent);
  check("the monthly price and the date are shown", t.document.getElementById("changePlanRecurring").textContent.includes("59.00") && t.document.getElementById("changePlanRecurring").textContent.includes("2026"), t.document.getElementById("changePlanRecurring").textContent);
  check("the confirm button states the amount", t.document.getElementById("changePlanConfirmBtn").textContent.includes("29.90"));
  check("NOTHING has been changed yet", t.calls.change.length === 0);
  // δύο γρήγορα κλικ = μία μόνο χρέωση
  const confirmBtn = t.document.getElementById("changePlanConfirmBtn");
  confirmBtn.click(); confirmBtn.click();
  await sleep(20);
  check("the confirm button is disabled at once and shows progress", confirmBtn.disabled && t.document.getElementById("changePlanStatus").textContent.includes("Switching"));
  await sleep(200);
  check("a double click sends ONE change request", t.calls.change.length === 1 && t.calls.change[0].body.plan === "pro");
  check("the panel says the plan is now Pro", text(t.document).includes("Your plan is now Pro") && !!t.document.getElementById("upgradeBackBtn"));
  check("the Switch to Pro button disappears, Manage stays", !visible(t.document, "changePlanBtn") && visible(t.document, "manageSubBtn"));
  t.document.getElementById("upgradeBackBtn").click();
  check("Back to documents works", t.calls.allDocsClicks === 1);
  t.window.close();
}
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.preview = () => PREVIEW_OK;
  t.document.getElementById("changePlanBtn").click();
  await sleep(80);
  t.document.getElementById("changePlanCancelBtn").click();
  await sleep(40);
  check("Cancel goes back and never changes anything", t.calls.allDocsClicks === 1 && t.calls.change.length === 0);
  t.window.close();
}
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }), lang: "el" });
  t.handlers.preview = () => PREVIEW_OK;
  t.document.getElementById("changePlanBtn").click();
  await sleep(80);
  check("Greek: amounts use Greek formatting", t.document.getElementById("changePlanToday").textContent.includes("29,90"), t.document.getElementById("changePlanToday").textContent);
  check("Greek: texts are Greek", text(t.document).includes("Χρέωση σήμερα") && t.document.getElementById("changePlanConfirmBtn").textContent.startsWith("Επιβεβαίωση και πληρωμή"));
  t.window.close();
}
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.preview = () => ({ status: 200, json: { toPlan: "pro", currency: "EUR", chargeToday: "2990", recurring: "5900", nextBilledAt: null } });
  t.document.getElementById("changePlanBtn").click();
  await sleep(80);
  check("without a next billing date the text still makes sense", t.document.getElementById("changePlanRecurring").textContent.startsWith("Then"), t.document.getElementById("changePlanRecurring").textContent);
  t.window.close();
}

console.log("switch to Pro: when the preview fails");
for (const [label, resp, expectText, expectRetry] of [
  ["past due", { status: 409, json: { code: "past_due" } }, "last payment didn't go through", false],
  ["pending scheduled change", { status: 409, json: { code: "pending_changes" } }, "pending change", false],
  ["too close to renewal", { status: 409, json: { code: "locked_renewal" } }, "about to renew", false],
  ["not eligible", { status: 409, json: { code: "not_eligible" } }, "isn't available", false],
  ["billing unavailable (503)", { status: 503, json: { code: "unavailable" } }, "couldn't confirm", true],
  ["provider error (502)", { status: 502, json: { code: "provider_error" } }, "couldn't confirm", true],
  ["network down", "throw", "couldn't confirm", true],
  ["rate limited (429)", { status: 429, json: { code: "rate_limited" } }, "couldn't confirm", false],
]) {
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.preview = () => resp;
  t.document.getElementById("changePlanBtn").click();
  await sleep(80);
  check(`${label}: a clear message, no confirm button, nothing charged`, text(t.document).includes(expectText) && !t.document.getElementById("changePlanConfirmBtn") && t.calls.change.length === 0, text(t.document));
  check(`${label}: retry is ${expectRetry ? "offered" : "not offered"}`, !!t.document.getElementById("changePlanRetryBtn") === expectRetry);
  t.window.close();
}
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.preview = (n) => (n === 1 ? { status: 502, json: { code: "provider_error" } } : PREVIEW_OK);
  t.document.getElementById("changePlanBtn").click();
  await sleep(80);
  t.document.getElementById("changePlanRetryBtn").click();
  await sleep(80);
  check("Try again asks for a fresh preview and then shows the amount", t.calls.preview.length === 2 && !!t.document.getElementById("changePlanConfirmBtn"));
  t.window.close();
}

console.log("switch to Pro: when the change itself fails");
for (const [label, resp, expectText, expectRetry, refresh] of [
  ["payment declined (change not applied)", { status: 422, json: { code: "change_failed" } }, "your plan has not been changed", true, false],
  ["too close to renewal", { status: 409, json: { code: "locked_renewal" } }, "about to renew", true, false],
  ["past due", { status: 409, json: { code: "past_due" } }, "last payment didn't go through", false, false],
  ["provider error (could have gone through)", { status: 502, json: { code: "provider_error" } }, "couldn't confirm", false, true],
  ["network down (could have gone through)", "throw", "couldn't confirm", false, true],
]) {
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.preview = () => PREVIEW_OK;
  t.handlers.change = () => resp;
  t.document.getElementById("changePlanBtn").click();
  await sleep(80);
  const fetchesBefore = t.calls.statusFetches;
  t.document.getElementById("changePlanConfirmBtn").click();
  await sleep(120);
  check(`${label}: message shown`, text(t.document).includes(expectText), text(t.document));
  check(`${label}: retry is ${expectRetry ? "offered" : "not offered"}`, !!t.document.getElementById("changePlanRetryBtn") === expectRetry);
  check(`${label}: the page ${refresh ? "re-reads" : "does not need to re-read"} the real plan`, refresh ? t.calls.statusFetches > fetchesBefore : true);
  check(`${label}: never says "Your plan is now Pro"`, !text(t.document).includes("Your plan is now Pro"));
  t.window.close();
}
{
  // μετά από αβέβαιο σφάλμα, αν ο server τελικά λέει Pro, η σελίδα το δείχνει
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.preview = () => PREVIEW_OK;
  t.handlers.change = (n, api) => { api.setUsage(usageBody({ plan: "pro", upgrade: null, manage: { canManage: true, canChangeToPro: false } })); return { status: 502, json: { code: "provider_error" } }; };
  t.document.getElementById("changePlanBtn").click();
  await sleep(80);
  t.document.getElementById("changePlanConfirmBtn").click();
  await sleep(150);
  check("if the change actually went through, the button is gone after the refresh", !visible(t.document, "changePlanBtn"));
  t.window.close();
}

console.log("Manage subscription: the Paddle portal");
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.portal = () => ({ status: 200, delayMs: 60, json: { url: "https://sandbox-customer-portal.paddle.com/x?token=1", cancelUrl: null, updatePaymentUrl: null } });
  t.document.getElementById("manageSubBtn").click();
  check("the new tab opens IMMEDIATELY on the click, before the request to the server starts (so it is not blocked)", t.calls.opened.length === 1 && t.calls.opened[0].target === "_blank" && t.calls.portal[0].at === 1);
  check("the button is disabled while waiting", t.document.getElementById("manageSubBtn").disabled);
  await sleep(150);
  check("the tab is sent to the portal link", t.popup.location.href === "https://sandbox-customer-portal.paddle.com/x?token=1");
  check("the new tab cannot reach back into the app (opener cleared)", t.popup.opener === null);
  check("the request carries the session token and needs no ids from the browser", t.calls.portal[0].headers["X-Session-Token"] === "tok123" && Object.keys(t.calls.portal[0].body).length === 0);
  check("the button works again", !t.document.getElementById("manageSubBtn").disabled);
  check("no error notice", !visible(t.document, "billingNotice"));
  t.window.close();
}
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.portal = () => ({ status: 503, json: { code: "unavailable" } });
  t.document.getElementById("manageSubBtn").click();
  await sleep(100);
  check("portal error: the empty tab is closed and a notice explains", t.popup.closed === true && visible(t.document, "billingNotice") && t.document.getElementById("billingNoticeText").textContent.includes("couldn't open the billing page"));
  check("the error never navigated anywhere", t.popup.location.href === "" && t.calls.navigated.length === 0);
  t.document.getElementById("billingNoticeDismiss").click();
  check("the notice can be dismissed", !visible(t.document, "billingNotice"));
  check("the button works again after an error", !t.document.getElementById("manageSubBtn").disabled);
  t.window.close();
}
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t.handlers.portal = () => "throw";
  t.document.getElementById("manageSubBtn").click();
  await sleep(100);
  check("network down while opening the portal: notice, tab closed", t.popup.closed === true && visible(t.document, "billingNotice"));
  const t2 = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }) });
  t2.handlers.portal = () => ({ status: 200, json: {} });
  t2.document.getElementById("manageSubBtn").click();
  await sleep(100);
  check("an answer without a link is treated as an error", t2.popup.closed === true && visible(t2.document, "billingNotice") && t2.popup.location.href === "");
  t.window.close(); t2.window.close();
}
{
  const t = await boot({ usage: usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE }), blockPopups: true });
  t.handlers.portal = () => ({ status: 200, json: { url: "https://sandbox-customer-portal.paddle.com/x?token=1" } });
  t.document.getElementById("manageSubBtn").click();
  await sleep(100);
  check("popup blocked by the browser: falls back to opening in the same tab", t.calls.navigated.length === 1 && t.calls.navigated[0] === "https://sandbox-customer-portal.paddle.com/x?token=1");
  t.window.close();
}

console.log("right after a first purchase the new buttons appear");
{
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.handlers.reconcile = (b, n, api) => { api.setUsage(usageBody({ plan: "basic", upgrade: null, manage: SUB_MANAGE })); return { status: 200, json: { status: "applied", plan: "basic" } }; };
  check("before paying there is nothing to manage", !visible(t.document, "manageSubBtn") && !visible(t.document, "changePlanBtn"));
  await openAndPay(t, "basic");
  await sleep(300);
  check("once the plan is confirmed, Manage subscription and Switch to Pro appear", visible(t.document, "manageSubBtn") && visible(t.document, "changePlanBtn"));
  t.window.close();
}

console.log("basic account, server offers only pro");
{
  const offer = { ...OFFER_FREE, currentPlan: "basic", offers: [OFFER_FREE.offers[1]] };
  const { window, document } = await boot({ usage: usageBody({ plan: "basic", upgrade: offer }) });
  document.getElementById("upgradeBtn").click();
  await sleep(60);
  const plans = Array.from(document.querySelectorAll(".upgrade-choose-btn")).map((b) => b.dataset.plan);
  check("only the pro card", plans.join() === "pro");
  window.close();
}

console.log("no offer from the server (pro, live subscription, guest, missing config)");
{
  const { window, document } = await boot({ usage: usageBody({ plan: "pro", upgrade: null }) });
  check("button stays hidden when upgrade is null", !btnVisible(document));
  window.close();
}
{
  const { window, document } = await boot({ usage: usageBody({}), session: false });
  check("button stays hidden with an older backend (no upgrade field)", !btnVisible(document));
  window.close();
}
{
  const { window, document } = await boot({ usage: usageBody({ upgrade: { ...OFFER_FREE, offers: [] } }) });
  check("button stays hidden when the offer list is empty", !btnVisible(document));
  window.close();
}

console.log("Greek interface");
{
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }), lang: "el" });
  check("button text is Greek", t.document.getElementById("upgradeBtn").textContent === "Αναβάθμιση");
  t.document.getElementById("upgradeBtn").click();
  await sleep(80);
  const main = t.document.getElementById("mainPanel");
  check("panel is Greek", main.textContent.includes("Αναβάθμιση πλάνου") && main.textContent.includes("Τρέχον πλάνο: Free") && main.textContent.includes("μηνύματα / μήνα"));
  main.querySelector('.upgrade-choose-btn[data-plan="basic"]').click();
  await sleep(50);
  check("checkout locale is el", t.calls.checkoutOpen[0] && t.calls.checkoutOpen[0].settings.locale === "el");
  t.calls.initialize[0].eventCallback({ name: "checkout.completed" });
  check("pending view is Greek", t.document.getElementById("mainPanel").textContent.includes("Ενεργοποιούμε το πλάνο σου"));
  check("pending banner is Greek", t.document.getElementById("paymentPendingBanner").textContent.includes("Η πληρωμή σου επεξεργάζεται"));
  t.setUsage(usageBody({ plan: "basic", upgrade: null }));
  await sleep(250);
  check("confirmed view is Greek", t.document.getElementById("mainPanel").textContent.includes("Το πλάνο σου είναι τώρα Basic"));
  t.window.close();
}

console.log("Paddle.js fails to start");
{
  const { window, document } = await boot({ usage: usageBody({ upgrade: OFFER_FREE }), paddleInitThrows: true });
  document.getElementById("upgradeBtn").click();
  await sleep(80);
  document.querySelector('.upgrade-choose-btn[data-plan="pro"]').click();
  await sleep(80);
  check("user sees a friendly error, not a crash", document.getElementById("upgradeStatus").textContent.startsWith("Couldn't open the payment window"), document.getElementById("upgradeStatus").textContent);
  window.close();
}

console.log("Paddle.js is injected from the official CDN when not preloaded");
{
  const { window, document } = await boot({ usage: usageBody({ upgrade: OFFER_FREE }), paddle: "none" });
  document.getElementById("upgradeBtn").click();
  await sleep(60);
  const s = document.querySelector('script[src="https://cdn.paddle.com/paddle/v2/paddle.js"]');
  check("script tag points at cdn.paddle.com v2", !!s);
  window.close();
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
