// Έλεγχος του πεδίου "upgrade" στο GET /usage/status (Section R).
// Τρέχει ΧΩΡΙΣ wrangler dev: φορτώνει το src/index.js απευθείας και του δίνει
// ψεύτικα D1/KV. Χρήση (PowerShell, από τον φάκελο idmon):
//   node tests/upgrade-offer.mjs
// Προαιρετικά: $env:INDEX_PATH = "C:\\...\\index.js" για άλλο αρχείο.
import { loadWorker } from "./helpers/load-worker.mjs";

// Φόρτωση του ΠΡΑΓΜΑΤΙΚΟΥ src/index.js στο Node (και με πραγματικό Argon2id): βλ. tests/helpers/load-worker.mjs
const worker = await loadWorker();

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

// Ψεύτικη D1: απαντάει μόνο στα δύο queries που κάνει το /usage/status.
function makeEnv({ users = {}, sessions = {}, vars = {} } = {}) {
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("FROM sessions")) return sessions[args[0]] || null;
              if (sql.includes("SELECT plan FROM users")) {
                const u = users[args[0]];
                return u ? { plan: u.plan } : null;
              }
              if (sql.includes("SELECT plan, paddle_customer_id, paddle_subscription_id, paddle_status FROM users")) {
                const u = users[args[0]];
                return u ? { plan: u.plan, paddle_customer_id: u.paddle_customer_id ?? null, paddle_subscription_id: u.paddle_subscription_id ?? null, paddle_status: u.paddle_status ?? null } : null;
              }
              if (sql.includes("SELECT paddle_status, email FROM users")) {
                const u = users[args[0]];
                return u ? { paddle_status: u.paddle_status ?? null, email: u.email ?? null } : null;
              }
              throw new Error("Unexpected SQL in test: " + sql);
            },
          };
        },
      };
    },
  };
  const DOCUMENT_REGISTRY = {
    async get() { return null; },
    async list() { return { keys: [], list_complete: true }; },
  };
  return {
    DB,
    DOCUMENT_REGISTRY,
    PADDLE_API_KEY: "pdl_test_dummy_key",
    PADDLE_CLIENT_TOKEN: "test_dummy_token",
    PADDLE_ENV: "sandbox",
    PADDLE_PRICE_BASIC: "pri_basic_test",
    PADDLE_PRICE_PRO: "pri_pro_test",
    ...vars,
  };
}

async function status(env, headers) {
  const res = await worker.fetch(new Request("https://idmon.app/usage/status", { headers }), env);
  return { res, body: await res.json() };
}

const future = new Date(Date.now() + 3600_000).toISOString();

console.log("free account without subscription");
{
  const env = makeEnv({ users: { "ws-free": { plan: "free" } } });
  const { res, body } = await status(env, { "X-Workspace-Id": "ws-free" });
  check("status 200", res.status === 200);
  check("offers basic and pro", body.upgrade && body.upgrade.offers.map((o) => o.plan).join() === "basic,pro", JSON.stringify(body.upgrade));
  check("carries workspaceId and currentPlan", body.upgrade && body.upgrade.workspaceId === "ws-free" && body.upgrade.currentPlan === "free");
  check("carries sandbox environment and token", body.upgrade && body.upgrade.environment === "sandbox" && body.upgrade.clientToken === "test_dummy_token");
  check("price ids come from vars", body.upgrade && body.upgrade.offers[0].priceId === "pri_basic_test" && body.upgrade.offers[1].priceId === "pri_pro_test");
  check("limits come from PLAN_LIMITS", body.upgrade && body.upgrade.offers[0].messages === 500 && body.upgrade.offers[0].docs === 20 && body.upgrade.offers[1].messages === 2500 && body.upgrade.offers[1].docs === null);
  check("existing fields intact", body.plan === "free" && body.messagesLimit === 100 && body.messagesUsed === 0 && body.docsLimit === 5);
}

console.log("basic account without subscription (migration default)");
{
  const env = makeEnv({ users: { "ws-basic": { plan: "basic", paddle_status: null } } });
  const { body } = await status(env, { "X-Workspace-Id": "ws-basic" });
  check("offers only pro", body.upgrade && body.upgrade.offers.map((o) => o.plan).join() === "pro", JSON.stringify(body.upgrade));
}

console.log("account with a live subscription");
for (const st of ["active", "trialing", "past_due", "paused"]) {
  const env = makeEnv({ users: { "ws-sub": { plan: "basic", paddle_status: st } } });
  const { body } = await status(env, { "X-Workspace-Id": "ws-sub" });
  check("no upgrade when status is " + st, body.upgrade === null);
}

