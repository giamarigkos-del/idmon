// Headless έλεγχος του κουμπιού "Αναβάθμιση" στο editor.html (Section R), με
// jsdom και ψεύτικο Paddle.js -- χωρίς browser, χωρίς δίκτυο, χωρίς wrangler.
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

// Χτίζει τη σελίδα: το shared.js μπαίνει inline, τα εξωτερικά scripts/CSS
// (CDN) αφαιρούνται και τα ελάχιστα globals που περιμένει ο editor ορίζονται
// ως stubs -- δεν τα χρειάζεται καμία λειτουργία του κουμπιού.
async function boot({ usage, lang = "en", session = true, paddle = "mock", paddleInitThrows = false }) {
  let html = editorHtml
    .replace(/<link[^>]*>/g, "")
    .replace('<script src="/shared.js"></script>', () => "<script>" + sharedJs + "</script>")
    .replace(/<script src="https?:[^>]*><\/script>/g, "");

  const calls = { initialize: [], environment: [], checkoutOpen: [], pricePreview: [], statusFetches: 0 };
  let currentUsage = usage;

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://app.idmon.app/editor.html",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("workspaceId", "ws-real");
      if (session) window.localStorage.setItem("sessionToken", "tok123");
      window.localStorage.setItem("uiLang", lang);
      window.marked = { parse: (s) => s, use() {}, setOptions() {} };
      window.DOMPurify = { sanitize: (s) => s };
      window.toastui = { Editor: function () {} };
      window.fetch = async (url) => {
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
  return { dom, window: dom.window, document: dom.window.document, calls, setUsage: (u) => { currentUsage = u; } };
}

const btnVisible = (doc) => doc.getElementById("upgradeBtn").style.display !== "none";

console.log("free account, server offers basic and pro");
{
  const { window, document, calls } = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  check("button is visible", btnVisible(document));
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

console.log("after a completed checkout the button disappears once the server confirms");
{
  const t = await boot({ usage: usageBody({ upgrade: OFFER_FREE }) });
  t.document.getElementById("upgradeBtn").click();
  await sleep(80);
  t.calls.initialize[0].eventCallback({ name: "checkout.completed" });
  check("processing message is shown", t.document.getElementById("upgradeStatus").textContent.startsWith("Payment received"));
  // Ο server "βλέπει" πλέον την ενεργή συνδρομή (το webhook τελείωσε).
  t.setUsage(usageBody({ plan: "pro", messagesLimit: 2500, upgrade: null }));
  await sleep(3400);
  check("success message names the new plan", t.document.getElementById("upgradeStatus").textContent === "All set. Your plan is now Pro.", t.document.getElementById("upgradeStatus").textContent);
  check("button is hidden again", !btnVisible(t.document));
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
  const { window, document, calls } = await boot({ usage: usageBody({ upgrade: OFFER_FREE }), lang: "el" });
  check("button text is Greek", document.getElementById("upgradeBtn").textContent === "Αναβάθμιση");
  document.getElementById("upgradeBtn").click();
  await sleep(80);
  const main = document.getElementById("mainPanel");
  check("panel is Greek", main.textContent.includes("Αναβάθμιση πλάνου") && main.textContent.includes("Τρέχον πλάνο: Free") && main.textContent.includes("μηνύματα / μήνα"));
  main.querySelector('.upgrade-choose-btn[data-plan="basic"]').click();
  await sleep(50);
  check("checkout locale is el", calls.checkoutOpen[0] && calls.checkoutOpen[0].settings.locale === "el");
  window.close();
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
