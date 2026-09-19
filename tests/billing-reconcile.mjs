// Έλεγχος του Section R (billing): η "συμφωνία" πληρωμής (POST /billing/reconcile)
// ΚΑΙ ότι το webhook συμπεριφέρεται όπως πριν, τώρα που μοιράζονται τον ίδιο
// πυρήνα (applyPaddleSubscription). Τρέχει ΧΩΡΙΣ wrangler dev και ΧΩΡΙΣ πραγματικό
// Paddle: φορτώνει το src/index.js και του δίνει ψεύτικα D1/KV και ψεύτικο Paddle API.
// Χρήση (PowerShell, από τον φάκελο idmon):
//   node tests/billing-reconcile.mjs
// Προαιρετικά: $env:INDEX_PATH = "C:\\...\\index.js"
//              $env:WEBHOOK_ONLY = "1"  (μόνο οι έλεγχοι του webhook)
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

// Το repo έχει package.json με "type": "commonjs", οπότε φορτώνουμε από προσωρινό
// φάκελο με { "type": "module" } (τα αρχικά αρχεία δεν αγγίζονται).
const indexPath = path.resolve(process.env.INDEX_PATH || "./src/index.js");
const srcDir = path.dirname(indexPath);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idmon-test-"));
for (const name of fs.readdirSync(srcDir)) {
  if (name.endsWith(".js")) fs.copyFileSync(path.join(srcDir, name), path.join(tmpDir, name));
}
fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
const worker = (await import(pathToFileURL(path.join(tmpDir, path.basename(indexPath))).href)).default;
process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const WEBHOOK_ONLY = process.env.WEBHOOK_ONLY === "1";

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

// ------------------------------------------------------------------ fixtures
const API_KEY = "pdl_sdbx_apikey_SHOULD_NEVER_LEAK_0123456789";
const WEBHOOK_SECRET = "pdl_ntfset_test_secret";
const WS = "ws-real";
const TOKEN = "tok-real";
const future = new Date(Date.now() + 3600_000).toISOString();
const id26 = (n) => String(n).padStart(26, "0");
const TXN = "txn_" + id26(1);
const SUB = "sub_" + id26(2);
const SUB_OLD = "sub_" + id26(3);

function makeState(userOverrides = {}) {
  return {
    users: [{
      id: 1, workspace_id: WS, plan: "free",
      paddle_customer_id: null, paddle_subscription_id: null, paddle_status: null, paddle_event_at: null,
      ...userOverrides,
    }],
    sessions: {
      [TOKEN]: { user_id: 1, workspace_id: WS, expires_at: future },
      "tok-expired": { user_id: 1, workspace_id: WS, expires_at: new Date(Date.now() - 1000).toISOString() },
      "tok-demo": { user_id: 9, workspace_id: "efood-ops-demo", expires_at: future },
    },
  };
}

function makeEnv(state, vars = {}, { failDb = false } = {}) {
  const pick = (u) => u && ({ id: u.id, plan: u.plan, paddle_subscription_id: u.paddle_subscription_id, paddle_status: u.paddle_status, paddle_event_at: u.paddle_event_at });
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (failDb) throw new Error("D1 is down");
              if (sql.includes("FROM sessions WHERE token")) return state.sessions[args[0]] || null;
              if (sql.includes("FROM users WHERE paddle_subscription_id")) return pick(state.users.find((u) => u.paddle_subscription_id === args[0])) || null;
              if (sql.includes("FROM users WHERE workspace_id")) return pick(state.users.find((u) => u.workspace_id === args[0])) || null;
              throw new Error("Unexpected SQL (first): " + sql);
            },
            async run() {
              if (failDb) throw new Error("D1 is down");
              if (sql.trim().startsWith("UPDATE users")) {
                const [plan, customerId, subId, status, eventAt, id] = args;
                const u = state.users.find((x) => x.id === id);
                u.plan = plan;
                u.paddle_customer_id = customerId == null ? u.paddle_customer_id : customerId;
                u.paddle_subscription_id = subId;
                u.paddle_status = status;
                u.paddle_event_at = eventAt;
                return { success: true };
              }
              throw new Error("Unexpected SQL (run): " + sql);
            },
          };
        },
      };
    },
  };
  const kv = new Map();
  const DOCUMENT_REGISTRY = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, v); },
    async delete(k) { kv.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
  return {
    DB, DOCUMENT_REGISTRY,
    PADDLE_API_KEY: API_KEY, PADDLE_ENV: "sandbox", PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PADDLE_PRICE_BASIC: "pri_basic_test", PADDLE_PRICE_PRO: "pri_pro_test",
    ...vars,
  };
}

