// Έλεγχος της αλλαγής Basic -> Pro (preview και πραγματική αλλαγή) και του portal του Paddle
// (Section R). Τρέχει ΧΩΡΙΣ wrangler dev και ΧΩΡΙΣ πραγματικό Paddle: φορτώνει το src/index.js
// και του δίνει ψεύτικα D1/KV και ψεύτικο Paddle API.
// Χρήση (PowerShell, από τον φάκελο idmon):
//   node tests/billing-plan-change.mjs
// Προαιρετικά: $env:INDEX_PATH = "C:\\...\\index.js"
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Το repo έχει package.json με "type": "commonjs": φορτώνουμε από προσωρινό φάκελο ESM.
const indexPath = path.resolve(process.env.INDEX_PATH || "./src/index.js");
const srcDir = path.dirname(indexPath);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idmon-test-"));
for (const name of fs.readdirSync(srcDir)) {
  if (name.endsWith(".js")) fs.copyFileSync(path.join(srcDir, name), path.join(tmpDir, name));
}
fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
// Από τις 22 Σεπ το src/index.js φορτώνει το Argon2id με στατικά imports .wasm,
// που το Node δεν ξέρει να φορτώσει (τα υποστηρίζει μόνο ο Cloudflare runtime).
// Αυτό το test δεν κάνει ποτέ hashing, οπότε στο ΠΡΟΣΩΡΙΝΟ αντίγραφο τα imports
// αντικαθίστανται με stubs που πετάνε σφάλμα αν κληθούν. Το αρχικό αρχείο δεν αλλάζει.
{
  const tmpIndex = path.join(tmpDir, path.basename(indexPath));
  const patched = fs.readFileSync(tmpIndex, "utf8")
    .replace(/^import \{ argon2id, argon2Verify, setWASMModules \} from "argon2-wasm-edge";\r?$/m,
      'const argon2id = async () => { throw new Error("argon2 is not available in this test"); }; const argon2Verify = argon2id; const setWASMModules = () => {};')
    .replace(/^import (argon2WASM|blake2bWASM) from "argon2-wasm-edge\/wasm\/[a-z0-9]+\.wasm";\r?$/gm, "const $1 = null;");
  fs.writeFileSync(tmpIndex, patched);
}
const worker = (await import(pathToFileURL(path.join(tmpDir, path.basename(indexPath))).href)).default;
process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

// ------------------------------------------------------------------ fixtures
const API_KEY = "pdl_sdbx_apikey_SHOULD_NEVER_LEAK_0123456789";
const WS = "ws-real";
const TOKEN = "tok-real";
const future = new Date(Date.now() + 3600_000).toISOString();
const id26 = (n) => String(n).padStart(26, "0");
const SUB = "sub_" + id26(2);
const CUSTOMER = "ctm_" + id26(4);
const PRO = "pri_pro_test";

function makeState(userOverrides = {}) {
  return {
    users: [{
      id: 1, workspace_id: WS, plan: "basic",
      paddle_customer_id: CUSTOMER, paddle_subscription_id: SUB, paddle_status: "active",
      paddle_event_at: "2026-09-19T19:00:00.000Z",
      ...userOverrides,
    }],
    customers: [],
    subscriptions: [],
    // Ο καθρέφτης που γράφει το webhook: subscription id -> τωρινό price id.
    // Προεπιλογή: Basic ΜΗΝΙΑΙΟ. Κενό αντικείμενο = η συνδρομή δεν είναι στον καθρέφτη.
    mirroredPrices: { [SUB]: "pri_basic_test" },
    sessions: {
      [TOKEN]: { user_id: 1, workspace_id: WS, expires_at: future },
      "tok-expired": { user_id: 1, workspace_id: WS, expires_at: new Date(Date.now() - 1000).toISOString() },
      "tok-demo": { user_id: 9, workspace_id: "efood-ops-demo", expires_at: future },
    },
  };
}

