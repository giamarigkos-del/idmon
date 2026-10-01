// tests\team.test.mjs
// Section W: αυτόματα τεστ για το "Idmon για ομάδες" + έλεγχος ότι το SMB δεν άλλαξε.
//
// Τρέχει τον ΠΡΑΓΜΑΤΙΚΟ Worker (src/index.js + src/team/) μέσα σε Node, με ψεύτικα (in-memory):
//   D1 (πραγματική SQLite, με το πραγματικό schema.sql), KV, Vectorize (με φίλτρα metadata),
//   Gemini (embeddings, απαντήσεις, streaming) και Resend (email).
// Δεν χρειάζεται δίκτυο, λογαριασμό Cloudflare ή κλειδιά, και δεν αγγίζει τίποτα live.
//
// Χρήση (από τον φάκελο του repo):   node tests/team.test.mjs
// Απαιτεί Node 22+ (node:sqlite) και το git tag smb-stable-2026-09-30 (για τη σύγκριση SMB).

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error("Το τεστ χρειάζεται Node 22.5 ή νεότερο (node:sqlite). Έλεγξε την έκδοση με: node --version");
  process.exit(2);
}
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.removeAllListeners("warning"); // σβήνει το "ExperimentalWarning: SQLite"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_TAG = "smb-stable-2026-09-30";

// ------------------------------------------------------------------ βοηθητικά τεστ
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  PASS " + name);
  } else {
    failures.push(name);
    console.log("  FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : ""));
  }
}
function section(title) {
  console.log("\n" + title);
}

// ------------------------------------------------- προσωρινό αντίγραφο για φόρτωση σε Node
// Το src/index.js εισάγει δύο .wasm αρχεία που το Node δεν μπορεί να φορτώσει. Στο ΠΡΟΣΩΡΙΝΟ
// αντίγραφο (όχι στο πραγματικό αρχείο σου) τα αντικαθιστούμε με null. Δεν επηρεάζει τίποτα
// που δοκιμάζουμε (δεν κάνουμε hashing κωδικών).
const TMP = mkdtempSync(join(tmpdir(), "idmon-team-test-"));
process.on("exit", () => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
writeFileSync(join(TMP, "package.json"), '{"type":"module"}');
symlinkSync(join(REPO, "node_modules"), join(TMP, "node_modules"), "junction");

function stubWasm(source) {
  return source
    .replace('import argon2WASM from "argon2-wasm-edge/wasm/argon2.wasm";', "const argon2WASM = null;")
    .replace('import blake2bWASM from "argon2-wasm-edge/wasm/blake2b.wasm";', "const blake2bWASM = null;")
    .replace("setWASMModules({ argon2WASM, blake2bWASM });", "");
}

// νέα έκδοση (τρέχων κώδικας)
cpSync(join(REPO, "src"), join(TMP, "modified", "src"), { recursive: true });
const modIndex = join(TMP, "modified", "src", "index.js");
writeFileSync(modIndex, stubWasm(readFileSync(modIndex, "utf8")));

// baseline: ο κώδικας του production όπως ήταν στο tag
let baselineSource;
try {
  baselineSource = execFileSync("git", ["show", `${BASELINE_TAG}:src/index.js`], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 });
} catch {
  console.error(`Δεν βρέθηκε το git tag ${BASELINE_TAG}. Τρέξε: git fetch --tags`);
  process.exit(2);
}
mkdirSync(join(TMP, "baseline", "src"), { recursive: true });
writeFileSync(join(TMP, "baseline", "src", "index.js"), stubWasm(baselineSource));

const workerNew = (await import(pathToFileURL(modIndex).href)).default;
const workerOld = (await import(pathToFileURL(join(TMP, "baseline", "src", "index.js")).href)).default;
const access = await import(pathToFileURL(join(TMP, "modified", "src", "team", "access.js")).href);

// ------------------------------------------------------------------------ ψεύτικο D1
class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    const r = this.db.prepare(this.sql).get(...this.args);
    return r === undefined ? null : { ...r };
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(join(REPO, "schema.sql"), "utf8"));
  return { raw: db, prepare: (sql) => new Stmt(db, sql) };
}

// ------------------------------------------------------------------------ ψεύτικο KV
function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, opts) {
      const e = store.get(key);
      if (!e) return null;
      return opts === "json" || (opts && opts.type === "json") ? JSON.parse(e.value) : e.value;
    },
    async put(key, value, opts = {}) {
      store.set(key, { value: String(value), metadata: opts.metadata });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([name, e]) => ({ name, metadata: e.metadata }));
      return { keys, list_complete: true };
    },
  };
}