// Ψεύτικο Paddle API: αντικαθιστά το global fetch για τη διάρκεια κάθε κλήσης.
function paddleMock() {
  const m = { calls: [], transactions: {}, subscriptions: {}, mode: null };
  m.fetch = async (url, init = {}) => {
    m.calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body });
    if (m.mode === "network") throw new TypeError("fetch failed");
    if (m.mode === "abort") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    const u = new URL(String(url));
    const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let mm = u.pathname.match(/^\/transactions\/(.+)$/);
    if (mm) {
      const r = m.transactions[mm[1]];
      return r ? respond(r.status || 200, r.body) : respond(404, { error: { code: "entity_not_found", detail: "not found" } });
    }
    mm = u.pathname.match(/^\/subscriptions\/(.+)$/);
    if (mm) {
      const r = m.subscriptions[mm[1]];
      return r ? respond(r.status || 200, r.body) : respond(404, { error: { code: "entity_not_found", detail: "not found" } });
    }
    return respond(404, { error: { code: "not_found" } });
  };
  return m;
}

const realFetch = globalThis.fetch;
const txnBody = (over = {}) => ({ data: { id: TXN, status: "completed", customer_id: "ctm_1", subscription_id: SUB, custom_data: { workspace_id: WS }, ...over } });
const subBody = (over = {}) => ({ data: {
  id: SUB, status: "active", customer_id: "ctm_1", custom_data: { workspace_id: WS },
  updated_at: "2026-09-19T19:00:00.000Z", items: [{ price: { id: "pri_basic_test" }, quantity: 1 }], ...over,
} });