function makeEnv(state, vars = {}) {
  const row = (u) => u && ({ plan: u.plan, paddle_customer_id: u.paddle_customer_id, paddle_subscription_id: u.paddle_subscription_id, paddle_status: u.paddle_status });
  const pick = (u) => u && ({ id: u.id, plan: u.plan, paddle_subscription_id: u.paddle_subscription_id, paddle_status: u.paddle_status, paddle_event_at: u.paddle_event_at });
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("FROM sessions WHERE token")) return state.sessions[args[0]] || null;
              if (sql.includes("FROM subscriptions s") && sql.includes("LEFT JOIN customers")) return null;
              if (sql.includes("SELECT price_id FROM subscriptions WHERE subscription_id")) {
                const priceId = state.mirroredPrices[args[0]];
                return priceId ? { price_id: priceId } : null;
              }
              if (sql.includes("SELECT plan, paddle_customer_id, paddle_subscription_id, paddle_status FROM users")) return row(state.users.find((u) => u.workspace_id === args[0])) || null;
              if (sql.includes("FROM users WHERE paddle_subscription_id")) return pick(state.users.find((u) => u.paddle_subscription_id === args[0])) || null;
              if (sql.includes("FROM users WHERE workspace_id")) return pick(state.users.find((u) => u.workspace_id === args[0])) || null;
              throw new Error("Unexpected SQL (first): " + sql);
            },
            async run() {
              if (sql.trim().startsWith("UPDATE users")) {
                const [plan, customerId, subId, status, eventAt, id] = args;
                const u = state.users.find((x) => x.id === id);
                u.plan = plan;
                u.paddle_customer_id = customerId == null ? u.paddle_customer_id : customerId;
                u.paddle_subscription_id = subId; u.paddle_status = status; u.paddle_event_at = eventAt;
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
    PADDLE_API_KEY: API_KEY, PADDLE_ENV: "sandbox",
    PADDLE_PRICE_BASIC: "pri_basic_test", PADDLE_PRICE_PRO: PRO,
    ...vars,
  };
}

// Ψεύτικο Paddle API με πίνακα διαδρομών "METHOD /path" -> { status, body }.
function paddleMock() {
  const m = { calls: [], routes: {}, mode: null };
  m.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(String(url));
    m.calls.push({ url: String(url), method, path: u.pathname, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (m.mode === "network") throw new TypeError("fetch failed");
    if (m.mode === "abort") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    const r = m.routes[`${method} ${u.pathname}`];
    if (!r) return new Response(JSON.stringify({ error: { code: "entity_not_found" } }), { status: 404 });
    if (r.onCall) r.onCall(); // προσομοιώνει κάτι που συμβαίνει ΜΕΣΑ στην κλήση (π.χ. έρχεται το webhook)
    return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { "Content-Type": "application/json" } });
  };
  return m;
}