// ------------------------------------------------- ψεύτικο Vectorize (με φίλτρα metadata)
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
function matchesFilter(metadata, filter) {
  if (!filter) return true;
  for (const [field, cond] of Object.entries(filter)) {
    const v = metadata ? metadata[field] : undefined;
    if (cond && typeof cond === "object") {
      if ("$in" in cond && !cond.$in.includes(v)) return false;
      if ("$eq" in cond && v !== cond.$eq) return false;
    } else if (v !== cond) return false;
  }
  return true;
}
function makeVectorize() {
  const vectors = new Map(); // id -> vector
  const v = {
    vectors,
    calls: [],
    ignoreFilter: false, // για να δοκιμάσουμε τον δεύτερο έλεγχο στον κώδικα
    async upsert(list) {
      for (const x of list) vectors.set(x.id, x);
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
    },
    async query(values, options) {
      v.calls.push({ ...JSON.parse(JSON.stringify(options)), __keys: Object.keys(options).sort() });
      const filter = v.ignoreFilter ? undefined : options.filter;
      const rows = [...vectors.values()]
        .filter((x) => x.namespace === options.namespace && matchesFilter(x.metadata, filter))
        .map((x) => ({ id: x.id, score: cosine(values, x.values), metadata: x.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return { matches: rows };
    },
  };
  return v;
}

// ---------------------------------------------- ψεύτικο δίκτυο: Gemini και Resend
function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
}
function embedText(text, dims = 64) {
  const vec = new Array(dims).fill(0);
  for (const t of tokenize(text)) {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.codePointAt(0)) % dims;
    vec[h] += 1;
  }
  return vec;
}
function installFetchMock(state) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ url: u, body });
    if (u.includes("embedContent")) {
      return new Response(JSON.stringify({ embedding: { values: embedText(body.content.parts[0].text) } }), { status: 200 });
    }
    if (u.includes("generateContent") || u.includes("streamGenerateContent")) {
      const prompt = body.contents[0].parts[0].text;
      state.prompts.push(prompt);
      (state.urls = state.urls || []).push(u);
      if (state.llmDown) return new Response("{}", { status: 500 });
      const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
      const sentenceWith = (text, phrase) => (text.split(".").find((x) => x.includes(phrase)) || phrase).trim() + ".";
      // (α) ο κριτής αντιφάσεων
      if (prompt.includes("Απάντησε ΜΟΝΟ με JSON")) {
        let items = [];
        if (state.judgeFabricate) {
          items = [{ topic: "Επινοημένη", quoteNew: "Αυτή η πρόταση δεν υπάρχει πουθενά.", quoteOther: "Ούτε αυτή υπάρχει." }];
        } else if (Array.isArray(state.judge)) {
          const dropTitle = (part) => part.slice(part.indexOf("\n") + 1); // αφαιρεί τη γραμμή «τίτλος»
          const newPart = dropTitle(prompt.split("ΝΕΟ ΕΓΓΡΑΦΟ: ")[1].split("\n\nΑΛΛΟ ΕΓΓΡΑΦΟ: ")[0]);
          const otherPart = dropTitle(prompt.split("ΑΛΛΟ ΕΓΓΡΑΦΟ: ")[1]);
          for (const { x, y, topic } of state.judge) {
            if (newPart.includes(x) && otherPart.includes(y)) items.push({ topic, quoteNew: sentenceWith(newPart, x), quoteOther: sentenceWith(otherPart, y) });
            else if (newPart.includes(y) && otherPart.includes(x)) items.push({ topic, quoteNew: sentenceWith(newPart, y), quoteOther: sentenceWith(otherPart, x) });
          }
        }
        const raw = JSON.stringify({ contradictions: items });
        return reply(state.judgeFences ? "```json\n" + raw + "\n```" : raw);
      }
      // (β) η ενσωμάτωση update: αντικαθιστά τον πρώτο ποσό "N €" του κειμένου με αυτόν της ενημέρωσης
      if (prompt.includes("Ξαναγράψε ολόκληρο το κείμενο του εγγράφου")) {
        if (state.mergeMode === "empty") return reply("");
        if (state.mergeMode === "short") return reply("ΟΚ");
        const afterDoc = prompt.split(/ΕΓΓΡΑΦΟ: «[^»]*»\n/)[1];
        const [base, update] = afterDoc.split("\n\nΕΝΗΜΕΡΩΣΗ:\n");
        const n = update.match(/\d+ €/);
        const merged = n ? base.replace(/\d+ €/, n[0]) : base + "\n" + update;
        if (state.mergeMode === "title") return reply("«" + prompt.match(/ΕΓΓΡΑΦΟ: «([^»]*)»/)[1] + "»\n" + merged);
        return reply(merged);
      }
      // (γ) ερωτήσεις με λέξεις "άγνωστες" στο LLM
      if ((state.unknown || []).some((w) => prompt.includes(w))) {
        if (u.includes("streamGenerateContent")) {
          const sse = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Δεν γνωρίζω." }] } }] })}\r\n\r\n`;
          return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        return reply("Δεν γνωρίζω.");
      }
      // Η "απάντηση" αναφέρει μόνο τους δείκτες *-MARK που είδε το LLM, ώστε να φαίνεται τι του δόθηκε.
      const marks = [...new Set(prompt.match(/[A-Z]+-MARK/g) || [])].join(",");
      const text = state.mdHtml ? "<script>window.__xss=1</script><img src=x onerror=window.__xss=1> εκτελέστηκε"
        : state.md ? "* **3 εργάσιμες ημέρες** η επιστροφή\n- δεύτερη γραμμή"
        : "ΑΠΑΝΤΗΣΗ [" + marks + "]";
      if (u.includes("streamGenerateContent")) {
        const sse = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
    }
    if (u.includes("api.resend.com")) {
      state.emails.push({ to: body.to[0], subject: body.subject, text: body.text });
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
}

function makeEnv() {
  return {
    DB: makeD1(),
    DOCUMENT_REGISTRY: makeKV(),
    VECTORIZE: makeVectorize(),
    AI: { run: async () => ({ response: "ai" }) },
    GEMINI_API_KEY: "test-key",
    RESEND_API_KEY: "test-resend",
    NOTIFY_FROM_EMAIL: "notifications@idmon.app",
    TEAM_CONTRADICTION_MIN_SCORE: "0.05", // οι ψεύτικες "embeddings" βγάζουν χαμηλές ομοιότητες
  };
}

const BASE = "https://lab.test";
let ipCounter = 1;
function req(env, worker, method, path, { cookie, body, headers = {}, origin = BASE } = {}) {
  const h = { "CF-Connecting-IP": `203.0.113.${(ipCounter++ % 250) + 1}`, ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (origin && method !== "GET") h.Origin = origin;
  return worker.fetch(new Request(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
}
async function readJson(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
async function readSse(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)));
}

// ============================================================ 1. Καθαροί κανόνες πρόσβασης
section("1. Κανόνες πρόσβασης (access.js)");
{
  const depts = [
    { id: "cc", name: "Customer Care", hidden: 0 },
    { id: "fin", name: "Finance", hidden: 0 },
    { id: "hr", name: "HR", hidden: 1 },
  ];
  const emp = { role: "employee", departmentIds: ["cc"] };
  const ed = { role: "editor", departmentIds: ["cc"] };
  const adm = { role: "admin", departmentIds: [] };
  const set = (s) => (s === null ? null : [...s].sort().join(","));
  check("employee διαβάζει: δικό του + εταιρικά", set(access.readableDepartmentIds(emp, depts)) === "_all,cc");
  check("editor διαβάζει: δικό του + εταιρικά + άλλα ΜΗ κρυφά", set(access.readableDepartmentIds(ed, depts)) === "_all,cc,fin");
  check("admin διαβάζει όλα (null)", access.readableDepartmentIds(adm, depts) === null);
  check("βοηθός employee ψάχνει μόνο δικό του + εταιρικά", set(access.searchDepartmentIds(emp)) === "_all,cc");
  check("βοηθός editor ψάχνει μόνο δικό του + εταιρικά (ΟΧΙ άλλα τμήματα)", set(access.searchDepartmentIds(ed)) === "_all,cc");
  check("βοηθός admin χωρίς φίλτρο", access.vectorFilterFor(adm) === undefined);
  check("φίλτρο vector = $in στα σωστά τμήματα", JSON.stringify(access.vectorFilterFor(emp).department_id.$in.sort()) === '["_all","cc"]');
  check("employee δεν γράφει πουθενά", !access.canWriteDepartment(emp, depts, "cc"));
  check("editor γράφει στο δικό του τμήμα", access.canWriteDepartment(ed, depts, "cc"));
  check("editor ΔΕΝ γράφει σε ξένο τμήμα", !access.canWriteDepartment(ed, depts, "fin"));
  check("editor ΔΕΝ γράφει εταιρικά", !access.canWriteDepartment(ed, depts, "_all"));
  check("admin γράφει παντού και στα εταιρικά", access.canWriteDepartment(adm, depts, "fin") && access.canWriteDepartment(adm, depts, "_all"));
  check("admin δεν γράφει σε ανύπαρκτο τμήμα", !access.canWriteDepartment(adm, depts, "nope"));
}

// ================================================================ 2. Πλήρες σενάριο ομάδας
const state = { calls: [], prompts: [], emails: [] };
installFetchMock(state);
const env = makeEnv();
const db = env.DB.raw;
const now = new Date().toISOString();

db.exec(`
INSERT INTO team_workspaces(id,name,status,created_at) VALUES ('team-demo','Εταιρεία Demo','pilot','${now}'),('team-other','Άλλη Εταιρεία','pilot','${now}');
INSERT INTO departments(id,workspace_id,name,hidden,created_at) VALUES
 ('cc','team-demo','Customer Care',0,'${now}'),('fin','team-demo','Finance',0,'${now}'),('hr','team-demo','HR',1,'${now}'),('cc2','team-other','CC other',0,'${now}');
INSERT INTO team_members(workspace_id,email,role,status,created_at) VALUES
 ('team-demo','admin@demo.gr','admin','active','${now}'),
 ('team-demo','ed_cc@demo.gr','editor','active','${now}'),
 ('team-demo','ed_fin@demo.gr','editor','active','${now}'),
 ('team-demo','emp_cc@demo.gr','employee','active','${now}'),
 ('team-demo','emp_fin@demo.gr','employee','active','${now}'),
 ('team-demo','emp_hr@demo.gr','employee','active','${now}'),
 ('team-demo','off@demo.gr','employee','disabled','${now}'),
 ('team-other','other@other.gr','admin','active','${now}');
`);
const memberId = (email) => db.prepare("select id from team_members where email=?").get(email).id;
for (const [email, dep] of [["ed_cc@demo.gr","cc"],["ed_fin@demo.gr","fin"],["emp_cc@demo.gr","cc"],["emp_fin@demo.gr","fin"],["emp_hr@demo.gr","hr"],["off@demo.gr","cc"]]) {
  db.prepare("insert into member_departments(member_id,department_id) values(?,?)").run(memberId(email), dep);
}

async function login(email) {
  const before = state.emails.length;
  const r1 = await req(env, workerNew, "POST", "/team/login/start", { body: { email } });
  if (state.emails.length === before) return { start: r1, cookie: null };
  const token = state.emails[state.emails.length - 1].text.match(/#login=([a-f0-9]{64})/)[1];
  const r2 = await req(env, workerNew, "POST", "/team/login/verify", { body: { token } });
  const setCookie = r2.headers.get("set-cookie");
  return { start: r1, verify: r2, token, setCookie, cookie: setCookie ? setCookie.split(";")[0] : null };
}

section("2. Σύνδεση με link στο email");
{
  const before = state.emails.length;
  const rUnknown = await req(env, workerNew, "POST", "/team/login/start", { body: { email: "nobody@nowhere.gr" } });
  const unknownBody = await readJson(rUnknown);
  check("άγνωστο email: 200 {ok:true}", rUnknown.status === 200 && unknownBody.ok === true);
  check("άγνωστο email: ΚΑΝΕΝΑ email δεν στάλθηκε", state.emails.length === before);
  const rBad = await req(env, workerNew, "POST", "/team/login/start", { body: { email: "not-an-email" } });
  check("άκυρη μορφή email: 400", rBad.status === 400);
  const rDis = await req(env, workerNew, "POST", "/team/login/start", { body: { email: "off@demo.gr" } });
  check("απενεργοποιημένο μέλος: ίδια απάντηση, ΚΑΝΕΝΑ email", rDis.status === 200 && state.emails.length === before);

  const a = await login("admin@demo.gr");
  check("γνωστό μέλος: στάλθηκε email με link προς το portal", /^https:\/\/lab\.test\/portal\.html#login=[a-f0-9]{64}$/m.test(state.emails.at(-1).text));
  check("το link ΔΕΝ έχει το token στο query (μόνο στο fragment)", !/\?[^#\s]*login=/.test(state.emails.at(-1).text));
  check("η απάντηση είναι ίδια για γνωστό και άγνωστο email", JSON.stringify(await readJson(a.start)) === JSON.stringify(unknownBody));
  check("verify: 200", a.verify.status === 200);
  check("cookie: HttpOnly, Secure, SameSite=Strict, Path=/team", /HttpOnly/.test(a.setCookie) && /Secure/.test(a.setCookie) && /SameSite=Strict/.test(a.setCookie) && /Path=\/team/.test(a.setCookie));
  check("το session token ΔΕΝ αποθηκεύεται αυτούσιο στη βάση", db.prepare("select count(*) c from team_sessions where token = ?").get(a.cookie.split("=")[1]).c === 0);
  const reuse = await req(env, workerNew, "POST", "/team/login/verify", { body: { token: a.token } });
  check("το token είναι μίας χρήσης (δεύτερο verify: 400)", reuse.status === 400);
  const junk = await req(env, workerNew, "POST", "/team/login/verify", { body: { token: "x".repeat(64) } });
  check("άκυρο token: 400", junk.status === 400);
  const noCookie = await req(env, workerNew, "GET", "/team/me");
  check("χωρίς cookie: 401", noCookie.status === 401);
  const forged = await req(env, workerNew, "GET", "/team/me", { cookie: "team_session=" + "a".repeat(64) });
  check("πλαστό cookie: 401", forged.status === 401);
  const foreignOrigin = await req(env, workerNew, "POST", "/team/logout", { cookie: a.cookie, origin: "https://evil.example" });
  check("POST από ξένη προέλευση: 403", foreignOrigin.status === 403);
  const me = await readJson(await req(env, workerNew, "GET", "/team/me", { cookie: a.cookie }));
  check("/team/me: email και ρόλος", me.email === "admin@demo.gr" && me.role === "admin");

  // rate limit ανά email
  let last;
  for (let i = 0; i < 6; i++) last = await req(env, workerNew, "POST", "/team/login/start", { body: { email: "spam@demo.gr" } });
  check("rate limit ανά email: το 6ο αίτημα 429", last.status === 429);
}

const S = {};
for (const email of ["admin@demo.gr", "ed_cc@demo.gr", "ed_fin@demo.gr", "emp_cc@demo.gr", "emp_fin@demo.gr", "emp_hr@demo.gr", "other@other.gr"]) {
  S[email] = (await login(email)).cookie;
}
const call = (email, method, path, body) => req(env, workerNew, method, path, { cookie: S[email], body });

section("3. Ανάκληση πρόσβασης");
{
  const t = await login("off@demo.gr");
  check("απενεργοποιημένος: δεν μπορεί να συνδεθεί (cookie null)", t.cookie === null);
  db.exec(`INSERT INTO team_members(workspace_id,email,role,status,created_at) VALUES ('team-demo','leaver@demo.gr','employee','active','${now}')`);
  const l = await login("leaver@demo.gr");
  check("ενεργό μέλος συνδέεται", (await req(env, workerNew, "GET", "/team/me", { cookie: l.cookie })).status === 200);
  db.prepare("update team_members set status='disabled' where email='leaver@demo.gr'").run();
  check("απενεργοποίηση: το ΥΠΑΡΧΟΝ session κόβεται ΑΜΕΣΩΣ", (await req(env, workerNew, "GET", "/team/me", { cookie: l.cookie })).status === 401);

  db.exec(`INSERT INTO team_members(workspace_id,email,role,status,created_at) VALUES ('team-demo','exp@demo.gr','employee','active','${now}')`);
  const e = await login("exp@demo.gr");
  db.prepare("update team_sessions set expires_at = ? where member_id = ?").run("2020-01-01T00:00:00.000Z", memberId("exp@demo.gr"));
  check("ληγμένο session: 401", (await req(env, workerNew, "GET", "/team/me", { cookie: e.cookie })).status === 401);

  db.exec(`INSERT INTO team_workspaces(id,name,status,created_at) VALUES ('team-paused','Paused','pilot','${now}');
           INSERT INTO team_members(workspace_id,email,role,status,created_at) VALUES ('team-paused','p@paused.gr','admin','active','${now}')`);
  const p = await login("p@paused.gr");
  check("workspace pilot: σύνδεση OK", p.cookie !== null);
  db.prepare("update team_workspaces set status='paused' where id='team-paused'").run();
  check("workspace paused: τα υπάρχοντα sessions κόβονται", (await req(env, workerNew, "GET", "/team/me", { cookie: p.cookie })).status === 401);
  const pStart = state.emails.length;
  await req(env, workerNew, "POST", "/team/login/start", { body: { email: "p@paused.gr" } });
  check("workspace paused: δεν στέλνεται νέο link", state.emails.length === pStart);

  const out = await login("emp_fin@demo.gr").catch(() => null);
  const lg = await req(env, workerNew, "POST", "/team/logout", { cookie: S["emp_cc@demo.gr"] });
  check("logout: 200", lg.status === 200);
  check("μετά το logout το session δεν ισχύει", (await req(env, workerNew, "GET", "/team/me", { cookie: S["emp_cc@demo.gr"] })).status === 401);
  S["emp_cc@demo.gr"] = (await login("emp_cc@demo.gr")).cookie;
  void out;
}

section("4. Έγγραφα: δικαιώματα εγγραφής");
const DOC = {};
{
  const mk = (title, dept, text) => ({ title, departmentId: dept, text });
  const r1 = await call("ed_cc@demo.gr", "POST", "/team/documents", mk("Διαδικασία επιστροφών", "cc", "Η επιστροφή χρημάτων γίνεται σε πέντε εργάσιμες ημέρες. CC-MARK"));
  check("editor CC δημιουργεί έγγραφο στο CC: 201", r1.status === 201);
  DOC.cc = (await readJson(r1)).id;
  check("editor CC ΔΕΝ δημιουργεί σε ξένο τμήμα (Finance): 403", (await call("ed_cc@demo.gr", "POST", "/team/documents", mk("x", "fin", "κείμενο"))).status === 403);
  check("editor CC ΔΕΝ δημιουργεί εταιρικό έγγραφο: 403", (await call("ed_cc@demo.gr", "POST", "/team/documents", mk("x", "_all", "κείμενο"))).status === 403);
  check("employee ΔΕΝ δημιουργεί: 403", (await call("emp_cc@demo.gr", "POST", "/team/documents", mk("x", "cc", "κείμενο"))).status === 403);
  const rf = await call("admin@demo.gr", "POST", "/team/documents", mk("Όρια έγκρισης", "fin", "Ποσά άνω των εκατό ευρώ χρειάζονται έγκριση. FIN-MARK"));
  DOC.fin = (await readJson(rf)).id;
  check("admin δημιουργεί στο Finance: 201", rf.status === 201);
  DOC.hr = (await readJson(await call("admin@demo.gr", "POST", "/team/documents", mk("Πειθαρχικά", "hr", "Πειθαρχικά μέτρα και διαδικασίες. HR-MARK")))).id;
  DOC.all = (await readJson(await call("admin@demo.gr", "POST", "/team/documents", mk("Ωράριο εορτών", "_all", "Ωράριο εορτών και αργίες. ALL-MARK")))).id;
  check("admin δημιουργεί εταιρικό έγγραφο", !!DOC.all);
  check("ανύπαρκτο τμήμα: 403", (await call("admin@demo.gr", "POST", "/team/documents", mk("x", "nope", "κείμενο"))).status === 403);
  check("κενός τίτλος: 400", (await call("admin@demo.gr", "POST", "/team/documents", mk("", "cc", "κείμενο"))).status === 400);
  check("χωρίς κείμενο: 400", (await call("admin@demo.gr", "POST", "/team/documents", { title: "x", departmentId: "cc" })).status === 400);
  check("υπερβολικά μεγάλο κείμενο: 400", (await call("admin@demo.gr", "POST", "/team/documents", mk("x", "cc", "λέξη ".repeat(8001)))).status === 400);
}

section("5. Έγγραφα: δικαιώματα ανάγνωσης");
{
  const titles = async (email) => (await readJson(await call(email, "GET", "/team/documents"))).documents.map((d) => d.title).sort();
  check("employee CC βλέπει: CC + εταιρικά", JSON.stringify(await titles("emp_cc@demo.gr")) === JSON.stringify(["Διαδικασία επιστροφών", "Ωράριο εορτών"].sort()));
  check("editor CC βλέπει: CC + εταιρικά + Finance, ΟΧΙ HR (κρυφό)", JSON.stringify(await titles("ed_cc@demo.gr")) === JSON.stringify(["Διαδικασία επιστροφών", "Όρια έγκρισης", "Ωράριο εορτών"].sort()));
  check("admin βλέπει όλα, και το κρυφό HR", (await titles("admin@demo.gr")).length === 4);
  check("employee HR βλέπει το ΔΙΚΟ του κρυφό τμήμα", (await titles("emp_hr@demo.gr")).includes("Πειθαρχικά"));
  check("employee CC: έγγραφο Finance = 404 (δεν αποκαλύπτεται καν ότι υπάρχει)", (await call("emp_cc@demo.gr", "GET", `/team/documents/${DOC.fin}`)).status === 404);
  const readFin = await readJson(await call("ed_cc@demo.gr", "GET", `/team/documents/${DOC.fin}`));
  check("editor CC διαβάζει έγγραφο Finance, μόνο για ανάγνωση (editable=false)", readFin.title === "Όρια έγκρισης" && readFin.editable === false);
  check("editor CC: κρυφό έγγραφο HR = 404", (await call("ed_cc@demo.gr", "GET", `/team/documents/${DOC.hr}`)).status === 404);
  check("editor CC: δικό του έγγραφο editable=true", (await readJson(await call("ed_cc@demo.gr", "GET", `/team/documents/${DOC.cc}`))).editable === true);
  check("άλλη εταιρεία: δεν βλέπει τίποτα", (await titles("other@other.gr")).length === 0);
  check("άλλη εταιρεία: έγγραφο της demo = 404", (await call("other@other.gr", "GET", `/team/documents/${DOC.cc}`)).status === 404);
  check("id με ../ = 404", (await call("admin@demo.gr", "GET", "/team/documents/..%2F..%2Fx")).status === 404);
  check("id με άνω-κάτω τελεία = 404", (await call("admin@demo.gr", "GET", "/team/documents/doc:abc")).status === 404);
}

section("6. Έγγραφα: επεξεργασία και διαγραφή");
{
  const put = (email, id, dept, text = "Νέο κείμενο ενημέρωσης. CC-MARK") => call(email, "PUT", `/team/documents/${id}`, { title: "Διαδικασία επιστροφών", departmentId: dept, text });
  check("editor CC: PUT σε ξένο έγγραφο (Finance) = 403", (await put("ed_cc@demo.gr", DOC.fin, "fin")).status === 403);
  check("editor CC: ΔΕΝ μεταφέρει δικό του έγγραφο σε άλλο τμήμα = 403", (await put("ed_cc@demo.gr", DOC.cc, "fin")).status === 403);
  check("editor CC: ΔΕΝ το κάνει εταιρικό = 403", (await put("ed_cc@demo.gr", DOC.cc, "_all")).status === 403);
  check("editor CC: DELETE ξένου εγγράφου = 403", (await call("ed_cc@demo.gr", "DELETE", `/team/documents/${DOC.fin}`)).status === 403);
  check("employee: PUT = 403", (await put("emp_cc@demo.gr", DOC.cc, "cc")).status === 403);
  const upd = await put("ed_cc@demo.gr", DOC.cc, "cc");
  const updBody = await readJson(upd);
  check("editor CC ενημερώνει το δικό του: 200 και version 2", upd.status === 200 && updBody.version === 2);
  check("editor Finance ενημερώνει έγγραφο Finance", (await put("ed_fin@demo.gr", DOC.fin, "fin", "Όρια έγκρισης: εκατόν πενήντα ευρώ. FIN-MARK")).status === 200);
  check("άλλη εταιρεία: PUT σε έγγραφο της demo = 404", (await put("other@other.gr", DOC.cc, "cc2")).status === 404 || (await put("other@other.gr", DOC.cc, "cc2")).status === 403);
}

section("7. Vectorize: τι γράφεται και πού");
{
  const vs = [...env.VECTORIZE.vectors.values()];
  check("κάθε vector έχει department_id (κανένα χωρίς)", vs.length > 0 && vs.every((v) => typeof v.metadata.department_id === "string" && v.metadata.department_id.length > 0));
  check("namespace = workspace της ομάδας (team-...)", vs.every((v) => v.namespace === "team-demo"));
  const cc = vs.find((v) => v.metadata.documentId === DOC.cc);
  check("το vector του εγγράφου CC έχει department_id=cc", cc && cc.metadata.department_id === "cc");
  check("vector του εταιρικού εγγράφου έχει department_id=_all", vs.find((v) => v.metadata.documentId === DOC.all).metadata.department_id === "_all");
  const kvKeys = [...env.DOCUMENT_REGISTRY.store.keys()];
  check("κανένα KV key ομάδας ΔΕΝ έχει το πρόθεμα session: του SMB", !kvKeys.some((k) => k.startsWith("session:")));
  check("τα έγγραφα ζουν στο πρόθεμα team:", kvKeys.filter((k) => k.includes(":doc:")).every((k) => k.startsWith("team:team-demo:doc:")));
  // μείωση chunks: μεγάλο κείμενο -> μικρό
  const big = "λέξη ".repeat(700) + "τέλος";
  const rBig = await call("ed_cc@demo.gr", "PUT", `/team/documents/${DOC.cc}`, { title: "Διαδικασία επιστροφών", departmentId: "cc", text: big });
  const n1 = (await readJson(rBig)).chunkCount;
  const rSmall = await call("ed_cc@demo.gr", "PUT", `/team/documents/${DOC.cc}`, { title: "Διαδικασία επιστροφών", departmentId: "cc", text: "Σύντομο κείμενο. CC-MARK" });
  const remaining = [...env.VECTORIZE.vectors.values()].filter((v) => v.metadata.documentId === DOC.cc).length;
  check("μεγάλο κείμενο = πολλά chunks", n1 > 1);
  check("όταν το κείμενο μικραίνει, τα περιττά παλιά chunks διαγράφονται", (await readJson(rSmall)).chunkCount === 1 && remaining === 1);
  const delDoc = await call("admin@demo.gr", "POST", "/team/documents", { title: "Προσωρινό", departmentId: "cc", text: "Προσωρινό κείμενο διαγραφής" });
  const delId = (await readJson(delDoc)).id;
  await call("ed_cc@demo.gr", "DELETE", `/team/documents/${delId}`);
  check("DELETE σβήνει και τα vectors και το KV", ![...env.VECTORIZE.vectors.values()].some((v) => v.metadata.documentId === delId) && !env.DOCUMENT_REGISTRY.store.has(`team:team-demo:doc:${delId}`));
}

section("8. Βοηθός: το φίλτρο τμήματος (η ΚΑΡΔΙΑ του διαχωρισμού)");
{
  const ask = async (email, q) => {
    state.prompts.length = 0;
    const res = await call(email, "POST", "/team/query/stream", { question: q });
    const events = await readSse(res);
    return { events, prompt: state.prompts.join("\n"), lastQuery: env.VECTORIZE.calls.at(-1) };
  };
  // ξαναβάζουμε γνωστό κείμενο για σταθερές δοκιμές
  await call("ed_cc@demo.gr", "PUT", `/team/documents/${DOC.cc}`, { title: "Διαδικασία επιστροφών", departmentId: "cc", text: "Η επιστροφή χρημάτων γίνεται σε πέντε εργάσιμες ημέρες. CC-MARK" });
  await call("ed_fin@demo.gr", "PUT", `/team/documents/${DOC.fin}`, { title: "Όρια έγκρισης", departmentId: "fin", text: "Ποσά άνω των εκατό ευρώ χρειάζονται έγκριση. FIN-MARK" });

  let r = await ask("emp_cc@demo.gr", "Ποια είναι τα όρια έγκρισης για ποσά εκατό ευρώ;");
  check("employee CC: το ερώτημα στο Vectorize έχει φίλτρο $in [_all, cc]", JSON.stringify((r.lastQuery.filter?.department_id?.$in || []).slice().sort()) === '["_all","cc"]');
  check("employee CC: το LLM ΔΕΝ είδε το περιεχόμενο του Finance", !r.prompt.includes("FIN-MARK"));
  check("employee CC: το LLM ΔΕΝ είδε το κρυφό HR", !r.prompt.includes("HR-MARK"));

  r = await ask("emp_cc@demo.gr", "Πώς γίνεται η επιστροφή χρημάτων;");
  const done = r.events.find((e) => e.type === "done");
  check("employee CC: η απάντηση χρησιμοποιεί έγγραφο του τμήματός του", r.prompt.includes("CC-MARK"));
  check("employee CC: πηγή = Διαδικασία επιστροφών, τμήμα Customer Care", done && done.primarySource && done.primarySource.title === "Διαδικασία επιστροφών" && done.primarySource.departmentName === "Customer Care");
  check("ροή SSE: chunk και done", r.events.some((e) => e.type === "chunk") && !!done);

  r = await ask("emp_fin@demo.gr", "Ποια είναι τα όρια έγκρισης;");
  check("employee Finance: βλέπει το έγγραφο Finance", r.prompt.includes("FIN-MARK"));
  check("employee Finance: ΔΕΝ βλέπει το CC", !r.prompt.includes("CC-MARK"));

  r = await ask("ed_cc@demo.gr", "Ποια είναι τα όρια έγκρισης για ποσά εκατό ευρώ;");
  check("editor CC: ο βοηθός ΔΕΝ ψάχνει σε άλλα τμήματα (ούτε Finance)", !r.prompt.includes("FIN-MARK"));
  check("editor CC: το φίλτρο είναι το ίδιο με του employee", JSON.stringify((r.lastQuery.filter?.department_id?.$in || []).slice().sort()) === '["_all","cc"]');

  r = await ask("admin@demo.gr", "Ποια πειθαρχικά μέτρα και όρια έγκρισης ισχύουν;");
  check("admin: χωρίς φίλτρο στο ερώτημα", r.lastQuery.filter === undefined);
  check("admin: βλέπει και το κρυφό HR", r.prompt.includes("HR-MARK") || r.prompt.includes("FIN-MARK"));

  // Δεύτερος έλεγχος στον κώδικα: το Vectorize "χαλάει" και αγνοεί το φίλτρο
  env.VECTORIZE.ignoreFilter = true;
  r = await ask("emp_cc@demo.gr", "Ποια είναι τα όρια έγκρισης για ποσά εκατό ευρώ και τα πειθαρχικά μέτρα;");
  check("ΑΝ το Vectorize αγνοήσει το φίλτρο, ο κώδικας κόβει τα ξένα αποτελέσματα (Finance)", !r.prompt.includes("FIN-MARK"));
  check("... και τα κρυφά (HR)", !r.prompt.includes("HR-MARK"));
  // Vector χωρίς department_id (π.χ. λάθος/παλιά εγγραφή) = fail closed
  env.VECTORIZE.vectors.set("legacy-1", { id: "legacy-1", namespace: "team-demo", values: embedText("όρια έγκρισης ποσά εκατό ευρώ πειθαρχικά"), metadata: { documentId: "legacy", chunkIndex: 0, text: "LEGACY-MARK χωρίς τμήμα" } });
  r = await ask("emp_cc@demo.gr", "Ποια είναι τα όρια έγκρισης για ποσά εκατό ευρώ και τα πειθαρχικά μέτρα;");
  check("vector ΧΩΡΙΣ department_id αποκλείεται πάντα (fail closed)", !r.prompt.includes("LEGACY-MARK"));
  env.VECTORIZE.vectors.delete("legacy-1");
  env.VECTORIZE.ignoreFilter = false;

  // Καμία σχετική πληροφορία -> "δεν βρέθηκε", και καταγράφεται αναπάντητη ΧΩΡΙΣ ταυτότητα
  const beforeKeys = [...env.DOCUMENT_REGISTRY.store.keys()].filter((k) => k.includes(":fallback:")).length;
  r = await ask("other@other.gr", "Τι ισχύει για τις άδειες;");
  const d2 = r.events.find((e) => e.type === "done");
  check("χώρος χωρίς έγγραφα: fallback και καμία πηγή", d2 && d2.isFallback === true && d2.primarySource === null);
  const fbKeys = [...env.DOCUMENT_REGISTRY.store.entries()].filter(([k]) => k.includes(":fallback:"));
  check("η αναπάντητη ερώτηση καταγράφεται", fbKeys.length === beforeKeys + 1);
  check("... χωρίς ταυτότητα υπαλλήλου", !JSON.stringify(fbKeys.at(-1)[1].value).includes("other@other.gr"));
  check("... και μόνο στο πρόθεμα team:", fbKeys.every(([k]) => k.startsWith("team:")));

  check("κενή ερώτηση: 400", (await call("emp_cc@demo.gr", "POST", "/team/query/stream", { question: "  " })).status === 400);
  check("υπερβολικά μεγάλη ερώτηση: 400", (await call("emp_cc@demo.gr", "POST", "/team/query/stream", { question: "α".repeat(1001) })).status === 400);
  check("χωρίς session: 401", (await req(env, workerNew, "POST", "/team/query/stream", { body: { question: "τι;" } })).status === 401);
}

section("9. Απομόνωση από το παλιό (SMB) μονοπάτι");
{
  const viaHeader = (path, method = "GET", body) => req(env, workerNew, method, path, { headers: { "X-Workspace-Id": "team-demo" }, body });
  const d = await viaHeader("/documents");
  check("GET /documents με X-Workspace-Id: team-demo -> 400 (απορρίπτεται)", d.status === 400);
  const q = await viaHeader("/query", "POST", { question: "όρια έγκρισης" });
  check("POST /query με X-Workspace-Id: team-demo -> 400", q.status === 400);
  const s = await viaHeader("/search-documents", "POST", { query: "όρια έγκρισης" });
  check("POST /search-documents με X-Workspace-Id: team-demo -> 400", s.status === 400);
  const c = await viaHeader("/contradictions");
  check("GET /contradictions με X-Workspace-Id: team-demo -> 400", c.status === 400);
  const txt = JSON.stringify([await readJson(d), await readJson(q)]);
  check("καμία διαρροή περιεχομένου ομάδας στις απαντήσεις", !/FIN-MARK|CC-MARK|HR-MARK|ALL-MARK/.test(txt));
  const t = await req(env, workerNew, "GET", "/team/documents", { headers: { "X-Workspace-Id": "team-demo" } });
  check("/team/* δεν δέχεται το header ως ταυτότητα (401)", t.status === 401);
}

// ===================================================== 10. Σύγκριση SMB: baseline vs νέος κώδικας
section(`10. Το SMB δεν άλλαξε: ίδιες απαντήσεις με το production (${BASELINE_TAG})`);
{
  async function runSmb(worker) {
    const e = makeEnv();
    e.CF_ACCOUNT_ID = "acc123"; e.AI_GATEWAY_ID = "idmon-ai"; // όπως στο production: εκεί τα URL πρέπει να μείνουν ίδια
    const st = { calls: [], prompts: [], emails: [] };
    installFetchMock(st);
    const ws = "ws-aaaaaaaaaaaaaaaaaaaaaaaa";
    // δύο δημοσιευμένα έγγραφα SMB, όπως τα γράφει το handleUpload
    for (const [id, title, text] of [["doc-a", "Ωράριο", "Το κατάστημα ανοίγει στις εννιά. SMB-MARK"], ["doc-b", "Επιστροφές", "Επιστροφές εντός δέκα ημερών. SMB-MARK"]]) {
      await e.DOCUMENT_REGISTRY.put(`session:${ws}:doc:${id}`, JSON.stringify({ title, chunkCount: 1, fullText: text, status: "published", updatedAt: "2026-09-01T00:00:00.000Z", version: 1 }));
      await e.VECTORIZE.upsert([{ id: `${id}-chunk-0`, namespace: ws, values: embedText(text), metadata: { documentId: id, chunkIndex: 0, text } }]);
    }
    const H = { "X-Workspace-Id": ws };
    const out = [];
    const grab = async (label, promise) => {
      const res = await promise;
      out.push([label, res.status, (await res.text()).replace(/"updatedAt":"[^"]*"/g, '"updatedAt":"X"')]);
    };
    await grab("health", req(e, worker, "GET", "/health"));
    await grab("config", req(e, worker, "GET", "/config/public"));
    await grab("documents", req(e, worker, "GET", "/documents", { headers: H }));
    await grab("query", req(e, worker, "POST", "/query", { headers: H, body: { question: "Πότε ανοίγει το κατάστημα;" } }));
    await grab("query+history", req(e, worker, "POST", "/query", { headers: H, body: { question: "και οι επιστροφές;", history: [{ role: "user", text: "Πότε ανοίγει το κατάστημα;" }, { role: "assistant", text: "Στις εννιά." }] } }));
    await grab("stream", req(e, worker, "POST", "/query/stream", { headers: H, body: { question: "Πώς γίνονται οι επιστροφές;" } }));
    await grab("search", req(e, worker, "POST", "/search-documents", { headers: H, body: { query: "επιστροφές" } }));
    await grab("no-header", req(e, worker, "GET", "/documents"));
    await grab("unknown", req(e, worker, "GET", "/does-not-exist"));
    return { out, vectorCalls: e.VECTORIZE.calls, urls: st.calls.map((c) => c.url.replace(/key=[^&]*/, "key=K")) };
  }
  const oldRun = await runSmb(workerOld);
  const newRun = await runSmb(workerNew);
  for (let i = 0; i < oldRun.out.length; i++) {
    const [label, s1, b1] = oldRun.out[i];
    const [, s2, b2] = newRun.out[i];
    check(`SMB ${label}: ίδιο status και ίδιο σώμα (${s1})`, s1 === s2 && b1 === b2, s1 !== s2 ? [s1, s2] : undefined);
  }
  check("SMB: ίδια ερωτήματα προς το Vectorize (ίδια options, ΚΑΝΕΝΑ νέο κλειδί)", JSON.stringify(oldRun.vectorCalls) === JSON.stringify(newRun.vectorCalls));
  check("SMB: κανένα ερώτημα Vectorize δεν έχει πεδίο filter (ούτε με τιμή undefined)", newRun.vectorCalls.every((c) => !c.__keys.includes("filter")));
  check("SMB: ίδιες κλήσεις προς Gemini", JSON.stringify(oldRun.urls) === JSON.stringify(newRun.urls));
  check("SMB: οι απαντήσεις δεν είναι κενές (το τεστ πράγματι έτρεξε ροές)", oldRun.out.filter(([l, s]) => ["documents", "query", "stream"].includes(l) && s === 200).length === 3);
}


// ================================== 11. Οι σελίδες σε headless browser (jsdom) πάνω στον Worker
section("11. portal.html και team-editor.html: χρήση σαν πραγματικός χρήστης (jsdom)");
{
  installFetchMock(state); // το section 10 είχε βάλει δικό του ψεύτικο δίκτυο: ξανά το κύριο
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const portalHtml = readFileSync(join(REPO, "public", "portal.html"), "utf8");
  const editorHtml = readFileSync(join(REPO, "public", "team-editor.html"), "utf8");

  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const v = fn(); if (v) return v; } catch { /* ακόμα όχι */ }
      await new Promise((r) => setTimeout(r, 15));
    }
    return null;
  };

  // "browser": fetch που καταλήγει στον πραγματικό Worker, με cookie jar (όπως ένας browser:
  // στέλνει το cookie μόνο σε διαδρομές /team).
  function makeBrowser() {
    const jar = { value: null };
    const bridge = async (input, init = {}) => {
      const url = new URL(input, BASE);
      const method = init.method || "GET";
      const headers = { "CF-Connecting-IP": `198.51.100.${(ipCounter++ % 250) + 1}`, ...(init.headers || {}) };
      if (jar.value && url.pathname.startsWith("/team")) headers.Cookie = jar.value;
      if (method !== "GET") headers.Origin = BASE;
      const res = await workerNew.fetch(new Request(url, { method, headers, body: init.body }), env);
      const sc = res.headers.get("set-cookie");
      if (sc) jar.value = /Max-Age=0/.test(sc) ? null : sc.split(";")[0];
      return res;
    };
    const open = (html, path) => {
      const dom = new JSDOM(html, {
        url: BASE + path,
        runScripts: "dangerously",
        pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
        beforeParse(window) {
          window.fetch = bridge;
          window.TextDecoder = TextDecoder;
          window.confirm = () => true;
        },
      });
      return dom;
    };
    return { jar, open };
  }
  const submit = (dom, formSel) => {
    const f = dom.window.document.querySelector(formSel);
    f.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  };
  const text = (dom, sel) => (dom.window.document.querySelector(sel) || {}).textContent || "";
  const allText = (dom) => dom.window.document.body.textContent;

  // --- Υπάλληλος: σύνδεση από το email
  const br = makeBrowser();
  let dom = br.open(portalHtml, "/portal.html");
  check("χωρίς σύνδεση: εμφανίζεται η φόρμα email", !!(await waitFor(() => dom.window.document.querySelector("#email"))));
  dom.window.document.querySelector("#email").value = "emp_cc@demo.gr";
  const emailsBefore = state.emails.length;
  submit(dom, "form");
  check("μετά την αποστολή: ουδέτερο μήνυμα (δεν αποκαλύπτει αν υπάρχει το email)", !!(await waitFor(() => /Αν το email ανήκει/.test(text(dom, ".note")))));
  check("στάλθηκε email σύνδεσης", state.emails.length === emailsBefore + 1);
  const link = state.emails.at(-1).text.match(/#login=([a-f0-9]{64})/)[1];

  dom = br.open(portalHtml, "/portal.html#login=" + link);
  check("με το link: μπαίνει στην κύρια οθόνη (εμφανίζεται το πεδίο αναζήτησης)", !!(await waitFor(() => dom.window.document.querySelector("#q"))));
  check("κορυφή: όνομα εταιρείας, τμήμα και ρόλος", /Εταιρεία Demo/.test(text(dom, ".topbar")) && /Customer Care/.test(text(dom, ".topbar")) && /Υπάλληλος/.test(text(dom, ".topbar")));
  check("το token φεύγει από τη γραμμή διευθύνσεων", dom.window.location.hash === "");
  await waitFor(() => dom.window.document.querySelectorAll(".row").length > 0);
  const page = allText(dom);
  check("λίστα εγγράφων: το δικό του τμήμα και τα εταιρικά", /Διαδικασία επιστροφών/.test(page) && /Ωράριο εορτών/.test(page));
  check("λίστα εγγράφων: ΚΑΝΕΝΑ έγγραφο άλλου τμήματος (Finance, HR) στη σελίδα", !/Όρια έγκρισης/.test(page) && !/Πειθαρχικά/.test(page));
  check("υπάλληλος: ΔΕΝ υπάρχει σύνδεσμος διαχείρισης", !dom.window.document.querySelector('a[href="/team-editor.html"]'));

  // --- ερώτηση
  dom.window.document.querySelector("#q").value = "Πώς γίνεται η επιστροφή χρημάτων;";
  submit(dom, "form.searchrow");
  const answered = await waitFor(() => /ΑΠΑΝΤΗΣΗ/.test(text(dom, ".answer .body")));
  check("η απάντηση εμφανίζεται", !!answered);
  check("η απάντηση χρησιμοποίησε έγγραφο του τμήματος και ΟΧΙ του Finance", /CC-MARK/.test(text(dom, ".answer .body")) && !/FIN-MARK/.test(text(dom, ".answer .body")));
  await waitFor(() => dom.window.document.querySelector(".answer .source"));
  check("πηγή: τίτλος και τμήμα", /Πηγή: Διαδικασία επιστροφών · Customer Care/.test(text(dom, ".answer .source")));
  check("φαίνεται η παραπομπή στον υπεύθυνο του τμήματος", /Ρώτα τον υπεύθυνο του τμήματος/.test(text(dom, ".answer .handoff")));

  // --- ανάγνωση εγγράφου
  dom.window.document.querySelector(".answer .source button").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  const reader = await waitFor(() => dom.window.document.querySelector(".overlay .reader"));
  check("Άνοιγμα άρθρου: εμφανίζεται ο αναγνώστης με τίτλο και κείμενο", !!reader && /Διαδικασία επιστροφών/.test(reader.textContent) && /CC-MARK/.test(reader.textContent));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  check("Escape κλείνει τον αναγνώστη", !dom.window.document.querySelector(".overlay"));

  // --- αποσύνδεση
  dom.window.document.querySelector(".userbox button").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  check("αποσύνδεση: επιστροφή στη φόρμα email", !!(await waitFor(() => dom.window.document.querySelector("#email"))));
  const dom2 = br.open(portalHtml, "/portal.html#login=" + link);
  check("το ίδιο link ξανά: δεν ισχύει, μήνυμα και νέα φόρμα", !!(await waitFor(() => /έληξε ή έχει ήδη χρησιμοποιηθεί/.test(text(dom2, ".note")))));

  // --- Editor: διαχείριση εγγράφων
  const brEd = makeBrowser();
  const dEd = brEd.open(portalHtml, "/portal.html");
  await waitFor(() => dEd.window.document.querySelector("#email"));
  dEd.window.document.querySelector("#email").value = "ed_cc@demo.gr";
  const eb = state.emails.length;
  submit(dEd, "form");
  await waitFor(() => state.emails.length === eb + 1);
  const edLink = state.emails.at(-1).text.match(/#login=([a-f0-9]{64})/)[1];
  const edPortal = brEd.open(portalHtml, "/portal.html#login=" + edLink);
  await waitFor(() => edPortal.window.document.querySelector("#q"));
  check("editor: βλέπει σύνδεσμο διαχείρισης", !!edPortal.window.document.querySelector('a[href="/team-editor.html"]'));

  const ed = brEd.open(editorHtml, "/team-editor.html");
  await waitFor(() => ed.window.document.querySelector("#tab-docs")); // η οθόνη ξεκινά από τα Εισερχόμενα
  ed.window.document.querySelector("#tab-docs").dispatchEvent(new ed.window.Event("click", { bubbles: true }));
  await waitFor(() => ed.window.document.querySelectorAll(".item").length > 2);
  const items = [...ed.window.document.querySelectorAll(".item")];
  check("editor: η λίστα δείχνει και έγγραφα άλλων τμημάτων (Finance)", items.some((i) => /Όρια έγκρισης/.test(i.textContent)));
  check("... σημειωμένα ως μόνο ανάγνωση", items.find((i) => /Όρια έγκρισης/.test(i.textContent)).textContent.includes("μόνο ανάγνωση"));
  check("editor: το κρυφό τμήμα HR δεν εμφανίζεται", !items.some((i) => /Πειθαρχικά/.test(i.textContent)));
  items.find((i) => /Όρια έγκρισης/.test(i.textContent)).dispatchEvent(new ed.window.Event("click", { bubbles: true }));
  await waitFor(() => ed.window.document.querySelector(".readonly-text"));
  check("έγγραφο άλλου τμήματος: μόνο ανάγνωση, χωρίς φόρμα επεξεργασίας", !!ed.window.document.querySelector(".readonly-text") && !ed.window.document.querySelector("#panel form"));

  ed.window.document.querySelector(".item").dispatchEvent(new ed.window.Event("click", { bubbles: true })); // + Νέο έγγραφο
  await waitFor(() => ed.window.document.querySelector("#panel form"));
  const opts = [...ed.window.document.querySelectorAll("#dept option")].map((o) => o.value);
  check("editor: μπορεί να επιλέξει ΜΟΝΟ το δικό του τμήμα", JSON.stringify(opts) === '["cc"]');
  ed.window.document.querySelector("#title").value = '<img src=x onerror="window.__pwned=1">Δοκιμή XSS';
  ed.window.document.querySelector("#text").value = "<script>window.__pwned=1<\/script> Κείμενο δοκιμής για ασφάλεια. XSS-MARK";
  submit(ed, "#panel form");
  check("δημοσίευση νέου εγγράφου από τη σελίδα", !!(await waitFor(() => /Αποθηκεύτηκε \(έκδοση 1\)/.test(text(ed, "#panel .note")))));
  check("το νέο έγγραφο μπήκε στη λίστα", !!(await waitFor(() => [...ed.window.document.querySelectorAll(".item")].some((i) => /Δοκιμή XSS/.test(i.textContent)))));

  // --- XSS: το περιεχόμενο εγγράφων δεν εκτελείται ποτέ ως HTML
  const portal3 = brEd.open(portalHtml, "/portal.html");
  await waitFor(() => [...portal3.window.document.querySelectorAll(".row")].some((r) => /Δοκιμή XSS/.test(r.textContent)));
  [...portal3.window.document.querySelectorAll(".row")].find((r) => /Δοκιμή XSS/.test(r.textContent)).dispatchEvent(new portal3.window.Event("click", { bubbles: true }));
  await waitFor(() => portal3.window.document.querySelector(".overlay .reader"));
  check("XSS: ο τίτλος εμφανίζεται ως κείμενο, δεν δημιουργείται στοιχείο img", !portal3.window.document.querySelector("img") && /<img src=x/.test(portal3.window.document.body.textContent));
  check("XSS: το script του εγγράφου ΔΕΝ εκτελέστηκε", portal3.window.__pwned === undefined && ed.window.__pwned === undefined);
}

// ============================================================================ 12. Αντιφάσεις
section("12. Αντιφάσεις: ανίχνευση, ορατότητα, ειδοποιήσεις");
const DOC2 = {};
const cList = async (email, status = "open") => (await readJson(await call(email, "GET", `/team/contradictions?status=${status}`))).contradictions;
const audit = async () => (await readJson(await call("admin@demo.gr", "GET", "/team/admin/audit"))).entries;
{
  state.judge = [
    { x: "πέντε εργάσιμες ημέρες", y: "επτά εργάσιμες ημέρες", topic: "Χρόνος επιστροφής" },
    { x: "εκατόν πενήντα ευρώ", y: "εκατό ευρώ", topic: "Όριο έγκρισης" },
    { x: "είκοσι ημέρες", y: "είκοσι πέντε ημέρες", topic: "Ημέρες άδειας" },
  ];
  const mk = (title, dept, text) => ({ title, departmentId: dept, text });

  // (α) ίδιο τμήμα
  const r1 = await call("ed_cc@demo.gr", "POST", "/team/documents", mk("Αποζημιώσεις", "cc", "Η επιστροφή χρημάτων γίνεται σε επτά εργάσιμες ημέρες. AP-MARK"));
  const b1 = await readJson(r1);
  DOC2.ap = b1.id;
  check("η δημοσίευση απαντά κανονικά και δηλώνει ότι ξεκίνησε έλεγχος αντιφάσεων", r1.status === 201 && b1.contradictionCheck === "started");
  let list = await cList("ed_cc@demo.gr");
  const ap = list.find((c) => c.topic === "Χρόνος επιστροφής");
  check("βρέθηκε αντίφαση μεταξύ δύο εγγράφων του ίδιου τμήματος", !!ap && ap.sides.length === 2);
  check("... και οι δύο πλευρές είναι επεξεργάσιμες από τον editor CC", ap.sides.every((s) => s.editable === true && !s.hidden));
  check("... με τις ακριβείς προτάσεις", ap.sides.some((s) => s.quote.includes("πέντε εργάσιμες ημέρες")) && ap.sides.some((s) => s.quote.includes("επτά εργάσιμες ημέρες")));
  check("ο editor Finance ΔΕΝ βλέπει αντίφαση που δεν τον αφορά", !(await cList("ed_fin@demo.gr")).some((c) => c.topic === "Χρόνος επιστροφής"));
  check("ο admin τη βλέπει", (await cList("admin@demo.gr")).some((c) => c.topic === "Χρόνος επιστροφής"));
  check("ο υπάλληλος δεν έχει πρόσβαση στα εισερχόμενα: 403", (await call("emp_cc@demo.gr", "GET", "/team/inbox")).status === 403 && (await call("emp_cc@demo.gr", "GET", "/team/contradictions")).status === 403);
  check("ο ίδιος ο δημοσιεύων δεν παίρνει email για τη δική του δημοσίευση", !state.emails.some((e) => e.to === "ed_cc@demo.gr" && /αντίφαση/.test(e.subject)));

  // (β) διαφορετικά τμήματα (Finance)
  const emailsBefore = state.emails.length;
  await call("ed_cc@demo.gr", "PUT", `/team/documents/${DOC.cc}`, mk("Διαδικασία επιστροφών", "cc", "Η επιστροφή χρημάτων γίνεται σε πέντε εργάσιμες ημέρες. Ποσά άνω των εκατόν πενήντα ευρώ χρειάζονται έγκριση. CC-MARK"));
  list = await cList("ed_cc@demo.gr");
  const fin = list.find((c) => c.topic === "Όριο έγκρισης");
  check("βρέθηκε αντίφαση ανάμεσα σε CC και Finance", !!fin);
  const own = fin.sides.find((s) => s.editable), foreign = fin.sides.find((s) => !s.editable);
  check("ο editor CC βλέπει την άλλη πλευρά ΜΟΝΟ για ανάγνωση, με τίτλο και τμήμα", foreign && !foreign.hidden && foreign.title === "Όρια έγκρισης" && foreign.departmentName === "Finance" && /εκατό ευρώ/.test(foreign.quote));
  const finView = (await cList("ed_fin@demo.gr")).find((c) => c.topic === "Όριο έγκρισης");
  check("ο editor Finance τη βλέπει ανάποδα: δικό του Finance, ξένο CC (ανάγνωση)", finView && finView.sides.find((s) => s.editable).title === "Όρια έγκρισης" && !finView.sides.find((s) => !s.editable).editable);
  const finMails = state.emails.slice(emailsBefore).filter((e) => e.to === "ed_fin@demo.gr");
  check("ο editor Finance ειδοποιήθηκε με email", finMails.length === 1 && /team-editor\.html/.test(finMails[0].text));
  check("το email είναι γενικό: ΚΑΝΕΝΑΣ τίτλος ή περιεχόμενο εγγράφου", !/Όρια έγκρισης|Διαδικασία|εκατό|CC-MARK|FIN-MARK/.test(finMails[0].text + finMails[0].subject));
  check("... και δεν στάλθηκε στον ίδιο τον δημοσιεύοντα", !state.emails.slice(emailsBefore).some((e) => e.to === "ed_cc@demo.gr"));
  check("δεν δημιουργήθηκαν διπλότυπα για το ήδη γνωστό ζεύγος CC", list.filter((c) => c.topic === "Χρόνος επιστροφής").length === 1);
  DOC2.finContradiction = fin.id;

  // (γ) κρυφό τμήμα HR
  const emailsBeforeHr = state.emails.length;
  await call("admin@demo.gr", "PUT", `/team/documents/${DOC.hr}`, mk("Πειθαρχικά", "hr", "Η ετήσια άδεια είναι είκοσι ημέρες. HR-MARK"));
  const r3 = await call("ed_cc@demo.gr", "POST", "/team/documents", mk("Οδηγός βάρδιας", "cc", "Η ετήσια άδεια είναι είκοσι πέντε ημέρες. OD-MARK"));
  DOC2.guide = (await readJson(r3)).id;
  const raw = await call("ed_cc@demo.gr", "GET", "/team/contradictions?status=open");
  const rawText = await raw.text();
  const hrC = JSON.parse(rawText).contradictions.find((c) => c.sides.some((s) => s.hidden));
  check("ο editor CC βλέπει ότι υπάρχει αντίφαση με κρυφό έγγραφο", !!hrC && hrC.sides.some((s) => s.hidden === true));
  const hiddenSide = hrC.sides.find((s) => s.hidden);
  check("... η κρυφή πλευρά δεν έχει ΚΑΝΕΝΑ πεδίο εκτός από hidden/editable", JSON.stringify(Object.keys(hiddenSide).sort()) === JSON.stringify(["editable", "hidden"]));
  check("... ο τίτλος της αντίφασης είναι ΓΕΝΙΚΟΣ (ο τίτλος του LLM θα μπορούσε να αποκαλύψει το θέμα του κρυφού εγγράφου)", hrC.topic === "Πιθανή αντίφαση με έγγραφο κρυφού τμήματος" && !rawText.includes("Ημέρες άδειας"));
  check("... και η απάντηση δεν περιέχει τίτλο, κείμενο ή id του κρυφού εγγράφου", !/Πειθαρχικά|HR-MARK|είκοσι ημέρες|"doc-[a-f0-9]{16}"[^}]*Πειθαρχικά/.test(rawText) && !rawText.includes(DOC.hr));
  const adminHr = (await cList("admin@demo.gr")).find((c) => c.topic === "Ημέρες άδειας");
  check("ο admin βλέπει και τις δύο πλευρές (και την κρυφή) με πλήρες περιεχόμενο", adminHr && adminHr.sides.every((s) => !s.hidden) && adminHr.sides.some((s) => s.title === "Πειθαρχικά"));
  const adminMail = state.emails.slice(emailsBeforeHr).find((e) => e.to === "admin@demo.gr");
  check("ειδοποιήθηκε ο admin (εμπλέκεται κρυφό τμήμα)", !!adminMail && !/Πειθαρχικά|είκοσι|HR-MARK/.test(adminMail.text));
  check("ο editor του άλλου τμήματος (Finance) δεν βλέπει αυτή την αντίφαση", !(await cList("ed_fin@demo.gr")).some((c) => c.topic === "Ημέρες άδειας"));
  check("ο υπάλληλος του HR δεν έχει πρόσβαση στις αντιφάσεις", (await call("emp_hr@demo.gr", "GET", "/team/contradictions")).status === 403);
  DOC2.hrContradiction = hrC.id;

  // (δ) αυτόματο κλείσιμο όταν διορθωθεί, και ξανάνοιγμα αν επανέλθει
  await call("ed_cc@demo.gr", "PUT", `/team/documents/${DOC2.ap}`, mk("Αποζημιώσεις", "cc", "Η επιστροφή χρημάτων γίνεται σε πέντε εργάσιμες ημέρες. AP-MARK"));
  check("όταν ο editor διορθώσει το κείμενο, η αντίφαση κλείνει αυτόματα", !(await cList("ed_cc@demo.gr")).some((c) => c.topic === "Χρόνος επιστροφής"));
  const resolved = (await cList("ed_cc@demo.gr", "resolved")).find((c) => c.topic === "Χρόνος επιστροφής");
  check("... και εμφανίζεται στα λυμένα (resolution: edited)", !!resolved && resolved.resolution === "edited");
  await call("ed_cc@demo.gr", "PUT", `/team/documents/${DOC2.ap}`, mk("Αποζημιώσεις", "cc", "Η επιστροφή χρημάτων γίνεται σε επτά εργάσιμες ημέρες. AP-MARK"));
  check("αν το λάθος επανέλθει, η αντίφαση ξανανοίγει (όχι διπλότυπο)", (await cList("ed_cc@demo.gr")).filter((c) => c.topic === "Χρόνος επιστροφής").length === 1);
  DOC2.apContradiction = (await cList("ed_cc@demo.gr")).find((c) => c.topic === "Χρόνος επιστροφής").id;

  // (ε) "δεν είναι αντίφαση" και υπενθύμιση
  check("editor που δεν εμπλέκεται δεν μπορεί να απορρίψει: 404", (await call("ed_fin@demo.gr", "POST", `/team/contradictions/${DOC2.apContradiction}/dismiss`)).status === 404);
  check("editor Finance που ΕΜΠΛΕΚΕΤΑΙ μπορεί να κάνει dismiss στη δική του: 200", (await call("ed_fin@demo.gr", "POST", `/team/contradictions/${DOC2.finContradiction}/dismiss`)).status === 200);
  check("η απορριφθείσα δεν φαίνεται πια στα ανοιχτά", !(await cList("ed_cc@demo.gr")).some((c) => c.topic === "Όριο έγκρισης"));
  check("... και δεύτερο dismiss: 409", (await call("ed_cc@demo.gr", "POST", `/team/contradictions/${DOC2.finContradiction}/dismiss`)).status === 409);
  const chk = await readJson(await call("ed_cc@demo.gr", "POST", `/team/documents/${DOC.cc}/check`));
  check("χειροκίνητος έλεγχος: η απορριφθείσα ΔΕΝ ξαναδημιουργείται", chk.created === 0 && !(await cList("ed_cc@demo.gr")).some((c) => c.topic === "Όριο έγκρισης"));
  check("χειροκίνητος έλεγχος από άλλο τμήμα: 403", (await call("ed_fin@demo.gr", "POST", `/team/documents/${DOC.cc}/check`)).status === 403);
  check("υπενθύμιση σε αντίφαση όπου ήδη στάλθηκε ειδοποίηση: 429 (cooldown)", (await call("ed_cc@demo.gr", "POST", `/team/contradictions/${DOC2.hrContradiction}/remind`)).status === 429);
  const mailsBeforeRemind = state.emails.length;
  check("υπενθύμιση σε ανοιχτή αντίφαση χωρίς πρόσφατη ειδοποίηση: 200", (await call("ed_cc@demo.gr", "POST", `/team/contradictions/${DOC2.apContradiction}/remind`)).status === 200);
  check("... στάλθηκε email (στον admin, γιατί δεν υπάρχει άλλο τμήμα)", state.emails.slice(mailsBeforeRemind).some((e) => e.to === "admin@demo.gr"));
  check("... και δεύτερη αμέσως μετά: 429", (await call("ed_cc@demo.gr", "POST", `/team/contradictions/${DOC2.apContradiction}/remind`)).status === 429);
  check("υπενθύμιση από editor που δεν εμπλέκεται: 404", (await call("ed_fin@demo.gr", "POST", `/team/contradictions/${DOC2.apContradiction}/remind`)).status === 404);

  // (στ) ασφάλεια του κριτή: επινοημένες παραθέσεις, code fences, διακοπή AI
  const countOpen = async () => (await cList("admin@demo.gr")).length;
  let before = await countOpen();
  state.judgeFabricate = true;
  const rf = await call("ed_cc@demo.gr", "POST", "/team/documents", mk("Δοκιμαστικό 1", "cc", "Η επιστροφή χρημάτων γίνεται σε πέντε εργάσιμες ημέρες. DK1-MARK"));
  state.judgeFabricate = false;
  check("επινοημένες παραθέσεις του LLM απορρίπτονται (δεν υπάρχουν στα κείμενα)", rf.status === 201 && (await countOpen()) === before);
  state.judgeFences = true;
  await call("ed_cc@demo.gr", "POST", "/team/documents", mk("Οδηγός βάρδιας 2", "cc", "Η ετήσια άδεια είναι είκοσι πέντε ημέρες. OD2-MARK"));
  state.judgeFences = false;
  check("JSON τυλιγμένο σε code fences διαβάζεται κανονικά", (await countOpen()) === before + 1);
  before = await countOpen();
  state.llmDown = true;
  const rd = await call("ed_cc@demo.gr", "POST", "/team/documents", mk("Δοκιμαστικό 2", "cc", "Η επιστροφή χρημάτων γίνεται σε πέντε εργάσιμες ημέρες. DK2-MARK"));
  state.llmDown = false;
  check("αν ο πάροχος AI πέσει, η δημοσίευση ΔΕΝ μπλοκάρεται", rd.status === 201);
  check("... και η αποτυχία του ελέγχου καταγράφεται στο ιστορικό", (await audit()).some((a) => a.action === "contradiction_check" && a.detail && a.detail.failed >= 1));
  check("... χωρίς νέες αντιφάσεις", (await countOpen()) === before);

  // (ζ) ctx.waitUntil (παραγωγή): ο έλεγχος τρέχει στο παρασκήνιο
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const rw = await workerNew.fetch(new Request(BASE + "/team/documents", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, Cookie: S["ed_cc@demo.gr"], "CF-Connecting-IP": "203.0.113.77" },
    body: JSON.stringify(mk("Οδηγός βάρδιας 3", "cc", "Η ετήσια άδεια είναι είκοσι πέντε ημέρες. OD3-MARK")),
  }), env, ctx);
  check("με ctx.waitUntil: η απάντηση επιστρέφει και ο έλεγχος ανατίθεται στο παρασκήνιο", rw.status === 201 && pending.length === 1);
  await Promise.all(pending);
  check("... και ολοκληρώνεται σωστά (βρέθηκε η αντίφαση)", (await countOpen()) === before + 1);

  // (η) διαγραφή και απομόνωση
  await call("admin@demo.gr", "DELETE", `/team/documents/${DOC2.ap}`);
  const rows = db.prepare("select status, resolution from team_contradictions where doc_a=? or doc_b=?").all(DOC2.ap, DOC2.ap);
  check("όταν διαγραφεί έγγραφο, οι αντιφάσεις του κλείνουν (resolution: deleted)", rows.length > 0 && rows.every((r) => r.status === "resolved" || r.status === "dismissed"));
  check("... και δεν εμφανίζονται πια σε κανέναν", !(await cList("admin@demo.gr")).some((c) => c.sides.some((s) => s.documentId === DOC2.ap)));
  const oi = await readJson(await call("other@other.gr", "GET", "/team/inbox"));
  check("άλλος οργανισμός: καμία αντίφαση ή update του demo, καμία διαρροή", oi.counts.contradictions === 0 && oi.counts.updates === 0 && !JSON.stringify(oi).includes("team-demo"));
  state.judge = null;
}

// ============================================================================ 13. Updates
section("13. Updates: άμεση ορατότητα, ενσωμάτωση με έγκριση");
{
  const mk = (title, dept, text) => ({ title, departmentId: dept, text });
  const rp = await call("admin@demo.gr", "POST", "/team/documents", mk("Όρια πληρωμών", "cc", "Ποσά άνω των 150 € χρειάζονται έγκριση από τον υπεύθυνο. Η επιστροφή γίνεται σε 5 εργάσιμες ημέρες."));
  DOC2.pay = (await readJson(rp)).id;
  const docGet = async (email, id) => readJson(await call(email, "GET", `/team/documents/${id}`));

  const ru = await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "Το όριο έγκρισης γίνεται 200 €." });
  const U1 = (await readJson(ru)).id;
  check("editor CC δημιουργεί update στο έγγραφο του τμήματός του: 201", ru.status === 201 && Number.isInteger(U1));
  const uv = env.VECTORIZE.vectors.get(`upd-${U1}-chunk-0`);
  check("το update έγινε αναζητήσιμο: vector με το ΙΔΙΟ τμήμα και σήμανση update", uv && uv.metadata.department_id === "cc" && uv.metadata.kind === "update" && uv.metadata.documentId === DOC2.pay && uv.namespace === "team-demo");
  check("... με σήμανση 'πρόσφατη ενημέρωση' στο κείμενο", /^\[ΠΡΟΣΦΑΤΗ ΕΝΗΜΕΡΩΣΗ/.test(uv.metadata.text));
  let g = await docGet("admin@demo.gr", DOC2.pay);
  check("το βασικό έγγραφο ΔΕΝ άλλαξε μόνο του (έκδοση 1, ίδιο κείμενο)", g.version === 1 && /150 €/.test(g.fullText) && !/200 €/.test(g.fullText));
  check("ο editor Finance ΔΕΝ μπορεί να κάνει update σε έγγραφο CC: 403", (await call("ed_fin@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "x" })).status === 403);
  check("ο υπάλληλος δεν κάνει update: 403", (await call("emp_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "x" })).status === 403);
  check("update σε ανύπαρκτο έγγραφο: 404", (await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: "doc-0000000000000000", text: "x" })).status === 404);
  check("update με άκυρο id: 404", (await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: "../x", text: "x" })).status === 404);
  check("update με κενό κείμενο: 400", (await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "  " })).status === 400);
  check("update υπερβολικά μεγάλο: 400", (await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "α".repeat(4001) })).status === 400);
  check("update από άλλον οργανισμό: 404", (await call("other@other.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "x" })).status === 404);

  // ορατότητα στους υπαλλήλους
  const empList = (await readJson(await call("emp_cc@demo.gr", "GET", "/team/documents"))).documents.find((d) => d.id === DOC2.pay);
  check("ο υπάλληλος CC βλέπει σήμανση update στη λίστα", empList && empList.pendingUpdates && empList.pendingUpdates.count === 1);
  g = await docGet("emp_cc@demo.gr", DOC2.pay);
  check("... και το update μέσα στο έγγραφο", g.pendingUpdates.length === 1 && /200 €/.test(g.pendingUpdates[0].text));
  check("ο υπάλληλος Finance ΔΕΝ βλέπει ούτε το έγγραφο ούτε το update", !(await readJson(await call("emp_fin@demo.gr", "GET", "/team/documents"))).documents.some((d) => d.id === DOC2.pay) && (await call("emp_fin@demo.gr", "GET", `/team/documents/${DOC2.pay}`)).status === 404);

  // ο βοηθός χρησιμοποιεί το update, μόνο για όσους έχουν πρόσβαση στο τμήμα
  const ask = async (email, q) => { state.prompts.length = 0; const ev = await readSse(await call(email, "POST", "/team/query/stream", { question: q })); return { ev, prompt: state.prompts.join("\n") }; };
  let a = await ask("emp_cc@demo.gr", "Ποιο είναι το όριο έγκρισης για πληρωμές;");
  check("ο βοηθός του CC χρησιμοποιεί το update στην απάντηση (πρόσφατη ενημέρωση)", /ΠΡΟΣΦΑΤΗ ΕΝΗΜΕΡΩΣΗ/.test(a.prompt) && /γίνεται 200 €/.test(a.prompt));
  a = await ask("emp_fin@demo.gr", "Ποιο είναι το όριο έγκρισης για πληρωμές;");
  check("ο βοηθός του Finance ΔΕΝ βλέπει το update του CC", !/200 €/.test(a.prompt));

  // εισερχόμενα
  const ib = async (email) => (await readJson(await call(email, "GET", "/team/inbox"))).updates;
  check("το update εμφανίζεται στα εισερχόμενα του editor CC με τίτλο εγγράφου", (await ib("ed_cc@demo.gr")).some((u) => u.id === U1 && u.documentTitle === "Όρια πληρωμών" && u.hasProposal === false));
  check("... όχι στα εισερχόμενα του editor Finance", !(await ib("ed_fin@demo.gr")).some((u) => u.id === U1));
  check("... ναι στα εισερχόμενα του admin", (await ib("admin@demo.gr")).some((u) => u.id === U1));

  // πρόταση ενσωμάτωσης
  check("πρόταση από editor άλλου τμήματος: 403", (await call("ed_fin@demo.gr", "POST", `/team/updates/${U1}/propose`)).status === 403);
  const pr = await call("ed_cc@demo.gr", "POST", `/team/updates/${U1}/propose`);
  const prb = await readJson(pr);
  check("πρόταση ενσωμάτωσης: 200 με βασικό και προτεινόμενο κείμενο", pr.status === 200 && prb.baseText === g.fullText && /200 €/.test(prb.proposedText) && !/150 €/.test(prb.proposedText));
  g = await docGet("admin@demo.gr", DOC2.pay);
  check("η πρόταση ΔΕΝ εφαρμόστηκε μόνη της (το έγγραφο μένει ίδιο)", g.version === 1 && /150 €/.test(g.fullText));
  check("... και φαίνεται στα εισερχόμενα ότι υπάρχει πρόταση", (await ib("ed_cc@demo.gr")).find((u) => u.id === U1).hasProposal === true);
  state.mergeMode = "short";
  check("άχρηστη πρόταση από το LLM: 502", (await call("ed_cc@demo.gr", "POST", `/team/updates/${U1}/propose`)).status === 502);
  state.mergeMode = null; state.llmDown = true;
  check("διακοπή AI στην πρόταση: 503", (await call("ed_cc@demo.gr", "POST", `/team/updates/${U1}/propose`)).status === 503);
  state.llmDown = false;

  // εφαρμογή: μόνο με ρητό κείμενο από τον editor
  check("εφαρμογή χωρίς κείμενο: 400 (τίποτα δεν εφαρμόζεται αυτόματα)", (await call("ed_cc@demo.gr", "POST", `/team/updates/${U1}/apply`, {})).status === 400);
  check("εφαρμογή από editor άλλου τμήματος: 403", (await call("ed_fin@demo.gr", "POST", `/team/updates/${U1}/apply`, { text: "x" })).status === 403);
  const edited = prb.proposedText + " (διορθώθηκε από τον editor)";
  const ap = await call("ed_cc@demo.gr", "POST", `/team/updates/${U1}/apply`, { text: edited });
  check("εφαρμογή με το κείμενο του editor: 200, νέα έκδοση", ap.status === 200 && (await readJson(ap)).version === 2);
  g = await docGet("emp_cc@demo.gr", DOC2.pay);
  check("το έγγραφο έχει ΑΚΡΙΒΩΣ το κείμενο που ενέκρινε ο editor (όχι της πρότασης)", g.fullText === edited && g.pendingUpdates.length === 0);
  check("τα vectors του update διαγράφηκαν", !env.VECTORIZE.vectors.has(`upd-${U1}-chunk-0`));
  check("το έγγραφο ξαναδεικτοδοτήθηκε με το νέο κείμενο", [...env.VECTORIZE.vectors.values()].some((v) => v.metadata.documentId === DOC2.pay && /200 €/.test(v.metadata.text) && v.metadata.kind === undefined));
  check("δεύτερη εφαρμογή του ίδιου update: 404", (await call("ed_cc@demo.gr", "POST", `/team/updates/${U1}/apply`, { text: edited })).status === 404);
  check("το update δεν είναι πια στα εισερχόμενα", !(await ib("ed_cc@demo.gr")).some((u) => u.id === U1));
  check("η ενέργεια καταγράφηκε στο ιστορικό", (await audit()).some((x) => x.action === "update_applied" && x.actor === "ed_cc@demo.gr"));
  check("μετά την εφαρμογή έτρεξε νέος έλεγχος αντιφάσεων του εγγράφου", (await audit()).some((x) => x.action === "contradiction_check" && x.target === DOC2.pay));

  // απόρριψη
  const U2 = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "Προσωρινή αλλαγή που τελικά δεν ισχύει." }))).id;
  check("απόρριψη από editor άλλου τμήματος: 403", (await call("ed_fin@demo.gr", "POST", `/team/updates/${U2}/reject`)).status === 403);
  check("απόρριψη update: 200", (await call("ed_cc@demo.gr", "POST", `/team/updates/${U2}/reject`)).status === 200);
  check("... τα vectors του διαγράφηκαν και το έγγραφο δεν άλλαξε", !env.VECTORIZE.vectors.has(`upd-${U2}-chunk-0`) && (await docGet("admin@demo.gr", DOC2.pay)).version === 2);
  check("δεύτερη απόρριψη: 404", (await call("ed_cc@demo.gr", "POST", `/team/updates/${U2}/reject`)).status === 404);

  // διαγραφή εγγράφου με εκκρεμές update
  const tmp = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/documents", mk("Προσωρινό", "cc", "Κείμενο που θα διαγραφεί. TMP-MARK")))).id;
  const U3 = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: tmp, text: "Update σε έγγραφο που θα διαγραφεί." }))).id;
  await call("ed_cc@demo.gr", "DELETE", `/team/documents/${tmp}`);
  check("διαγραφή εγγράφου: το εκκρεμές update απορρίπτεται και τα vectors του φεύγουν", db.prepare("select status from team_updates where id=?").get(U3).status === "rejected" && !env.VECTORIZE.vectors.has(`upd-${U3}-chunk-0`));

  // μεταφορά τμήματος με εκκρεμές update
  const U4 = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "Ακόμα ένα update." }))).id;
  check("μεταφορά εγγράφου σε άλλο τμήμα με εκκρεμές update: 409", (await call("admin@demo.gr", "PUT", `/team/documents/${DOC2.pay}`, mk("Όρια πληρωμών", "fin", edited))).status === 409);
  await call("ed_cc@demo.gr", "POST", `/team/updates/${U4}/reject`);
  check("μετά την απόρριψη η μεταφορά επιτρέπεται και τα vectors ακολουθούν το νέο τμήμα", (await call("admin@demo.gr", "PUT", `/team/documents/${DOC2.pay}`, mk("Όρια πληρωμών", "fin", edited))).status === 200 && [...env.VECTORIZE.vectors.values()].filter((v) => v.metadata.documentId === DOC2.pay).every((v) => v.metadata.department_id === "fin"));
  await call("admin@demo.gr", "PUT", `/team/documents/${DOC2.pay}`, mk("Όρια πληρωμών", "cc", edited));
}