async function reconcile(env, mock, body, headers = { "X-Session-Token": TOKEN }, rawBody) {
  globalThis.fetch = mock.fetch;
  try {
    const res = await worker.fetch(new Request("https://app.idmon.app/billing/reconcile", {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: rawBody !== undefined ? rawBody : JSON.stringify(body),
    }), env);
    let json = null;
    try { json = await res.clone().json(); } catch (e) { /* not json */ }
    return { res, json, text: await res.text() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function captureConsole() {
  const logs = [];
  const orig = { error: console.error, warn: console.warn };
  console.error = (...a) => logs.push(a.map(String).join(" "));
  console.warn = (...a) => logs.push(a.map(String).join(" "));
  return { logs, restore() { console.error = orig.error; console.warn = orig.warn; } };
}

if (!WEBHOOK_ONLY) {
  console.log("reconcile: happy path");
  {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody() }; mock.subscriptions[SUB] = { body: subBody() };
    const { res, json } = await reconcile(env, mock, { transactionId: TXN });
    check("status 200 and applied", res.status === 200 && json.status === "applied" && json.plan === "basic", JSON.stringify(json));
    const u = state.users[0];
    check("plan, status, subscription and customer are written", u.plan === "basic" && u.paddle_status === "active" && u.paddle_subscription_id === SUB && u.paddle_customer_id === "ctm_1");
    check("event time is the subscription's updated_at", u.paddle_event_at === "2026-09-19T19:00:00.000Z");
    check("asked Paddle for the transaction, then the subscription", mock.calls.length === 2 && mock.calls[0].url.endsWith("/transactions/" + TXN) && mock.calls[1].url.endsWith("/subscriptions/" + SUB));
    check("uses the sandbox API host", mock.calls[0].url.startsWith("https://sandbox-api.paddle.com/"));
    check("sends the API key as a Bearer token", mock.calls[0].headers.Authorization === "Bearer " + API_KEY);
    check("response never contains the key", !JSON.stringify(json).includes(API_KEY));
  }
  {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody() };
    mock.subscriptions[SUB] = { body: subBody({ items: [{ price: { id: "pri_pro_test" }, quantity: 1 }] }) };
    const { json } = await reconcile(env, mock, { transactionId: TXN });
    check("pro price gives the pro plan", json.status === "applied" && state.users[0].plan === "pro");
  }
  {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody() };
    mock.subscriptions[SUB] = { body: subBody({ custom_data: null }) };
    const { json } = await reconcile(env, mock, { transactionId: TXN });
    check("finds the account from the session even if the subscription has no custom_data", json.status === "applied" && state.users[0].paddle_subscription_id === SUB);
  }
  {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody() }; mock.subscriptions[SUB] = { body: subBody() };
    await reconcile(env, mock, { transactionId: TXN });
    const before = JSON.stringify(state.users[0]);
    const again = await reconcile(env, mock, { transactionId: TXN });
    check("running it twice is harmless", again.json.status === "applied" && JSON.stringify(state.users[0]) === before);
  }

  console.log("reconcile: not ready yet");
  {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody({ subscription_id: null }) };
    const { json } = await reconcile(env, mock, { transactionId: TXN });
    check("no subscription yet: pending, nothing written, subscription not requested", json.status === "pending" && state.users[0].plan === "free" && mock.calls.length === 1);
  }
  for (const st of ["paid", "billed", "ready", "draft"]) {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody({ status: st }) };
    const { json } = await reconcile(env, mock, { transactionId: TXN });
    check(`transaction status "${st}" is pending`, json.status === "pending" && state.users[0].plan === "free");
  }
  for (const st of ["canceled", "past_due"]) {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody({ status: st }) };
    const { json } = await reconcile(env, mock, { transactionId: TXN });
    check(`transaction status "${st}" is not_completed`, json.status === "not_completed" && state.users[0].plan === "free");
  }

  console.log("reconcile: someone else's payment");
  for (const [label, custom] of [["another workspace", { workspace_id: "ws-someone-else" }], ["no custom_data", null], ["custom_data without workspace_id", { foo: 1 }]]) {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody({ custom_data: custom }) }; mock.subscriptions[SUB] = { body: subBody() };
    const { res } = await reconcile(env, mock, { transactionId: TXN });
    check(`${label}: 403, nothing written, subscription never requested`, res.status === 403 && state.users[0].plan === "free" && state.users[0].paddle_subscription_id === null && mock.calls.length === 1);
  }

  console.log("reconcile: who may call it");
  {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    const a = await reconcile(env, mock, { transactionId: TXN }, {});
    check("no session token: 401", a.res.status === 401);
    const b = await reconcile(env, mock, { transactionId: TXN }, { "X-Session-Token": "nope" });
    check("unknown session: 401", b.res.status === 401);
    const c = await reconcile(env, mock, { transactionId: TXN }, { "X-Session-Token": "tok-expired" });
    check("expired session: 401", c.res.status === 401);
    const d = await reconcile(env, mock, { transactionId: TXN }, { "X-Workspace-Id": WS });
    check("guest with only a workspace header: 401", d.res.status === 401);
    const e = await reconcile(env, mock, { transactionId: TXN }, { "X-Session-Token": "tok-demo" });
    check("protected demo workspace: 400", e.res.status === 400);
    check("none of them reached Paddle", mock.calls.length === 0);
  }
  {
    const state = makeState(); state.users = []; const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody() }; mock.subscriptions[SUB] = { body: subBody() };
    const { res } = await reconcile(env, mock, { transactionId: TXN });
    check("valid session but no account row: 404", res.status === 404);
  }

  console.log("reconcile: bad input");
  {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    const bad = ["txn_short", "abc", "sub_" + id26(1), "txn_" + id26(1).toUpperCase().replace(/0/g, "A"), "txn_../../subscriptions", TXN + "x", "", 123, null, { a: 1 }];
    let allRejected = true;
    for (const t of bad) {
      const { res } = await reconcile(env, mock, { transactionId: t });
      if (res.status !== 400) { allRejected = false; console.log("       accepted: " + JSON.stringify(t)); }
    }
    check("malformed transaction ids are rejected with 400", allRejected);
    const missing = await reconcile(env, mock, {});
    check("missing transactionId: 400", missing.res.status === 400);
    const notJson = await reconcile(env, mock, null, { "X-Session-Token": TOKEN }, "not json{");
    check("invalid JSON: 400", notJson.res.status === 400);
    check("none of them reached Paddle", mock.calls.length === 0);
  }

  console.log("reconcile: Paddle problems never leak and never break the page");
  for (const [label, setup, expectStatus] of [
    ["key rejected (401)", (m) => { m.transactions[TXN] = { status: 401, body: { error: { code: "authentication_failed", detail: "Bearer " + API_KEY } } }; }, 503],
    ["missing permission (403)", (m) => { m.transactions[TXN] = { status: 403, body: { error: { code: "forbidden" } } }; }, 503],
    ["transaction not found (404)", () => {}, 404],
    ["Paddle down (500)", (m) => { m.transactions[TXN] = { status: 500, body: { error: { code: "internal_error" } } }; }, 502],
    ["subscription 401", (m) => { m.transactions[TXN] = { body: txnBody() }; m.subscriptions[SUB] = { status: 401, body: { error: { code: "authentication_failed" } } }; }, 503],
    ["network failure", (m) => { m.mode = "network"; }, 502],
    ["timeout", (m) => { m.mode = "abort"; }, 502],
  ]) {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock(); setup(mock);
    const cap = captureConsole();
    const { res, text } = await reconcile(env, mock, { transactionId: TXN });
    cap.restore();
    check(`${label}: ${expectStatus}`, res.status === expectStatus, "got " + res.status);
    check(`${label}: nothing written`, state.users[0].plan === "free" && state.users[0].paddle_subscription_id === null);
    check(`${label}: key not in the response`, !text.includes(API_KEY));
    check(`${label}: key not in the logs`, !cap.logs.join("\n").includes(API_KEY));
  }
  {
    const state = makeState(); const env = makeEnv(state, { PADDLE_API_KEY: undefined }); const mock = paddleMock();
    const { res } = await reconcile(env, mock, { transactionId: TXN });
    check("no API key configured: 503 and Paddle not called", res.status === 503 && mock.calls.length === 0);
  }
  {
    const state = makeState(); const env = makeEnv(state, { PADDLE_ENV: undefined }); const mock = paddleMock();
    const { res } = await reconcile(env, mock, { transactionId: TXN });
    check("PADDLE_ENV missing: 503 and Paddle not called (never guesses the host)", res.status === 503 && mock.calls.length === 0);
  }
  {
    const state = makeState(); const env = makeEnv(state, { PADDLE_ENV: "production" }); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody({ status: "paid" }) };
    await reconcile(env, mock, { transactionId: TXN });
    check("PADDLE_ENV=production uses the live API host", mock.calls[0].url.startsWith("https://api.paddle.com/"));
  }

  console.log("reconcile: races with the webhook");
  {
    // Το webhook έχει ήδη γράψει ΝΕΟΤΕΡΟ γεγονός (π.χ. ακύρωση): η συμφωνία δεν το πατάει.
    const state = makeState({ plan: "free", paddle_subscription_id: SUB, paddle_status: "canceled", paddle_event_at: "2026-09-19T20:00:00.000Z" });
    const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody() }; mock.subscriptions[SUB] = { body: subBody() };
    const before = JSON.stringify(state.users[0]);
    const { json } = await reconcile(env, mock, { transactionId: TXN });
    check("older Paddle data does not overwrite a newer webhook result", json.status === "up_to_date" && JSON.stringify(state.users[0]) === before);
  }
  {
    // Νέα ενεργή συνδρομή παίρνει τη θέση μιας παλιάς ακυρωμένης.
    const state = makeState({ plan: "free", paddle_subscription_id: SUB_OLD, paddle_status: "canceled", paddle_event_at: "2026-09-19T10:00:00.000Z" });
    const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody() }; mock.subscriptions[SUB] = { body: subBody() };
    const { json } = await reconcile(env, mock, { transactionId: TXN });
    check("a new active subscription replaces an old canceled one", json.status === "applied" && state.users[0].paddle_subscription_id === SUB && state.users[0].plan === "basic");
  }
  {
    // Μη ενεργή διαφορετική συνδρομή ΔΕΝ πατάει την τρέχουσα.
    const state = makeState({ plan: "basic", paddle_subscription_id: SUB_OLD, paddle_status: "active", paddle_event_at: "2026-09-19T10:00:00.000Z" });
    const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody() }; mock.subscriptions[SUB] = { body: subBody({ status: "past_due" }) };
    const before = JSON.stringify(state.users[0]);
    const { json } = await reconcile(env, mock, { transactionId: TXN });
    check("a non-active different subscription does not replace the current one", json.status === "up_to_date" && JSON.stringify(state.users[0]) === before);
  }

  console.log("reconcile: rate limit");
  {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.transactions[TXN] = { body: txnBody({ status: "paid" }) };
    let lastOk = 0;
    for (let i = 0; i < 40; i++) { const r = await reconcile(env, mock, { transactionId: TXN }); if (r.res.status === 200) lastOk++; }
    const callsBefore = mock.calls.length;
    const over = await reconcile(env, mock, { transactionId: TXN });
    check("40 calls are allowed (enough for the polling)", lastOk === 40);
    check("the 41st is refused with 429 and never reaches Paddle", over.res.status === 429 && mock.calls.length === callsBefore);
  }
}