const realFetch = globalThis.fetch;
async function call(env, mock, pathName, body, headers = { "X-Session-Token": TOKEN }, rawBody) {
  globalThis.fetch = mock.fetch;
  try {
    const res = await worker.fetch(new Request("https://idmon.app" + pathName, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: rawBody !== undefined ? rawBody : JSON.stringify(body),
    }), env);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { res, json, text };
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

const previewBody = (over = {}) => ({ data: {
  status: "active", currency_code: "EUR", next_billed_at: "2026-10-19T19:00:00Z",
  immediate_transaction: { details: { totals: { grand_total: "2990", balance: "2990", total: "2990", currency_code: "EUR" } } },
  recurring_transaction_details: { totals: { total: "5900", currency_code: "EUR" } },
  update_summary: { charge: { amount: "2412", currency_code: "EUR" }, credit: { amount: "0", currency_code: "EUR" }, result: { action: "charge", amount: "2412", currency_code: "EUR" } },
  ...over,
} });
const changedSub = (over = {}) => ({ data: {
  id: SUB, status: "active", customer_id: CUSTOMER, custom_data: { workspace_id: WS },
  updated_at: "2026-09-19T20:00:00.000Z", items: [{ price: { id: PRO }, quantity: 1 }], ...over,
} });
const portalBody = (over = {}) => ({ data: { id: "cpls_" + id26(9), customer_id: CUSTOMER, urls: {
  general: { overview: "https://sandbox-customer-portal.paddle.com/cpl_x?action=overview&token=pga_abc" },
  subscriptions: [{ id: SUB,
    cancel_subscription: "https://sandbox-customer-portal.paddle.com/cpl_x?action=cancel_subscription&subscription_id=" + SUB + "&token=pga_abc",
    update_subscription_payment_method: "https://sandbox-customer-portal.paddle.com/cpl_x?action=update_subscription_payment_method&subscription_id=" + SUB + "&token=pga_abc" }],
}, ...over } });

const PREVIEW = "/billing/change-plan/preview";
const CHANGE = "/billing/change-plan";
const PORTAL = "/billing/portal";
const PATCH_PREVIEW = `PATCH /subscriptions/${SUB}/preview`;
const PATCH_SUB = `PATCH /subscriptions/${SUB}`;

console.log("preview: what the customer will be charged");
{
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_PREVIEW] = { body: previewBody() };
  const before = JSON.stringify(state.users[0]);
  const { res, json } = await call(env, mock, PREVIEW, { plan: "pro" });
  check("200 with the amounts", res.status === 200 && json.toPlan === "pro" && json.currency === "EUR" && json.chargeToday === "2990" && json.recurring === "5900" && json.nextBilledAt === "2026-10-19T19:00:00Z", JSON.stringify(json));
  check("one call to Paddle, the preview endpoint", mock.calls.length === 1 && mock.calls[0].method === "PATCH" && mock.calls[0].path === `/subscriptions/${SUB}/preview`);
  check("asks for the PRO price, quantity 1, prorated immediately", JSON.stringify(mock.calls[0].body) === JSON.stringify({ items: [{ price_id: PRO, quantity: 1 }], proration_billing_mode: "prorated_immediately" }), JSON.stringify(mock.calls[0].body));
  check("uses the sandbox host and the Bearer key", mock.calls[0].url.startsWith("https://sandbox-api.paddle.com/") && mock.calls[0].headers.Authorization === "Bearer " + API_KEY);
  check("nothing is written (a preview never changes anything)", JSON.stringify(state.users[0]) === before);
  check("the key is not in the response", !JSON.stringify(json).includes(API_KEY));
}
{
  // ο browser δεν μπορεί να διαλέξει subscription, price ή πλάνο
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_PREVIEW] = { body: previewBody() };
  await call(env, mock, PREVIEW, { plan: "pro", subscriptionId: "sub_" + id26(77), priceId: "pri_evil", price_id: "pri_evil", items: [{ price_id: "pri_evil" }] });
  check("client-supplied subscription and price ids are ignored", mock.calls[0].path === `/subscriptions/${SUB}/preview` && mock.calls[0].body.items[0].price_id === PRO);
}
{
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_PREVIEW] = { body: previewBody({ immediate_transaction: { details: { totals: { grand_total: "2990", currency_code: "EUR" } } } }) };
  const { json } = await call(env, mock, PREVIEW, { plan: "pro" });
  check("falls back to balance/total if grand_total is missing", json.chargeToday === "2990");
}
for (const [label, over] of [
  ["no immediate transaction", { immediate_transaction: null }],
  ["amount is not an integer string", { immediate_transaction: { details: { totals: { grand_total: "29.90", balance: "x", total: 2990, currency_code: "EUR" } } } }],
  ["no recurring total", { recurring_transaction_details: null }],
  ["no currency anywhere", { currency_code: null, immediate_transaction: { details: { totals: { grand_total: "2990" } } }, recurring_transaction_details: { totals: { total: "5900" } } }],
]) {
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_PREVIEW] = { body: previewBody(over) };
  const cap = captureConsole();
  const { res, json } = await call(env, mock, PREVIEW, { plan: "pro" });
  cap.restore();
  check(`unexpected Paddle answer (${label}): 502, no amounts shown`, res.status === 502 && json.code === "provider_error" && json.chargeToday === undefined);
}