console.log("account whose subscription was canceled (plan back to free)");
{
  const env = makeEnv({ users: { "ws-canceled": { plan: "free", paddle_status: "canceled" } } });
  const { body } = await status(env, { "X-Workspace-Id": "ws-canceled" });
  check("offers basic and pro again", body.upgrade && body.upgrade.offers.length === 2);
}

console.log("pro account");
{
  const env = makeEnv({ users: { "ws-pro": { plan: "pro", paddle_status: "active" } } });
  const { body } = await status(env, { "X-Workspace-Id": "ws-pro" });
  check("no upgrade", body.upgrade === null);
}

console.log("guest / developer (no users row)");
{
  const env = makeEnv();
  const { body } = await status(env, { "X-Workspace-Id": "ws-guest" });
  check("no upgrade", body.upgrade === null);
  check("plan is still reported as free", body.plan === "free");
}

console.log("protected demo workspace");
{
  const env = makeEnv({ users: { "efood-ops-demo": { plan: "free" } } });
  const { body } = await status(env, { "X-Workspace-Id": "efood-ops-demo" });
  check("no upgrade", body.upgrade === null);
}

console.log("real session resolves the workspace server-side");
{
  const env = makeEnv({
    users: { "ws-real": { plan: "free" } },
    sessions: { tok123: { workspace_id: "ws-real", expires_at: future } },
  });
  // Ο client στέλνει ΛΑΘΟΣ X-Workspace-Id· το session κερδίζει.
  const { body } = await status(env, { "X-Session-Token": "tok123", "X-Workspace-Id": "ws-someone-else" });
  check("workspaceId in offer comes from the session", body.upgrade && body.upgrade.workspaceId === "ws-real", JSON.stringify(body.upgrade));
}

console.log("missing Paddle configuration");
{
  for (const missing of ["PADDLE_CLIENT_TOKEN", "PADDLE_ENV"]) {
    const env = makeEnv({ users: { "ws-free": { plan: "free" } }, vars: { [missing]: undefined } });
    const { body } = await status(env, { "X-Workspace-Id": "ws-free" });
    check("no upgrade without " + missing, body.upgrade === null);
  }
  const noPro = makeEnv({ users: { "ws-basic": { plan: "basic" } }, vars: { PADDLE_PRICE_PRO: undefined } });
  const { body: b1 } = await status(noPro, { "X-Workspace-Id": "ws-basic" });
  check("basic account with no pro price gets no offer", b1.upgrade === null);
  const noBasic = makeEnv({ users: { "ws-free": { plan: "free" } }, vars: { PADDLE_PRICE_BASIC: undefined } });
  const { body: b2 } = await status(noBasic, { "X-Workspace-Id": "ws-free" });
  check("free account with no basic price gets pro only", b2.upgrade && b2.upgrade.offers.map((o) => o.plan).join() === "pro");
}

console.log("live environment flag");
{
  const env = makeEnv({ users: { "ws-free": { plan: "free" } }, vars: { PADDLE_ENV: "production" } });
  const { body } = await status(env, { "X-Workspace-Id": "ws-free" });
  check("PADDLE_ENV=production is passed through", body.upgrade && body.upgrade.environment === "production");
}