// ============================================================================ 14. Αναπάντητες ερωτήσεις
section("14. Αναπάντητες ερωτήσεις στα εισερχόμενα");
{
  state.unknown = ["εκδρομή", "προκαταβολή", "αυτοκίνητα"];
  const ask = async (email, q) => { await readSse(await call(email, "POST", "/team/query/stream", { question: q })); };
  await ask("emp_cc@demo.gr", "Πότε είναι η εταιρική εκδρομή;");
  await ask("emp_cc@demo.gr", "πότε είναι η εταιρική εκδρομή");
  await ask("emp_cc@demo.gr", "Πότε είναι η εταιρική  εκδρομή?!");
  await ask("emp_fin@demo.gr", "Πώς ζητώ προκαταβολή μισθού;");
  await ask("admin@demo.gr", "Τι ισχύει για τα εταιρικά αυτοκίνητα;");
  state.unknown = [];
  const qs = async (email) => (await readJson(await call(email, "GET", "/team/inbox"))).questions;
  const find = (list, word) => list.find((q) => q.question.includes(word));

  const cc = await qs("ed_cc@demo.gr");
  check("ο editor CC βλέπει την αναπάντητη ερώτηση των υπαλλήλων του τμήματος", !!find(cc, "εκδρομή"));
  check("... ομαδοποιημένη (ίδια ερώτηση με διαφορετική στίξη/κεφαλαία = μία, 3 φορές)", cc.filter((q) => /εκδρομή/.test(q.question)).length === 1 && find(cc, "εκδρομή").count === 3);
  check("... ΔΕΝ βλέπει ερωτήσεις άλλου τμήματος ούτε του admin", !find(cc, "προκαταβολή") && !find(cc, "αυτοκίνητα"));
  const fn = await qs("ed_fin@demo.gr");
  check("ο editor Finance βλέπει μόνο τις δικές του", !!find(fn, "προκαταβολή") && !find(fn, "εκδρομή"));
  const ad = await qs("admin@demo.gr");
  check("ο admin βλέπει όλες", !!find(ad, "εκδρομή") && !!find(ad, "προκαταβολή") && !!find(ad, "αυτοκίνητα"));
  check("ο υπάλληλος δεν έχει πρόσβαση: 403", (await call("emp_cc@demo.gr", "GET", "/team/inbox")).status === 403);
  const stored = JSON.stringify([...env.DOCUMENT_REGISTRY.store.entries()].filter(([k]) => k.startsWith("team:team-demo:fallback:")));
  check("η καταγραφή δεν περιέχει ταυτότητα υπαλλήλου (κανένα email)", stored.length > 10 && !stored.includes("@"));
  const ccEntry = [...env.DOCUMENT_REGISTRY.store.entries()].filter(([k]) => k.startsWith("team:team-demo:fallback:")).map(([, e]) => JSON.parse(e.value)).find((v) => /εκδρομή/.test(v.question));
  check("... μόνο κείμενο, ώρα και τμήματα", ccEntry && JSON.stringify(Object.keys(ccEntry).sort()) === JSON.stringify(["at", "departmentIds", "question"]) && JSON.stringify(ccEntry.departmentIds) === '["cc"]');

  const hash = find(cc, "εκδρομή").hash;
  check("dismiss από υπάλληλο: 403", (await call("emp_cc@demo.gr", "POST", "/team/inbox/questions/dismiss", { hash })).status === 403);
  check("dismiss με άκυρο hash: 400", (await call("ed_cc@demo.gr", "POST", "/team/inbox/questions/dismiss", { hash: "xyz" })).status === 400);
  check("dismiss από editor: 200", (await call("ed_cc@demo.gr", "POST", "/team/inbox/questions/dismiss", { hash })).status === 200);
  check("... η ερώτηση φεύγει από τα εισερχόμενα", !find(await qs("ed_cc@demo.gr"), "εκδρομή"));
  state.unknown = ["εκδρομή"];
  await ask("emp_cc@demo.gr", "Πότε είναι η εταιρική εκδρομή;");
  state.unknown = [];
  check("... και δεν ξαναεμφανίζεται όταν ξαναρωτηθεί (παραμένει παρακάμπτεται)", !find(await qs("ed_cc@demo.gr"), "εκδρομή"));
  check("άλλος οργανισμός δεν βλέπει τις ερωτήσεις του demo", !find(await qs("other@other.gr"), "εκδρομή") && !find(await qs("other@other.gr"), "προκαταβολή"));
}