console.log("preview and change: who may do it");
for (const [pathName, label] of [[PREVIEW, "preview"], [CHANGE, "change"]]) {
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  const a = await call(env, mock, pathName, { plan: "pro" }, {});
  const b = await call(env, mock, pathName, { plan: "pro" }, { "X-Session-Token": "nope" });
  const c = await call(env, mock, pathName, { plan: "pro" }, { "X-Session-Token": "tok-expired" });
  const d = await call(env, mock, pathName, { plan: "pro" }, { "X-Workspace-Id": WS });
  const e = await call(env, mock, pathName, { plan: "pro" }, { "X-Session-Token": "tok-demo" });
  check(`${label}: no/unknown/expired session and guest header are 401`, [a, b, c, d].every((r) => r.res.status === 401));
  check(`${label}: protected demo workspace is 400`, e.res.status === 400);
  check(`${label}: none of them reached Paddle`, mock.calls.length === 0);
}
for (const [pathName, label] of [[PREVIEW, "preview"], [CHANGE, "change"]]) {
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  let ok = true;
  for (const b of [{}, { plan: "basic" }, { plan: "enterprise" }, { plan: "PRO" }, { plan: null }, { plan: ["pro"] }]) {
    const r = await call(env, mock, pathName, b);
    if (r.res.status !== 400 || r.json.code !== "unsupported_plan") ok = false;
  }
  const bad = await call(env, mock, pathName, null, { "X-Session-Token": TOKEN }, "not json{");
  check(`${label}: only plan "pro" is accepted (everything else is 400)`, ok && bad.res.status === 400 && mock.calls.length === 0);
}

console.log("preview and change: who is eligible");
for (const [label, over, code] of [
  ["free account", { plan: "free", paddle_status: "canceled" }, "not_eligible"],
  ["already pro (preview)", { plan: "pro" }, "not_eligible"],
  ["basic without a subscription", { paddle_subscription_id: null, paddle_status: null }, "not_eligible"],
  ["basic with a canceled subscription", { paddle_status: "canceled" }, "not_eligible"],
  ["basic with a paused subscription", { paddle_status: "paused" }, "not_eligible"],
  ["basic with a trialing subscription", { paddle_status: "trialing" }, "not_eligible"],
  ["basic whose payment failed (past_due)", { paddle_status: "past_due" }, "past_due"],
  ["malformed subscription id in the database", { paddle_subscription_id: "sub_../../x" }, "not_eligible"],
]) {
  const state = makeState(over); const env = makeEnv(state); const mock = paddleMock();
  const p = await call(env, mock, PREVIEW, { plan: "pro" });
  const c = await call(env, mock, over.plan === "pro" ? PREVIEW : CHANGE, { plan: "pro" });
  check(`${label}: 409 ${code}, Paddle not called`, p.res.status === 409 && p.json.code === code && (over.plan === "pro" || (c.res.status === 409 && c.json.code === code)) && mock.calls.length === 0, JSON.stringify([p.json, c.json]));
}
{
  const state = makeState(); const env = makeEnv(state, { PADDLE_PRICE_PRO: undefined }); const mock = paddleMock();
  const { res, json } = await call(env, mock, PREVIEW, { plan: "pro" });
  check("no pro price configured: 503 unavailable", res.status === 503 && json.code === "unavailable" && mock.calls.length === 0);
  const env2 = makeEnv(makeState(), { PADDLE_API_KEY: undefined });
  const r2 = await call(env2, mock, PREVIEW, { plan: "pro" });
  check("no API key: 503 unavailable", r2.res.status === 503 && mock.calls.length === 0);
}

