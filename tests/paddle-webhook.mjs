// Integration test: Paddle webhook (Section R), πραγματικά υπογεγραμμένα
// μηνύματα προς ένα τρεχούμενο `npx wrangler dev`.
//
// Προαπαιτούμενα:
//   1. .dev.vars να περιέχει:  PADDLE_WEBHOOK_SECRET=test_secret_local
//      (οποιαδήποτε τιμή -- πρέπει απλά να είναι ίδια με το env var παρακάτω)
//   2. σε άλλο terminal:       npx wrangler dev
//   3. σε αυτό το terminal (PowerShell):
//        $env:PADDLE_WEBHOOK_SECRET = "test_secret_local"
//        node tests/paddle-webhook.mjs
//
// Το test φτιάχνει έναν προσωρινό λογαριασμό (τυχαίο email), περνάει όλη τη
// ζωή μιας συνδρομής (created -> upgrade -> past_due -> canceled) και
// ελέγχει κάθε φορά το plan μέσω του πραγματικού GET /usage/status. Στο
// τέλος διαγράφει τον λογαριασμό. Σημείωση: το signup έχει rate limit 5
// ανά 15 λεπτά ανά IP, οπότε μην το τρέξεις πάνω από 5 φορές σε 15 λεπτά.
import { createHmac, randomBytes } from "node:crypto";

const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const PRICE_BASIC = process.env.PADDLE_PRICE_BASIC || "pri_01m2ynemr2t4dnes8rz775p090";
const PRICE_PRO = process.env.PADDLE_PRICE_PRO || "pri_01m2ynen6sh5949wn1pnsr1s51";

if (!SECRET) {
  console.error('Λείπει το PADDLE_WEBHOOK_SECRET (βλ. οδηγίες στην κορυφή του αρχείου).');
  process.exit(2);
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

function signHeader(body, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

async function sendWebhook(payload, opts = {}) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (opts.unsigned !== true) headers["Paddle-Signature"] = signHeader(body, opts);
  const res = await fetch(`${BASE_URL}/paddle/webhook`, { method: "POST", headers, body });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const base = Date.now();
const at = (n) => new Date(base + n * 1000).toISOString();
function event(type, subscription, n) {
  return { event_id: `evt_test${n}`, event_type: type, occurred_at: at(n), notification_id: `ntf_test${n}`, data: subscription };
}

const email = `paddle-test-${randomBytes(6).toString("hex")}@example.com`;
const password = "TestPassw0rd!" + randomBytes(4).toString("hex");
const subId = "sub_test" + randomBytes(6).toString("hex");
let sessionToken = null, workspaceId = null;

async function planNow() {
  const res = await fetch(`${BASE_URL}/usage/status`, { headers: { "X-Session-Token": sessionToken } });
  return (await res.json()).plan;
}

try {
  console.log("\n[setup] προσωρινός λογαριασμός");
  const signup = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, lang: "en" }),
  });
  const signupBody = await signup.json();
  check("signup ok", signup.status === 200 && !!signupBody.sessionToken, JSON.stringify(signupBody));
  sessionToken = signupBody.sessionToken; workspaceId = signupBody.workspaceId;
  if (!sessionToken) throw new Error("signup failed, cannot continue");
  check("νέος λογαριασμός ξεκινά ως free", (await planNow()) === "free");

  console.log("\n[υπογραφή]");
  const sample = event("subscription.created", { id: subId, status: "active", customer_id: "ctm_test", custom_data: { workspace_id: workspaceId }, items: [{ price: { id: PRICE_BASIC } }] }, 1);
  let r = await sendWebhook(sample, { unsigned: true });
  check("χωρίς υπογραφή -> 401", r.status === 401);
  r = await sendWebhook(sample, { secret: "λάθος_secret" });
  check("λάθος secret -> 401", r.status === 401);
  r = await sendWebhook(sample, { ts: Math.floor(Date.now() / 1000) - 60 });
  check("παλιό timestamp (replay) -> 401", r.status === 401);
  check("τίποτα δεν άλλαξε μετά τις απορρίψεις", (await planNow()) === "free");

  console.log("\n[ζωή συνδρομής]");
  r = await sendWebhook(sample);
  check("created (Basic) -> 200", r.status === 200 && r.body.matched === true, JSON.stringify(r));
  check("plan = basic", (await planNow()) === "basic");

  r = await sendWebhook(sample);
  check("διπλό μήνυμα -> 200, ίδιο αποτέλεσμα", r.status === 200 && (await planNow()) === "basic");

  const later = (status, price, n, extra = {}) => event("subscription.updated", { id: subId, status, customer_id: "ctm_test", items: [{ price: { id: price } }], ...extra }, n);
  r = await sendWebhook(later("active", PRICE_PRO, 3));
  check("upgrade -> plan pro", r.status === 200 && (await planNow()) === "pro");

  r = await sendWebhook(later("active", PRICE_BASIC, 2));
  check("παλαιότερο γεγονός αγνοείται", r.body.ignored === "stale_event" && (await planNow()) === "pro");

  r = await sendWebhook(later("past_due", PRICE_PRO, 4));
  check("past_due -> το plan μένει pro", (await planNow()) === "pro");

  r = await sendWebhook(later("active", PRICE_PRO, 5, { scheduled_change: { action: "cancel", effective_at: at(3600) } }));
  check("προγραμματισμένη ακύρωση -> το plan μένει pro", (await planNow()) === "pro");

  r = await sendWebhook(event("subscription.canceled", { id: subId, status: "canceled", customer_id: "ctm_test" }, 6));
  check("canceled -> free", r.status === 200 && (await planNow()) === "free");

  r = await sendWebhook(event("transaction.completed", { id: "txn_test" }, 7));
  check("γεγονός που δεν μας αφορά -> 200", r.status === 200);
} finally {
  if (sessionToken) {
    const del = await fetch(`${BASE_URL}/account/delete`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
      body: JSON.stringify({ password }),
    });
    check("cleanup: ο προσωρινός λογαριασμός διαγράφηκε", del.status === 200);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