// ------------------------------------------------------------ webhook (regression)
console.log("webhook: behaves exactly as before the refactor");
function sign(raw, secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) {
  const h1 = crypto.createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}
async function webhook(env, event, { header, raw } = {}) {
  const body = raw !== undefined ? raw : JSON.stringify(event);
  const res = await worker.fetch(new Request("https://app.idmon.app/paddle/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "Paddle-Signature": header !== undefined ? header : sign(body) }, body,
  }), env);
  let json = null;
  try { json = await res.json(); } catch (e) { /* not json */ }
  return { res, json };
}
const evt = (type, subOver = {}, occurred = "2026-09-19T19:00:00.000Z") => ({
  event_type: type, occurred_at: occurred,
  data: { id: SUB, status: "active", customer_id: "ctm_1", custom_data: { workspace_id: WS }, items: [{ price: { id: "pri_basic_test" } }], ...subOver },
});
{
  const state = makeState(); const env = makeEnv(state);
  const a = await webhook(env, evt("subscription.created"), { header: "" });
  check("no signature: 401", a.res.status === 401);
  const b = await webhook(env, evt("subscription.created"), { header: sign(JSON.stringify(evt("subscription.created")), "wrong-secret") });
  check("wrong signature: 401", b.res.status === 401);
  const c = await webhook(env, evt("subscription.created"), { header: sign(JSON.stringify(evt("subscription.created")), WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 600) });
  check("old timestamp (replay): 401", c.res.status === 401);
  check("nothing was written by any of them", state.users[0].plan === "free" && state.users[0].paddle_subscription_id === null);
}
{
  const state = makeState(); const env = makeEnv(state);
  const r = await webhook(env, evt("subscription.created"));
  check("subscription.created: 200 matched, basic", r.res.status === 200 && r.json.matched === true && r.json.plan === "basic", JSON.stringify(r.json));
  const u = state.users[0];
  check("row is updated (plan, status, subscription, customer, time)", u.plan === "basic" && u.paddle_status === "active" && u.paddle_subscription_id === SUB && u.paddle_customer_id === "ctm_1" && u.paddle_event_at === "2026-09-19T19:00:00.000Z");
  const again = await webhook(env, evt("subscription.created"));
  check("the same event again gives the same result", again.json.matched === true && again.json.plan === "basic");
  const stale = await webhook(env, evt("subscription.updated", { status: "canceled" }, "2026-09-19T18:00:00.000Z"));
  check("an older event is ignored (stale_event)", stale.json.ignored === "stale_event" && state.users[0].plan === "basic");
  const proUp = await webhook(env, evt("subscription.updated", { items: [{ price: { id: "pri_pro_test" } }] }, "2026-09-19T19:30:00.000Z"));
  check("upgrade to pro via subscription.updated", proUp.json.plan === "pro" && state.users[0].plan === "pro");
  const pastDue = await webhook(env, evt("subscription.past_due", { status: "past_due" }, "2026-09-19T20:00:00.000Z"));
  check("past_due keeps the plan but records the status", pastDue.json.plan === "pro" && state.users[0].plan === "pro" && state.users[0].paddle_status === "past_due");
  const canceled = await webhook(env, evt("subscription.canceled", { status: "canceled" }, "2026-09-19T21:00:00.000Z"));
  check("canceled goes back to free", canceled.json.plan === "free" && state.users[0].plan === "free" && state.users[0].paddle_status === "canceled");
}
{
  const state = makeState(); const env = makeEnv(state);
  const unknown = await webhook(env, evt("subscription.created", { custom_data: { workspace_id: "ws-nobody" } }));
  check("unknown workspace: 200 matched:false", unknown.res.status === 200 && unknown.json.matched === false);
  const noCustom = await webhook(env, evt("subscription.created", { custom_data: null }));
  check("no custom_data and unknown subscription: matched:false", noCustom.json.matched === false);
  const notSub = await webhook(env, { event_type: "transaction.completed", occurred_at: "2026-09-19T19:00:00.000Z", data: { id: "txn_x" } });
  check("non-subscription event is ignored with 200", notSub.res.status === 200 && notSub.json.ignored === "event_type");
  const malformed = await webhook(env, { event_type: "subscription.created", occurred_at: "not a date", data: { id: SUB } });
  check("malformed event is ignored with 200", malformed.res.status === 200 && malformed.json.ignored === "malformed_event");
  const badJson = await webhook(env, null, { raw: "not json{" });
  check("invalid JSON (with a valid signature): 400", badJson.res.status === 400);
}
{
  const state = makeState({ plan: "basic", paddle_subscription_id: SUB_OLD, paddle_status: "active", paddle_event_at: "2026-09-19T10:00:00.000Z" });
  const env = makeEnv(state);
  const other = await webhook(env, evt("subscription.canceled", { status: "canceled" }, "2026-09-19T19:00:00.000Z"));
  check("a late event of ANOTHER subscription does not break the current one", other.json.ignored === "other_subscription" && state.users[0].plan === "basic" && state.users[0].paddle_subscription_id === SUB_OLD);
  const takeover = await webhook(env, evt("subscription.created", {}, "2026-09-19T19:10:00.000Z"));
  check("a new ACTIVE subscription takes over", takeover.json.matched === true && state.users[0].paddle_subscription_id === SUB);
}
{
  const state = makeState(); const env = makeEnv(state, {}, { failDb: true });
  const cap = captureConsole();
  const r = await webhook(env, evt("subscription.created"));
  cap.restore();
  check("database failure: 500 so Paddle retries", r.res.status === 500);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