console.log("change: the real change");
{
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_SUB] = { body: changedSub() };
  const { res, json } = await call(env, mock, CHANGE, { plan: "pro" });
  check("200 applied, plan pro", res.status === 200 && json.status === "applied" && json.plan === "pro", JSON.stringify(json));
  check("the database says pro, active, same subscription", state.users[0].plan === "pro" && state.users[0].paddle_status === "active" && state.users[0].paddle_subscription_id === SUB);
  check("event time comes from the subscription", state.users[0].paddle_event_at === "2026-09-19T20:00:00.000Z");
  check("one PATCH to the subscription (no new checkout, no second subscription)", mock.calls.length === 1 && mock.calls[0].method === "PATCH" && mock.calls[0].path === `/subscriptions/${SUB}`);
  check("body: pro price, prorated immediately, payment failure PREVENTS the change", JSON.stringify(mock.calls[0].body) === JSON.stringify({ items: [{ price_id: PRO, quantity: 1 }], proration_billing_mode: "prorated_immediately", on_payment_failure: "prevent_change" }), JSON.stringify(mock.calls[0].body));
  const again = await call(env, mock, CHANGE, { plan: "pro" });
  check("a second click does not charge again (idempotent)", again.res.status === 200 && again.json.plan === "pro" && mock.calls.length === 1);
}
{
  // Το webhook του Paddle φτάνει ΜΕΣΑ στην κλήση και γράφει ΝΕΟΤΕΡΟ γεγονός (pro). Η απάντηση της
  // αλλαγής βγαίνει "παλιότερη" και δεν το πατάει, αλλά ο πελάτης βλέπει σωστά Pro από τη βάση.
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_SUB] = { body: changedSub({ updated_at: "2026-09-19T19:30:00.000Z" }), onCall: () => {
    state.users[0].plan = "pro"; state.users[0].paddle_event_at = "2026-09-19T21:00:00.000Z";
  } };
  const { res, json } = await call(env, mock, CHANGE, { plan: "pro" });
  check("webhook wins the race: still 200 applied, plan pro, newer webhook time kept", res.status === 200 && json.plan === "pro" && state.users[0].plan === "pro" && state.users[0].paddle_event_at === "2026-09-19T21:00:00.000Z", JSON.stringify(json));
}
{
  // Το Paddle απαντά 200 αλλά η συνδρομή ΔΕΝ έχει το pro price: δεν λέμε ποτέ "έγινε"
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_SUB] = { body: changedSub({ items: [{ price: { id: "pri_basic_test" }, quantity: 1 }] }) };
  const cap = captureConsole();
  const { res, json } = await call(env, mock, CHANGE, { plan: "pro" });
  cap.restore();
  check("Paddle says OK but the subscription is not Pro: 502, plan stays basic", res.status === 502 && json.code === "provider_error" && state.users[0].plan === "basic");
}
{
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_SUB] = { body: { data: null } };
  const cap = captureConsole();
  const { res } = await call(env, mock, CHANGE, { plan: "pro" });
  cap.restore();
  check("empty answer from Paddle: 502, nothing written", res.status === 502 && state.users[0].plan === "basic");
}

console.log("Paddle refuses or fails (preview and change)");
const errorCases = [
  ["too close to renewal (409)", { status: 409, body: { error: { code: "subscription_locked_renewal" } } }, 409, "locked_renewal"],
  ["pending scheduled change", { status: 400, body: { error: { code: "subscription_locked_pending_changes" } } }, 409, "pending_changes"],
  ["past due at Paddle", { status: 400, body: { error: { code: "subscription_update_when_past_due" } } }, 409, "past_due"],
  ["payment declined (change not applied)", { status: 400, body: { error: { code: "subscription_payment_declined" } } }, 422, "change_failed"],
  ["some other 4xx", { status: 422, body: { error: { code: "invalid_field" } } }, 422, "change_failed"],
  ["key rejected (401)", { status: 401, body: { error: { code: "authentication_failed", detail: "Bearer " + API_KEY } } }, 503, "unavailable"],
  ["missing permission (403)", { status: 403, body: { error: { code: "forbidden" } } }, 503, "unavailable"],
  ["subscription not found (404)", { status: 404, body: { error: { code: "entity_not_found" } } }, 404, "not_found"],
  ["Paddle rate limit (429)", { status: 429, body: { error: { code: "too_many_requests" } } }, 502, "provider_error"],
  ["Paddle down (500)", { status: 500, body: { error: { code: "internal_error" } } }, 502, "provider_error"],
];
for (const [label, route, expectStatus, expectCode] of errorCases) {
  for (const [pathName, key, name] of [[PREVIEW, PATCH_PREVIEW, "preview"], [CHANGE, PATCH_SUB, "change"]]) {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
    mock.routes[key] = route;
    const cap = captureConsole();
    const { res, json, text } = await call(env, mock, pathName, { plan: "pro" });
    cap.restore();
    check(`${name}: ${label} -> ${expectStatus} ${expectCode}`, res.status === expectStatus && json.code === expectCode, `${res.status} ${JSON.stringify(json)}`);
    if (name === "change") check(`change: ${label}: plan unchanged, key not leaked`, state.users[0].plan === "basic" && !text.includes(API_KEY) && !cap.logs.join("\n").includes(API_KEY));
  }
}
for (const mode of ["network", "abort"]) {
  for (const [pathName, name] of [[PREVIEW, "preview"], [CHANGE, "change"]]) {
    const state = makeState(); const env = makeEnv(state); const mock = paddleMock(); mock.mode = mode;
    const cap = captureConsole();
    const { res, json } = await call(env, mock, pathName, { plan: "pro" });
    cap.restore();
    check(`${name}: ${mode === "abort" ? "timeout" : "network failure"} -> 502, plan unchanged`, res.status === 502 && json.code === "provider_error" && state.users[0].plan === "basic");
  }
}