console.log("manage block: what an existing subscriber may do");
{
  const SUBID = "sub_" + "0".repeat(25) + "2";
  const acct = (over) => ({ plan: "basic", paddle_subscription_id: SUBID, paddle_status: "active", paddle_customer_id: null, ...over });
  const manageOf = async (user, vars = {}, ws = "ws-m") => {
    const env = makeEnv({ users: user ? { [ws]: user } : {}, vars });
    const { body } = await status(env, { "X-Workspace-Id": ws });
    return body.manage;
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check("basic + active subscription: can manage and change to pro", eq(await manageOf(acct()), { canManage: true, canChangeToPro: true }));
  check("pro + active: can manage, cannot change", eq(await manageOf(acct({ plan: "pro" })), { canManage: true, canChangeToPro: false }));
  check("basic + past_due: can manage (to fix the card), cannot change", eq(await manageOf(acct({ paddle_status: "past_due" })), { canManage: true, canChangeToPro: false }));
  check("basic + trialing: can manage, cannot change", eq(await manageOf(acct({ paddle_status: "trialing" })), { canManage: true, canChangeToPro: false }));
  check("basic + paused: can manage, cannot change", eq(await manageOf(acct({ paddle_status: "paused" })), { canManage: true, canChangeToPro: false }));
  check("canceled subscription: nothing to manage", (await manageOf(acct({ plan: "free", paddle_status: "canceled" }))) === null);
  check("legacy basic without a subscription: nothing to manage", (await manageOf(acct({ paddle_subscription_id: null, paddle_status: null }))) === null);
  check("guest / developer (no account row): null", (await manageOf(null)) === null);
  check("no PADDLE_API_KEY: null", (await manageOf(acct(), { PADDLE_API_KEY: undefined })) === null);
  check("PADDLE_ENV missing: null", (await manageOf(acct(), { PADDLE_ENV: undefined })) === null);
  check("PADDLE_ENV unknown value: null", (await manageOf(acct(), { PADDLE_ENV: "staging" })) === null);
  check("no pro price configured: can manage, cannot change", eq(await manageOf(acct(), { PADDLE_PRICE_PRO: undefined }), { canManage: true, canChangeToPro: false }));
  check("protected demo workspace: null", (await manageOf(acct(), {}, "efood-ops-demo")) === null);
  const envKey = makeEnv({ users: { "ws-m": acct() } });
  const { body } = await status(envKey, { "X-Workspace-Id": "ws-m" });
  check("the API key never appears in the response", !JSON.stringify(body).includes("pdl_test_dummy_key"));
  check("an existing subscriber gets no upgrade offer (no double subscription)", body.upgrade === null);
}

console.log("monthly and annual prices in the offer");
{
  const env = makeEnv({ users: { "ws-free": { plan: "free" } }, vars: {
    PADDLE_PRICE_BASIC_ANNUAL: "pri_basic_annual_test", PADDLE_PRICE_PRO_ANNUAL: "pri_pro_annual_test",
  } });
  const { body } = await status(env, { "X-Workspace-Id": "ws-free" });
  const [b, p] = (body.upgrade && body.upgrade.offers) || [];
  check("basic carries monthly and annual price ids", b && b.prices && b.prices.monthly === "pri_basic_test" && b.prices.annual === "pri_basic_annual_test", JSON.stringify(b));
  check("pro carries monthly and annual price ids", p && p.prices && p.prices.monthly === "pri_pro_test" && p.prices.annual === "pri_pro_annual_test", JSON.stringify(p));
  check("priceId stays the monthly one (compatibility)", b && b.priceId === "pri_basic_test" && p.priceId === "pri_pro_test");
}
{
  const env = makeEnv({ users: { "ws-free": { plan: "free" } } });
  const { body } = await status(env, { "X-Workspace-Id": "ws-free" });
  check("no annual vars: annual is null, monthly still offered", body.upgrade && body.upgrade.offers.every((o) => o.prices.annual === null && o.prices.monthly === o.priceId), JSON.stringify(body.upgrade));
}
{
  const env = makeEnv({ users: { "ws-free": { plan: "free" } }, vars: {
    PADDLE_PRICE_BASIC: undefined, PADDLE_PRICE_PRO: undefined,
    PADDLE_PRICE_BASIC_MONTHLY: "pri_bm", PADDLE_PRICE_PRO_MONTHLY: "pri_pm",
  } });
  const { body } = await status(env, { "X-Workspace-Id": "ws-free" });
  check("the _MONTHLY names alone are enough", body.upgrade && body.upgrade.offers.map((o) => o.priceId).join() === "pri_bm,pri_pm", JSON.stringify(body.upgrade));
}

console.log("account email for the checkout (only with a real session)");
{
  const future = new Date(Date.now() + 86400000).toISOString();
  const users = { "ws-real": { plan: "free", email: "owner@example.com" } };
  const sessions = { tok123: { workspace_id: "ws-real", expires_at: future } };
  {
    const { body } = await status(makeEnv({ users, sessions }), { "X-Session-Token": "tok123" });
    check("with a session: the offer carries the account email", body.upgrade && body.upgrade.email === "owner@example.com", JSON.stringify(body.upgrade));
  }
  {
    const { body } = await status(makeEnv({ users, sessions }), { "X-Workspace-Id": "ws-real" });
    check("without a session (only X-Workspace-Id): NO email, the offer is otherwise the same", body.upgrade && body.upgrade.email === null && body.upgrade.offers.length === 2, JSON.stringify(body.upgrade));
  }
  {
    const { res } = await status(makeEnv({ users, sessions }), { "X-Session-Token": "wrong-token", "X-Workspace-Id": "ws-real" });
    check("a wrong session token does not fall back to X-Workspace-Id (no offer, no email)", res.status === 400, String(res.status));
  }
  {
    const { body } = await status(makeEnv({ users: { "ws-real": { plan: "free" } }, sessions }), { "X-Session-Token": "tok123" });
    check("account without an email on file: email is null", body.upgrade && body.upgrade.email === null);
  }
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