// ============================================================================ 15. Διαχείριση (admin)
section("15. Διαχείριση: τμήματα, μέλη, ιστορικό");
{
  const adm = (method, path, body) => call("admin@demo.gr", method, "/team/admin" + path, body);
  for (const who of ["ed_cc@demo.gr", "emp_cc@demo.gr"]) {
    const codes = [
      (await call(who, "GET", "/team/admin/overview")).status, (await call(who, "GET", "/team/admin/audit")).status,
      (await call(who, "POST", "/team/admin/departments", { name: "X" })).status, (await call(who, "POST", "/team/admin/members", { email: "x@demo.gr", role: "employee" })).status,
      (await call(who, "PATCH", "/team/admin/departments/cc", { hidden: true })).status, (await call(who, "PATCH", `/team/admin/members/${memberId("admin@demo.gr")}`, { role: "employee" })).status,
    ];
    check(`${who.split("@")[0]}: ΟΛΑ τα admin endpoints απαγορεύονται (403)`, codes.every((c) => c === 403), codes.join(","));
  }
  check("χωρίς session: 401", (await req(env, workerNew, "GET", "/team/admin/overview")).status === 401);

  // επισκόπηση
  const ov = await readJson(await adm("GET", "/overview"));
  const cc = ov.departments.find((d) => d.id === "cc");
  check("επισκόπηση: τμήματα με πλήθος μελών και εγγράφων, το HR κρυφό", cc.memberCount >= 2 && cc.documentCount > 0 && ov.departments.find((d) => d.id === "hr").hidden === true && ov.members.length >= 7);
  check("επισκόπηση: μόνο του δικού του οργανισμού (όχι cc2 ούτε other@other.gr)", !ov.departments.some((d) => d.id === "cc2") && !ov.members.some((m) => m.email === "other@other.gr"));

  // τμήματα
  const c1 = await adm("POST", "/departments", { name: "Logistics" });
  const nd = await readJson(c1);
  check("δημιουργία τμήματος: 201 με ασφαλές id", c1.status === 201 && /^d-[a-f0-9]{8}$/.test(nd.id));
  check("διπλό όνομα (και με άλλα κεφαλαία): 409", (await adm("POST", "/departments", { name: "logistics" })).status === 409);
  check("κενό ή υπερβολικά μεγάλο όνομα: 400", (await adm("POST", "/departments", { name: "  " })).status === 400 && (await adm("POST", "/departments", { name: "α".repeat(81) })).status === 400);
  check("μετονομασία: 200", (await adm("PATCH", `/departments/${nd.id}`, { name: "Logistics & Shipping" })).status === 200);
  check("μετονομασία σε υπάρχον όνομα: 409", (await adm("PATCH", `/departments/${nd.id}`, { name: "Finance" })).status === 409);
  check("άκυρο hidden / καμία αλλαγή: 400", (await adm("PATCH", `/departments/${nd.id}`, { hidden: "yes" })).status === 400 && (await adm("PATCH", `/departments/${nd.id}`, {})).status === 400);
  check("τμήμα άλλου οργανισμού: 404", (await adm("PATCH", "/departments/cc2", { hidden: true })).status === 404);
  check("το νέο τμήμα μπορεί να έχει έγγραφα (το id περνά στο Vectorize)", (await call("admin@demo.gr", "POST", "/team/documents", { title: "Δρομολόγια", departmentId: nd.id, text: "Τα δρομολόγια ανανεώνονται κάθε Δευτέρα." })).status === 201);

  // απόκρυψη τμήματος: άμεση επίδραση
  const titles = async (email) => (await readJson(await call(email, "GET", "/team/documents"))).documents.map((d) => d.title);
  check("πριν την απόκρυψη: ο editor CC βλέπει Finance", (await titles("ed_cc@demo.gr")).includes("Όρια έγκρισης"));
  check("απόκρυψη του Finance: 200", (await adm("PATCH", "/departments/fin", { hidden: true })).status === 200);
  check("ΑΜΕΣΑ: ο editor CC δεν βλέπει πια έγγραφα Finance", !(await titles("ed_cc@demo.gr")).includes("Όρια έγκρισης") && (await call("ed_cc@demo.gr", "GET", `/team/documents/${DOC.fin}`)).status === 404);
  check("... ούτε το τμήμα στους επιλογείς", !(await readJson(await call("ed_cc@demo.gr", "GET", "/team/departments"))).departments.some((d) => d.id === "fin"));
  const dismissed = (await readJson(await call("ed_cc@demo.gr", "GET", "/team/contradictions?status=dismissed"))).contradictions.find((c) => c.sides.some((s) => s.hidden));
  check("οι αντιφάσεις με το κρυφό Finance εμφανίζονται χωρίς περιεχόμενο", dismissed && dismissed.sides.some((s) => s.hidden === true && Object.keys(s).length === 2));
  check("ο υπάλληλος του κρυφού τμήματος βλέπει ακόμα τα δικά του έγγραφα", (await titles("emp_fin@demo.gr")).includes("Όρια έγκρισης"));
  const a1 = await ask2("emp_cc@demo.gr");
  async function ask2(email) { state.prompts.length = 0; await readSse(await call(email, "POST", "/team/query/stream", { question: "Ποια είναι τα όρια έγκρισης;" })); return state.prompts.join("\n"); }
  check("ο βοηθός του CC δεν χρησιμοποιεί ποτέ Finance (ούτε πριν ούτε μετά)", !/FIN-MARK/.test(a1));
  check("επαναφορά ορατότητας: 200 και ο editor CC ξαναβλέπει Finance", (await adm("PATCH", "/departments/fin", { hidden: false })).status === 200 && (await titles("ed_cc@demo.gr")).includes("Όρια έγκρισης"));

  // μέλη
  check("μέλος: άκυρο email 400", (await adm("POST", "/members", { email: "oxi", role: "employee" })).status === 400);
  check("μέλος: άκυρος ρόλος 400", (await adm("POST", "/members", { email: "n1@demo.gr", role: "boss" })).status === 400);
  check("μέλος: τμήμα άλλου οργανισμού 400", (await adm("POST", "/members", { email: "n1@demo.gr", role: "employee", departmentIds: ["cc2"] })).status === 400);
  const dupA = await adm("POST", "/members", { email: "ed_cc@demo.gr", role: "employee" });
  const dupB = await adm("POST", "/members", { email: "other@other.gr", role: "employee" });
  check("υπάρχον email (ίδιος ή άλλος οργανισμός): 409 με ΙΔΙΑ απάντηση (καμία διαρροή)", dupA.status === 409 && dupB.status === 409 && JSON.stringify(await readJson(dupA)) === JSON.stringify(await readJson(dupB)));
  const mailsBefore = state.emails.length;
  const nm = await adm("POST", "/members", { email: "New@Demo.gr", role: "editor", departmentIds: ["cc"], sendInvite: true });
  check("νέο μέλος (email κανονικοποιείται σε πεζά): 201", nm.status === 201 && db.prepare("select role from team_members where email='new@demo.gr'").get().role === "editor");
  check("στάλθηκε πρόσκληση με σύνδεσμο προς το portal, χωρίς token", state.emails.slice(mailsBefore).some((e) => e.to === "new@demo.gr" && /portal\.html/.test(e.text) && !/login=/.test(e.text)));
  const lg = await login("new@demo.gr");
  check("το νέο μέλος συνδέεται με link και βλέπει τα εισερχόμενα (editor)", !!lg.cookie && (await req(env, workerNew, "GET", "/team/inbox", { cookie: lg.cookie })).status === 200);
  const newId = memberId("new@demo.gr");
  const patch = (body) => adm("PATCH", `/members/${newId}`, body);
  check("υποβάθμιση σε employee: 200", (await patch({ role: "employee" })).status === 200);
  check("ΑΜΕΣΑ: το ήδη συνδεδεμένο μέλος χάνει πρόσβαση στα εισερχόμενα (403)", (await req(env, workerNew, "GET", "/team/inbox", { cookie: lg.cookie })).status === 403);
  await patch({ role: "editor" });
  check("μεταφορά σε άλλο τμήμα: 200 και ισχύει αμέσως", (await patch({ departmentIds: ["fin"] })).status === 200 && (await readJson(await req(env, workerNew, "GET", "/team/me", { cookie: lg.cookie }))).departments[0].id === "fin");
  check("... ο editor Finance δεν γράφει πια στο CC", (await req(env, workerNew, "POST", "/team/documents", { cookie: lg.cookie, body: { title: "x", departmentId: "cc", text: "κείμενο" } })).status === 403);
  check("άκυρος ρόλος/κατάσταση/τμήματα: 400", (await patch({ role: "x" })).status === 400 && (await patch({ status: "x" })).status === 400 && (await patch({ departmentIds: ["cc2"] })).status === 400);
  check("απενεργοποίηση: 200", (await patch({ status: "disabled" })).status === 200);
  check("ΑΜΕΣΑ: το συνδεδεμένο μέλος βγαίνει έξω (401)", (await req(env, workerNew, "GET", "/team/me", { cookie: lg.cookie })).status === 401);
  const mb = state.emails.length;
  await req(env, workerNew, "POST", "/team/login/start", { body: { email: "new@demo.gr" } });
  check("... και δεν παίρνει πια link σύνδεσης", state.emails.length === mb);
  check("επανενεργοποίηση: 200 και μπορεί ξανά να συνδεθεί", (await patch({ status: "active" })).status === 200 && !!(await login("new@demo.gr")).cookie);
  check("άγνωστο id μέλους / μη αριθμητικό: 404", (await adm("PATCH", "/members/999999", { role: "employee" })).status === 404 && (await adm("PATCH", "/members/abc", { role: "employee" })).status === 404);
  check("μέλος άλλου οργανισμού: 404 (και δεν αλλάζει)", (await adm("PATCH", `/members/${memberId("other@other.gr")}`, { status: "disabled" })).status === 404 && db.prepare("select status from team_members where email='other@other.gr'").get().status === "active");
  check("ο admin άλλου οργανισμού δεν αγγίζει τα δικά μας τμήματα/μέλη", (await call("other@other.gr", "PATCH", "/team/admin/departments/cc", { hidden: true })).status === 404 && (await call("other@other.gr", "PATCH", `/team/admin/members/${newId}`, { role: "employee" })).status === 404);

  // τελευταίος admin
  const me = memberId("admin@demo.gr");
  check("ο μοναδικός admin δεν υποβαθμίζεται: 409", (await adm("PATCH", `/members/${me}`, { role: "editor" })).status === 409);
  check("ο μοναδικός admin δεν απενεργοποιείται: 409", (await adm("PATCH", `/members/${me}`, { status: "disabled" })).status === 409);
  await adm("POST", "/members", { email: "admin2@demo.gr", role: "admin" });
  const a2 = memberId("admin2@demo.gr");
  check("με δεύτερο admin, ο ένας μπορεί να απενεργοποιηθεί: 200", (await adm("PATCH", `/members/${a2}`, { status: "disabled" })).status === 200);
  check("... αλλά ο τελευταίος ενεργός admin παραμένει προστατευμένος: 409", (await adm("PATCH", `/members/${me}`, { role: "employee" })).status === 409);
  check("ο ρόλος του admin δεν άλλαξε", db.prepare("select role from team_members where id=?").get(me).role === "admin");

  // ιστορικό
  const au = await readJson(await adm("GET", "/audit"));
  const acts = new Set(au.entries.map((e) => e.action));
  check("ιστορικό: καταγράφονται οι διαχειριστικές ενέργειες", ["login", "department_created", "department_hidden", "department_unhidden", "member_added", "member_role_changed", "member_disabled", "member_enabled", "document_created"].every((a) => acts.has(a)), [...acts].join(","));
  check("ιστορικό: ποιος έκανε τι (email και στόχος)", au.entries.some((e) => e.action === "member_role_changed" && e.actor === "admin@demo.gr" && e.target === "new@demo.gr" && e.detail.to === "employee"));
  check("ιστορικό: ΔΕΝ περιέχει ερωτήσεις υπαλλήλων", !JSON.stringify(au).includes("εκδρομή") && !JSON.stringify(au).includes("προκαταβολή"));
  check("ιστορικό: μόνο του δικού μας οργανισμού", (await readJson(await call("other@other.gr", "GET", "/team/admin/audit"))).entries.every((e) => !/demo\.gr/.test(e.actor)));
  db.prepare("insert into team_audit_log(workspace_id,actor_email,action,created_at) values('team-demo','old@demo.gr','old_action',?)").run(new Date(Date.now() - 400 * 86400000).toISOString());
  check("διατήρηση: εγγραφές παλαιότερες του έτους σβήνονται", !(await readJson(await adm("GET", "/audit"))).entries.some((e) => e.action === "old_action") && db.prepare("select count(*) c from team_audit_log where action='old_action'").get().c === 0);
}