console.log("rate limit");
{
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[PATCH_PREVIEW] = { body: previewBody() };
  let ok = 0;
  for (let i = 0; i < 40; i++) { const r = await call(env, mock, PREVIEW, { plan: "pro" }); if (r.res.status === 200) ok++; }
  const callsBefore = mock.calls.length;
  const over = await call(env, mock, PREVIEW, { plan: "pro" });
  const overChange = await call(env, mock, CHANGE, { plan: "pro" });
  check("40 requests are fine", ok === 40);
  check("the 41st (preview or change) is 429 and never reaches Paddle", over.res.status === 429 && overChange.res.status === 429 && mock.calls.length === callsBefore);
}

console.log("portal: manage subscription");
{
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[`POST /customers/${CUSTOMER}/portal-sessions`] = { status: 201, body: portalBody() };
  const { res, json } = await call(env, mock, PORTAL, {});
  check("200 with the portal link", res.status === 200 && json.url.startsWith("https://sandbox-customer-portal.paddle.com/") && json.cancelUrl.includes("cancel_subscription") && json.updatePaymentUrl.includes("update_subscription_payment_method"), JSON.stringify(json));
  check("asked Paddle once, for THIS customer and THIS subscription", mock.calls.length === 1 && mock.calls[0].path === `/customers/${CUSTOMER}/portal-sessions` && JSON.stringify(mock.calls[0].body) === JSON.stringify({ subscription_ids: [SUB] }));
  check("nothing is written", state.users[0].plan === "basic");
}
{
  const state = makeState({ paddle_customer_id: null }); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[`GET /subscriptions/${SUB}`] = { body: { data: { id: SUB, customer_id: CUSTOMER } } };
  mock.routes[`POST /customers/${CUSTOMER}/portal-sessions`] = { status: 201, body: portalBody() };
  const { res, json } = await call(env, mock, PORTAL, {});
  check("no customer id stored: it is looked up from the subscription first", res.status === 200 && json.url && mock.calls.length === 2 && mock.calls[0].path === `/subscriptions/${SUB}`);
}
for (const status of ["active", "past_due", "paused", "trialing"]) {
  const state = makeState({ paddle_status: status }); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[`POST /customers/${CUSTOMER}/portal-sessions`] = { status: 201, body: portalBody() };
  const { res } = await call(env, mock, PORTAL, {});
  check(`portal works for a ${status} subscription (e.g. to fix the card)`, res.status === 200);
}
for (const [label, over] of [["canceled subscription", { paddle_status: "canceled", plan: "free" }], ["no subscription", { paddle_subscription_id: null, paddle_status: null }]]) {
  const state = makeState(over); const env = makeEnv(state); const mock = paddleMock();
  const { res, json } = await call(env, mock, PORTAL, {});
  check(`${label}: 409 no_subscription, Paddle not called`, res.status === 409 && json.code === "no_subscription" && mock.calls.length === 0);
}
{
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  const a = await call(env, mock, PORTAL, {}, {});
  const b = await call(env, mock, PORTAL, {}, { "X-Workspace-Id": WS });
  const c = await call(env, mock, PORTAL, {}, { "X-Session-Token": "tok-expired" });
  const d = await call(env, mock, PORTAL, {}, { "X-Session-Token": "tok-demo" });
  check("guests and expired sessions are 401, demo workspace 400, Paddle never called", a.res.status === 401 && b.res.status === 401 && c.res.status === 401 && d.res.status === 400 && mock.calls.length === 0);
}
for (const [label, urls] of [
  ["a link to another site", { general: { overview: "https://evil.example.com/steal?token=1" }, subscriptions: [] }],
  ["an http (not https) link", { general: { overview: "http://sandbox-customer-portal.paddle.com/x" }, subscriptions: [] }],
  ["a look-alike host", { general: { overview: "https://paddle.com.evil.example/x" }, subscriptions: [] }],
  ["a javascript: link", { general: { overview: "javascript:alert(1)" }, subscriptions: [] }],
  ["no link at all", {}],
]) {
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[`POST /customers/${CUSTOMER}/portal-sessions`] = { status: 201, body: portalBody({ urls }) };
  const cap = captureConsole();
  const { res, text } = await call(env, mock, PORTAL, {});
  cap.restore();
  check(`Paddle returns ${label}: 502 and the link is NOT passed on`, res.status === 502 && !text.includes("evil") && !text.includes("javascript"));
}
{
  // links secundarios inválidos se descartan pero el principal sobrevive
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[`POST /customers/${CUSTOMER}/portal-sessions`] = { status: 201, body: portalBody({ urls: {
    general: { overview: "https://sandbox-customer-portal.paddle.com/cpl_x?action=overview&token=pga_abc" },
    subscriptions: [{ id: SUB, cancel_subscription: "https://evil.example.com/x", update_subscription_payment_method: "https://sandbox-customer-portal.paddle.com/y" }],
  } }) };
  const { json } = await call(env, mock, PORTAL, {});
  check("an unsafe deep link is dropped (null) while the safe ones stay", json.url && json.cancelUrl === null && json.updatePaymentUrl.includes("paddle.com"));
}
for (const [label, route, expectStatus, expectCode] of [
  ["key rejected", { status: 401, body: { error: { code: "authentication_failed" } } }, 503, "unavailable"],
  ["missing permission", { status: 403, body: { error: { code: "forbidden" } } }, 503, "unavailable"],
  ["customer not found", { status: 404, body: { error: { code: "entity_not_found" } } }, 404, "not_found"],
  ["Paddle down", { status: 500, body: { error: { code: "internal_error" } } }, 502, "provider_error"],
]) {
  const state = makeState(); const env = makeEnv(state); const mock = paddleMock();
  mock.routes[`POST /customers/${CUSTOMER}/portal-sessions`] = route;
  const cap = captureConsole();
  const { res, json, text } = await call(env, mock, PORTAL, {});
  cap.restore();
  check(`${label}: ${expectStatus} ${expectCode}, key not leaked`, res.status === expectStatus && json.code === expectCode && !text.includes(API_KEY) && !cap.logs.join("\n").includes(API_KEY));
}
{
  const state = makeState(); const env = makeEnv(state, { PADDLE_API_KEY: undefined }); const mock = paddleMock();
  const { res } = await call(env, mock, PORTAL, {});
  check("no API key: 503 and Paddle not called", res.status === 503 && mock.calls.length === 0);
}

