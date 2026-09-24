// Headless έλεγχος της διαδρομής "Αναβάθμιση" από τη σελίδα τιμολόγησης (24 Σεπ 2026):
//   idmon.app (Αναβάθμιση) -> /landing.html?plan=..&period=.. -> εγγραφή/σύνδεση
//   -> /editor.html?checkout=..&period=.. -> ο editor ανοίγει μόνος του το checkout.
// Ελέγχει ΚΑΙ τις τρεις σελίδες με τον ΠΡΑΓΜΑΤΙΚΟ τους κώδικα (jsdom, ψεύτικο fetch και
// Paddle.js), χωρίς browser, δίκτυο ή wrangler.
// Χρήση (PowerShell, από τον φάκελο idmon):
//   node tests/checkout-intent-headless-check.mjs
// Απαιτεί το πακέτο jsdom (npm install jsdom).
import fs from "node:fs";
import { JSDOM } from "jsdom";

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sharedJs = read("public/shared.js");
const landingHtml = read("public/landing.html");
const pricingHtml = read("public/index.html");
const editorHtml = read("public/editor.html");

// ------------------------------------------------------------------ 1. σελίδα τιμολόγησης
console.log("pricing page: Upgrade goes to signup, never to a checkout");
{
  const html = pricingHtml.replace(/<link[^>]*>/g, "").replace('<script src="shared.js"></script>', () => "<script>" + sharedJs + "</script>");
  const navigated = [];
  // Το jsdom δεν αλλάζει σελίδα στο κλικ: σιωπή στο "not implemented", αλλά κρατάμε το πού θα πήγαινε.
  const virtualConsole = new (await import("jsdom")).VirtualConsole();
  const navErrors = [];
  virtualConsole.on("jsdomError", (e) => navErrors.push(String(e && e.message)));
  const dom = new JSDOM(html, {
    virtualConsole,
    runScripts: "dangerously",
    url: "https://idmon.app/",
    beforeParse(window) {
      window.localStorage.setItem("uiLang", "el");
      window.Paddle = { Initialize() { navigated.push("PADDLE"); }, Checkout: { open() { navigated.push("CHECKOUT"); } } };
    },
  });
  await sleep(30);
  const { document } = dom.window;
  const buttons = (plan) => [...document.querySelectorAll('#content-el .checkout-btn[data-plan="' + plan + '"]')];
  check("two upgrade buttons in the Greek block", buttons("basic").length === 1 && buttons("pro").length === 1);
  const src = pricingHtml;
  check("no Paddle.js and no Checkout.open on the page", !src.includes("cdn.paddle.com") && !src.includes("Checkout.open"));
  check("the click target is /landing.html with plan and period", src.includes("'/landing.html?plan=' + plan + '&period=' + billingPeriod"));
  for (const b of [...buttons("basic"), ...buttons("pro")]) b.click();
  check("clicking did not touch Paddle", navigated.length === 0);
  check("each click tried to leave the page (to the signup)", navErrors.filter((m) => m.includes("navigation")).length === 2, JSON.stringify(navErrors));
}

// ------------------------------------------------------------------ 2. landing
const landingBody = landingHtml.match(/<body>([\s\S]*?)<script>window\.__IS_LANDING_PAGE__/)[1];
const landingScript = [...landingHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];