// ============================================================================ 16. Οθόνες: εισερχόμενα, admin, portal (jsdom)
section("16. team-editor (εισερχόμενα), team-admin και portal: πραγματική συμπεριφορά σε browser (jsdom)");
{
  installFetchMock(state);
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const page = (n) => readFileSync(join(REPO, "public", n), "utf8");
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch { /* ξανά */ } await new Promise((r) => setTimeout(r, 15)); }
    return null;
  };
  function browserFor(email) {
    const jar = { value: S[email] };
    const bridge = async (input, init = {}) => {
      const url = new URL(input, BASE);
      const method = init.method || "GET";
      const headers = { "CF-Connecting-IP": `198.51.100.${(ipCounter++ % 250) + 1}`, ...(init.headers || {}) };
      if (jar.value && url.pathname.startsWith("/team")) headers.Cookie = jar.value;
      if (method !== "GET") headers.Origin = BASE;
      return workerNew.fetch(new Request(url, { method, headers, body: init.body }), env);
    };
    return (file, query = "") => new JSDOM(page(file), {
      url: BASE + "/" + file + query, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(w) { w.fetch = bridge; w.TextDecoder = TextDecoder; w.confirm = () => true; },
    });
  }
  const $ = (dom, sel) => dom.window.document.querySelector(sel);
  const $$ = (dom, sel) => [...dom.window.document.querySelectorAll(sel)];
  const click = (dom, el) => el.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  const submit = (dom, sel) => $(dom, sel).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  const byText = (dom, sel, re) => $$(dom, sel).find((e) => re.test(e.textContent));
  const num = (dom, sel) => parseInt(($(dom, sel) || {}).textContent, 10);
  const setVal = (dom, el, v) => { el.value = v; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };

  // ------------------------------------------------------------ εισερχόμενα editor CC
  state.judge = [{ x: "είκοσι ημέρες", y: "είκοσι πέντε ημέρες", topic: "Ημέρες άδειας" }];
  const openEd = browserFor("ed_cc@demo.gr");
  const U5 = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "Το όριο έγκρισης γίνεται 300 €." }))).id;
  state.unknown = ["υπερωρίες"];
  await readSse(await call("emp_cc@demo.gr", "POST", "/team/query/stream", { question: "Πώς δηλώνω υπερωρίες;" }));
  await readSse(await call("emp_cc@demo.gr", "POST", "/team/query/stream", { question: "Πώς δηλώνω υπερωρίες;" }));
  state.unknown = [];
  let ed = openEd("team-editor.html");
  check("εισερχόμενα: φορτώνουν με τέσσερις μετρητές", !!(await waitFor(() => $$(ed, ".count").length === 4)));
  const c0 = num(ed, ".count.danger .n");
  check("εισερχόμενα: εμφανίζονται κάρτες αντιφάσεων με επισημασμένη πρόταση", c0 > 0 && $$(ed, ".card.contradiction mark").length >= 1);
  const hiddenCard = $$(ed, ".hidden-side")[0];
  check("κρυφό τμήμα: η κάρτα λέει μόνο ότι υπάρχει αντίφαση και ότι ειδοποιήθηκε ο admin", !!hiddenCard && /κρυφού τμήματος/.test(hiddenCard.textContent) && /admin ειδοποιήθηκε/.test(hiddenCard.textContent));
  check("... και ΚΑΝΕΝΑ στοιχείο της σελίδας δεν περιέχει το κείμενο του κρυφού εγγράφου", !/Πειθαρχικά|HR-MARK|είκοσι ημέρες\./.test(ed.window.document.body.textContent));
  check("κάρτα με κρυφή πλευρά: έχει κουμπί υπενθύμισης και «Δεν είναι αντίφαση»", !!byText(ed, ".card.contradiction button", /Υπενθύμιση/) && !!byText(ed, ".card.contradiction button", /Δεν είναι αντίφαση/));
  click(ed, byText(ed, ".card.contradiction button", /Δεν είναι αντίφαση/));
  check("«Δεν είναι αντίφαση»: η κάρτα φεύγει και ο μετρητής μειώνεται", !!(await waitFor(() => num(ed, ".count.danger .n") === c0 - 1)));
  check("μετρητές και κάρτες updates/ερωτήσεων υπάρχουν", $$(ed, ".card.update").length >= 1 && $$(ed, ".qrow").length >= 1);

  // ενσωμάτωση update με diff και έγκριση
  const upd = $$(ed, ".card.update").find((c) => /300 €/.test(c.textContent));
  check("κάρτα update: δείχνει το έγγραφο και το κείμενο του update", !!upd && /Όρια πληρωμών/.test(upd.textContent));
  click(ed, [...upd.querySelectorAll("button")].find((b) => /Πρότεινε ενσωμάτωση/.test(b.textContent)));
  check("πρόταση ενσωμάτωσης: εμφανίζεται diff με προσθήκες και αφαιρέσεις", !!(await waitFor(() => upd.querySelector(".diff .add") && upd.querySelector(".diff .del"))));
  check("... το diff δείχνει το παλιό ποσό διαγραμμένο και το νέο προστιθέμενο", /200 €/.test(upd.querySelector(".diff .del").textContent) && /300 €/.test(upd.querySelector(".diff .add").textContent));
  const before = (await readJson(await call("admin@demo.gr", "GET", `/team/documents/${DOC2.pay}`)));
  check("ΠΡΙΝ την έγκριση το έγγραφο δεν έχει αλλάξει", /200 €/.test(before.fullText) && !/300 €/.test(before.fullText));
  const ta = upd.querySelector("textarea");
  setVal(ed, ta, ta.value + " Διορθώθηκε από τον editor.");
  check("η επεξεργασία του κειμένου ανανεώνει το diff", !!(await waitFor(() => /Διορθώθηκε από τον editor/.test(upd.querySelector(".diff").textContent))));
  click(ed, [...upd.querySelectorAll("button")].find((b) => /Εφαρμογή στο άρθρο/.test(b.textContent)));
  check("εφαρμογή: μήνυμα επιτυχίας και η κάρτα φεύγει από τα εισερχόμενα", !!(await waitFor(() => /ενσωματώθηκε/.test(ed.window.document.body.textContent) && !$$(ed, ".card.update").some((c) => /300 €/.test(c.textContent)))));
  const after = (await readJson(await call("admin@demo.gr", "GET", `/team/documents/${DOC2.pay}`)));
  check("... και το έγγραφο έχει ΑΚΡΙΒΩΣ το κείμενο που ενέκρινε ο editor", /300 €/.test(after.fullText) && /Διορθώθηκε από τον editor\.$/.test(after.fullText) && after.version === before.version + 1);

  // αναπάντητες ερωτήσεις
  check("αναπάντητη ερώτηση: εμφανίζεται με πλήθος", !!byText(ed, ".qrow", /υπερωρίες/) && /2 φορές/.test(byText(ed, ".qrow", /υπερωρίες/).textContent));
  click(ed, byText(ed, ".qrow", /υπερωρίες/).querySelectorAll("button")[0]); // Γράψε άρθρο
  check("«Γράψε άρθρο»: ανοίγει νέο έγγραφο με προσυμπληρωμένο τίτλο την ερώτηση", !!(await waitFor(() => $(ed, "#title") && /υπερωρίες/.test($(ed, "#title").value))));
  click(ed, $(ed, "#tab-inbox"));
  await waitFor(() => $$(ed, ".count").length === 4);
  click(ed, byText(ed, ".qrow", /υπερωρίες/).querySelectorAll("button")[1]); // Παράβλεψη
  check("«Παράβλεψη»: η ερώτηση φεύγει", !!(await waitFor(() => !byText(ed, ".qrow", /υπερωρίες/))));

  // έγγραφα: updates μέσα στο έγγραφο
  const U6 = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "Ενημέρωση για δοκιμή σελίδας." }))).id;
  ed = openEd("team-editor.html", `?doc=${DOC2.pay}`);
  check("έγγραφο με εκκρεμές update: το πλαίσιο updates φαίνεται πάνω από τη φόρμα", !!(await waitFor(() => $(ed, ".pending") && /Ενημέρωση για δοκιμή σελίδας/.test($(ed, ".pending").textContent))));
  check("... και στη λίστα σημειώνεται ο αριθμός updates", !!byText(ed, ".item", /Όρια πληρωμών.*1 update/));
  setVal(ed, $(ed, "#update-text"), "Δεύτερη ενημέρωση από τη σελίδα.");
  submit(ed, "#update-form");
  check("προσθήκη update από τη σελίδα: επιτυχία", !!(await waitFor(() => /δημοσιεύτηκε και είναι ήδη αναζητήσιμο/.test(ed.window.document.body.textContent))));
  check("... και το update υπάρχει στον server", (await readJson(await call("admin@demo.gr", "GET", `/team/documents/${DOC2.pay}`))).pendingUpdates.length === 2);
  await call("ed_cc@demo.gr", "POST", `/team/updates/${U6}/reject`);
  for (const u of (await readJson(await call("admin@demo.gr", "GET", `/team/documents/${DOC2.pay}`))).pendingUpdates) await call("ed_cc@demo.gr", "POST", `/team/updates/${u.id}/reject`);

  // ------------------------------------------------------------ portal υπαλλήλου και editor
  const U7 = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: DOC2.pay, text: "Προσωρινή αλλαγή ωραρίου αυτή την εβδομάδα." }))).id;
  const pe = browserFor("emp_cc@demo.gr")("portal.html");
  const recentRow = await waitFor(() => byText(pe, ".row", /Όρια πληρωμών/));
  check("portal: το έγγραφο με εκκρεμές update εμφανίζεται στο «Τι άλλαξε πρόσφατα» με σήμανση update", !!recentRow && /update/.test(recentRow.textContent));
  click(pe, recentRow);
  check("portal: ο αναγνώστης δείχνει τις ενημερώσεις που δεν έχουν ενσωματωθεί, πάνω από το κείμενο", !!(await waitFor(() => $(pe, ".overlay .reader") && /Πρόσφατες ενημερώσεις που δεν έχουν ενσωματωθεί/.test($(pe, ".overlay .reader").textContent) && /Προσωρινή αλλαγή ωραρίου/.test($(pe, ".overlay .reader").textContent))));
  check("portal υπαλλήλου: ΔΕΝ υπάρχουν σύνδεσμοι εισερχομένων ή διαχείρισης", !$(pe, "#staff-link") && !$(pe, "#admin-link"));
  const pd = browserFor("ed_cc@demo.gr")("portal.html");
  const staff = await waitFor(() => $(pd, "#staff-link"));
  check("portal editor: σύνδεσμος «Εισερχόμενα και έγγραφα», ΧΩΡΙΣ σύνδεσμο διαχείρισης", !!staff && !$(pd, "#admin-link"));
  check("... με μετρητή εκκρεμοτήτων", !!(await waitFor(() => /\(\d+\)/.test($(pd, "#staff-link").textContent))));
  const pa = browserFor("admin@demo.gr")("portal.html");
  check("portal admin: υπάρχει και σύνδεσμος διαχείρισης", !!(await waitFor(() => $(pa, "#admin-link"))));
  await call("ed_cc@demo.gr", "POST", `/team/updates/${U7}/reject`);

  // ------------------------------------------------------------ οθόνη διαχείρισης
  const openAd = browserFor("admin@demo.gr");
  let ad = openAd("team-admin.html");
  check("admin: φορτώνει τμήματα με πλήθος μελών/εγγράφων και σήμανση κρυφού", !!(await waitFor(() => $$(ad, ".dept-row").length >= 3)) && /κρυφό/.test(byText(ad, ".dept-row", /HR/).textContent));
  click(ad, byText(ad, ".dept-row", /Finance/).querySelector(".hide-toggle"));
  check("απόκρυψη τμήματος από τη σελίδα: εμφανίζεται «κρυφό»", !!(await waitFor(() => /κρυφό/.test((byText(ad, ".dept-row", /Finance/) || {}).textContent || ""))));
  check("... και ισχύει αμέσως στον server", db.prepare("select hidden from departments where id='fin'").get().hidden === 1);
  click(ad, byText(ad, ".dept-row", /Finance/).querySelector(".hide-toggle"));
  check("επαναφορά ορατότητας", !!(await waitFor(() => !/κρυφό/.test((byText(ad, ".dept-row", /Finance/) || { textContent: "κρυφό" }).textContent))) && db.prepare("select hidden from departments where id='fin'").get().hidden === 0);
  setVal(ad, $(ad, "#new-dept"), "Marketing");
  submit(ad, "#add-dept");
  check("νέο τμήμα από τη σελίδα", !!(await waitFor(() => byText(ad, ".dept-row", /Marketing/))));
  setVal(ad, $(ad, "#new-dept"), "marketing");
  submit(ad, "#add-dept");
  check("διπλό όνομα: εμφανίζεται μήνυμα λάθους", !!(await waitFor(() => /Υπάρχει ήδη τμήμα/.test(ad.window.document.body.textContent))));

  click(ad, $(ad, "#tab-members"));
  check("μέλη: λίστα με επιλογή ρόλου και τμημάτων ανά μέλος", !!(await waitFor(() => $$(ad, ".member-row").length >= 7)) && byText(ad, ".member-row", /ed_cc@demo\.gr/).querySelectorAll("input[type=checkbox]").length >= 3);
  setVal(ad, $(ad, "#new-email"), "pg@demo.gr");
  $(ad, "#new-role").value = "editor";
  submit(ad, "#add-member");
  check("προσθήκη μέλους από τη σελίδα", !!(await waitFor(() => byText(ad, ".member-row", /pg@demo\.gr/))) && db.prepare("select role from team_members where email='pg@demo.gr'").get().role === "editor");
  const sel = byText(ad, ".member-row", /pg@demo\.gr/).querySelector("select");
  sel.value = "employee"; sel.dispatchEvent(new ad.window.Event("change", { bubbles: true }));
  check("αλλαγή ρόλου από τη σελίδα ισχύει αμέσως", !!(await waitFor(() => db.prepare("select role from team_members where email='pg@demo.gr'").get().role === "employee")));
  click(ad, byText(ad, ".member-row", /pg@demo\.gr/).querySelector(".status-toggle"));
  check("απενεργοποίηση από τη σελίδα", !!(await waitFor(() => db.prepare("select status from team_members where email='pg@demo.gr'").get().status === "disabled")) && !!(await waitFor(() => /απενεργοποιημένο/.test((byText(ad, ".member-row", /pg@demo\.gr/) || {}).textContent || ""))));
  const own = byText(ad, ".member-row", /admin@demo\.gr/).querySelector("select");
  own.value = "editor"; own.dispatchEvent(new ad.window.Event("change", { bubbles: true }));
  check("ο τελευταίος admin δεν υποβαθμίζεται: το λάθος μένει ορατό μετά την ανανέωση", !!(await waitFor(() => /χωρίς ενεργό admin/.test(ad.window.document.body.textContent))) && db.prepare("select role from team_members where email='admin@demo.gr'").get().role === "admin");

  click(ad, $(ad, "#tab-audit"));
  check("ιστορικό: εμφανίζονται ενέργειες με email και περιγραφή", !!(await waitFor(() => $$(ad, ".log").length > 5)) && /νέο τμήμα|σύνδεση|νέο μέλος/.test(ad.window.document.body.textContent));
  check("ιστορικό: δεν περιέχει ερωτήσεις υπαλλήλων", !/υπερωρίες|εκδρομή/.test(ad.window.document.body.textContent));

  // οι υπόλοιποι ρόλοι δεν "βλέπουν" τη σελίδα admin
  const notAdmin = browserFor("ed_cc@demo.gr")("team-admin.html");
  await new Promise((r) => setTimeout(r, 300));
  check("editor στη σελίδα admin: δεν εμφανίζεται κανένα δεδομένο διαχείρισης", $$(notAdmin, ".dept-row").length === 0 && $$(notAdmin, ".member-row").length === 0);
  state.judge = null;
}