console.log("annual subscriptions: the change keeps the billing period");
const BASIC_ANNUAL = "pri_basic_annual_test";
const PRO_ANNUAL = "pri_pro_annual_test";
const annualVars = { PADDLE_PRICE_BASIC_ANNUAL: BASIC_ANNUAL, PADDLE_PRICE_PRO_ANNUAL: PRO_ANNUAL };
{
  const state = makeState(); state.mirroredPrices[SUB] = BASIC_ANNUAL;
  const env = makeEnv(state, annualVars); const mock = paddleMock();
  mock.routes[PATCH_PREVIEW] = { body: previewBody() };
  const { res, json } = await call(env, mock, PREVIEW, { plan: "pro" });
  check("basic annual: preview asks for the PRO ANNUAL price", res.status === 200 && mock.calls.length === 1 && mock.calls[0].body.items[0].price_id === PRO_ANNUAL, JSON.stringify(mock.calls.map((c) => c.body)));
  check("basic annual: preview says period annual", json.period === "annual", JSON.stringify(json));
}
{
  const state = makeState(); state.mirroredPrices[SUB] = BASIC_ANNUAL;
  const env = makeEnv(state, annualVars); const mock = paddleMock();
  mock.routes[PATCH_SUB] = { body: changedSub({ items: [{ price: { id: PRO_ANNUAL }, quantity: 1 }] }) };
  const { res, json } = await call(env, mock, CHANGE, { plan: "pro" });
  check("basic annual: the change PATCHes to PRO ANNUAL and the account becomes pro", res.status === 200 && json.plan === "pro" && mock.calls[0].body.items[0].price_id === PRO_ANNUAL && state.users[0].plan === "pro", JSON.stringify([json, mock.calls[0] && mock.calls[0].body]));
}
{
  const state = makeState(); // Basic μηνιαίο στον καθρέφτη
  const env = makeEnv(state, annualVars); const mock = paddleMock();
  mock.routes[PATCH_PREVIEW] = { body: previewBody() };
  const { json } = await call(env, mock, PREVIEW, { plan: "pro" });
  check("basic monthly (annual prices configured too): still PRO MONTHLY, period monthly", mock.calls[0].body.items[0].price_id === PRO && json.period === "monthly", JSON.stringify(json));
}
{
  // Η συνδρομή δεν είναι στον καθρέφτη: ρωτάμε το Paddle ποιο price έχει
  const state = makeState(); state.mirroredPrices = {};
  const env = makeEnv(state, annualVars); const mock = paddleMock();
  mock.routes[`GET /subscriptions/${SUB}`] = { body: { data: { id: SUB, status: "active", items: [{ price: { id: BASIC_ANNUAL }, quantity: 1 }] } } };
  mock.routes[PATCH_PREVIEW] = { body: previewBody() };
  const { res, json } = await call(env, mock, PREVIEW, { plan: "pro" });
  check("not mirrored: GET the subscription first, then preview PRO ANNUAL", res.status === 200 && mock.calls.length === 2 && mock.calls[0].method === "GET" && mock.calls[0].path === `/subscriptions/${SUB}` && mock.calls[1].body.items[0].price_id === PRO_ANNUAL && json.period === "annual", JSON.stringify(mock.calls.map((c) => c.method + " " + c.path)));
}
{
  // Ούτε καθρέφτης ούτε Paddle: ΔΕΝ μαντεύουμε, δεν γίνεται καμία αλλαγή
  const state = makeState(); state.mirroredPrices = {};
  const env = makeEnv(state, annualVars); const mock = paddleMock();
  mock.routes[`GET /subscriptions/${SUB}`] = { status: 500, body: { error: { code: "internal_error" } } };
  const cap = captureConsole();
  const { res, json } = await call(env, mock, CHANGE, { plan: "pro" });
  cap.restore();
  check("not mirrored and Paddle down: 502, no PATCH, plan stays basic", res.status === 502 && json.code === "provider_error" && mock.calls.every((c) => c.method !== "PATCH") && state.users[0].plan === "basic", JSON.stringify(json));
}
{
  // Basic ετήσιο αλλά δεν έχει ρυθμιστεί Pro ετήσιο: δεν πάμε σιωπηλά σε μηνιαίο
  const state = makeState(); state.mirroredPrices[SUB] = BASIC_ANNUAL;
  const env = makeEnv(state, { PADDLE_PRICE_BASIC_ANNUAL: BASIC_ANNUAL }); const mock = paddleMock();
  const { res, json } = await call(env, mock, PREVIEW, { plan: "pro" });
  check("basic annual without a pro annual price: 503 unavailable, Paddle not called", res.status === 503 && json.code === "unavailable" && mock.calls.length === 0, JSON.stringify(json));
}
{
  // Τα νέα ονόματα (_MONTHLY) αρκούν χωρίς τα παλιά
  const state = makeState(); const mock = paddleMock();
  const env = makeEnv(state, { PADDLE_PRICE_PRO: undefined, PADDLE_PRICE_PRO_MONTHLY: "pri_pro_monthly_new" });
  mock.routes[PATCH_PREVIEW] = { body: previewBody() };
  const { res } = await call(env, mock, PREVIEW, { plan: "pro" });
  check("PADDLE_PRICE_PRO_MONTHLY alone is enough", res.status === 200 && mock.calls[0].body.items[0].price_id === "pri_pro_monthly_new");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