function loadLanding({ search = "", session = null, lang = "el", signupResult = null } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${landingBody}</body></html>`, {
    url: "https://idmon.app/landing.html" + search,
    runScripts: "outside-only",
  });
  const w = dom.window;
  const calls = [];
  w.localStorage.setItem("uiLang", lang);
  if (session) { w.localStorage.setItem("workspaceId", "ws-real"); w.localStorage.setItem("sessionToken", session); }
  w.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url) === "/config/public") return { ok: true, status: 200, json: async () => ({ turnstileSiteKey: "k" }) };
    const r = signupResult || { status: 200, body: { ok: true, workspaceId: "ws-new", sessionToken: "tok-new", emailVerified: false } };
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  // Ψεύτικο Turnstile: κρατάμε τα callbacks ώστε το test να "λύσει" το captcha.
  const turnstileCallbacks = {};
  w.turnstile = { render(sel, opts) { turnstileCallbacks[sel] = opts.callback; return sel; }, reset() {} };
  const nav = [];
  w.eval("window.__IS_LANDING_PAGE__ = true;");
  w.eval(sharedJs);
  w.navigateTo = (u) => nav.push(u);
  w.eval(landingScript);
  w.onTurnstileLoad();
  return { w, doc: w.document, nav, calls, turnstileCallbacks };
}

async function submitSignup(page, email = "new@example.com") {
  await sleep(10); // το /config/public έχει απαντήσει, τα widgets έχουν γίνει render
  page.turnstileCallbacks["#accountTurnstile"]("turnstile-ok");
  page.doc.getElementById("accountEmail").value = email;
  page.doc.getElementById("accountPassword").value = "correct horse battery";
  page.doc.getElementById("accountSubmitBtn").click();
  await sleep(20);
}

console.log("landing: arriving from Upgrade (not logged in)");
{
  const p = loadLanding({ search: "?plan=basic&period=annual" });
  const note = p.doc.getElementById("checkoutIntentNote");
  check("the account form opens directly (no Guest choice)", p.doc.getElementById("accountForm").classList.contains("show") && p.doc.getElementById("choiceGrid").style.display === "none");
  check("the note names the plan and the period", note.style.display === "block" && note.textContent.includes("Basic") && note.textContent.includes("ετήσιο"), note.textContent);
  check("default tab is sign up", p.doc.getElementById("signupTabBtn").classList.contains("active"));
  check("no redirect yet", p.nav.length === 0);
  await submitSignup(p);
  const signup = p.calls.find((c) => c.url === "/account/signup");
  check("signs up through the normal endpoint", !!signup && signup.body.email === "new@example.com");
  check("after signup: straight to the editor with the choice", p.nav.join() === "/editor.html?checkout=basic&period=annual", p.nav.join());
  check("the new session is stored", p.w.localStorage.getItem("sessionToken") === "tok-new" && p.w.localStorage.getItem("workspaceId") === "ws-new");
}
{
  const p = loadLanding({ search: "?plan=pro&period=monthly", lang: "en" });
  p.doc.getElementById("loginTabBtn").click();
  await submitSignup(p);
  check("log in (existing account) also continues to the editor", p.calls.some((c) => c.url === "/account/login") && p.nav.join() === "/editor.html?checkout=pro&period=monthly", p.nav.join());
  check("English note", p.doc.getElementById("checkoutIntentNote").textContent.includes("Pro") && p.doc.getElementById("checkoutIntentNote").textContent.includes("monthly"));
}
{
  const p = loadLanding({ search: "?plan=pro" });
  await submitSignup(p);
  check("missing period means monthly", p.nav.join() === "/editor.html?checkout=pro&period=monthly", p.nav.join());
}
{
  const p = loadLanding({ search: "?plan=basic&period=annual", signupResult: { status: 400, body: { ok: false, error: "Email already registered" } } });
  await submitSignup(p);
  check("failed signup: stays on the page, shows the error, no redirect", p.nav.length === 0 && p.doc.getElementById("accountError").textContent.includes("already"));
}
console.log("landing: already logged in");
{
  const p = loadLanding({ search: "?plan=pro&period=annual", session: "tok-existing" });
  check("goes straight to the editor, no form", p.nav.join() === "/editor.html?checkout=pro&period=annual" && !p.doc.getElementById("accountForm").classList.contains("show"), p.nav.join());
}
console.log("landing: no or bad plan in the link (unchanged behaviour)");
for (const search of ["", "?plan=enterprise&period=annual", "?period=annual", "?plan=BASIC"]) {
  const p = loadLanding({ search });
  const normal = p.doc.getElementById("choiceGrid").style.display !== "none" && !p.doc.getElementById("accountForm").classList.contains("show") && p.doc.getElementById("checkoutIntentNote").style.display === "none";
  p.doc.getElementById("accountBtn").click();
  await submitSignup(p);
  check(`"${search || "(none)"}": normal choice screen, signup goes to /home.html`, normal && p.nav.join() === "/home.html", p.nav.join());
}
{
  const p = loadLanding({ search: "?plan=basic&period=annual", session: null });
  p.doc.getElementById("accountCancelBtn").click();
  check("Cancel forgets the plan: note hidden, choices shown", p.doc.getElementById("checkoutIntentNote").style.display === "none" && p.doc.getElementById("choiceGrid").style.display !== "none");
  p.doc.getElementById("accountBtn").click();
  await submitSignup(p);
  check("after Cancel, signup goes to /home.html (no checkout)", p.nav.join() === "/home.html", p.nav.join());
}

// ------------------------------------------------------------------ 3. editor
const OFFER = (over = {}) => ({
  environment: "sandbox", clientToken: "test_dummy_token", workspaceId: "ws-real", currentPlan: "free",
  offers: [
    { plan: "basic", priceId: "pri_bm", prices: { monthly: "pri_bm", annual: "pri_ba" }, messages: 500, docs: 20 },
    { plan: "pro", priceId: "pri_pm", prices: { monthly: "pri_pm", annual: "pri_pa" }, messages: 2500, docs: null },
  ],
  ...over,
});
const usage = (upgrade, manage = null) => ({ plan: "free", messagesUsed: 0, messagesLimit: 100, messagesLimitReached: false, docsUsed: 0, docsLimit: 5, docsLimitReached: false, upgrade, manage });

async function bootEditor({ search = "", status, lang = "en", local = {}, preview = null }) {
  const html = editorHtml
    .replace(/<link[^>]*>/g, "")
    .replace('<script src="/shared.js"></script>', () => "<script>" + sharedJs + "</script>")
    .replace(/<script src="https?:[^>]*><\/script>/g, "");
  const calls = { checkoutOpen: [], pricePreview: [], statusFetches: 0 };
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://idmon.app/editor.html" + search,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("workspaceId", "ws-real");
      window.localStorage.setItem("sessionToken", "tok123");
      window.localStorage.setItem("uiLang", lang);
      for (const [k, v] of Object.entries(local)) window.localStorage.setItem(k, v);
      window.marked = { parse: (s) => s, use() {}, setOptions() {} };
      window.DOMPurify = { sanitize: (s) => s };
      window.toastui = { Editor: function () {} };
      window.fetch = async (url) => {
        if (String(url).startsWith("/usage/status")) { calls.statusFetches++; return { ok: true, status: 200, json: async () => status }; }
        if (String(url) === "/billing/change-plan/preview" && preview) return { ok: true, status: 200, json: async () => preview };
        return { ok: true, status: 200, json: async () => ({}) };
      };
      window.Paddle = {
        Environment: { set() {} },
        Initialize() {},
        Checkout: { open: (o) => calls.checkoutOpen.push(o) },
        PricePreview: async (req) => {
          calls.pricePreview.push(req);
          return { data: { details: { lineItems: req.items.map((it) => ({ price: { id: it.priceId }, formattedTotals: { total: "€" + it.priceId } })) } } };
        },
      };
    },
  });
  await sleep(120);
  return { w: dom.window, doc: dom.window.document, calls };
}

console.log("editor: arriving with a plan from the pricing page");
{
  const e = await bootEditor({ search: "?checkout=basic&period=annual", status: usage(OFFER()) });
  const open = e.calls.checkoutOpen;
  check("checkout opened once, by itself", open.length === 1, JSON.stringify(open));
  check("with the ANNUAL basic price, quantity 1", open[0] && open[0].items.length === 1 && open[0].items[0].priceId === "pri_ba" && open[0].items[0].quantity === 1);
  check("with the workspace id (so the payment belongs to this account)", open[0] && open[0].customData && open[0].customData.workspace_id === "ws-real");
  check("the choice is removed from the address bar (a reload does not reopen it)", e.w.location.search === "", e.w.location.href);
  check("the upgrade panel is shown on Annual", e.doc.querySelector('.period-toggle [data-period="annual"]')?.getAttribute("aria-pressed") === "true", e.doc.getElementById("mainPanel").innerHTML.slice(0, 300));
}
{
  const e = await bootEditor({ search: "?checkout=pro&period=monthly", status: usage(OFFER()) });
  check("pro monthly: the monthly pro price", e.calls.checkoutOpen.length === 1 && e.calls.checkoutOpen[0].items[0].priceId === "pri_pm");
}
{
  const e = await bootEditor({ search: "?checkout=pro&period=annual", status: usage(OFFER({ offers: [{ plan: "pro", priceId: "pri_pm", prices: { monthly: "pri_pm", annual: null }, messages: 2500, docs: null }] })) });
  check("annual asked but not configured on the server: falls back to monthly, never a wrong id", e.calls.checkoutOpen.length === 1 && e.calls.checkoutOpen[0].items[0].priceId === "pri_pm");
}
{
  // Ο λογαριασμός έχει ήδη συνδρομή: ο server δεν προσφέρει τίποτα
  const e = await bootEditor({ search: "?checkout=basic&period=annual", status: usage(null, { canManage: true, canChangeToPro: true }) });
  check("already subscribed: NO checkout", e.calls.checkoutOpen.length === 0);
  check("already subscribed: a notice explains why", e.doc.getElementById("billingNotice").style.display === "flex" && e.doc.getElementById("billingNoticeText").textContent.length > 20);
}
{
  // Basic λογαριασμός χωρίς συνδρομή ζητάει Basic: ο server προσφέρει μόνο Pro
  const e = await bootEditor({ search: "?checkout=basic&period=monthly", status: usage(OFFER({ currentPlan: "basic", offers: [OFFER().offers[1]] })) });
  check("plan not offered by the server: NO checkout, notice shown", e.calls.checkoutOpen.length === 0 && e.doc.getElementById("billingNotice").style.display === "flex");
}
{
  for (const search of ["?checkout=enterprise&period=annual", "?checkout=pro&period=annual&x=1"]) {
    const e = await bootEditor({ search, status: usage(OFFER()) });
    const bad = search.includes("enterprise");
    check(`"${search}": ${bad ? "unknown plan, nothing opens" : "other query params are kept"}`, bad ? e.calls.checkoutOpen.length === 0 && e.w.location.search === "" : e.calls.checkoutOpen.length === 1 && e.w.location.search === "?x=1", e.w.location.search);
  }
}
{
  const pending = JSON.stringify({ plan: "basic", transactionId: null, workspaceId: "ws-real", at: Date.now() });
  const e = await bootEditor({ search: "?checkout=basic&period=annual", status: usage(OFFER()), local: { idmonPaymentPending: pending } });
  check("a payment is already being processed: NO second checkout", e.calls.checkoutOpen.length === 0);
}
{
  const e = await bootEditor({ search: "", status: usage(OFFER()) });
  check("no choice in the link: nothing opens by itself", e.calls.checkoutOpen.length === 0);
}

console.log("editor: monthly / annual in the upgrade panel");
{
  const e = await bootEditor({ status: usage(OFFER()), lang: "el" });
  e.doc.getElementById("upgradeBtn").click();
  await sleep(40);
  const toggle = e.doc.querySelectorAll(".period-toggle [data-period]");
  check("the panel has a monthly/annual switch, monthly first and selected", toggle.length === 2 && toggle[0].dataset.period === "monthly" && toggle[0].getAttribute("aria-pressed") === "true");
  check("Greek labels", toggle[0].textContent === "Μηνιαία" && toggle[1].textContent === "Ετήσια");
  check("monthly prices are previewed", JSON.stringify(e.calls.pricePreview.at(-1).items.map((i) => i.priceId)) === JSON.stringify(["pri_bm", "pri_pm"]));
  check("monthly label", e.doc.querySelector('[data-price-for="pri_bm"] small')?.textContent.includes("μήνα"));
  toggle[1].click();
  await sleep(40);
  check("after switching: annual prices are previewed", JSON.stringify(e.calls.pricePreview.at(-1).items.map((i) => i.priceId)) === JSON.stringify(["pri_ba", "pri_pa"]));
  check("annual label", e.doc.querySelector('[data-price-for="pri_pa"] small')?.textContent.includes("έτος"));
  check("annual is now selected", e.doc.querySelector('.period-toggle [data-period="annual"]').getAttribute("aria-pressed") === "true");
  e.doc.querySelector('.upgrade-choose-btn[data-plan="pro"]').click();
  await sleep(20);
  check("choosing Pro on Annual opens the ANNUAL pro checkout with the workspace id", e.calls.checkoutOpen.length === 1 && e.calls.checkoutOpen[0].items[0].priceId === "pri_pa" && e.calls.checkoutOpen[0].customData.workspace_id === "ws-real");
}
{
  // Παλιός server (χωρίς "prices"): όπως πριν, μόνο μηνιαίο, χωρίς διακόπτη
  const old = OFFER({ offers: OFFER().offers.map(({ prices, ...o }) => o) });
  const e = await bootEditor({ status: usage(old) });
  e.doc.getElementById("upgradeBtn").click();
  await sleep(40);
  check("no annual prices from the server: no switch, monthly cards as before", !e.doc.querySelector(".period-toggle") && e.doc.querySelectorAll(".upgrade-choose-btn").length === 2);
  e.doc.querySelector('.upgrade-choose-btn[data-plan="basic"]').click();
  await sleep(20);
  check("and the monthly checkout works", e.calls.checkoutOpen.length === 1 && e.calls.checkoutOpen[0].items[0].priceId === "pri_bm");
}

console.log("editor: the account email is prefilled and locked in the checkout");
{
  const e = await bootEditor({ search: "?checkout=basic&period=monthly", status: usage(OFFER({ email: "owner@example.com" })) });
  const o = e.calls.checkoutOpen[0];
  check("the checkout gets the account email", o && o.customer && o.customer.email === "owner@example.com", JSON.stringify(o));
  check("and the email cannot be changed (allowLogout false)", o && o.settings.allowLogout === false);
  check("the workspace id is still sent", o && o.customData.workspace_id === "ws-real");
}
{
  const e = await bootEditor({ status: usage(OFFER({ email: "owner@example.com" })) });
  e.doc.getElementById("upgradeBtn").click();
  await sleep(40);
  e.doc.querySelector('.upgrade-choose-btn[data-plan="pro"]').click();
  await sleep(20);
  const o = e.calls.checkoutOpen[0];
  check("also when choosing from the upgrade panel", o && o.customer && o.customer.email === "owner@example.com" && o.settings.allowLogout === false);
}
{
  const e = await bootEditor({ search: "?checkout=basic&period=monthly", status: usage(OFFER()) });
  const o = e.calls.checkoutOpen[0];
  check("no email from the server: no customer field, email stays editable (as before)", o && !o.customer && o.settings.allowLogout === undefined, JSON.stringify(o));
}

console.log("editor: Switch to Pro keeps the billing period in the text");
for (const [period, word] of [["annual", "year"], ["monthly", "month"], [undefined, "month"]]) {
  const preview = { toPlan: "pro", period, currency: "EUR", chargeToday: "2990", recurring: period === "annual" ? "59000" : "5900", nextBilledAt: "2026-10-19T19:00:00Z" };
  const e = await bootEditor({ status: usage(null, { canManage: true, canChangeToPro: true }), preview });
  e.doc.getElementById("changePlanBtn").click();
  await sleep(30);
  const txt = e.doc.getElementById("changePlanRecurring") && e.doc.getElementById("changePlanRecurring").textContent;
  check(`preview period ${period}: recurring line says "/ ${word}"`, !!txt && txt.includes("/ " + word), txt);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