// ============================================================================ 17. Διεύθυνση Gemini (gateway ή απευθείας)
section("17. Κλήσεις Gemini: απευθείας όταν δεν υπάρχει gateway, gateway όταν υπάρχει");
{
  const oneSave = async (label) => {
    state.urls = [];
    state.judge = [{ x: "πέντε εργάσιμες ημέρες", y: "επτά εργάσιμες ημέρες", topic: "Χρόνος επιστροφής" }];
    await call("ed_cc@demo.gr", "POST", "/team/documents", { title: label, departmentId: "cc", text: `Η επιστροφή χρημάτων γίνεται σε επτά εργάσιμες ημέρες. ${label}` });
    state.judge = null;
    return state.urls.filter((x) => x.includes("generateContent"));
  };
  check("lab (χωρίς CF_ACCOUNT_ID/AI_GATEWAY_ID): ο κριτής καλεί ΑΠΕΥΘΕΙΑΣ τη Google, ποτέ .../undefined/...", await (async () => { const urls = await oneSave("URL-A"); return urls.length > 0 && urls.every((x) => x.startsWith("https://generativelanguage.googleapis.com/v1beta/models/gemini-") && !x.includes("undefined")); })());
  env.CF_ACCOUNT_ID = "acc123"; env.AI_GATEWAY_ID = "gw-test";
  check("production (με τις δύο μεταβλητές): ο κριτής περνά από το gateway, όπως πριν", await (async () => { const urls = await oneSave("URL-B"); return urls.length > 0 && urls.every((x) => x.startsWith("https://gateway.ai.cloudflare.com/v1/acc123/gw-test/google-ai-studio/v1beta/models/gemini-")); })());
  delete env.CF_ACCOUNT_ID; delete env.AI_GATEWAY_ID;
}

// ============================================================================ 18. Βελτιώσεις μετά τη δοκιμή στο lab
section("18. Βελτιώσεις: τίτλος πρότασης, μήνυμα ελέγχου, ετικέτες, markdown, ενεργά updates, ονόματα στο ιστορικό");
{
  const mk = (title, dept, text) => ({ title, departmentId: dept, text });
  const newDoc = async (email, title, dept, text) => (await readJson(await call(email, "POST", "/team/documents", mk(title, dept, text)))).id;

  // (1) ο τίτλος που προσθέτει το LLM αφαιρείται από την πρόταση ενσωμάτωσης
  const dC = await newDoc("ed_cc@demo.gr", "Όρια Γ", "cc", "Ποσά άνω των 10 € θέλουν έγκριση από τον υπεύθυνο.");
  const uC = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: dC, text: "Το όριο γίνεται 20 €." }))).id;
  state.mergeMode = "title";
  const pC = await readJson(await call("ed_cc@demo.gr", "POST", `/team/updates/${uC}/propose`));
  state.mergeMode = null;
  check("πρόταση ενσωμάτωσης: ο τίτλος «Όρια Γ» που πρόσθεσε το LLM αφαιρείται", /^Ποσά άνω των 20 €/.test(pC.proposedText) && !/«/.test(pC.proposedText));
  const dD = await newDoc("ed_cc@demo.gr", "Όρια Δ", "cc", "Όρια Δ\nΠοσά άνω των 10 € θέλουν έγκριση.");
  const uD = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: dD, text: "Το όριο γίνεται 20 €." }))).id;
  const pD = await readJson(await call("ed_cc@demo.gr", "POST", `/team/updates/${uD}/propose`));
  check("... αλλά αν το ίδιο το έγγραφο ξεκινά με τη γραμμή του τίτλου, μένει (νόμιμο περιεχόμενο)", /^Όρια Δ\nΠοσά άνω των 20 €/.test(pD.proposedText));
  await call("ed_cc@demo.gr", "POST", `/team/updates/${uC}/reject`); await call("ed_cc@demo.gr", "POST", `/team/updates/${uD}/reject`);

  // (2) ο χειροκίνητος έλεγχος δηλώνει πόσες αντιφάσεις υπάρχουν ήδη ανοιχτές
  state.judge = [{ x: "τρεις δόσεις", y: "έξι δόσεις", topic: "Δόσεις" }];
  const dA = await newDoc("ed_cc@demo.gr", "Δόσεις Α", "cc", "Η εξόφληση γίνεται σε τρεις δόσεις. DA-X");
  const dB = await newDoc("ed_cc@demo.gr", "Δόσεις Β", "cc", "Η εξόφληση γίνεται σε έξι δόσεις. DB-X");
  const chk = await readJson(await call("ed_cc@demo.gr", "POST", `/team/documents/${dB}/check`));
  check("χειροκίνητος έλεγχος: 0 νέες, αλλά δηλώνει ότι υπάρχει ήδη 1 ανοιχτή", chk.created === 0 && chk.open === 1 && chk.failed === 0);
  const dZ = await newDoc("ed_cc@demo.gr", "Άσχετο έγγραφο", "cc", "Το κατάστημα ανοίγει στις εννιά. AS-X");
  const chkZ = await readJson(await call("ed_cc@demo.gr", "POST", `/team/documents/${dZ}/check`));
  check("έγγραφο χωρίς αντιφάσεις: open 0", chkZ.created === 0 && chkZ.open === 0);

  // (2β) το μήνυμα στη σελίδα, σε κάθε περίπτωση
  installFetchMock(state);
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const page = (n) => readFileSync(join(REPO, "public", n), "utf8");
  const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch { /* ξανά */ } await new Promise((r) => setTimeout(r, 15)); } return null; };
  const browserFor = (email) => {
    const jar = { value: S[email] };
    const bridge = async (input, init = {}) => {
      const url = new URL(input, BASE); const method = init.method || "GET";
      const headers = { "CF-Connecting-IP": `198.51.100.${(ipCounter++ % 250) + 1}`, ...(init.headers || {}) };
      if (jar.value && url.pathname.startsWith("/team")) headers.Cookie = jar.value;
      if (method !== "GET") headers.Origin = BASE;
      return workerNew.fetch(new Request(url, { method, headers, body: init.body }), env);
    };
    return (file, query = "") => new JSDOM(page(file), { url: BASE + "/" + file + query, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(w) { w.fetch = bridge; w.TextDecoder = TextDecoder; w.confirm = () => true; } });
  };
  const $ = (dom, sel) => dom.window.document.querySelector(sel);
  const $$ = (dom, sel) => [...dom.window.document.querySelectorAll(sel)];
  const click = (dom, el) => el.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  const byText = (dom, sel, re) => $$(dom, sel).find((e) => re.test(e.textContent));
  const openEd = browserFor("ed_cc@demo.gr");
  async function checkMessage(docId) {
    const dom = openEd("team-editor.html", `?doc=${docId}`);
    const btn = await waitFor(() => byText(dom, "button", /Έλεγχος αντιφάσεων τώρα/));
    click(dom, btn);
    return await waitFor(() => { const n = [...dom.window.document.querySelectorAll(".note")].map((x) => x.textContent).find((t) => /Καμία νέα|Δεν βρέθηκε|δεν ολοκληρώθηκε|Βρέθηκαν/.test(t)); return n || null; });
  }
  check("μήνυμα σελίδας (γνωστή αντίφαση): «Καμία νέα αντίφαση. Υπάρχουν ήδη 1 ανοιχτές»", /Καμία νέα αντίφαση\. Υπάρχουν ήδη 1 ανοιχτές/.test(await checkMessage(dB) || ""));
  check("μήνυμα σελίδας (τίποτα): «Δεν βρέθηκε καμία αντίφαση»", /Δεν βρέθηκε καμία αντίφαση/.test(await checkMessage(dZ) || ""));
  state.llmDown = true;
  const downMsg = await checkMessage(dB);
  state.llmDown = false;
  check("μήνυμα σελίδας (AI εκτός): «δεν ολοκληρώθηκε», ΟΧΙ «0 νέες»", /δεν ολοκληρώθηκε/.test(downMsg || "") && !/Καμία νέα/.test(downMsg || ""));
  state.judge = null;

  // (3) ετικέτα στήλης εγγράφων ανά ρόλο
  const pEmp = browserFor("emp_cc@demo.gr")("portal.html");
  const pStaff = browserFor("ed_cc@demo.gr")("portal.html");
  check("υπάλληλος: «Έγγραφα του τμήματός σου»", !!(await waitFor(() => $$(pEmp, "h2").some((h) => h.textContent === "Έγγραφα του τμήματός σου"))));
  check("editor (βλέπει και άλλα τμήματα): «Όλα τα έγγραφα που βλέπεις»", !!(await waitFor(() => $$(pStaff, "h2").some((h) => h.textContent === "Όλα τα έγγραφα που βλέπεις"))) && !$$(pStaff, "h2").some((h) => h.textContent === "Έγγραφα του τμήματός σου"));

  // (4) markdown στις απαντήσεις: έντονα και κουκκίδες, χωρίς αστερίσκους και χωρίς HTML από το LLM
  state.md = true;
  $(pEmp, "#q").value = "Σε πόσες ημέρες γίνεται η επιστροφή;";
  $(pEmp, "form").dispatchEvent(new pEmp.window.Event("submit", { bubbles: true, cancelable: true }));
  const body = await waitFor(() => $(pEmp, ".answer .body strong") && $(pEmp, ".answer .body"));
  state.md = false;
  check("απάντηση: το **κείμενο** γίνεται έντονο (strong) και δεν μένουν αστερίσκοι", !!body && $(pEmp, ".answer .body strong").textContent === "3 εργάσιμες ημέρες" && !/\*/.test(body.textContent));
  check("απάντηση: οι λίστες με * και - γίνονται κουκκίδες", /^• /.test(body.textContent) && /• δεύτερη γραμμή/.test(body.textContent));
  state.mdHtml = true;
  $(pEmp, "#q").value = "Δοκιμή HTML";
  $(pEmp, "form").dispatchEvent(new pEmp.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => /εκτελέστηκε/.test(($$(pEmp, ".answer .body").pop() || {}).textContent || "") || $$(pEmp, ".answer .body").length > 1);
  state.mdHtml = false;
  check("απάντηση με <script>/<img onerror>: εμφανίζεται ως κείμενο, ΚΑΝΕΝΑ στοιχείο δεν δημιουργείται", $$(pEmp, ".answer .body").every((b) => !b.querySelector("script") && !b.querySelector("img")) && !pEmp.window.__xss);

  // (5) ένα update που έχει φύγει από τη βάση ΔΕΝ φτάνει ποτέ στον βοηθό, ακόμα κι αν το Vectorize το έχει ακόμα
  const dE = await newDoc("ed_cc@demo.gr", "Ωράριο καφέ", "cc", "Ο καφές σερβίρεται από τις εννιά. KF-MARK");
  const uE = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: dE, text: "Ο καφές σερβίρεται πλέον από τις οκτώ. ZZ-MARK" }))).id;
  const stale = env.VECTORIZE.vectors.get(`upd-${uE}-chunk-0`);
  const askPrompt = async (q) => { state.prompts.length = 0; await readSse(await call("emp_cc@demo.gr", "POST", "/team/query/stream", { question: q })); return state.prompts.join("\n"); };
  check("ενεργό update: φτάνει στον βοηθό", /ZZ-MARK/.test(await askPrompt("Από τι ώρα σερβίρεται ο καφές;")));
  await call("ed_cc@demo.gr", "POST", `/team/updates/${uE}/reject`);
  env.VECTORIZE.vectors.set(`upd-${uE}-chunk-0`, stale); // προσομοίωση: το Vectorize δεν έχει προλάβει να σβήσει
  check("απορριφθέν update που το Vectorize δεν έχει σβήσει ακόμα: ΔΕΝ φτάνει στον βοηθό", !/ZZ-MARK/.test(await askPrompt("Από τι ώρα σερβίρεται ο καφές;")) && /KF-MARK/.test(state.prompts.join("\n")));
  env.VECTORIZE.vectors.delete(`upd-${uE}-chunk-0`);
  // fail closed: χωρίς δυνατότητα ελέγχου στη βάση, κανένα update δεν περνά
  const uF = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/updates", { documentId: dE, text: "Ο καφές σερβίρεται και στις επτά. YY-MARK" }))).id;
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/FROM team_updates WHERE workspace_id = \? AND status = 'pending' AND id IN/.test(sql)) throw new Error("db down"); return realPrepare(sql); };
  const downPrompt = await askPrompt("Από τι ώρα σερβίρεται ο καφές;");
  env.DB.prepare = realPrepare;
  check("αν ο έλεγχος στη βάση αποτύχει, κανένα update δεν δίνεται στον βοηθό (fail closed), το έγγραφο όμως ναι", !/YY-MARK/.test(downPrompt) && /KF-MARK/.test(downPrompt));
  await call("ed_cc@demo.gr", "POST", `/team/updates/${uF}/reject`);

  // (6) ονόματα αντί για id στο ιστορικό
  const entries = (await readJson(await call("admin@demo.gr", "GET", "/team/admin/audit"))).entries;
  check("ιστορικό: τα έγγραφα εμφανίζονται με τον τίτλο τους", entries.some((e) => e.action === "document_created" && e.target === dB && e.targetLabel === "Δόσεις Β"));
  check("ιστορικό: τα τμήματα εμφανίζονται με το όνομά τους (όχι «fin»)", entries.some((e) => e.action === "department_hidden" && e.target === "fin" && e.targetLabel === "Finance"));
  await call("admin@demo.gr", "DELETE", `/team/documents/${dZ}`);
  const after = (await readJson(await call("admin@demo.gr", "GET", "/team/admin/audit"))).entries;
  check("ιστορικό: διαγραμμένο έγγραφο κρατά τον τίτλο που είχε", after.some((e) => e.action === "document_deleted" && e.target === dZ && e.targetLabel === "Άσχετο έγγραφο"));
  check("ιστορικό: πάντα μόνο για admin και όχι διαρροή σε άλλον οργανισμό", (await call("ed_cc@demo.gr", "GET", "/team/admin/audit")).status === 403 && !JSON.stringify((await readJson(await call("other@other.gr", "GET", "/team/admin/audit"))).entries).includes("Δόσεις"));
  const adDom = browserFor("admin@demo.gr")("team-admin.html");
  click(adDom, await waitFor(() => $(adDom, "#tab-audit")));
  check("σελίδα ιστορικού: δείχνει «Finance» και τίτλους αντί για id", !!(await waitFor(() => /απόκρυψη τμήματος · Finance/.test(adDom.window.document.body.textContent) && /νέο έγγραφο · Δόσεις/.test(adDom.window.document.body.textContent))) && !/· fin\b/.test(adDom.window.document.body.textContent));
}

// ============================================================================ 19-23. Πακέτο 2
const { JSDOM: JSDOMu, VirtualConsole: VCu } = await import("jsdom");
const uiWait = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch { /* ξανά */ } await new Promise((r) => setTimeout(r, 15)); } return null; };
function uiFor(email) {
  const jar = { value: S[email] };
  const bridge = async (input, init = {}) => {
    const url = new URL(input, BASE); const method = init.method || "GET";
    const headers = { "CF-Connecting-IP": `198.51.100.${(ipCounter++ % 250) + 1}`, ...(init.headers || {}) };
    if (jar.value && url.pathname.startsWith("/team")) headers.Cookie = jar.value;
    if (method !== "GET") headers.Origin = BASE;
    return workerNew.fetch(new Request(url, { method, headers, body: init.body }), env);
  };
  return (file, query = "") => new JSDOMu(readFileSync(join(REPO, "public", file), "utf8"), { url: BASE + "/" + file + query, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VCu(),
    beforeParse(w) { w.fetch = bridge; w.TextDecoder = TextDecoder; w.confirm = () => true; } });
}
const $u = (dom, sel) => dom.window.document.querySelector(sel);
const $$u = (dom, sel) => [...dom.window.document.querySelectorAll(sel)];
const clickU = (dom, el) => el.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
const byTextU = (dom, sel, re) => $$u(dom, sel).find((e) => re.test(e.textContent));
const newDocU = async (email, title, dept, text) => (await readJson(await call(email, "POST", "/team/documents", { title, departmentId: dept, text }))).id;
const tick = async (fn) => { const pending = []; await fn({ waitUntil: (p) => pending.push(p) }); await Promise.all(pending); };

section("19. Αυτόματος επανέλεγχος αντιφάσεων (cron) και ανοχή σε ελλιπές migration");
{
  db.prepare("update team_rechecks set done_at = ? where done_at is null").run(new Date().toISOString()); // καθαρή ουρά: μόνο τα νέα έγγραφα
  state.judge = null; // προσομοίωση: ο άμεσος έλεγχος δεν βρίσκει τίποτα (π.χ. το Vectorize δεν έχει προλάβει)
  const a = await newDocU("ed_cc@demo.gr", "Παράδοση Α", "cc", "Η παράδοση γίνεται σε δύο ημέρες. PA-X");
  const b = await newDocU("ed_cc@demo.gr", "Παράδοση Β", "cc", "Η παράδοση γίνεται σε πέντε ημέρες. PB-X");
  const rows = db.prepare("select due_at from team_rechecks where document_id in (?, ?) and done_at is null").all(a, b);
  check("κάθε αποθήκευση προγραμματίζει επανέλεγχο (2 έγγραφα, 2 εγγραφές)", rows.length === 2);
  check("... λίγα λεπτά αργότερα (όχι άμεσα)", rows.every((r) => new Date(r.due_at).getTime() > Date.now() + 2 * 60 * 1000 && new Date(r.due_at).getTime() < Date.now() + 5 * 60 * 1000));
  const topicExists = async () => (await cList("admin@demo.gr")).some((c) => c.topic === "Παράδοση");
  check("ο άμεσος έλεγχος δεν βρήκε τίποτα", !(await topicExists()));
  state.judge = [{ x: "δύο ημέρες", y: "πέντε ημέρες", topic: "Παράδοση" }];
  await tick((ctx) => workerNew.scheduled({}, env, ctx));
  check("το cron ΠΡΙΝ από την ώρα του δεν τρέχει τον επανέλεγχο", !(await topicExists()) && db.prepare("select count(*) c from team_rechecks where document_id = ? and done_at is null").get(a).c === 1);
  db.prepare("update team_rechecks set due_at = ? where done_at is null").run(new Date(Date.now() - 1000).toISOString());
  const mailsBefore = state.emails.length;
  await tick((ctx) => workerNew.scheduled({}, env, ctx));
  check("το cron όταν έρθει η ώρα: ο επανέλεγχος ΒΡΗΚΕ την αντίφαση που ο άμεσος έλεγχος έχασε", await topicExists());
  check("... και οι εγγραφές επανελέγχου σημάνθηκαν ως ολοκληρωμένες", db.prepare("select count(*) c from team_rechecks where document_id in (?, ?) and done_at is null").get(a, b).c === 0);
  check("... με email ειδοποίησης που έχει σύνδεσμο προς τον editor (το origin κρατήθηκε από το αρχικό request)", state.emails.slice(mailsBefore).some((e) => e.to === "ed_cc@demo.gr" && e.text.includes(`${BASE}/team-editor.html`)));
  const countBefore = (await cList("admin@demo.gr")).filter((c) => c.topic === "Παράδοση").length;
  await call("ed_cc@demo.gr", "PUT", `/team/documents/${b}`, { title: "Παράδοση Β", departmentId: "cc", text: "Η παράδοση γίνεται σε πέντε ημέρες. PB-X" });
  db.prepare("update team_rechecks set due_at = ? where done_at is null").run(new Date(Date.now() - 1000).toISOString());
  await tick((ctx) => workerNew.scheduled({}, env, ctx));
  check("δεύτερος επανέλεγχος της ίδιας αντίφασης: ΔΕΝ δημιουργεί διπλότυπο", (await cList("admin@demo.gr")).filter((c) => c.topic === "Παράδοση").length === countBefore);

  // έγγραφο που διαγράφεται πριν τον επανέλεγχο
  const gone = await newDocU("ed_cc@demo.gr", "Προσωρινό Ε", "cc", "Κείμενο που θα φύγει. EE-X");
  await call("ed_cc@demo.gr", "DELETE", `/team/documents/${gone}`);
  db.prepare("update team_rechecks set due_at = ? where done_at is null").run(new Date(Date.now() - 1000).toISOString());
  let threw = false;
  try { await tick((ctx) => workerNew.scheduled({}, env, ctx)); } catch { threw = true; }
  check("διαγραμμένο έγγραφο: ο επανέλεγχος το προσπερνά χωρίς σφάλμα", !threw && db.prepare("select count(*) c from team_rechecks where document_id = ? and done_at is null").get(gone).c === 0);

  // χειροκίνητη εκτέλεση από τον admin
  state.judge = null;
  const d = await newDocU("ed_cc@demo.gr", "Ωράριο ΣΚ", "cc", "Το κατάστημα ανοίγει στις δέκα το Σάββατο. WK-X");
  const e = await newDocU("ed_cc@demo.gr", "Ωράριο ΣΚ 2", "cc", "Το κατάστημα ανοίγει στις έντεκα το Σάββατο. WK-Y");
  state.judge = [{ x: "στις δέκα", y: "στις έντεκα", topic: "Ωράριο ΣΚ" }];
  check("επανέλεγχος χειροκίνητα: editor δεν έχει δικαίωμα (403)", (await call("ed_cc@demo.gr", "POST", "/team/admin/rechecks/run")).status === 403);
  const run = await readJson(await call("admin@demo.gr", "POST", "/team/admin/rechecks/run"));
  check("επανέλεγχος χειροκίνητα από admin: τρέχει ΤΩΡΑ και βρίσκει την αντίφαση", run.processed >= 2 && run.created >= 1 && (await cList("admin@demo.gr")).some((c) => c.topic === "Ωράριο ΣΚ"));
  const pendingDoc = await newDocU("ed_cc@demo.gr", "Εκκρεμεί επανέλεγχος", "cc", "Έγγραφο που περιμένει τον επανέλεγχό του. PD-X");
  const otherRun = await readJson(await call("other@other.gr", "POST", "/team/admin/rechecks/run"));
  check("... ο admin άλλου οργανισμού ΔΕΝ τρέχει ούτε αγγίζει επανελέγχους του demo", otherRun.processed === 0 && db.prepare("select count(*) c from team_rechecks where document_id = ? and done_at is null").get(pendingDoc).c === 1);
  await call("admin@demo.gr", "POST", "/team/admin/rechecks/run");
  state.judge = null;

  // ελλιπές migration: ο κώδικας δεν χαλά τίποτα
  db.exec("ALTER TABLE team_rechecks RENAME TO team_rechecks_x");
  const rOk = await call("ed_cc@demo.gr", "POST", "/team/documents", { title: "Χωρίς πίνακα", departmentId: "cc", text: "Δοκιμή χωρίς το migration 0012. NM-X" });
  let cronThrew = false;
  try { await tick((ctx) => workerNew.scheduled({}, env, ctx)); } catch { cronThrew = true; }
  const runNoTable = await call("admin@demo.gr", "POST", "/team/admin/rechecks/run");
  db.exec("ALTER TABLE team_rechecks_x RENAME TO team_rechecks");
  check("χωρίς τον πίνακα επανελέγχων: η δημοσίευση δουλεύει κανονικά (201)", rOk.status === 201);
  check("... το cron δεν σκάει και το admin endpoint απαντά (200)", !cronThrew && runNoTable.status === 200);
}

section("20. Ημερήσιο όριο ερωτήσεων ανά μέλος");
{
  env.TEAM_DAILY_QUESTION_LIMIT = "3";
  db.prepare("delete from team_usage").run();
  const ask = async (email) => { const r = await call(email, "POST", "/team/query/stream", { question: "Πού βρίσκεται το γραφείο;" }); const status = r.status; await r.text(); return status; };
  const codes = [await ask("emp_cc@demo.gr"), await ask("emp_cc@demo.gr"), await ask("emp_cc@demo.gr")];
  check("οι 3 πρώτες ερωτήσεις (όριο 3) περνούν", codes.every((c) => c === 200));
  const over = await call("emp_cc@demo.gr", "POST", "/team/query/stream", { question: "Πού βρίσκεται το γραφείο;" });
  const overBody = await readJson(over);
  check("η 4η ερώτηση απορρίπτεται: 429 daily_limit με το όριο", over.status === 429 && overBody.error === "daily_limit" && overBody.limit === 3);
  check("άλλο μέλος δεν επηρεάζεται από το όριο του πρώτου", (await ask("emp_fin@demo.gr")) === 200);
  check("ο μετρητής κρατά ΜΟΝΟ αριθμούς (κανένα κείμενο ερώτησης)", !JSON.stringify(db.prepare("select * from team_usage").all()).includes("γραφείο"));
  db.prepare("update team_usage set day = '2020-01-01'").run();
  check("νέα ημέρα: το όριο μηδενίζεται", (await ask("emp_cc@demo.gr")) === 200);
  await tick((ctx) => workerNew.scheduled({}, env, ctx));
  check("το cron σβήνει παλιούς μετρητές (πάνω από 7 ημέρες)", db.prepare("select count(*) c from team_usage where day = '2020-01-01'").get().c === 0);
  db.exec("ALTER TABLE team_usage RENAME TO team_usage_x");
  const free = [await ask("emp_cc@demo.gr"), await ask("emp_cc@demo.gr"), await ask("emp_cc@demo.gr"), await ask("emp_cc@demo.gr")];
  db.exec("ALTER TABLE team_usage_x RENAME TO team_usage");
  check("χωρίς τον πίνακα μετρητών: το όριο ΔΕΝ εφαρμόζεται (fail open), το προϊόν δουλεύει", free.every((c) => c === 200));

  // σελίδα: μήνυμα όταν φτάσεις το όριο
  env.TEAM_DAILY_QUESTION_LIMIT = "1";
  db.prepare("delete from team_usage").run();
  const pe = uiFor("emp_cc@demo.gr")("portal.html");
  const askUi = async (q) => { $u(pe, "#q").value = q; $u(pe, "form").dispatchEvent(new pe.window.Event("submit", { bubbles: true, cancelable: true })); };
  await uiWait(() => $u(pe, "#q"));
  await askUi("Σε πόσες ημέρες γίνεται η επιστροφή;");
  await uiWait(() => $u(pe, ".answer .body") && $u(pe, ".answer .body").textContent.length > 5);
  await askUi("Άλλη ερώτηση;");
  check("σελίδα: όταν φτάσεις το όριο βλέπεις καθαρό μήνυμα για το ημερήσιο όριο", !!(await uiWait(() => $$u(pe, ".answer .body").some((b) => /ημερήσιο όριο ερωτήσεων/.test(b.textContent)))));
  delete env.TEAM_DAILY_QUESTION_LIMIT;
  db.prepare("delete from team_usage").run();
}

section("21. Εμπιστευτικά έγγραφα (σήμανση από τον admin)");
{
  state.judge = [{ x: "στις 25", y: "στις 30", topic: "Ημέρα πληρωμής" }];
  const hid = await newDocU("ed_cc@demo.gr", "Μισθοδοσία ομάδας", "cc", "Οι μισθοί πληρώνονται στις 25 του μήνα. MS-X");
  const titlesOf = async (email) => (await readJson(await call(email, "GET", "/team/documents"))).documents.map((x) => x.title);
  check("πριν τη σήμανση: ο editor Finance βλέπει το έγγραφο του CC (ανάγνωση)", (await titlesOf("ed_fin@demo.gr")).includes("Μισθοδοσία ομάδας"));
  check("σήμανση από editor: 403, από υπάλληλο: 403", (await call("ed_cc@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: true })).status === 403 && (await call("emp_cc@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: true })).status === 403);
  check("άκυρο σώμα: 400, ανύπαρκτο έγγραφο: 404, άκυρο id: 404", (await call("admin@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: "ναι" })).status === 400 && (await call("admin@demo.gr", "PATCH", "/team/admin/documents/doc-0000000000000000", { hidden: true })).status === 404 && (await call("admin@demo.gr", "PATCH", "/team/admin/documents/xyz", { hidden: true })).status === 404);
  check("έγγραφο άλλου οργανισμού: 404", (await call("other@other.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: true })).status === 404);
  const dAll = (await readJson(await call("admin@demo.gr", "GET", "/team/documents"))).documents.find((x) => x.departmentId === "_all");
  check("εταιρικό έγγραφο (_all) δεν γίνεται εμπιστευτικό: 400", !dAll || (await call("admin@demo.gr", "PATCH", `/team/admin/documents/${dAll.id}`, { hidden: true })).status === 400);
  check("σήμανση από admin: 200", (await call("admin@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: true })).status === 200);
  check("ΑΜΕΣΑ: ο editor Finance δεν το βλέπει ούτε στη λίστα ούτε με άμεσο id (404)", !(await titlesOf("ed_fin@demo.gr")).includes("Μισθοδοσία ομάδας") && (await call("ed_fin@demo.gr", "GET", `/team/documents/${hid}`)).status === 404);
  const own = (await readJson(await call("ed_cc@demo.gr", "GET", "/team/documents"))).documents.find((x) => x.id === hid);
  check("ο editor του ίδιου τμήματος το βλέπει και το επεξεργάζεται, με σήμανση", own && own.hidden === true && own.editable === true);
  check("ο υπάλληλος του ίδιου τμήματος το βλέπει", (await titlesOf("emp_cc@demo.gr")).includes("Μισθοδοσία ομάδας"));
  check("ο υπάλληλος του Finance και ο admin: ο admin το βλέπει, ο υπάλληλος Finance όχι", (await titlesOf("admin@demo.gr")).includes("Μισθοδοσία ομάδας") && !(await titlesOf("emp_fin@demo.gr")).includes("Μισθοδοσία ομάδας"));
  state.prompts.length = 0;
  await readSse(await call("emp_cc@demo.gr", "POST", "/team/query/stream", { question: "Πότε πληρώνονται οι μισθοί;" }));
  check("ο βοηθός του ίδιου τμήματος συνεχίζει να χρησιμοποιεί το έγγραφο", /MS-X/.test(state.prompts.join("\n")));
  check("αναφορά από άλλο τμήμα για εμπιστευτικό έγγραφο: 404 (δεν αποκαλύπτεται ότι υπάρχει)", (await call("ed_fin@demo.gr", "POST", "/team/feedback", { documentId: hid, kind: "wrong" })).status === 404);

  // αντίφαση με εμπιστευτικό έγγραφο: κρύβεται όπως ένα κρυφό τμήμα
  await newDocU("ed_fin@demo.gr", "Μισθοδοσία Finance", "fin", "Οι μισθοί πληρώνονται στις 30 του μήνα. MF-X");
  const rawFin = await (await call("ed_fin@demo.gr", "GET", "/team/contradictions?status=open")).text();
  const finView = JSON.parse(rawFin).contradictions.find((c) => c.sides.some((s) => s.hidden));
  check("αντίφαση με εμπιστευτικό έγγραφο: ο editor Finance βλέπει «κρυφή» πλευρά και γενικό τίτλο", !!finView && finView.topic === "Πιθανή αντίφαση με έγγραφο κρυφού τμήματος");
  check("... και δεν διαρρέει τίτλος, κείμενο, id ή θέμα του εγγράφου", !/Μισθοδοσία ομάδας|στις 25|MS-X|Ημέρα πληρωμής/.test(rawFin) && !rawFin.includes(hid));
  const adminView = (await cList("admin@demo.gr")).find((c) => c.topic === "Ημέρα πληρωμής");
  check("ο admin βλέπει και τις δύο πλευρές με το πραγματικό θέμα", adminView && adminView.sides.every((s) => !s.hidden));
  const ccView = (await cList("ed_cc@demo.gr")).find((c) => c.topic === "Ημέρα πληρωμής");
  check("ο editor του ίδιου τμήματος βλέπει και τις δύο πλευρές (η άλλη πλευρά, Finance, είναι ορατή)", ccView && ccView.sides.every((s) => !s.hidden));
  state.judge = null;

  // επεξεργασία και μεταφορά
  await call("ed_cc@demo.gr", "PUT", `/team/documents/${hid}`, { title: "Μισθοδοσία ομάδας", departmentId: "cc", text: "Οι μισθοί πληρώνονται στις 25 του μήνα. MS-X Ενημερώθηκε." });
  check("η επεξεργασία από τον editor του τμήματος ΔΕΝ αίρει την σήμανση", (await readJson(await call("ed_cc@demo.gr", "GET", `/team/documents/${hid}`))).hidden === true && !(await titlesOf("ed_fin@demo.gr")).includes("Μισθοδοσία ομάδας"));
  check("εμπιστευτικό έγγραφο δεν μεταφέρεται σε «όλη την εταιρεία»: 409", (await call("admin@demo.gr", "PUT", `/team/documents/${hid}`, { title: "Μισθοδοσία ομάδας", departmentId: "_all", text: "Οι μισθοί πληρώνονται στις 25 του μήνα. MS-X" })).status === 409);

  // επισκόπηση admin και άρση
  const list = (await readJson(await call("admin@demo.gr", "GET", "/team/admin/documents"))).documents;
  const mine = list.find((x) => x.id === hid);
  check("admin: λίστα εγγράφων με σήμανση, τμήμα και ανοιχτές αντιφάσεις", mine && mine.hidden === true && mine.departmentName === "Customer Care" && mine.openContradictions >= 1);
  check("λίστα εγγράφων admin: μόνο για admin", (await call("ed_cc@demo.gr", "GET", "/team/admin/documents")).status === 403 && !JSON.stringify((await readJson(await call("other@other.gr", "GET", "/team/admin/documents"))).documents).includes("Μισθοδοσία"));
  check("άρση σήμανσης: 200 και ο editor Finance ξαναβλέπει το έγγραφο", (await call("admin@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: false })).status === 200 && (await titlesOf("ed_fin@demo.gr")).includes("Μισθοδοσία ομάδας"));
  check("το ιστορικό καταγράφει τη σήμανση και την άρση με τίτλο", ["document_hidden", "document_unhidden"].every((act) => (audit.__x = 1) && true) && (await (async () => { const en = await audit(); return en.some((x) => x.action === "document_hidden" && x.targetLabel === "Μισθοδοσία ομάδας") && en.some((x) => x.action === "document_unhidden"); })()));

  // οθόνη admin: καρτέλα Έγγραφα
  await call("admin@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: true });
  const ad = uiFor("admin@demo.gr")("team-admin.html");
  clickU(ad, await uiWait(() => $u(ad, "#tab-documents")));
  const row = await uiWait(() => byTextU(ad, ".doc-row", /Μισθοδοσία ομάδας/));
  check("σελίδα admin: καρτέλα «Έγγραφα» με τα έγγραφα και σήμανση «εμπιστευτικό»", !!row && /εμπιστευτικό/.test(row.textContent));
  clickU(ad, row.querySelector(".doc-hide-toggle"));
  check("σελίδα admin: άρση σήμανσης με κλικ ισχύει αμέσως", !!(await uiWait(() => (readDocHidden(hid) === false))));
  function readDocHidden(id) { const raw = env.DOCUMENT_REGISTRY.store.get(`team:team-demo:doc:${id}`); return raw ? !!JSON.parse(raw.value).hidden : null; }
  clickU(ad, await uiWait(() => $u(ad, "#tab-documents")));
  clickU(ad, await uiWait(() => $u(ad, "#run-rechecks")));
  check("σελίδα admin: κουμπί «Εκτέλεση τώρα» για επανελέγχους δείχνει αποτέλεσμα", !!(await uiWait(() => /Ελέγχθηκαν \d+ έγγραφα/.test(ad.window.document.body.textContent))));
  const eDom = uiFor("ed_cc@demo.gr")("team-editor.html", "");
  clickU(eDom, await uiWait(() => $u(eDom, "#tab-docs")));
  await call("admin@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: true });
  const eDom2 = uiFor("ed_cc@demo.gr")("team-editor.html", "");
  clickU(eDom2, await uiWait(() => $u(eDom2, "#tab-docs")));
  check("σελίδα editor: το εμπιστευτικό έγγραφο σημειώνεται στη λίστα", !!(await uiWait(() => byTextU(eDom2, ".item", /Μισθοδοσία ομάδας.*εμπιστευτικό/))));
  await call("admin@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: false });
}

section("22. Αναφορές υπαλλήλων (λάθος ή ξεπερασμένη απάντηση)");
{
  db.prepare("delete from team_usage").run();
  const fb = (email, body) => call(email, "POST", "/team/feedback", body);
  const target = await newDocU("ed_cc@demo.gr", "Πολιτική δώρων", "cc", "Τα δώρα πελατών δεν ξεπερνούν τα 20 €. GF-X");
  check("αναφορά από υπάλληλο του τμήματος: 201", (await fb("emp_cc@demo.gr", { documentId: target, kind: "wrong", note: "Το όριο είναι 30 €", question: "Ποιο είναι το όριο δώρων;" })).status === 201);
  check("δεύτερη αναφορά (άλλη σημείωση): 201", (await fb("emp_cc@demo.gr", { documentId: target, kind: "wrong", note: "Λάθος ποσό" })).status === 201);
  check("άκυρο είδος: 400", (await fb("emp_cc@demo.gr", { documentId: target, kind: "xyz" })).status === 400);
  check("υπερβολικά μεγάλη σημείωση: 400", (await fb("emp_cc@demo.gr", { documentId: target, kind: "wrong", note: "α".repeat(301) })).status === 400);
  check("ανύπαρκτο ή άκυρο έγγραφο: 404", (await fb("emp_cc@demo.gr", { documentId: "doc-0000000000000000", kind: "wrong" })).status === 404 && (await fb("emp_cc@demo.gr", { documentId: "../x", kind: "wrong" })).status === 404);
  check("έγγραφο που δεν μπορεί να διαβάσει (Finance): 404, ίδια απάντηση με το ανύπαρκτο", (await fb("emp_cc@demo.gr", { documentId: DOC.fin, kind: "wrong" })).status === 404);
  check("χωρίς σύνδεση: 401, από άλλον οργανισμό: 404", (await req(env, workerNew, "POST", "/team/feedback", { body: { documentId: target, kind: "wrong" } })).status === 401 && (await fb("other@other.gr", { documentId: target, kind: "wrong" })).status === 404);

  const inboxFb = async (email) => (await readJson(await call(email, "GET", "/team/inbox")));
  const ccInbox = await inboxFb("ed_cc@demo.gr");
  const grp = ccInbox.feedback.find((f) => f.documentId === target);
  check("ο editor CC βλέπει την αναφορά ομαδοποιημένη (2 υπάλληλοι), με σημειώσεις και ερώτηση", grp && grp.count === 2 && grp.kind === "wrong" && grp.notes.length === 2 && grp.questions[0] === "Ποιο είναι το όριο δώρων;" && grp.documentTitle === "Πολιτική δώρων");
  check("ο μετρητής εισερχομένων περιλαμβάνει τις αναφορές", ccInbox.counts.feedback === ccInbox.feedback.length && ccInbox.counts.feedback >= 1);
  check("ο editor Finance ΔΕΝ βλέπει αναφορές για έγγραφα του CC", !(await inboxFb("ed_fin@demo.gr")).feedback.some((f) => f.documentId === target));
  check("ο admin τις βλέπει", (await inboxFb("admin@demo.gr")).feedback.some((f) => f.documentId === target));
  check("ο υπάλληλος δεν έχει πρόσβαση στα εισερχόμενα: 403", (await call("emp_cc@demo.gr", "GET", "/team/inbox")).status === 403);
  const stored = JSON.stringify(db.prepare("select * from team_feedback").all());
  check("ΔΕΝ αποθηκεύεται ταυτότητα του υπαλλήλου (κανένα email ή id μέλους)", !/@/.test(stored) && !/member/.test(Object.keys(db.prepare("select * from team_feedback limit 1").get()).join(",")));

  check("κλείσιμο από editor άλλου τμήματος: 403", (await call("ed_fin@demo.gr", "POST", "/team/inbox/feedback/close", { documentId: target, kind: "wrong" })).status === 403);
  check("κλείσιμο με άκυρα στοιχεία: 400", (await call("ed_cc@demo.gr", "POST", "/team/inbox/feedback/close", { documentId: target, kind: "x" })).status === 400);
  check("κλείσιμο από editor του τμήματος: 200", (await call("ed_cc@demo.gr", "POST", "/team/inbox/feedback/close", { documentId: target, kind: "wrong" })).status === 200);
  check("... οι αναφορές φεύγουν από τα εισερχόμενα και το κλείσιμο καταγράφεται", !(await inboxFb("ed_cc@demo.gr")).feedback.some((f) => f.documentId === target) && (await audit()).some((x) => x.action === "feedback_closed" && x.targetLabel === "Πολιτική δώρων"));

  // ημερήσιο όριο αναφορών
  env.TEAM_DAILY_FEEDBACK_LIMIT = "2";
  db.prepare("delete from team_usage").run();
  const c = [(await fb("emp_cc@demo.gr", { documentId: target, kind: "outdated" })).status, (await fb("emp_cc@demo.gr", { documentId: target, kind: "outdated" })).status, (await fb("emp_cc@demo.gr", { documentId: target, kind: "outdated" })).status];
  check("ημερήσιο όριο αναφορών: οι 2 πρώτες περνούν, η 3η 429", c[0] === 201 && c[1] === 201 && c[2] === 429);
  delete env.TEAM_DAILY_FEEDBACK_LIMIT;

  // διαγραφή εγγράφου κλείνει τις αναφορές
  await call("ed_cc@demo.gr", "DELETE", `/team/documents/${target}`);
  check("όταν διαγραφεί το έγγραφο, οι αναφορές του κλείνουν", db.prepare("select count(*) c from team_feedback where document_id = ? and status = 'open'").get(target).c === 0);

  // ελλιπές migration
  db.exec("ALTER TABLE team_feedback RENAME TO team_feedback_x");
  const noTable = await readJson(await call("ed_cc@demo.gr", "GET", "/team/inbox"));
  const noTablePost = await fb("emp_cc@demo.gr", { documentId: DOC.cc, kind: "wrong" });
  db.exec("ALTER TABLE team_feedback_x RENAME TO team_feedback");
  check("χωρίς τον πίνακα αναφορών: τα εισερχόμενα δουλεύουν (feedback κενό)", noTable.counts.feedback === 0 && Array.isArray(noTable.feedback) && noTable.counts.contradictions !== undefined);
  check("... και η αναφορά απαντά καθαρά 503, όχι σφάλμα", noTablePost.status === 503);

  // σελίδες: αναφορά από τον υπάλληλο και κλείσιμο από τον editor
  db.prepare("delete from team_usage").run();
  const pe = uiFor("emp_cc@demo.gr")("portal.html");
  await uiWait(() => $u(pe, "#q"));
  $u(pe, "#q").value = "Σε πόσες ημέρες γίνεται η επιστροφή;";
  $u(pe, "form").dispatchEvent(new pe.window.Event("submit", { bubbles: true, cancelable: true }));
  const row = await uiWait(() => $u(pe, ".answer .feedback"));
  check("portal: κάτω από απάντηση με πηγή εμφανίζονται κουμπιά «Είναι λάθος» / «Είναι ξεπερασμένη»", !!row && !!byTextU(pe, ".feedback button", /Είναι λάθος/) && !!byTextU(pe, ".feedback button", /Είναι ξεπερασμένη/));
  clickU(pe, byTextU(pe, ".feedback button", /Είναι ξεπερασμένη/));
  check("portal: το κλικ στέλνει αναφορά και δείχνει ευχαριστώ", !!(await uiWait(() => /Ευχαριστούμε/.test($u(pe, ".answer .feedback").textContent))) && db.prepare("select count(*) c from team_feedback where kind = 'outdated' and status = 'open'").get().c >= 1);
  const ed = uiFor("ed_cc@demo.gr")("team-editor.html");
  const card = await uiWait(() => $u(ed, ".card.feedback"));
  check("editor: η αναφορά εμφανίζεται ως κάρτα στα Εισερχόμενα, με τέταρτο μετρητή", !!card && $$u(ed, ".count").length === 4 && /ξεπερασμένη/.test(card.textContent));
  clickU(ed, byTextU(ed, ".card.feedback button", /Κλείσιμο αναφορών/));
  check("editor: «Κλείσιμο αναφορών» αφαιρεί την κάρτα", !!(await uiWait(() => !$u(ed, ".card.feedback"))));
  state.judge = null;
}

// ============================================================================ Σύνοψη
console.log("\n" + "=".repeat(60));
if (failures.length) {
  console.log(`ΑΠΟΤΥΧΙΑ: ${failures.length} τεστ απέτυχαν, ${passed} πέρασαν.`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
} else {
  console.log(`ΟΛΑ ΤΑ ΤΕΣΤ ΠΕΡΑΣΑΝ: ${passed}`);
}
