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
    async getByIds(ids) {
      return ids.map((id) => vectors.get(id)).filter(Boolean).map((x) => ({ id: x.id, values: x.values, namespace: x.namespace, metadata: x.metadata }));
    },
    async query(values, options) {
      v.calls.push({ ...JSON.parse(JSON.stringify(options)), __keys: Object.keys(options).sort() });
      // Το πραγματικό Vectorize απορρίπτει φίλτρο metadata μεγαλύτερο από 2048 bytes.
      if (options.filter && Buffer.byteLength(JSON.stringify(options.filter)) > 2048) throw new Error("VECTOR_QUERY_ERROR: filter too large");
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
  const ed = { role: "editor", departmentIds: ["cc"], editorProjectIds: ["cc"] };
  const adm = { role: "admin", departmentIds: [] };
  const set = (s) => (s === null ? null : [...s].sort().join(","));
  check("employee διαβάζει: δικό του + εταιρικά", set(access.readableDepartmentIds(emp, depts)) === "_all,cc");
  check("editor διαβάζει: ΜΟΝΟ δικό του + εταιρικά (κανόνας Β: το ακροατήριο εγγράφων περιορίζει και τους editors)", set(access.readableDepartmentIds(ed, depts)) === "_all,cc");
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
// Ρόλος ανά project: οι editors του demo είναι editors στο δικό τους project (όπως θα τους είχε δώσει το backfill του migration 0014).
for (const [email, dep] of [["ed_cc@demo.gr", "cc"], ["ed_fin@demo.gr", "fin"]]) {
  db.prepare("insert into team_project_editors(member_id,project_id,created_at) values(?,?,?)").run(memberId(email), dep, new Date().toISOString());
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
  check("editor CC βλέπει: CC + εταιρικά, ΟΧΙ Finance (κανόνας Β), ΟΧΙ HR (κρυφό)", JSON.stringify(await titles("ed_cc@demo.gr")) === JSON.stringify(["Διαδικασία επιστροφών", "Ωράριο εορτών"].sort()));
  check("admin βλέπει όλα, και το κρυφό HR", (await titles("admin@demo.gr")).length === 4);
  check("employee HR βλέπει το ΔΙΚΟ του κρυφό τμήμα", (await titles("emp_hr@demo.gr")).includes("Πειθαρχικά"));
  check("employee CC: έγγραφο Finance = 404 (δεν αποκαλύπτεται καν ότι υπάρχει)", (await call("emp_cc@demo.gr", "GET", `/team/documents/${DOC.fin}`)).status === 404);
  check("editor CC: έγγραφο Finance = 404 (κανόνας Β: ένας editor δεν διαβάζει άλλα projects χωρίς ακροατήριο)", (await call("ed_cc@demo.gr", "GET", `/team/documents/${DOC.fin}`)).status === 404);
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
  check("τα έγγραφα ΔΕΝ ζουν πια στο KV (άμεση συνέπεια): πίνακας team_documents στο D1", kvKeys.filter((k) => k.includes(":doc:")).length === 0 && db.prepare("select count(*) c from team_documents where workspace_id = 'team-demo'").get().c >= 3);
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
  check("DELETE σβήνει και τα vectors και την εγγραφή του εγγράφου", ![...env.VECTORIZE.vectors.values()].some((v) => v.metadata.documentId === delId) && db.prepare("select count(*) c from team_documents where id = ?").get(delId).c === 0);
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

  // Κανόνας Β (φέτα 2): ο editor βλέπει έγγραφο άλλου project ΜΟΝΟ αν το project του είναι στο ακροατήριο. Φτιάχνουμε ένα ΠΡΟΣΩΡΙΝΟ κοινό
  // έγγραφο (Finance -> CC), δοκιμάζουμε την ανάγνωση μόνο, και το σβήνουμε αμέσως ώστε να μη μπερδέψει τις επόμενες ερωτήσεις του βοηθού.
  const sharedId = (await readJson(await call("admin@demo.gr", "POST", "/team/documents", { title: "Όρια έγκρισης (κοινό με CC)", departmentId: "fin", text: "Κοινή σημείωση ορίων για ομάδες. SHARED-X", audienceProjectIds: ["cc"] }))).id;
  const ed = brEd.open(editorHtml, "/team-editor.html");
  await waitFor(() => ed.window.document.querySelector("#tab-docs")); // η οθόνη ξεκινά από τα Εισερχόμενα
  ed.window.document.querySelector("#tab-docs").dispatchEvent(new ed.window.Event("click", { bubbles: true }));
  await waitFor(() => ed.window.document.querySelectorAll(".item").length > 2);
  const items = [...ed.window.document.querySelectorAll(".item")];
  check("editor: η λίστα δείχνει έγγραφο άλλου τμήματος (Finance) που μοιράζεται με το project του μέσω ακροατηρίου", items.some((i) => /Όρια έγκρισης/.test(i.textContent)));
  check("... σημειωμένα ως μόνο ανάγνωση", items.find((i) => /Όρια έγκρισης/.test(i.textContent)).textContent.includes("μόνο ανάγνωση"));
  check("editor: το κρυφό τμήμα HR δεν εμφανίζεται", !items.some((i) => /Πειθαρχικά/.test(i.textContent)));
  items.find((i) => /Όρια έγκρισης/.test(i.textContent)).dispatchEvent(new ed.window.Event("click", { bubbles: true }));
  await waitFor(() => ed.window.document.querySelector(".readonly-text"));
  check("έγγραφο άλλου τμήματος: μόνο ανάγνωση, χωρίς φόρμα επεξεργασίας", !!ed.window.document.querySelector(".readonly-text") && !ed.window.document.querySelector("#panel form"));
  await call("admin@demo.gr", "DELETE", `/team/documents/${sharedId}`);

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
  // Κανόνας Β: ο editor ΔΕΝ διαβάζει έγγραφα άλλων projects (χωρίς ακροατήριο). Η αντίφαση φαίνεται, αλλά η ξένη πλευρά είναι κρυμμένη και ο τίτλος γενικός.
  const fin = list.find((c) => c.sides.some((s) => s.hidden) && c.sides.some((s) => s.editable && /εκατόν πενήντα/.test(s.quote)));
  check("βρέθηκε αντίφαση ανάμεσα σε CC και Finance", !!fin);
  const own = fin.sides.find((s) => s.editable), foreign = fin.sides.find((s) => !s.editable);
  check("ο editor CC βλέπει την ξένη πλευρά ΚΡΥΜΜΕΝΗ (κανόνας Β): ούτε τίτλος, ούτε τμήμα, ούτε παράθεση, γενικός τίτλος", foreign && foreign.hidden === true && Object.keys(foreign).length === 2 && fin.topic === "Πιθανή αντίφαση με έγγραφο που δεν έχεις πρόσβαση" && !JSON.stringify(fin).includes("Όρια έγκρισης") && !JSON.stringify(fin).includes("εκατό ευρώ"));
  const finView = (await cList("ed_fin@demo.gr")).find((c) => c.sides.some((s) => s.hidden) && c.sides.some((s) => s.editable && s.title === "Όρια έγκρισης"));
  check("ο editor Finance τη βλέπει ανάποδα: δικό του Finance, η πλευρά του CC κρυμμένη", finView && finView.sides.find((s) => s.editable).title === "Όρια έγκρισης" && finView.sides.find((s) => !s.editable).hidden === true);
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
  check("... ο τίτλος της αντίφασης είναι ΓΕΝΙΚΟΣ (ο τίτλος του LLM θα μπορούσε να αποκαλύψει το θέμα του κρυφού εγγράφου)", hrC.topic === "Πιθανή αντίφαση με έγγραφο που δεν έχεις πρόσβαση" && !rawText.includes("Ημέρες άδειας"));
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
  check("η απορριφθείσα δεν φαίνεται πια στα ανοιχτά", !(await cList("ed_cc@demo.gr")).some((c) => c.id === DOC2.finContradiction));
  check("... και δεύτερο dismiss: 409", (await call("ed_cc@demo.gr", "POST", `/team/contradictions/${DOC2.finContradiction}/dismiss`)).status === 409);
  const chk = await readJson(await call("ed_cc@demo.gr", "POST", `/team/documents/${DOC.cc}/check`));
  check("χειροκίνητος έλεγχος: η απορριφθείσα ΔΕΝ ξαναδημιουργείται", chk.created === 0 && !(await cList("ed_cc@demo.gr")).some((c) => c.id === DOC2.finContradiction));
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
  check("πριν την απόκρυψη: ο υπάλληλος του Finance βλέπει τα έγγραφά του, ο editor CC ΟΧΙ (κανόνας Β)", (await titles("emp_fin@demo.gr")).includes("Όρια έγκρισης") && !(await titles("ed_cc@demo.gr")).includes("Όρια έγκρισης"));
  check("απόκρυψη του Finance: 200", (await adm("PATCH", "/departments/fin", { hidden: true })).status === 200);
  check("ΑΜΕΣΑ: ο editor CC δεν βλέπει έγγραφα Finance (ούτε με άμεσο id)", !(await titles("ed_cc@demo.gr")).includes("Όρια έγκρισης") && (await call("ed_cc@demo.gr", "GET", `/team/documents/${DOC.fin}`)).status === 404);
  check("... ούτε το τμήμα στους επιλογείς", !(await readJson(await call("ed_cc@demo.gr", "GET", "/team/departments"))).departments.some((d) => d.id === "fin"));
  const dismissed = (await readJson(await call("ed_cc@demo.gr", "GET", "/team/contradictions?status=dismissed"))).contradictions.find((c) => c.sides.some((s) => s.hidden));
  check("οι αντιφάσεις με το κρυφό Finance εμφανίζονται χωρίς περιεχόμενο", dismissed && dismissed.sides.some((s) => s.hidden === true && Object.keys(s).length === 2));
  check("ο υπάλληλος του κρυφού τμήματος βλέπει ακόμα τα δικά του έγγραφα", (await titles("emp_fin@demo.gr")).includes("Όρια έγκρισης"));
  const a1 = await ask2("emp_cc@demo.gr");
  async function ask2(email) { state.prompts.length = 0; await readSse(await call(email, "POST", "/team/query/stream", { question: "Ποια είναι τα όρια έγκρισης;" })); return state.prompts.join("\n"); }
  check("ο βοηθός του CC δεν χρησιμοποιεί ποτέ Finance (ούτε πριν ούτε μετά)", !/FIN-MARK/.test(a1));
  check("επαναφορά ορατότητας: 200 (ο editor CC συνεχίζει να μη βλέπει Finance χωρίς ακροατήριο)", (await adm("PATCH", "/departments/fin", { hidden: false })).status === 200 && !(await titles("ed_cc@demo.gr")).includes("Όρια έγκρισης") && (await titles("emp_fin@demo.gr")).includes("Όρια έγκρισης"));

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
  check("πλευρά χωρίς πρόσβαση: η κάρτα λέει μόνο ότι υπάρχει αντίφαση με έγγραφο που δεν έχεις πρόσβαση και ότι ειδοποιήθηκαν οι υπεύθυνοι", !!hiddenCard && /δεν έχεις πρόσβαση/.test(hiddenCard.textContent) && /Ειδοποιήθηκαν οι υπεύθυνοι/.test(hiddenCard.textContent) && !/κρυφού τμήματος/.test(hiddenCard.textContent));
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
  check("διπλό όνομα: εμφανίζεται μήνυμα λάθους", !!(await waitFor(() => /Υπάρχει ήδη project/.test(ad.window.document.body.textContent))));

  click(ad, $(ad, "#tab-members"));
  const ccNameAd = db.prepare("select name from departments where id = 'cc'").get().name;
  check("άνθρωποι: λίστα με γραμμές και περίληψη projects, ΧΩΡΙΣ dropdown ανά project", !!(await waitFor(() => $$(ad, ".member-row").length >= 7)) && $$(ad, "#people-list select").length === 0 && byText(ad, ".member-row", /ed_cc@demo\.gr/).textContent.includes(ccNameAd));
  setVal(ad, $(ad, "#new-email"), "pg@demo.gr");
  $(ad, "#new-role").value = "member";
  $(ad, "#new-project").value = "cc"; $(ad, "#new-project-role").value = "editor";
  submit(ad, "#add-member");
  setVal(ad, $(ad, "#people-q"), "pg@demo");
  check("προσθήκη μέλους από τη σελίδα (editor στο cc)", !!(await waitFor(() => byText(ad, ".member-row", /pg@demo\.gr/))) && db.prepare("select role from team_members where email='pg@demo.gr'").get().role === "editor" && !!db.prepare("select 1 from team_project_editors e join team_members m on m.id=e.member_id where m.email='pg@demo.gr' and e.project_id='cc'").get());
  click(ad, byText(ad, ".member-row", /pg@demo\.gr/).querySelector(".open-member"));
  await waitFor(() => $(ad, "#member-detail"));
  click(ad, $(ad, "#member-detail .prow[data-project=cc] .seg-member"));
  check("αλλαγή ρόλου από την καρτέλα ισχύει αμέσως", !!(await waitFor(() => db.prepare("select role from team_members where email='pg@demo.gr'").get().role === "employee")));
  await waitFor(() => $(ad, "#member-detail") && !$(ad, ".busy")); // η καρτέλα ξεκλειδώνει όταν ανανεωθεί η λίστα
  click(ad, $(ad, "#member-detail .status-toggle"));
  click(ad, await waitFor(() => $(ad, ".confirm-yes"))); // η απενεργοποίηση ζητά πρώτα «Σίγουρα;»
  check("απενεργοποίηση από τη σελίδα (μετά το «Ναι»)", !!(await waitFor(() => db.prepare("select status from team_members where email='pg@demo.gr'").get().status === "disabled")) && !!(await waitFor(() => /απενεργοποιημένο/.test((byText(ad, ".member-row", /pg@demo\.gr/) || {}).textContent || ""))));
  setVal(ad, $(ad, "#people-q"), "admin@demo");
  await waitFor(() => $$(ad, ".member-row").length === 1);
  click(ad, $(ad, ".member-row .open-member"));
  const own = await waitFor(() => $(ad, "#detail-org-role"));
  own.value = "member"; own.dispatchEvent(new ad.window.Event("change", { bubbles: true }));
  check("ο τελευταίος admin δεν υποβαθμίζεται: το λάθος μένει ορατό μετά την ανανέωση", !!(await waitFor(() => /χωρίς ενεργό admin/.test(ad.window.document.body.textContent))) && db.prepare("select role from team_members where email='admin@demo.gr'").get().role === "admin");

  click(ad, $(ad, "#tab-audit"));
  check("ιστορικό: εμφανίζονται ενέργειες με email και περιγραφή", !!(await waitFor(() => $$(ad, ".log").length > 5)) && /νέο project|σύνδεση|νέο μέλος/.test(ad.window.document.body.textContent));
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
  check("υπάλληλος: «Έγγραφα που βλέπεις» (ουδέτερος τίτλος, αφού φαίνονται και έγγραφα που μοιράζονται από άλλα projects)", !!(await waitFor(() => $$(pEmp, "h2").some((h) => h.textContent === "Έγγραφα που βλέπεις"))));
  check("editor: ο ίδιος τίτλος «Έγγραφα που βλέπεις»", !!(await waitFor(() => $$(pStaff, "h2").some((h) => h.textContent === "Έγγραφα που βλέπεις"))) && !$$(pStaff, "h2").some((h) => h.textContent === "Έγγραφα του τμήματός σου" || h.textContent === "Όλα τα έγγραφα που βλέπεις"));

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
  check("σελίδα ιστορικού: δείχνει «Finance» και τίτλους αντί για id", !!(await waitFor(() => /απόκρυψη project · Finance/.test(adDom.window.document.body.textContent) && /νέο έγγραφο · Δόσεις/.test(adDom.window.document.body.textContent))) && !/· fin\b/.test(adDom.window.document.body.textContent));
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
  check("κανόνας Β: χωρίς ακροατήριο ο editor Finance ΔΕΝ βλέπει το έγγραφο του CC", !(await titlesOf("ed_fin@demo.gr")).includes("Μισθοδοσία ομάδας"));
  await call("admin@demo.gr", "PUT", `/team/documents/${hid}`, { title: "Μισθοδοσία ομάδας", departmentId: "cc", text: "Οι μισθοί πληρώνονται στις 25 του μήνα. MS-X", audienceProjectIds: ["fin"] });
  check("πριν τη σήμανση: με ακροατήριο [fin] ο editor Finance βλέπει το έγγραφο του CC (ανάγνωση)", (await titlesOf("ed_fin@demo.gr")).includes("Μισθοδοσία ομάδας"));
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
  check("αντίφαση με εμπιστευτικό έγγραφο: ο editor Finance βλέπει «κρυφή» πλευρά και γενικό τίτλο", !!finView && finView.topic === "Πιθανή αντίφαση με έγγραφο που δεν έχεις πρόσβαση");
  check("... και δεν διαρρέει τίτλος, κείμενο, id ή θέμα του εγγράφου", !/Μισθοδοσία ομάδας|στις 25|MS-X|Ημέρα πληρωμής/.test(rawFin) && !rawFin.includes(hid));
  const adminView = (await cList("admin@demo.gr")).find((c) => c.topic === "Ημέρα πληρωμής");
  check("ο admin βλέπει και τις δύο πλευρές με το πραγματικό θέμα", adminView && adminView.sides.every((s) => !s.hidden));
  const ccView = (await cList("ed_cc@demo.gr")).find((c) => c.sides.some((x) => x.hidden === true) && c.sides.some((x) => x.editable && x.title === "Μισθοδοσία ομάδας"));
  check("κανόνας Β: ο editor του CC βλέπει την πλευρά του Finance ΚΡΥΜΜΕΝΗ (δεν διαβάζει το έγγραφο του Finance) και γενικό τίτλο", !!ccView && ccView.topic === "Πιθανή αντίφαση με έγγραφο που δεν έχεις πρόσβαση" && ccView.sides.find((x) => !x.editable).hidden === true);
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
  check("άρση σήμανσης: 200. Το ακροατήριο ΔΕΝ επανέρχεται μόνο του (το εμπιστευτικό το είχε επαναφέρει): ο editor Finance δεν το βλέπει, ο ιδιοκτήτης ναι", (await call("admin@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: false })).status === 200 && !(await titlesOf("ed_fin@demo.gr")).includes("Μισθοδοσία ομάδας") && (await titlesOf("emp_cc@demo.gr")).includes("Μισθοδοσία ομάδας"));
  check("το ιστορικό καταγράφει τη σήμανση και την άρση με τίτλο", ["document_hidden", "document_unhidden"].every((act) => (audit.__x = 1) && true) && (await (async () => { const en = await audit(); return en.some((x) => x.action === "document_hidden" && x.targetLabel === "Μισθοδοσία ομάδας") && en.some((x) => x.action === "document_unhidden"); })()));

  // οθόνη admin: καρτέλα Έγγραφα
  await call("admin@demo.gr", "PATCH", `/team/admin/documents/${hid}`, { hidden: true });
  const ad = uiFor("admin@demo.gr")("team-admin.html");
  clickU(ad, await uiWait(() => $u(ad, "#tab-documents")));
  const row = await uiWait(() => byTextU(ad, ".doc-row", /Μισθοδοσία ομάδας/));
  check("σελίδα admin: καρτέλα «Έγγραφα» με τα έγγραφα και σήμανση «εμπιστευτικό»", !!row && /εμπιστευτικό/.test(row.textContent));
  clickU(ad, row.querySelector(".doc-hide-toggle"));
  check("σελίδα admin: άρση σήμανσης με κλικ ισχύει αμέσως", !!(await uiWait(() => (readDocHidden(hid) === false))));
  function readDocHidden(id) { const r = db.prepare("select hidden from team_documents where workspace_id = 'team-demo' and id = ?").get(id); return r ? !!r.hidden : null; }
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

// ============================================================================ 24. Έγγραφα στο D1: άμεση συνέπεια και μεταφορά από το KV
section("24. Έγγραφα στο D1: άμεση συνέπεια (αντί για τελικά συνεπές KV), αυτόματη μεταφορά παλιών εγγράφων");
{
  const store = await import(pathToFileURL(join(TMP, "modified", "src", "team", "store.js")).href);
  const titlesOf = async (email) => (await readJson(await call(email, "GET", "/team/documents"))).documents.map((x) => x.title);

  // (α) προσομοίωση "αργού" KV: οι λίστες και οι αναγνώσεις του KV επιστρέφουν άδεια. Τα έγγραφα δεν πρέπει να επηρεάζονται.
  const kv = env.DOCUMENT_REGISTRY;
  const realList = kv.list, realGet = kv.get;
  kv.list = async () => ({ keys: [], list_complete: true });
  kv.get = async () => null;
  const fresh = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/documents", { title: "Νέο ΤΑΧΕΙΑ", departmentId: "cc", text: "Κείμενο που πρέπει να φαίνεται αμέσως. TX-MARK" }))).id;
  check("με 'αργό' KV: ένα νέο έγγραφο φαίνεται ΑΜΕΣΩΣ στη λίστα του συναδέλφου και του admin", (await titlesOf("emp_cc@demo.gr")).includes("Νέο ΤΑΧΕΙΑ") && (await titlesOf("admin@demo.gr")).includes("Νέο ΤΑΧΕΙΑ"));
  check("... και ανοίγει αμέσως (ανάγνωση)", (await readJson(await call("emp_cc@demo.gr", "GET", `/team/documents/${fresh}`))).fullText.includes("TX-MARK"));
  await call("admin@demo.gr", "PUT", `/team/documents/${fresh}`, { title: "Νέο ΤΑΧΕΙΑ", departmentId: "cc", text: "Κείμενο που πρέπει να φαίνεται αμέσως. TX-MARK", audienceProjectIds: ["fin"] });
  check("με 'αργό' KV: ο editor Finance βλέπει (μέσω ακροατηρίου [fin]) το έγγραφο πριν τη σήμανση", (await titlesOf("ed_fin@demo.gr")).includes("Νέο ΤΑΧΕΙΑ"));
  await call("admin@demo.gr", "PATCH", `/team/admin/documents/${fresh}`, { hidden: true });
  check("ΑΜΕΣΑ μετά τη σήμανση εμπιστευτικού: ο editor Finance δεν το βλέπει (λίστα και άμεση ανάγνωση)", !(await titlesOf("ed_fin@demo.gr")).includes("Νέο ΤΑΧΕΙΑ") && (await call("ed_fin@demo.gr", "GET", `/team/documents/${fresh}`)).status === 404);
  check("... και η λίστα του admin δείχνει αμέσως τη σήμανση", (await readJson(await call("admin@demo.gr", "GET", "/team/admin/documents"))).documents.find((x) => x.id === fresh).hidden === true);
  await call("admin@demo.gr", "PATCH", `/team/admin/documents/${fresh}`, { hidden: false });
  check("ΑΜΕΣΑ μετά την άρση: ο ιδιοκτήτης το βλέπει, ο editor Finance όχι (το ακροατήριο επαναφέρθηκε με τη σήμανση)", (await titlesOf("emp_cc@demo.gr")).includes("Νέο ΤΑΧΕΙΑ") && !(await titlesOf("ed_fin@demo.gr")).includes("Νέο ΤΑΧΕΙΑ"));
  await call("ed_cc@demo.gr", "DELETE", `/team/documents/${fresh}`);
  check("ΑΜΕΣΑ μετά τη διαγραφή: εξαφανίζεται από όλους (λίστα και άμεση ανάγνωση)", !(await titlesOf("emp_cc@demo.gr")).includes("Νέο ΤΑΧΕΙΑ") && (await call("emp_cc@demo.gr", "GET", `/team/documents/${fresh}`)).status === 404);
  kv.list = realList; kv.get = realGet;

  // (β) μεγάλο έγγραφο και ακεραιότητα του κειμένου
  const bigText = ("Μια πρόταση για το μέγεθος του εγγράφου. ".repeat(900)) + "ΤΕΛΟΣ-BIG"; // κοντά στο όριο λέξεων του προϊόντος
  const big = (await readJson(await call("ed_cc@demo.gr", "POST", "/team/documents", { title: "Μεγάλο έγγραφο", departmentId: "cc", text: bigText }))).id;
  check("μεγάλο έγγραφο (κοντά στο όριο λέξεων): αποθηκεύεται και διαβάζεται ακέραιο", (await readJson(await call("emp_cc@demo.gr", "GET", `/team/documents/${big}`))).fullText === bigText);
  await call("ed_cc@demo.gr", "DELETE", `/team/documents/${big}`);

  // (γ) αυτόματη μεταφορά παλιών εγγράφων από το KV
  const legacyId = "doc-aaaaaaaaaaaaaaaa";
  const legacy2 = "doc-bbbbbbbbbbbbbbbb";
  const otherWs = "doc-cccccccccccccccc";
  const legacyDoc = (extra = {}) => JSON.stringify({ id: "x", title: "Παλιό έγγραφο", fullText: "Κείμενο παλιού εγγράφου. LEG-MARK", departmentId: "cc", status: "published", version: 3, chunkCount: 1, createdBy: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedBy: 1, updatedAt: "2026-08-02T00:00:00.000Z", ...extra });
  await kv.put(`team:team-demo:doc:${legacyId}`, legacyDoc(), { metadata: { title: "Παλιό έγγραφο", departmentId: "cc", updatedAt: "2026-08-02T00:00:00.000Z" } });
  await kv.put(`team:team-demo:doc:not-a-valid-id`, legacyDoc(), {});
  await kv.put(`team:team-other:doc:${otherWs}`, legacyDoc({ title: "Άλλου οργανισμού" }), {});
  db.prepare("delete from team_meta").run();
  store.resetMigrationCache();
  const afterList = await titlesOf("admin@demo.gr");
  check("παλιό έγγραφο του KV: εμφανίζεται στη λίστα μετά τη μεταφορά", afterList.includes("Παλιό έγγραφο"));
  const row = db.prepare("select * from team_documents where workspace_id = 'team-demo' and id = ?").get(legacyId);
  check("... με όλα τα πεδία ακέραια (κείμενο, τμήμα, έκδοση, ημερομηνίες)", row && row.full_text.includes("LEG-MARK") && row.department_id === "cc" && row.version === 3 && row.created_at === "2026-08-01T00:00:00.000Z" && row.updated_at === "2026-08-02T00:00:00.000Z" && row.chunk_count === 1);
  check("... και σβήνεται από το KV (μία μόνο πηγή αλήθειας)", !kv.store.has(`team:team-demo:doc:${legacyId}`));
  check("άκυρο id στο KV: αγνοείται (δεν μεταφέρεται)", !db.prepare("select 1 from team_documents where id = 'not-a-valid-id'").get());
  check("έγγραφο ΑΛΛΟΥ οργανισμού στο KV: δεν αγγίζεται ούτε εμφανίζεται εδώ", kv.store.has(`team:team-other:doc:${otherWs}`) && !afterList.includes("Άλλου οργανισμού"));
  check("η μεταφορά σημαίνεται ως ολοκληρωμένη για τον οργανισμό", !!db.prepare("select docs_migrated_at from team_meta where workspace_id = 'team-demo'").get());
  await titlesOf("admin@demo.gr");
  check("δεύτερη φορά: καμία διπλή εγγραφή", db.prepare("select count(*) c from team_documents where id = ?").get(legacyId).c === 1);
  check("το μεταφερμένο έγγραφο ανοίγει κανονικά από υπάλληλο του τμήματος", (await readJson(await call("emp_cc@demo.gr", "GET", `/team/documents/${legacyId}`))).fullText.includes("LEG-MARK"));

  // (δ) έγγραφο που ο λίστα του KV δεν επέστρεψε, αλλά υπάρχει: το δίχτυ ασφαλείας το μεταφέρει όταν ζητηθεί
  await kv.put(`team:team-demo:doc:${legacy2}`, legacyDoc({ title: "Παλιό που ξέφυγε" }), {});
  const missed = await call("emp_cc@demo.gr", "GET", `/team/documents/${legacy2}`);
  check("παλιό έγγραφο που ξέφυγε από τη λίστα του KV: ανοίγει και μεταφέρεται", missed.status === 200 && !kv.store.has(`team:team-demo:doc:${legacy2}`) && !!db.prepare("select 1 from team_documents where id = ?").get(legacy2));
  check("ανύπαρκτο έγγραφο: 404 όπως πριν", (await call("emp_cc@demo.gr", "GET", "/team/documents/doc-dddddddddddddddd")).status === 404);
  await call("admin@demo.gr", "DELETE", `/team/documents/${legacyId}`);
  await call("admin@demo.gr", "DELETE", `/team/documents/${legacy2}`);

  // (ε) απομόνωση οργανισμών και διαγραφή οργανισμού
  const otherDocs = JSON.stringify((await readJson(await call("other@other.gr", "GET", "/team/documents"))).documents);
  check("ο άλλος οργανισμός δεν βλέπει έγγραφα του demo", !/Παλιό|Οδηγός|Αποζημιώσεις/.test(otherDocs));
  db.prepare("insert into team_workspaces(id,name,created_at) values('team-tmp','T','2026-10-01T00:00:00Z')").run();
  db.prepare("insert into team_documents(id,workspace_id,title,full_text,department_id,created_at,updated_at) values('doc-eeeeeeeeeeeeeeee','team-tmp','t','x','d1','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").run();
  db.prepare("delete from team_workspaces where id = 'team-tmp'").run();
  check("διαγραφή οργανισμού: διαγράφονται και όλα τα έγγραφά του (cascade)", db.prepare("select count(*) c from team_documents where workspace_id = 'team-tmp'").get().c === 0);

  // (στ) αν δεν έχει εφαρμοστεί το migration 0013: καθαρό μήνυμα και όχι σκάσιμο
  store.resetMigrationCache();
  db.exec("ALTER TABLE team_documents RENAME TO team_documents_x");
  const noTable = await call("admin@demo.gr", "GET", "/team/documents");
  const noTableBody = await readJson(noTable);
  db.exec("ALTER TABLE team_documents_x RENAME TO team_documents");
  store.resetMigrationCache();
  check("χωρίς το migration 0013: 503 με καθαρό μήνυμα (migration_required), όχι ακατέργαστο σφάλμα", noTable.status === 503 && noTableBody.error === "migration_required");
  check("... και μετά την εφαρμογή του όλα δουλεύουν κανονικά", (await titlesOf("admin@demo.gr")).length > 3);
}

// ============================================================================ 25. Ρόλος ανά project (φέτα 1)
section("25. Ρόλος ανά project: μέλος σε ένα project, editor σε άλλο");
{
  const access = await import(pathToFileURL(join(TMP, "modified", "src", "team", "access.js")).href);
  const adm = (method, path, body) => call("admin@demo.gr", method, `/team/admin${path}`, body);
  const myRole = async (email) => readJson(await call(email, "GET", "/team/me"));
  const post = (email, dep, title) => call(email, "POST", "/team/documents", { title, departmentId: dep, text: `Κείμενο ${title}. PR-X` });

  // (α) πίνακας δικαιωμάτων: ρόλος × ενέργεια, με ρητή άρνηση
  const deps = [{ id: "a", name: "A", hidden: false }, { id: "b", name: "B", hidden: false }, { id: "c", name: "C", hidden: true }];
  const M = (role, departmentIds, editorProjectIds) => ({ role, departmentIds, editorProjectIds });
  const admin = M("admin", [], []);
  const edAmemB = M("editor", ["a", "b"], ["a"]);           // editor στο Α, απλό μέλος στο Β
  const edBoth = M("editor", ["a", "b"], ["a", "b"]);
  const plain = M("employee", ["a"], []);
  const outsider = M("employee", [], []);
  const stale = M("editor", ["a"], ["a", "b"]);             // ανάθεση editor σε project όπου ΔΕΝ είναι μέλος (παλιά γραμμή)
  const w = (m, d) => access.canWriteDepartment(m, deps, d);
  const r = (m, d) => access.canReadDepartment(m, deps, d);
  check("γράφει: admin παντού (και στο _all)", w(admin, "a") && w(admin, "b") && w(admin, "_all"));
  check("γράφει: editor Α + μέλος Β = ΜΟΝΟ στο Α", w(edAmemB, "a") && !w(edAmemB, "b"));
  check("γράφει: editor και στα δύο = και στα δύο, ΠΟΤΕ στο _all", w(edBoth, "a") && w(edBoth, "b") && !w(edBoth, "_all"));
  check("γράφει: απλό μέλος και outsider ΠΟΤΕ", !w(plain, "a") && !w(outsider, "a") && !w(plain, "b"));
  check("γράφει: ανάθεση editor χωρίς συμμετοχή στο project δεν δίνει πρόσβαση (b)", !w(stale, "b") && w(stale, "a"));
  check("γράφει: project που δεν υπάρχει στον οργανισμό ΠΟΤΕ (ούτε ο admin σε ξένο project)", !w(edBoth, "zzz") && !w(admin, "zzz"));
  check("διαβάζει: μέλος και στα δικά του, όχι στα άλλα (b) ούτε στα κρυφά (c)", r(plain, "a") && !r(plain, "b") && !r(plain, "c") && r(plain, "_all"));
  check("διαβάζει: editor (παραγόμενος ρόλος) διαβάζει τα projects όπου είναι μέλος (a, b), όχι κρυφά projects που δεν είναι δικά του (c)", r(edAmemB, "b") && !r(edAmemB, "c"));
  check("ρόλος σε project: admin, editor, member, null", access.projectRoleOf(admin, "a") === "admin" && access.projectRoleOf(edAmemB, "a") === "editor" && access.projectRoleOf(edAmemB, "b") === "member" && access.projectRoleOf(outsider, "a") === null);

  // (β) από άκρη σε άκρη: νέο μέλος με ρόλο ανά project
  const created = await adm("POST", "/members", { email: "lead@demo.gr", role: "member", projectRoles: { cc: "editor", fin: "member" } });
  check("νέο μέλος με ρόλο ανά project: 201", created.status === 201);
  check("αποθήκευση: συμμετοχή σε 2 projects, editor σε 1, παράγωγος ρόλος editor", db.prepare("select count(*) c from member_departments md join team_members m on m.id=md.member_id where m.email='lead@demo.gr'").get().c === 2 && db.prepare("select project_id from team_project_editors e join team_members m on m.id=e.member_id where m.email='lead@demo.gr'").all().map((x) => x.project_id).join() === "cc" && db.prepare("select role from team_members where email='lead@demo.gr'").get().role === "editor");
  S["lead@demo.gr"] = (await login("lead@demo.gr")).cookie;
  const me1 = await myRole("lead@demo.gr");
  check("/team/me: editorProjectIds = [cc], ρόλος editor", me1.role === "editor" && JSON.stringify(me1.editorProjectIds) === JSON.stringify(["cc"]));
  check("γράφει στο cc (editor): 201", (await post("lead@demo.gr", "cc", "Έγγραφο lead cc")).status === 201);
  check("ΔΕΝ γράφει στο fin όπου είναι απλό μέλος: 403", (await post("lead@demo.gr", "fin", "Έγγραφο lead fin")).status === 403);
  const finDocs = (await readJson(await call("lead@demo.gr", "GET", "/team/documents"))).documents.filter((d) => d.departmentId === "fin");
  check("διαβάζει έγγραφα του fin αλλά όχι επεξεργάσιμα", finDocs.length >= 1 && finDocs.every((d) => d.editable === false));
  const finDoc = finDocs[0];
  check("επεξεργασία εγγράφου του fin: 403", (await call("lead@demo.gr", "PUT", `/team/documents/${finDoc.id}`, { title: finDoc.title, departmentId: "fin", text: "Αλλαγή που δεν επιτρέπεται" })).status === 403);
  check("διαγραφή εγγράφου του fin: 403", (await call("lead@demo.gr", "DELETE", `/team/documents/${finDoc.id}`)).status === 403);
  check("μεταφορά δικού του εγγράφου στο fin: 403 (δεν είναι editor εκεί)", await (async () => { const id = (await readJson(await post("lead@demo.gr", "cc", "Μεταφορά Χ"))).id; return (await call("lead@demo.gr", "PUT", `/team/documents/${id}`, { title: "Μεταφορά Χ", departmentId: "fin", text: "Κείμενο Μεταφορά Χ. PR-X" })).status === 403; })());

  // (γ) αλλαγή ρόλων ισχύει ΑΜΕΣΑ, χωρίς νέα σύνδεση
  check("αλλαγή ρόλων (cc: μέλος, fin: editor): 200", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { projectRoles: { cc: "member", fin: "editor" } })).status === 200);
  check("ΑΜΕΣΑ: ο editor μεταφέρθηκε: γράφει στο fin, όχι πια στο cc", (await post("lead@demo.gr", "fin", "Έγγραφο lead fin 2")).status === 201 && (await post("lead@demo.gr", "cc", "Έγγραφο lead cc 2")).status === 403);
  check("το ιστορικό καταγράφει την αλλαγή ρόλων ανά project", (await audit()).some((x) => x.action === "member_project_roles_changed"));
  check("αφαίρεση από project (μόνο fin): χάνει και τη συμμετοχή στο cc, και κάθε δικαίωμα εκεί", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { projectRoles: { fin: "editor" } })).status === 200 && (await post("lead@demo.gr", "cc", "Μετά την αφαίρεση")).status === 403 && db.prepare("select count(*) c from member_departments md join team_members m on m.id=md.member_id where m.email='lead@demo.gr' and md.department_id='cc'").get().c === 0);
  check("υποβάθμιση σε μέλος παντού: ο παράγωγος ρόλος γίνεται employee και χάνει ΑΜΕΣΩΣ τα εισερχόμενα (403)", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { projectRoles: { fin: "member" } })).status === 200 && (await call("lead@demo.gr", "GET", "/team/inbox")).status === 403 && (await myRole("lead@demo.gr")).role === "employee");
  // (δ) συντομογραφίες και έλεγχοι εισόδου
  check("συντομογραφία role=editor: editor σε ΟΛΑ τα projects του", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { projectRoles: { cc: "member", fin: "member" } })).status === 200 && (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { role: "editor" })).status === 200 && (await post("lead@demo.gr", "cc", "Συντομογραφία cc")).status === 201 && (await post("lead@demo.gr", "fin", "Συντομογραφία fin")).status === 201);
  check("role=member: δεν αγγίζει τους ρόλους ανά project", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { role: "member" })).status === 200 && (await post("lead@demo.gr", "cc", "Μετά member")).status === 201);
  check("role=employee: αφαιρεί όλους τους ρόλους editor", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { role: "employee" })).status === 200 && (await post("lead@demo.gr", "cc", "Μετά employee")).status === 403);
  check("άκυρος ρόλος project: 400", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { projectRoles: { cc: "admin" } })).status === 400);
  check("project άλλου οργανισμού: 400", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { projectRoles: { cc2: "editor" } })).status === 400);
  check("projectRoles που δεν είναι αντικείμενο: 400", (await adm("PATCH", `/members/${memberId("lead@demo.gr")}`, { projectRoles: ["cc"] })).status === 400);
  check("δημιουργία με άκυρο project: 400", (await adm("POST", "/members", { email: "bad@demo.gr", role: "member", projectRoles: { nope: "editor" } })).status === 400);
  check("ο editor δεν αλλάζει ρόλους (admin μόνο): 403", (await call("ed_cc@demo.gr", "PATCH", `/team/admin/members/${memberId("lead@demo.gr")}`, { projectRoles: { cc: "editor" } })).status === 403);
  check("ο admin άλλου οργανισμού δεν αλλάζει ρόλους εδώ: 404", (await call("other@other.gr", "PATCH", `/team/admin/members/${memberId("lead@demo.gr")}`, { projectRoles: { cc2: "editor" } })).status === 404);
  const list = (await readJson(await adm("GET", "/overview"))).members.find((m) => m.email === "lead@demo.gr");
  check("η λίστα μελών δείχνει ρόλο ανά project", list && typeof list.projectRoles === "object" && list.projectRoles.cc === "member" && list.projectRoles.fin === "member");
  check("η συμμετοχή σε project με editor ανάθεση: διαγραφή project καθαρίζει τις αναθέσεις (cascade)", await (async () => {
    db.prepare("insert into departments(id,workspace_id,name,hidden,created_at) values('tmp1','team-demo','Tmp',0,'2026-10-01T00:00:00Z')").run();
    db.prepare("insert into member_departments(member_id,department_id) values(?, 'tmp1')").run(memberId("lead@demo.gr"));
    db.prepare("insert into team_project_editors(member_id,project_id,created_at) values(?, 'tmp1','2026-10-01T00:00:00Z')").run(memberId("lead@demo.gr"));
    db.prepare("delete from departments where id='tmp1'").run();
    return db.prepare("select count(*) c from team_project_editors where project_id='tmp1'").get().c === 0;
  })());

  // (ε) migration: κάθε παλιός editor γίνεται editor σε όλα τα τμήματά του, μόνο αυτός
  const t = "2026-10-01T00:00:00Z";
  db.prepare("insert into team_members(workspace_id,email,role,status,created_at) values('team-demo','legacy_ed@demo.gr','editor','active',?)").run(t);
  db.prepare("insert into team_members(workspace_id,email,role,status,created_at) values('team-demo','legacy_emp@demo.gr','employee','active',?)").run(t);
  for (const e of ["legacy_ed@demo.gr", "legacy_emp@demo.gr"]) for (const d of ["cc", "fin"]) db.prepare("insert into member_departments(member_id,department_id) values(?,?)").run(memberId(e), d);
  db.exec(readFileSync(join(REPO, "migrations", "0014_team_project_roles.sql"), "utf8"));
  const legacyRows = (e) => db.prepare("select project_id from team_project_editors where member_id = ? order by 1").all(memberId(e)).map((x) => x.project_id).join();
  check("migration 0014 (backfill): παλιός editor → editor σε όλα τα τμήματά του", legacyRows("legacy_ed@demo.gr") === "cc,fin");
  check("migration 0014 (backfill): παλιός υπάλληλος → κανένας ρόλος editor", legacyRows("legacy_emp@demo.gr") === "");
  db.exec(readFileSync(join(REPO, "migrations", "0014_team_project_roles.sql"), "utf8"));
  check("migration 0014: ασφαλές να ξανατρέξει (καμία διπλή γραμμή)", db.prepare("select count(*) c from team_project_editors where member_id = ?").get(memberId("legacy_ed@demo.gr")).c === 2);
  S["legacy_ed@demo.gr"] = (await login("legacy_ed@demo.gr")).cookie;
  check("ο παλιός editor μετά το backfill: γράφει σε cc και fin όπως πριν", (await post("legacy_ed@demo.gr", "cc", "Παλιός cc")).status === 201 && (await post("legacy_ed@demo.gr", "fin", "Παλιός fin")).status === 201);

  // (ζ) ο ρόλος είναι ΠΑΡΑΓΩΓΟΣ από τις αναθέσεις, όχι από την τιμή που κρατά ο πίνακας μελών
  db.prepare("update team_members set role = 'editor' where email = 'emp_fin@demo.gr'").run();
  const staleRole = await post("emp_fin@demo.gr", "fin", "Παλιά τιμή editor");
  check("μπαγιάτικη τιμή role='editor' στη βάση χωρίς ανάθεση: δεν δίνει δικαίωμα εγγραφής, ρόλος employee, ούτε εισερχόμενα", staleRole.status === 403 && (await myRole("emp_fin@demo.gr")).role === "employee" && (await call("emp_fin@demo.gr", "GET", "/team/inbox")).status === 403);
  db.prepare("update team_members set role = 'employee' where email = 'emp_fin@demo.gr'").run();
  db.prepare("insert into team_project_editors(member_id,project_id,created_at) values(?, 'cc', '2026-10-01T00:00:00Z')").run(memberId("emp_fin@demo.gr"));
  const strayRole = await myRole("emp_fin@demo.gr");
  check("ανάθεση editor σε project όπου ΔΕΝ είναι μέλος: αγνοείται (ρόλος employee, καμία εγγραφή, ούτε εισερχόμενα)", strayRole.role === "employee" && strayRole.editorProjectIds.length === 0 && (await post("emp_fin@demo.gr", "cc", "Ξένη ανάθεση")).status === 403 && (await call("emp_fin@demo.gr", "GET", "/team/inbox")).status === 403);
  db.prepare("delete from team_project_editors where member_id = ?").run(memberId("emp_fin@demo.gr"));
  // προαγωγή σε admin και υποβάθμιση: τα δικαιώματα editor δεν "ανασταίνονται"
  const prom = await adm("POST", "/members", { email: "rise@demo.gr", role: "member", projectRoles: { cc: "editor" } });
  const riseId = (await readJson(prom)).id;
  await adm("PATCH", `/members/${riseId}`, { role: "admin" });
  const afterAdmin = db.prepare("select count(*) c from team_project_editors where member_id = ?").get(riseId).c;
  await adm("PATCH", `/members/${riseId}`, { role: "member" });
  S["rise@demo.gr"] = (await login("rise@demo.gr")).cookie;
  check("προαγωγή σε admin καθαρίζει τις αναθέσεις editor, και η υποβάθμιση σε μέλος ΔΕΝ ανασταίνει δικαιώματα εγγραφής", afterAdmin === 0 && (await post("rise@demo.gr", "cc", "Μετά την υποβάθμιση")).status === 403 && (await myRole("rise@demo.gr")).role === "employee");

  // (στ) αν δεν έχει εφαρμοστεί το migration 0014: το παλιό μοντέλο, χωρίς σκάσιμο
  db.exec("ALTER TABLE team_project_editors RENAME TO team_project_editors_x");
  const legacyWrite = await post("ed_cc@demo.gr", "cc", "Χωρίς migration 0014");
  const legacyEmp = await post("emp_cc@demo.gr", "cc", "Υπάλληλος χωρίς migration");
  db.exec("ALTER TABLE team_project_editors_x RENAME TO team_project_editors");
  check("χωρίς το migration 0014: ο editor γράφει όπως πριν και ο υπάλληλος όχι (παλιό μοντέλο)", legacyWrite.status === 201 && legacyEmp.status === 403);
}

// ============================================================================ 26. Διαχείριση (UX)
section("26. Διαχείριση (UX): μηνύματα με όνομα και ώρα, επιβεβαίωση, κλείδωμα, καρτέλα ατόμου");
{
  // Οι συνεδρίες των δύο admin πρέπει να ισχύουν (αν έληξαν από προηγούμενη ενότητα, ξανασυνδέονται).
  for (const e of ["admin@demo.gr", "other@other.gr"]) {
    if ((await call(e, "GET", "/team/me")).status !== 200) S[e] = (await login(e)).cookie;
  }
  const ctl = { hold: null, fail: false, patches: 0 }; // έλεγχος του ψεύτικου δικτύου της σελίδας
  // Σελίδα admin με ΨΕΥΤΙΚΑ χρονόμετρα και ρολόι: το "5 δευτερόλεπτα" δεν περιμένει πραγματικά, και η ώρα είναι πάντα 12:51:28.
  function adminPage(email) {
    const jar = { value: S[email] };
    const timers = [];
    const bridge = async (input, init = {}) => {
      const url = new URL(input, BASE); const method = init.method || "GET";
      const headers = { "CF-Connecting-IP": `198.51.100.${(ipCounter++ % 250) + 1}`, ...(init.headers || {}) };
      if (jar.value && url.pathname.startsWith("/team")) headers.Cookie = jar.value;
      if (method !== "GET") headers.Origin = BASE;
      if (method === "PATCH" && url.pathname.startsWith("/team/admin/members/")) {
        ctl.patches++;
        if (ctl.hold) await ctl.hold;
        if (ctl.fail) throw new TypeError("network down");
      }
      return workerNew.fetch(new Request(url, { method, headers, body: init.body }), env);
    };
    const dom = new JSDOMu(readFileSync(join(REPO, "public", "team-admin.html"), "utf8"), {
      url: BASE + "/team-admin.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VCu(),
      beforeParse(w) {
        w.fetch = bridge; w.TextDecoder = TextDecoder;
        const RealDate = w.Date;
        w.Date = class extends RealDate {
          constructor(...a) { if (a.length) super(...a); else super(2026, 9, 1, 12, 51, 28); }
          static now() { return new RealDate(2026, 9, 1, 12, 51, 28).getTime(); }
        };
        w.setTimeout = (fn, ms) => { timers.push({ fn, ms, done: false }); return timers.length; };
        w.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].done = true; };
      },
    });
    const live = (ms) => timers.filter((t) => !t.done && t.ms === ms);
    const fire = (ms) => { for (const t of live(ms)) { t.done = true; t.fn(); } };
    return { dom, live, fire };
  }
  const rowOf = (dom, email) => $$u(dom, ".member-row").find((r) => r.textContent.includes(email));
  const pick = (dom, sel, value) => { sel.value = value; sel.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  const typeInto = (dom, sel, value) => { const el = $u(dom, sel); el.value = value; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  const toastText = (dom) => { const t = $u(dom, ".toast"); return t ? t.textContent : null; };
  const settle = (dom) => uiWait(() => $u(dom, ".member-row, .dept-row, .doc-row") && !$u(dom, ".busy")); // η λίστα ξαναχτίστηκε και τίποτα δεν είναι κλειδωμένο
  const roleOf = (id) => db.prepare("select role from team_members where id = ?").get(id).role;
  const statusOf = (id) => db.prepare("select status from team_members where id = ?").get(id).status;
  const allEnabled = (el) => [...el.querySelectorAll("select, button, input")].every((x) => !x.disabled);
  // Η καρτέλα ατόμου ανοίγει με αναζήτηση και κλικ στο email της γραμμής (η λίστα δείχνει 25 ανά σελίδα).
  const openPerson = async (dom, email) => {
    if (!$u(dom, "#people-q")) clickU(dom, await uiWait(() => $u(dom, "#tab-members")));
    await uiWait(() => $u(dom, "#people-q"));
    typeInto(dom, "#people-q", email);
    const row = await uiWait(() => { const rs = $$u(dom, ".member-row"); return rs.length === 1 && rs[0].textContent.includes(email) ? rs[0] : null; });
    clickU(dom, row.querySelector(".open-member"));
    return uiWait(() => { const d = $u(dom, "#member-detail"); return d && d.textContent.includes(email) ? d : null; });
  };
  const detailOf = (dom) => $u(dom, "#member-detail");
  const segBtn = (dom, project, kind) => $u(dom, `#member-detail .prow[data-project=${project}] .seg-${kind}`);

  const ccName = db.prepare("select name from departments where id = 'cc'").get().name;
  const finName = db.prepare("select name from departments where id = 'fin'").get().name;
  const mk = async (email, projectRoles) => (await readJson(await call("admin@demo.gr", "POST", "/team/admin/members", { email, role: "member", projectRoles, sendInvite: false }))).id;
  const uxId = await mk("ux.agent@demo.gr", { cc: "member" });
  await newDocU("ed_cc@demo.gr", "UX έγγραφο", "cc", "Κείμενο δοκιμής για τα μηνύματα της διαχείρισης.");

  // ------------------------------------------------------------ (α) μήνυμα επιβεβαίωσης: ποιος, τι, πότε
  const A = adminPage("admin@demo.gr");
  await openPerson(A.dom, "ux.agent@demo.gr");
  clickU(A.dom, segBtn(A.dom, "cc", "editor"));
  const t1 = await uiWait(() => $u(A.dom, ".toast.ok"));
  check("μήνυμα: λέει ποιος, τι και πότε (email: project → ρόλος (ώρα))", !!t1 && t1.textContent === `ux.agent@demo.gr: ${ccName} → Editor (12:51:28)`);
  check("μήνυμα: σταθερή περιοχή aria-live=polite, το μήνυμα επιτυχίας έχει role=status", !!t1 && $u(A.dom, "#notice").getAttribute("aria-live") === "polite" && t1.getAttribute("role") === "status");
  await uiWait(() => $u(A.dom, ".member-row.changed"));
  check("η γραμμή που άλλαξε επισημαίνεται, και η επισήμανση φεύγει με το χρονόμετρο του 1 δευτερολέπτου",
    !!$u(A.dom, ".member-row.changed") && A.live(1000).length === 1 && (A.fire(1000), !$u(A.dom, ".member-row.changed")));
  check("το μήνυμα φαίνεται μέχρι το χρονόμετρο των 5 δευτερολέπτων και μετά εξαφανίζεται μόνο του",
    A.live(5000).length === 1 && !!$u(A.dom, ".toast") && (A.fire(5000), !$u(A.dom, ".toast")));

  // ------------------------------------------------------------ (β) δύο διαδοχικές ενέργειες: νέο μήνυμα, το χρονόμετρο ξεκινά από την αρχή
  clickU(A.dom, segBtn(A.dom, "cc", "member"));
  await uiWait(() => $u(A.dom, ".member-row.changed"));
  A.fire(1000);
  const first = toastText(A.dom);
  pick(A.dom, $u(A.dom, "#detail-add-project"), "fin");
  await uiWait(() => (toastText(A.dom) || "").includes(finName));
  await uiWait(() => $u(A.dom, ".member-row.changed"));
  check("δεύτερη ενέργεια: ένα μόνο μήνυμα, με νέο κείμενο (άλλο project), όχι το παλιό", $$u(A.dom, ".toast").length === 1 && toastText(A.dom) !== first && (toastText(A.dom) || "").includes(`${finName} → Μέλος`));
  check("δεύτερη ενέργεια: το χρονόμετρο του πρώτου μηνύματος ακυρώθηκε και υπάρχει ΕΝΑ νέο (5 δευτερολέπτων)", A.live(5000).length === 1);
  A.fire(1000); A.fire(5000);

  // ------------------------------------------------------------ (γ) ίδια ενέργεια δύο φορές την ίδια στιγμή: διακριτό με μετρητή
  clickU(A.dom, $u(A.dom, "#tab-departments"));
  const deptRow = (n) => $$u(A.dom, ".dept-row").find((r) => r.querySelector("input[type=text]").value === n);
  const saveBtn = (n) => [...deptRow(n).querySelectorAll("button")].find((b) => /Αποθήκευση ονόματος/.test(b.textContent));
  clickU(A.dom, saveBtn(finName));
  await uiWait(() => $u(A.dom, ".dept-row.changed"));
  clickU(A.dom, saveBtn(finName));
  const t2 = await uiWait(() => /×2/.test(toastText(A.dom) || "") && toastText(A.dom));
  check("ίδιο μήνυμα την ίδια στιγμή: ένα μόνο toast, διακριτό με μετρητή ×2", t2 === `${finName}: μετονομάστηκε σε ${finName} (12:51:28) ×2` && $$u(A.dom, ".toast").length === 1);
  A.fire(1000); A.fire(5000);

  // ------------------------------------------------------------ (δ) το σφάλμα ΜΕΝΕΙ μέχρι την επόμενη ενέργεια
  const B = adminPage("other@other.gr");
  await openPerson(B.dom, "other@other.gr");
  const onlyAdmin = db.prepare("select count(*) c from team_members where workspace_id = (select workspace_id from team_members where email = 'other@other.gr') and role = 'admin' and status = 'active'").get().c === 1;
  pick(B.dom, $u(B.dom, "#detail-org-role"), "member");
  const te = await uiWait(() => $u(B.dom, ".toast.err"));
  await settle(B.dom);
  check("σφάλμα (τελευταίος admin): μένει ορατό ΜΕΤΑ την ανανέωση, role=alert, χωρίς χρονόμετρο εξαφάνισης", onlyAdmin && !!te && /χωρίς ενεργό admin/.test(te.textContent) && te.getAttribute("role") === "alert" && B.live(5000).length === 0 && !!$u(B.dom, ".toast.err"));
  clickU(B.dom, $u(B.dom, ".toast.err .x"));
  check("σφάλμα: το κουμπί κλεισίματος το αφαιρεί", !$u(B.dom, ".toast"));
  pick(B.dom, $u(B.dom, "#detail-org-role"), "member");
  await uiWait(() => $u(B.dom, ".toast.err"));
  await settle(B.dom);
  clickU(B.dom, $u(B.dom, "#tab-departments"));
  check("σφάλμα: φεύγει με την επόμενη ενέργεια (αλλαγή καρτέλας)", !$u(B.dom, ".toast"));
  check("σφάλμα: ο τελευταίος admin παραμένει admin", roleOf(db.prepare("select id from team_members where email = 'other@other.gr'").get().id) === "admin");

  // ------------------------------------------------------------ (ε) σφάλμα δικτύου: η καρτέλα ΞΕΚΛΕΙΔΩΝΕΙ
  clickU(A.dom, $u(A.dom, "#tab-members"));
  await uiWait(() => detailOf(A.dom));
  ctl.fail = true;
  clickU(A.dom, segBtn(A.dom, "cc", "editor"));
  const tn = await uiWait(() => $u(A.dom, ".toast.err"));
  await settle(A.dom);
  ctl.fail = false;
  check("σφάλμα δικτύου: μήνυμα, καμία αλλαγή στη βάση, και η καρτέλα ξεκλειδώνει", !!tn && /Δεν υπάρχει σύνδεση/.test(tn.textContent) && allEnabled(detailOf(A.dom)) && db.prepare("select count(*) c from team_project_editors where member_id = ?").get(uxId).c === 0);

  // ------------------------------------------------------------ (στ) κλείδωμα καρτέλας όσο τρέχει το αίτημα
  let release; ctl.hold = new Promise((r) => { release = r; }); ctl.patches = 0;
  clickU(A.dom, segBtn(A.dom, "cc", "editor"));
  const busyCard = $u(A.dom, "#member-detail.busy");
  check("κλείδωμα: όσο τρέχει το αίτημα η καρτέλα είναι busy, aria-busy και ΟΛΑ τα χειριστήρια σβηστά", !!busyCard && busyCard.getAttribute("aria-busy") === "true" && [...busyCard.querySelectorAll("select, button")].every((x) => x.disabled));
  pick(A.dom, $u(A.dom, "#detail-add-project"), "hr"); // δεύτερη αλλαγή προγραμματιστικά (παρακάμπτει το disabled)
  await new Promise((r) => setTimeout(r, 50));
  check("κλείδωμα: δεύτερη αλλαγή στο ίδιο άτομο ΔΕΝ στέλνεται (ένα μόνο αίτημα)", ctl.patches === 1);
  ctl.hold = null; release();
  await uiWait(() => $u(A.dom, ".toast.ok") && !$u(A.dom, ".busy"));
  check("κλείδωμα: μετά την απάντηση ξεκλειδώνει, έγινε το cc και ΔΕΝ μπήκε το hr", allEnabled(detailOf(A.dom)) && roleOf(uxId) === "editor" && db.prepare("select count(*) c from member_departments where member_id = ? and department_id = 'hr'").get(uxId).c === 0);
  A.fire(1000); A.fire(5000);

  // ------------------------------------------------------------ (ζ) επιβεβαίωση ΜΟΝΟ για μεγάλο αντίκτυπο
  await call("admin@demo.gr", "PATCH", `/team/admin/members/${uxId}`, { projectRoles: { cc: "member" } });
  const C = adminPage("admin@demo.gr");
  await openPerson(C.dom, "ux.agent@demo.gr");
  const orgSel = () => $u(C.dom, "#detail-org-role");
  const toggleOf = () => $u(C.dom, "#member-detail .status-toggle");
  ctl.patches = 0;
  pick(C.dom, orgSel(), "admin");
  await uiWait(() => $u(C.dom, ".confirm"));
  const cf = $u(C.dom, ".confirm");
  check("προαγωγή σε Admin: ζητά «Σίγουρα;», δεν στέλνεται τίποτα και ο ρόλος δεν αλλάζει", !!cf && /Σίγουρα;/.test(cf.textContent) && ctl.patches === 0 && roleOf(uxId) !== "admin");
  check("προαγωγή σε Admin: τα υπόλοιπα χειριστήρια σβήνουν, τα «Ναι»/«Όχι» μένουν ενεργά", [...detailOf(C.dom).querySelectorAll("select, .status-toggle")].every((x) => x.disabled) && [...cf.querySelectorAll("button")].every((b) => !b.disabled));
  clickU(C.dom, $u(C.dom, ".confirm-no"));
  check("«Όχι»: επαναφέρει την επιλογή, κλείνει την ερώτηση, ξεκλειδώνει και δεν αλλάζει τίποτα", orgSel().value === "member" && !$u(C.dom, ".confirm") && ctl.patches === 0 && allEnabled(detailOf(C.dom)) && roleOf(uxId) !== "admin");
  pick(C.dom, orgSel(), "admin");
  await uiWait(() => $u(C.dom, ".confirm"));
  $u(C.dom, ".confirm-no").dispatchEvent(new C.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Escape ακυρώνει την ερώτηση", !$u(C.dom, ".confirm") && ctl.patches === 0 && orgSel().value === "member");
  pick(C.dom, orgSel(), "admin");
  await uiWait(() => $u(C.dom, ".confirm"));
  clickU(C.dom, $u(C.dom, ".confirm-yes"));
  await uiWait(() => roleOf(uxId) === "admin");
  await settle(C.dom);
  check("«Ναι»: ο ρόλος γίνεται Admin με ένα αίτημα και μήνυμα με όνομα", ctl.patches === 1 && /ux\.agent@demo\.gr: ρόλος Admin \(12:51:28\)/.test(toastText(C.dom) || ""));
  check("ο admin δεν έχει γραμμές projects στην καρτέλα (έχει πρόσβαση παντού)", /πρόσβαση σε όλα τα projects/.test(detailOf(C.dom).textContent) && !$u(C.dom, "#member-detail .prow"));
  ctl.patches = 0;
  pick(C.dom, orgSel(), "member");
  await uiWait(() => roleOf(uxId) !== "admin");
  check("υποβάθμιση από Admin: ΧΩΡΙΣ επιβεβαίωση (ένα αίτημα)", ctl.patches === 1 && !$u(C.dom, ".confirm"));
  await settle(C.dom);
  ctl.patches = 0;
  clickU(C.dom, toggleOf());
  await uiWait(() => $u(C.dom, ".confirm"));
  check("απενεργοποίηση μέλους: ζητά «Σίγουρα;», δεν στέλνεται τίποτα και το μέλος μένει ενεργό", /Σίγουρα;/.test(($u(C.dom, ".confirm") || {}).textContent || "") && ctl.patches === 0 && statusOf(uxId) === "active");
  clickU(C.dom, $u(C.dom, ".confirm-no"));
  check("«Όχι» στην απενεργοποίηση: μένει ενεργό και η καρτέλα ξεκλειδώνει", statusOf(uxId) === "active" && !$u(C.dom, ".confirm") && allEnabled(detailOf(C.dom)));
  clickU(C.dom, toggleOf());
  await uiWait(() => $u(C.dom, ".confirm"));
  clickU(C.dom, $u(C.dom, ".confirm-yes"));
  await uiWait(() => statusOf(uxId) === "disabled");
  await settle(C.dom);
  check("«Ναι» στην απενεργοποίηση: το μέλος απενεργοποιείται και φαίνεται ως τέτοιο στη λίστα", statusOf(uxId) === "disabled" && /απενεργοποιημένο/.test(rowOf(C.dom, "ux.agent@demo.gr").textContent) && /ux\.agent@demo\.gr: απενεργοποιήθηκε/.test(toastText(C.dom) || ""));
  ctl.patches = 0;
  clickU(C.dom, toggleOf());
  await uiWait(() => statusOf(uxId) === "active");
  check("ενεργοποίηση μέλους: ΧΩΡΙΣ επιβεβαίωση", ctl.patches === 1 && !$u(C.dom, ".confirm"));
  await settle(C.dom);
  C.fire(1000); C.fire(5000);

  // ------------------------------------------------------------ (η) μηνύματα στις υπόλοιπες καρτέλες
  clickU(C.dom, $u(C.dom, "#tab-departments"));
  const cDept = (n) => $$u(C.dom, ".dept-row").find((r) => r.querySelector("input[type=text]").value === n);
  const wasHidden = db.prepare("select hidden from departments where id = 'fin'").get().hidden === 1;
  clickU(C.dom, cDept(finName).querySelector(".hide-toggle"));
  await uiWait(() => $u(C.dom, ".dept-row.changed"));
  check("project: μήνυμα με όνομα, κατάσταση και ώρα", toastText(C.dom) === `${finName}: ${wasHidden ? "ορατό" : "κρυφό"} project (12:51:28)`);
  C.fire(1000);
  clickU(C.dom, cDept(finName).querySelector(".hide-toggle")); // επαναφορά
  await uiWait(() => $u(C.dom, ".dept-row.changed") && db.prepare("select hidden from departments where id = 'fin'").get().hidden === (wasHidden ? 1 : 0));
  C.fire(1000);
  $u(C.dom, "#new-dept").value = "UX Project";
  $u(C.dom, "#add-dept").dispatchEvent(new C.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await uiWait(() => $u(C.dom, ".dept-row.changed"));
  check("νέο project: μήνυμα «όνομα: νέο project (ώρα)» και επισημασμένη γραμμή", toastText(C.dom) === "UX Project: νέο project (12:51:28)" && !!cDept("UX Project"));
  C.fire(1000);
  clickU(C.dom, $u(C.dom, "#tab-documents"));
  const docRow = await uiWait(() => $$u(C.dom, ".doc-row").find((r) => /UX έγγραφο/.test(r.textContent)));
  clickU(C.dom, docRow.querySelector(".doc-hide-toggle"));
  await uiWait(() => $u(C.dom, ".doc-row.changed"));
  check("έγγραφο: μήνυμα «τίτλος: εμπιστευτικό (ώρα)» και επισημασμένη γραμμή", toastText(C.dom) === "UX έγγραφο: εμπιστευτικό (12:51:28)");
  C.fire(1000);
  clickU(C.dom, $$u(C.dom, ".doc-row").find((r) => /UX έγγραφο/.test(r.textContent)).querySelector(".doc-hide-toggle"));
  await uiWait(() => /δεν είναι πια εμπιστευτικό/.test(toastText(C.dom) || ""));
  check("έγγραφο: άρση: «τίτλος: δεν είναι πια εμπιστευτικό»", toastText(C.dom) === "UX έγγραφο: δεν είναι πια εμπιστευτικό (12:51:28)");
  C.fire(1000);
  clickU(C.dom, $u(C.dom, "#tab-members"));
  await uiWait(() => $u(C.dom, "#people-q"));
  typeInto(C.dom, "#people-q", "ux.nea");
  $u(C.dom, "#new-email").value = "ux.nea@demo.gr";
  $u(C.dom, "#new-project").value = "cc";
  $u(C.dom, "#new-project-role").value = "editor";
  $u(C.dom, "#add-member").dispatchEvent(new C.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await uiWait(() => $u(C.dom, ".member-row.changed"));
  check("νέο άτομο: μήνυμα «email: νέο μέλος (ώρα)», επισημασμένη γραμμή", toastText(C.dom) === "ux.nea@demo.gr: νέο μέλος (12:51:28)" && !!rowOf(C.dom, "ux.nea@demo.gr"));
  check("νέο άτομο: το project και ο ρόλος από τη φόρμα ισχύουν", db.prepare("select count(*) c from team_project_editors where member_id = (select id from team_members where email = 'ux.nea@demo.gr') and project_id = 'cc'").get().c === 1);

  // ------------------------------------------------------------ (θ) το ιστορικό δείχνει ελληνική ετικέτα για τις αλλαγές ρόλων ανά project
  clickU(C.dom, $u(C.dom, "#tab-audit"));
  const auditText = await uiWait(() => { const x = $u(C.dom, "#app").textContent; return /Ιστορικό ενεργειών/.test(x) && x; });
  check("ιστορικό: οι αλλαγές ρόλων ανά project έχουν ελληνική ετικέτα και όχι το τεχνικό όνομα", !!auditText && /αλλαγή ρόλων ανά project/.test(auditText) && !/member_project_roles_changed/.test(auditText));
}

// ============================================================================ 27. Άνθρωποι και projects: μαζικές ενέργειες (API)
section("27. Μαζικές ενέργειες: αλλαγές projects ανά πολλά μέλη και μαζική απενεργοποίηση (API)");
// Το ψεύτικο D1 δεν είχε batch. Εδώ το προσθέτουμε όπως λειτουργεί στην πραγματική βάση: ατομικά, όλα ή τίποτα.
env.DB.batch = async (statements) => {
  db.exec("BEGIN");
  try { for (const s of statements) await s.run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
};
const bulk = async (body, who = "admin@demo.gr") => { const res = await call(who, "POST", "/team/admin/memberships", body); return { status: res.status, data: await readJson(res) }; };
const bstatus = async (body, who = "admin@demo.gr") => { const res = await call(who, "POST", "/team/admin/members/bulk-status", body); return { status: res.status, data: await readJson(res) }; };
const mkMember = (email, ws = "team-demo") => Number(db.prepare("insert into team_members (workspace_id,email,role,status,created_at) values (?,?,?,?,?)").run(ws, email, "employee", "active", new Date().toISOString()).lastInsertRowid);
const projectsOf = (id) => Object.fromEntries(db.prepare("select d.department_id d, case when e.member_id is null then 'member' else 'editor' end r from member_departments d left join team_project_editors e on e.member_id = d.member_id and e.project_id = d.department_id where d.member_id = ?").all(id).map((r) => [r.d, r.r]));
const storedRoleOf = (id) => db.prepare("select role from team_members where id = ?").get(id).role;
const auditN = (a) => db.prepare("select count(*) c from team_audit_log where action = ?").get(a).c;
const snapMembership = () => JSON.stringify(db.prepare("select * from member_departments order by member_id, department_id").all());
{
  check("bulk: editor (όχι admin) 403", (await bulk({ memberIds: [1], changes: [{ projectId: "cc", role: "member" }] }, "ed_cc@demo.gr")).status === 403);
  check("bulk-status: editor 403", (await bstatus({ memberIds: [1], status: "disabled" }, "ed_cc@demo.gr")).status === 403);

  const m1 = mkMember("bk1@demo.gr"), m2 = mkMember("bk2@demo.gr"), m3 = mkMember("bk3@demo.gr");
  let r = await bulk({ memberIds: [m1, m2, m3], changes: [{ projectId: "cc", role: "member" }] });
  check("προσθήκη 3 μελών στο cc ως Μέλος σε ΕΝΑ αίτημα", r.status === 200 && r.data.updated === 3 && r.data.created === 0 && r.data.skippedAdmins === 0 && [m1, m2, m3].every((id) => JSON.stringify(projectsOf(id)) === '{"cc":"member"}'), r);
  await bulk({ memberIds: [m1, m2], changes: [{ projectId: "cc", role: "editor" }] });
  check("ανάθεση Editor στους 2: ρόλοι στο cc και αποθηκευμένος ρόλος editor μόνο γι' αυτούς", projectsOf(m1).cc === "editor" && projectsOf(m2).cc === "editor" && projectsOf(m3).cc === "member" && storedRoleOf(m1) === "editor" && storedRoleOf(m3) === "employee");
  await bulk({ memberIds: [m1], changes: [{ projectId: "cc", role: "member" }] });
  check("υποβάθμιση σε Μέλος: φεύγει ο editor, μένει η συμμετοχή, ο αποθηκευμένος ρόλος γίνεται employee", projectsOf(m1).cc === "member" && storedRoleOf(m1) === "employee");
  await bulk({ memberIds: [m1, m2, m3], changes: [{ projectId: "cc", role: null }] });
  check("αφαίρεση από το cc: καμία συμμετοχή ή ανάθεση editor", [m1, m2, m3].every((id) => Object.keys(projectsOf(id)).length === 0) && storedRoleOf(m2) === "employee");
  await bulk({ memberIds: [m1], changes: [{ projectId: "cc", role: "editor" }, { projectId: "fin", role: "member" }, { projectId: "hr", role: "member" }] });
  check("πολλά projects σε ένα αίτημα: editor στο cc, μέλος σε fin και hr", projectsOf(m1).cc === "editor" && projectsOf(m1).fin === "member" && projectsOf(m1).hr === "member");
  await bulk({ memberIds: [m1], changes: [{ projectId: "cc", role: "member" }, { projectId: "hr", role: null }] });
  check("μικτές αλλαγές στο ίδιο αίτημα: υποβάθμιση cc και αφαίρεση hr, το fin μένει", projectsOf(m1).cc === "member" && projectsOf(m1).hr === undefined && projectsOf(m1).fin === "member");
  await bulk({ memberIds: [m1], changes: [{ projectId: "cc", role: "member" }] });
  check("ξανά η ίδια αλλαγή: ασφαλές (καμία διπλή γραμμή)", db.prepare("select count(*) c from member_departments where member_id = ? and department_id = 'cc'").get(m1).c === 1);

  // ο admin παραλείπεται
  const adminId = memberId("admin@demo.gr");
  const adminBefore = JSON.stringify(projectsOf(adminId));
  r = await bulk({ memberIds: [adminId, m3], changes: [{ projectId: "fin", role: "editor" }] });
  check("ο admin παραλείπεται (skippedAdmins=1), ο άλλος ενημερώνεται", r.data.skippedAdmins === 1 && r.data.updated === 1 && JSON.stringify(projectsOf(adminId)) === adminBefore && storedRoleOf(adminId) === "admin" && projectsOf(m3).fin === "editor", r);
  r = await bulk({ memberIds: [adminId], changes: [{ projectId: "fin", role: "editor" }] });
  check("μόνο admin στην επιλογή: updated=0 και καμία αλλαγή", r.status === 200 && r.data.updated === 0 && r.data.skippedAdmins === 1);

  // απομόνωση οργανισμών και έλεγχοι εισόδου
  const foreign = mkMember("bk-other@other.gr", "team-other");
  const s0 = snapMembership();
  r = await bulk({ memberIds: [m1, foreign], changes: [{ projectId: "cc", role: "editor" }] });
  check("id μέλους άλλου οργανισμού: 404 και ΤΙΠΟΤΑ δεν αλλάζει ούτε για τους έγκυρους", r.status === 404 && snapMembership() === s0 && projectsOf(m1).cc === "member");
  check("project άλλου οργανισμού: 400 invalid_projects", (await bulk({ memberIds: [m1], changes: [{ projectId: "cc2", role: "member" }] })).data.error === "invalid_projects");
  check("άκυρος ρόλος: 400", (await bulk({ memberIds: [m1], changes: [{ projectId: "cc", role: "admin" }] })).data.error === "invalid_role");
  check("λείπει ο ρόλος: 400 και ΟΧΙ σιωπηλή αφαίρεση", (await bulk({ memberIds: [m1], changes: [{ projectId: "cc" }] })).data.error === "invalid_role" && projectsOf(m1).cc === "member");
  check("το ίδιο project δύο φορές: 400", (await bulk({ memberIds: [m1], changes: [{ projectId: "cc", role: "member" }, { projectId: "cc", role: "editor" }] })).data.error === "invalid_changes");
  check("χωρίς αλλαγές: 400", (await bulk({ memberIds: [m1], changes: [] })).data.error === "invalid_changes");
  check("πάνω από 10 αλλαγές: 400", (await bulk({ memberIds: [m1], changes: Array.from({ length: 11 }, () => ({ projectId: "cc", role: "member" })) })).status === 400);
  check("χωρίς μέλη: 400 no_targets", (await bulk({ changes: [{ projectId: "cc", role: "member" }] })).data.error === "no_targets");
  check("id ως κείμενο (προσπάθεια SQL): 400 invalid_members και ο πίνακας υπάρχει", (await bulk({ memberIds: ["1; DROP TABLE team_members"], changes: [{ projectId: "cc", role: "member" }] })).data.error === "invalid_members" && db.prepare("select count(*) c from team_members").get().c > 5);
  check("πάνω από 100 μέλη: 400 too_many", (await bulk({ memberIds: Array.from({ length: 101 }, (_, i) => i + 1), changes: [{ projectId: "cc", role: "member" }] })).data.error === "too_many");
  check("άκυρο email: 400 invalid_emails", (await bulk({ emails: ["όχι email"], changes: [{ projectId: "cc", role: "member" }] })).data.error === "invalid_emails");

  // emails: υπάρχοντα, άγνωστα, δημιουργία, προσκλήσεις
  mkMember("bk-existing@demo.gr");
  r = await bulk({ emails: ["BK-EXISTING@demo.gr", "bk-new1@demo.gr", "bk-new2@demo.gr"], changes: [{ projectId: "fin", role: "member" }] });
  check("emails: ο υπάρχων (με κεφαλαία) ενημερώνεται, οι άγνωστοι ΔΕΝ δημιουργούνται χωρίς createMissing", r.data.updated === 1 && r.data.created === 0 && r.data.notAdded.length === 2 && !db.prepare("select 1 from team_members where email = 'bk-new1@demo.gr'").get(), r);
  const mailsBefore = state.emails.length;
  r = await bulk({ emails: ["bk-new1@demo.gr", "bk-new2@demo.gr", "bk-existing@demo.gr"], createMissing: true, sendInvite: true, changes: [{ projectId: "cc", role: "member" }] });
  const created1 = db.prepare("select id, role, status, workspace_id from team_members where email = 'bk-new1@demo.gr'").get();
  check("createMissing: 2 νέα μέλη (employee, ενεργά, σωστός οργανισμός) μπαίνουν στο project", r.status === 200 && r.data.created === 2 && r.data.updated === 3 && !!created1 && created1.role === "employee" && created1.status === "active" && created1.workspace_id === "team-demo" && projectsOf(created1.id).cc === "member", r);
  const invites = state.emails.slice(mailsBefore);
  check("προσκλήσεις ΜΟΝΟ στους 2 νέους, με σύνδεσμο προς το portal", r.data.invited === 2 && invites.length === 2 && invites.every((m) => /^bk-new[12]@demo\.gr$/.test(m.to)) && invites[0].text.includes(BASE + "/portal.html"), invites.map((m) => m.to));
  r = await bulk({ emails: ["bk-other@other.gr"], createMissing: true, changes: [{ projectId: "cc", role: "member" }] });
  check("email που ανήκει σε ΑΛΛΟΝ οργανισμό: δεν δημιουργείται ούτε αλλάζει, και δεν αποκαλύπτεται", r.status === 200 && r.data.created === 0 && r.data.notAdded.includes("bk-other@other.gr") && db.prepare("select workspace_id from team_members where email = 'bk-other@other.gr'").get().workspace_id === "team-other" && Object.keys(projectsOf(foreign)).length === 0);
  const countMembers = () => db.prepare("select count(*) c from team_members").get().c;
  const c0 = countMembers();
  r = await bulk({ emails: Array.from({ length: 41 }, (_, i) => `bk-inv${i}@demo.gr`), createMissing: true, sendInvite: true, changes: [{ projectId: "cc", role: "member" }] });
  check("πάνω από 40 νέα μέλη με πρόσκληση: 400 too_many_invites και ΤΙΠΟΤΑ δεν δημιουργείται", r.data.error === "too_many_invites" && countMembers() === c0);
  r = await bulk({ emails: Array.from({ length: 60 }, (_, i) => `bkbulk${i}@demo.gr`), createMissing: true, sendInvite: false, changes: [{ projectId: "cc", role: "member" }] });
  check("60 νέα μέλη χωρίς πρόσκληση σε ένα αίτημα", r.data.created === 60 && r.data.updated === 60 && countMembers() === c0 + 60);

  // ατομικότητα: σπασμένο migration στη μέση
  const x1 = mkMember("bk-atomic@demo.gr");
  db.exec("ALTER TABLE team_project_editors RENAME TO team_project_editors_x");
  const snapBefore = snapMembership();
  r = await bulk({ memberIds: [x1], changes: [{ projectId: "cc", role: "member" }] });
  check("λείπει πίνακας στη μέση: καθαρό 503 migration_required", r.status === 503 && r.data.error === "migration_required", r);
  check("... και οι αλλαγές ΔΕΝ μένουν μισές (rollback)", snapMembership() === snapBefore && db.prepare("select count(*) c from member_departments where member_id = ?").get(x1).c === 0);
  db.exec("ALTER TABLE team_project_editors_x RENAME TO team_project_editors");
  const nb = env.DB.batch; delete env.DB.batch;
  r = await bulk({ memberIds: [x1], changes: [{ projectId: "cc", role: "member" }] });
  check("χωρίς διαθέσιμο batch: δουλεύει διαδοχικά", r.status === 200 && projectsOf(x1).cc === "member");
  env.DB.batch = nb;

  // ιστορικό
  const a0 = auditN("members_bulk_changed");
  await bulk({ memberIds: [m1, m2, m3], changes: [{ projectId: "fin", role: "member" }] });
  check("ΜΙΑ γραμμή ιστορικού ανά μαζική ενέργεια", auditN("members_bulk_changed") === a0 + 1);
  const lastAudit = db.prepare("select target, detail from team_audit_log where action = 'members_bulk_changed' order by id desc limit 1").get();
  check("... με αριθμούς και projects, ΧΩΡΙΣ emails και χωρίς στόχο", JSON.parse(lastAudit.detail).count === 3 && JSON.parse(lastAudit.detail).projects[0] === "fin:member" && !/@/.test(lastAudit.detail) && lastAudit.target === null, lastAudit);
  const a1 = auditN("members_bulk_changed");
  await bulk({ memberIds: [adminId], changes: [{ projectId: "fin", role: "member" }] });
  check("ενέργεια χωρίς καμία αλλαγή (μόνο admin): δεν γράφεται ιστορικό", auditN("members_bulk_changed") === a1);

  // overview
  const ov = await readJson(await call("admin@demo.gr", "GET", "/team/admin/overview"));
  const m3view = ov.members.find((x) => x.id === m3);
  check("overview: projectRoles ταιριάζουν με τη βάση", JSON.stringify(m3view.projectRoles) === JSON.stringify(projectsOf(m3)));

  // ο ρόλος ισχύει ΑΜΕΣΑ στο session
  const edEmail = "bk-ed@demo.gr"; const edId = mkMember(edEmail); S[edEmail] = (await login(edEmail)).cookie;
  check("πριν: ο νέος υπάλληλος δεν έχει εισερχόμενα (403)", (await call(edEmail, "GET", "/team/inbox")).status === 403);
  await bulk({ memberIds: [edId], changes: [{ projectId: "cc", role: "editor" }] });
  check("μετά το bulk: ο ρόλος ισχύει ΑΜΕΣΑ χωρίς νέα σύνδεση (εισερχόμενα 200)", (await call(edEmail, "GET", "/team/inbox")).status === 200);
  await bulk({ memberIds: [edId], changes: [{ projectId: "cc", role: "member" }] });
  check("υποβάθμιση: χάνει την πρόσβαση ΑΜΕΣΑ (403)", (await call(edEmail, "GET", "/team/inbox")).status === 403);

  // μαζική απενεργοποίηση
  const s1 = mkMember("bk-s1@demo.gr"), s2 = mkMember("bk-s2@demo.gr"), s3 = mkMember("bk-s3@demo.gr");
  S["bk-s1@demo.gr"] = (await login("bk-s1@demo.gr")).cookie;
  check("πριν την απενεργοποίηση: το s1 έχει ενεργή σύνδεση", (await call("bk-s1@demo.gr", "GET", "/team/me")).status === 200);
  r = await bstatus({ memberIds: [s1, s2, adminId], status: "disabled" });
  check("bulk-status: απενεργοποιούνται 2, ο admin παραλείπεται", r.status === 200 && r.data.updated === 2 && r.data.skippedAdmins === 1, r);
  const statusOf27 = (id) => db.prepare("select status from team_members where id = ?").get(id).status;
  check("... κατάσταση στη βάση: s1, s2 disabled, ο admin active", statusOf27(s1) === "disabled" && statusOf27(s2) === "disabled" && statusOf27(adminId) === "active");
  check("... η σύνδεση του s1 κλείνει ΑΜΕΣΑ (401) και τα sessions σβήνονται", (await call("bk-s1@demo.gr", "GET", "/team/me")).status === 401 && db.prepare("select count(*) c from team_sessions where member_id in (?, ?)").get(s1, s2).c === 0);
  const b0 = auditN("members_bulk_status");
  r = await bstatus({ memberIds: [s1, s2], status: "disabled" });
  check("ξανά απενεργοποίηση των ίδιων: updated=0 και καμία νέα γραμμή ιστορικού", r.data.updated === 0 && auditN("members_bulk_status") === b0);
  r = await bstatus({ memberIds: [s1, s2, s3], status: "active" });
  check("ενεργοποίηση: επανέρχονται οι 2 (το s3 ήταν ήδη ενεργό)", r.data.updated === 2 && [s1, s2, s3].every((id) => statusOf27(id) === "active"));
  check("ΜΙΑ γραμμή ιστορικού ανά ενέργεια κατάστασης, καμία για ενέργεια χωρίς αλλαγή", auditN("members_bulk_status") === b0 + 1);
  check("bulk-status: id άλλου οργανισμού 404 και τίποτα δεν αλλάζει", (await bstatus({ memberIds: [s1, foreign], status: "disabled" })).status === 404 && statusOf27(s1) === "active");
  check("bulk-status: άκυρη κατάσταση 400", (await bstatus({ memberIds: [s1], status: "deleted" })).data.error === "invalid_status");
  check("bulk-status: άδεια λίστα 400", (await bstatus({ memberIds: [], status: "disabled" })).data.error === "invalid_members");
  check("ο τελευταίος admin δεν απενεργοποιείται ποτέ από εδώ", (await bstatus({ memberIds: [adminId], status: "disabled" })).data.updated === 0 && statusOf27(adminId) === "active");
  check("ο άλλος οργανισμός δεν επηρεάστηκε από καμία ενέργεια", statusOf27(foreign) === "active" && Object.keys(projectsOf(foreign)).length === 0);
}


const allEnabledU = (el) => [...el.querySelectorAll("select, button, input")].every((x) => !x.disabled);
const statusOf27b = (id) => db.prepare("select status from team_members where id = ?").get(id).status;
section("27b. Οθόνη διαχείρισης: λίστα ανθρώπων, μαζικές ενέργειες και σελίδα project");
{
  const typeU = (dom, sel, value) => { const el = $u(dom, sel); el.value = value; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  const pickU = (dom, el, value) => { el.value = value; el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  const checkBox = (dom, el, on) => { el.checked = on; el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  const toastU = (dom) => { const t = $u(dom, ".toast"); return t ? t.textContent : ""; };
  const idle = (dom) => uiWait(() => !$u(dom, ".busy") && $u(dom, ".member-row, .dept-row, .proj-member-row, #project-page"));
  const U = (n) => `bulkui${String(n).padStart(2, "0")}@bulk.gr`;
  const pl = (n, one, many) => n + " " + (n === 1 ? one : many);
  const finName = db.prepare("select name from departments where id = 'fin'").get().name;
  const ccName = db.prepare("select name from departments where id = 'cc'").get().name;

  // 30 νέα άτομα με ένα αίτημα (έτσι θα μπαίνουν σε BPO): όλα μέλη του fin
  const created = await bulk({ emails: Array.from({ length: 30 }, (_, i) => U(i)), createMissing: true, sendInvite: false, changes: [{ projectId: "fin", role: "member" }] });
  check("προετοιμασία: 30 νέα άτομα σε ένα αίτημα", created.status === 200 && created.data.created === 30, created);

  const dom = uiFor("admin@demo.gr")("team-admin.html");
  clickU(dom, await uiWait(() => $u(dom, "#tab-members")));
  await uiWait(() => $$u(dom, ".member-row").length > 0);
  const total = db.prepare("select count(*) c from team_members where workspace_id = 'team-demo'").get().c;
  check("Άνθρωποι: 25 γραμμές ανά σελίδα και ΚΑΝΕΝΑ dropdown ανά project μέσα στη λίστα", $$u(dom, ".member-row").length === 25 && $$u(dom, "#people-list select").length === 0, $$u(dom, ".member-row").length);
  check("σελιδοποίηση: «Δείχνει 1-25 από N»", new RegExp(`Δείχνει 1-25 από ${total} `).test($u(dom, "#people-info").textContent), $u(dom, "#people-info").textContent);
  clickU(dom, $u(dom, "#people-next"));
  check("επόμενη σελίδα: ξεκινά από το 26", /Δείχνει 26-/.test($u(dom, "#people-info").textContent));
  typeU(dom, "#people-q", U(7));
  await uiWait(() => $$u(dom, ".member-row").length === 1);
  check("αναζήτηση: γυρίζει στη σελίδα 1 και δείχνει μόνο το άτομο", $$u(dom, ".member-row").length === 1 && /Δείχνει 1-1 από 1/.test($u(dom, "#people-info").textContent));
  typeU(dom, "#people-q", "");
  await uiWait(() => $$u(dom, ".member-row").length === 25);
  pickU(dom, $u(dom, "#people-project"), "fin");
  const finCount = db.prepare("select count(*) c from member_departments md join team_members m on m.id = md.member_id where md.department_id = 'fin' and m.workspace_id = 'team-demo'").get().c;
  await uiWait(() => $$u(dom, ".member-row").length === Math.min(25, finCount));
  check("φίλτρο project: δείχνει μόνο τα μέλη του fin", $$u(dom, ".member-row").length === Math.min(25, finCount) && new RegExp(`από ${finCount} `).test($u(dom, "#people-info").textContent));
  pickU(dom, $u(dom, "#people-project"), "");
  await uiWait(() => $$u(dom, ".member-row").length === 25);
  checkBox(dom, $u(dom, "#sel-page"), true);
  check("«Επιλογή σελίδας»: επιλέγει ΜΟΝΟ τη σελίδα (25 από το σύνολο)", $u(dom, "#bulk-count").textContent === "25 επιλεγμένοι");
  clickU(dom, $u(dom, "#bulk-clear"));
  check("«Καθαρισμός επιλογής»: καθαρίζει την επιλογή", $$u(dom, ".member-row .sel:checked").length === 0 && /Επίλεξε ανθρώπους/.test($u(dom, "#people-bulk").textContent));

  // ------------------------------------------------------------ μαζική προσθήκη σε project
  typeU(dom, "#people-q", "bulkui1");
  await uiWait(() => $$u(dom, ".member-row").length === 10);
  checkBox(dom, $u(dom, "#sel-page"), true);
  check("επιλογή 10 ατόμων: μετρητής «10 επιλεγμένοι»", $u(dom, "#bulk-count").textContent === "10 επιλεγμένοι");
  clickU(dom, $u(dom, "#bulk-add"));
  check("«Προσθήκη σε project»: ανοίγει πάνελ με project και ρόλο", !!$u(dom, "#bulk-project") && !!$u(dom, "#bulk-role"));
  clickU(dom, $u(dom, "#bulk-apply"));
  check("χωρίς project: μήνυμα λάθους και τίποτα δεν στέλνεται", /Διάλεξε project/.test(toastU(dom)) && projectsOf(memberId(U(10))).cc === undefined);
  pickU(dom, $u(dom, "#bulk-project"), "cc");
  pickU(dom, $u(dom, "#bulk-role"), "editor");
  const bulkAudit0 = auditN("members_bulk_changed");
  clickU(dom, $u(dom, "#bulk-apply"));
  await uiWait(() => projectsOf(memberId(U(19))).cc === "editor");
  await idle(dom);
  check("μαζική προσθήκη ως Editor: και τα 10 άτομα σε ΜΙΑ ενέργεια, με μήνυμα", [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].every((i) => projectsOf(memberId(U(i))).cc === "editor" && storedRoleOf(memberId(U(i))) === "editor") && new RegExp(`10 μέλη: ${ccName} → Editor`).test(toastU(dom)), toastU(dom));
  check("... η επιλογή καθαρίζει και το πάνελ κλείνει", $$u(dom, ".member-row .sel:checked").length === 0 && !$u(dom, "#bulk-panel"));
  check("... ΜΙΑ γραμμή ιστορικού για όλη την ενέργεια", auditN("members_bulk_changed") === bulkAudit0 + 1);

  // ------------------------------------------------------------ μαζική αφαίρεση με επιβεβαίωση
  checkBox(dom, $u(dom, `.member-row .sel[data-id="${memberId(U(10))}"]`), true);
  checkBox(dom, $u(dom, `.member-row .sel[data-id="${memberId(U(11))}"]`), true);
  check("επιλογή με checkbox: «2 επιλεγμένοι»", $u(dom, "#bulk-count").textContent === "2 επιλεγμένοι");
  clickU(dom, $u(dom, "#bulk-remove"));
  pickU(dom, $u(dom, "#bulk-project"), "cc");
  clickU(dom, $u(dom, "#bulk-apply"));
  await uiWait(() => $u(dom, ".confirm"));
  check("αφαίρεση από project ζητά «Σίγουρα;» και ΔΕΝ στέλνεται τίποτα πριν την επιβεβαίωση", new RegExp(`Θα αφαιρεθούν 2 μέλη από το ${ccName}`).test($u(dom, ".confirm").textContent) && projectsOf(memberId(U(10))).cc === "editor");
  clickU(dom, $u(dom, ".confirm-no"));
  check("«Όχι»: τίποτα δεν αλλάζει, η επιλογή μένει και το πάνελ ξεκλειδώνει", projectsOf(memberId(U(10))).cc === "editor" && $$u(dom, ".member-row .sel:checked").length === 2 && !$u(dom, ".confirm") && !!$u(dom, "#bulk-panel") && allEnabledU($u(dom, "#bulk-panel")));
  clickU(dom, $u(dom, "#bulk-apply"));
  await uiWait(() => $u(dom, ".confirm"));
  clickU(dom, $u(dom, ".confirm-yes"));
  await uiWait(() => projectsOf(memberId(U(10))).cc === undefined);
  await idle(dom);
  check("«Ναι»: αφαιρούνται και οι 2, οι υπόλοιποι 8 μένουν editors", projectsOf(memberId(U(10))).cc === undefined && projectsOf(memberId(U(11))).cc === undefined && projectsOf(memberId(U(12))).cc === "editor" && /2 μέλη/.test(toastU(dom)));

  // ------------------------------------------------------------ μαζική απενεργοποίηση με επιβεβαίωση
  typeU(dom, "#people-q", "bulkui2");
  await uiWait(() => $$u(dom, ".member-row").length === 10);
  checkBox(dom, $u(dom, "#sel-page"), true);
  clickU(dom, $u(dom, "#bulk-disable"));
  clickU(dom, $u(dom, "#bulk-apply"));
  await uiWait(() => $u(dom, ".confirm"));
  check("μαζική απενεργοποίηση ζητά «Σίγουρα;» και ενημερώνει ότι οι admins δεν επηρεάζονται", /οι admins δεν επηρεάζονται/.test($u(dom, ".confirm").textContent) && statusOf27b(memberId(U(20))) === "active");
  clickU(dom, $u(dom, ".confirm-yes"));
  await uiWait(() => statusOf27b(memberId(U(29))) === "disabled");
  await idle(dom);
  check("«Ναι»: και τα 10 απενεργοποιούνται, μήνυμα «10 μέλη απενεργοποιήθηκαν»", [20, 21, 22, 23, 24, 25, 26, 27, 28, 29].every((i) => statusOf27b(memberId(U(i))) === "disabled") && /10 μέλη απενεργοποιήθηκαν/.test(toastU(dom)), toastU(dom));

  // ------------------------------------------------------------ επιλογή που διατηρείται ανάμεσα σε αναζητήσεις, και ο admin παραλείπεται
  typeU(dom, "#people-q", "admin@demo");
  await uiWait(() => $$u(dom, ".member-row").length === 1);
  checkBox(dom, $u(dom, ".member-row .sel"), true);
  typeU(dom, "#people-q", U(5));
  await uiWait(() => $$u(dom, ".member-row").length === 1 && $$u(dom, ".member-row")[0].textContent.includes(U(5)));
  checkBox(dom, $u(dom, ".member-row .sel"), true);
  check("η επιλογή διατηρείται ανάμεσα σε διαφορετικές αναζητήσεις («2 επιλεγμένοι»)", $u(dom, "#bulk-count").textContent === "2 επιλεγμένοι");
  clickU(dom, $u(dom, "#bulk-add"));
  pickU(dom, $u(dom, "#bulk-project"), "fin");
  clickU(dom, $u(dom, "#bulk-apply"));
  await uiWait(() => /admin παραλείφθηκε/.test(toastU(dom)));
  await idle(dom);
  check("ο admin στην επιλογή παραλείπεται και το μήνυμα το λέει", /1 admin παραλείφθηκε/.test(toastU(dom)) && storedRoleOf(memberId("admin@demo.gr")) === "admin", toastU(dom));

  // ------------------------------------------------------------ καρτέλα ατόμου μέσα από τη λίστα
  typeU(dom, "#people-q", U(5));
  const row5 = await uiWait(() => { const rs = $$u(dom, ".member-row"); return rs.length === 1 && rs[0]; });
  clickU(dom, row5.querySelector(".open-member"));
  await uiWait(() => $u(dom, "#member-detail"));
  clickU(dom, $u(dom, "#member-detail .prow[data-project=fin] .seg-editor"));
  await uiWait(() => projectsOf(memberId(U(5))).fin === "editor");
  await idle(dom);
  check("καρτέλα ατόμου: αλλαγή σε Editor, και η καρτέλα με την αναζήτηση ΜΕΝΟΥΝ ανοιχτές μετά την ανανέωση", !!$u(dom, "#member-detail") && $u(dom, "#people-q").value === U(5) && !!$u(dom, "#member-detail .prow[data-project=fin] .seg-editor.on"));

  // ------------------------------------------------------------ σελίδα project
  clickU(dom, $u(dom, "#tab-departments"));
  const finRow = await uiWait(() => $$u(dom, ".dept-row").find((r) => r.querySelector("input[type=text]").value === finName));
  clickU(dom, finRow.querySelector(".open-project"));
  await uiWait(() => $u(dom, "#project-page"));
  const finMembers = db.prepare("select count(*) c from member_departments md join team_members m on m.id = md.member_id where md.department_id = 'fin' and m.workspace_id = 'team-demo' and m.status = 'active'").get().c;
  const finEditors = db.prepare("select count(*) c from team_project_editors e join team_members m on m.id = e.member_id where e.project_id = 'fin' and m.workspace_id = 'team-demo' and m.status = 'active'").get().c;
  const finDocs = db.prepare("select count(*) c from team_documents where workspace_id = 'team-demo' and department_id = 'fin'").get().c;
  check("σελίδα project: τίτλος και μετρητές μελών, editors και εγγράφων", new RegExp(finName).test($u(dom, "#project-page h2").textContent) && $u(dom, "#project-meta").textContent === `${pl(finMembers, "μέλος", "μέλη")} · ${pl(finEditors, "editor", "editors")} · ${pl(finDocs, "έγγραφο", "έγγραφα")}`, $u(dom, "#project-meta").textContent);
  check("σελίδα project: το πολύ 25 μέλη ανά σελίδα, με σελιδοποίηση", $$u(dom, ".proj-member-row").length === Math.min(25, finMembers) && new RegExp(`από ${finMembers} `).test($u(dom, "#proj-info").textContent));
  typeU(dom, "#proj-q", U(8));
  await uiWait(() => $$u(dom, ".proj-member-row").length === 1);
  clickU(dom, $u(dom, ".proj-member-row .seg-editor"));
  await uiWait(() => projectsOf(memberId(U(8))).fin === "editor");
  await idle(dom);
  check("σελίδα project: ρόλος Editor με ένα κλικ, και η αναζήτηση ΜΕΝΕΙ μετά την ανανέωση", $u(dom, "#proj-q").value === U(8) && !!$u(dom, "#project-page") && $$u(dom, ".proj-member-row").length === 1);
  clickU(dom, $u(dom, ".proj-member-row .remove-project"));
  await uiWait(() => projectsOf(memberId(U(8))).fin === undefined);
  await idle(dom);
  check("σελίδα project: αφαίρεση μέλους", projectsOf(memberId(U(8))).fin === undefined);
  typeU(dom, "#proj-q", "");

  // επικόλληση emails: χωρίς «Δημιουργία νέων μελών» οι άγνωστοι ΔΕΝ δημιουργούνται
  $u(dom, "#paste-emails").value = `${U(9)}, pastea@bulk.gr\npasteb@bulk.gr`;
  pickU(dom, $u(dom, "#paste-role"), "editor");
  clickU(dom, $u(dom, "#paste-add"));
  await uiWait(() => projectsOf(memberId(U(9))).fin === "editor");
  await idle(dom);
  check("επικόλληση χωρίς δημιουργία: ο υπάρχων μπαίνει ως Editor, οι άγνωστοι ΔΕΝ δημιουργούνται", projectsOf(memberId(U(9))).fin === "editor" && !db.prepare("select 1 from team_members where email = 'pastea@bulk.gr'").get());
  check("... η λίστα «δεν προστέθηκαν» μένει ορατή και λέει τι να κάνεις", /Δεν προστέθηκαν: pastea@bulk\.gr, pasteb@bulk\.gr/.test($u(dom, "#paste-result").textContent) && /Δημιουργία νέων μελών/.test($u(dom, "#paste-result").textContent), $u(dom, "#paste-result").textContent);
  // με «Δημιουργία νέων μελών» και πρόσκληση
  $u(dom, "#paste-emails").value = "pastea@bulk.gr\npasteb@bulk.gr";
  checkBox(dom, $u(dom, "#paste-create"), true);
  pickU(dom, $u(dom, "#paste-role"), "member");
  const mailsBefore = state.emails.length;
  clickU(dom, $u(dom, "#paste-add"));
  await uiWait(() => db.prepare("select 1 from team_members where email = 'pasteb@bulk.gr'").get());
  await idle(dom);
  const invitesSent = state.emails.slice(mailsBefore).map((m) => m.to).sort();
  check("με «Δημιουργία νέων μελών»: δημιουργούνται 2 νέα άτομα, ενεργά, μέλη του project", ["pastea", "pasteb"].every((n) => { const m = db.prepare("select id, status from team_members where email = ?").get(n + "@bulk.gr"); return m && m.status === "active" && projectsOf(m.id).fin === "member"; }) && /2 νέα μέλη δημιουργήθηκαν/.test(toastU(dom)), toastU(dom));
  check("... στάλθηκαν προσκλήσεις ΜΟΝΟ στους 2 νέους, και το πεδίο καθαρίζει", JSON.stringify(invitesSent) === JSON.stringify(["pastea@bulk.gr", "pasteb@bulk.gr"]) && $u(dom, "#paste-emails").value === "" && $u(dom, "#paste-result").textContent === "", invitesSent);
  $u(dom, "#paste-emails").value = "όχι email";
  clickU(dom, $u(dom, "#paste-add"));
  check("άκυρο email: μήνυμα λάθους και τίποτα δεν δημιουργείται", /Δεν είναι σωστά emails/.test(toastU(dom)));
  clickU(dom, $u(dom, "#project-back"));
  check("«← Όλα τα projects»: επιστροφή στη λίστα projects", $$u(dom, ".dept-row").length >= 3 && !$u(dom, "#project-page"));

  // ------------------------------------------------------------ ιστορικό
  clickU(dom, $u(dom, "#tab-audit"));
  const auditTxt = await uiWait(() => { const x = $u(dom, "#app").textContent; return /Ιστορικό ενεργειών/.test(x) && x; });
  check("ιστορικό: ελληνικές ετικέτες για τις μαζικές ενέργειες, όχι τεχνικά ονόματα", /μαζική αλλαγή projects/.test(auditTxt) && /μαζική αλλαγή κατάστασης/.test(auditTxt) && !/members_bulk_/.test(auditTxt));
}

// ============================================================================ 28. Ακροατήριο εγγράφου: ένα έγγραφο, πολλά projects (API)
section("28. Ακροατήριο εγγράφου: ιδιοκτήτης και λίστα projects που το διαβάζουν (κανόνας Β: όλοι εκτός από τον admin)");
{ // ένα μπλοκ: οι βοηθοί αυτής της ενότητας δεν συγκρούονται με τα top-level ονόματα της ενότητας 27
// Το ψεύτικο D1 δεν είχε batch στις παλιότερες ενότητες. Εδώ υπάρχει (όπως στο πραγματικό D1: όλα ή τίποτα).
if (!env.DB.batch) {
  env.DB.batch = async (statements) => {
    db.exec("BEGIN");
    try { for (const s of statements) await s.run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
}
const nowIso = () => new Date().toISOString();
const J = async (pending) => { const res = await pending; return { status: res.status, data: await readJson(res) }; };
const mkProject = (id, name, hidden = 0) => db.prepare("insert into departments(id,workspace_id,name,hidden,created_at) values (?,?,?,?,?)").run(id, "team-demo", name, hidden, nowIso());
const mkMember = async (email, projects, editorOf = []) => {
  const ins = db.prepare("insert into team_members(workspace_id,email,role,status,created_at) values (?,?,?,?,?)").run("team-demo", email, editorOf.length ? "editor" : "employee", "active", nowIso());
  const id = Number(ins.lastInsertRowid);
  for (const p of projects) db.prepare("insert into member_departments(member_id,department_id) values (?,?)").run(id, p);
  for (const p of editorOf) db.prepare("insert into team_project_editors(member_id,project_id,created_at) values (?,?,?)").run(id, p, nowIso());
  S[email] = (await login(email)).cookie;
  return id;
};
const askQ = async (email, q) => {
  state.prompts.length = 0;
  const before = env.VECTORIZE.calls.length;
  const events = await readSse(await call(email, "POST", "/team/query/stream", { question: q }));
  return { events, prompt: state.prompts.join("\n"), queries: env.VECTORIZE.calls.slice(before), done: events.find((e) => e.type === "done") };
};
const vecGroups = (docId) => [...new Set([...env.VECTORIZE.vectors.values()].filter((v) => v.metadata.documentId === docId && v.metadata.kind !== "update").map((v) => v.metadata.department_id))];
const audRows = (docId) => db.prepare("select group_id from team_document_audience where document_id = ?").all(docId);
const groupProjects = (g) => db.prepare("select project_id from team_audience_group_projects where group_id = ? order by project_id").all(g).map((r) => r.project_id);
const putDoc = (who, id, body) => J(call(who, "PUT", `/team/documents/${id}`, body));
const A = "admin@demo.gr";
const QA = "Η διαδικασία ακύρωσης συμβολαίου απαιτεί ειδοποίηση τριάντα ημέρες."; // σχεδόν αντίγραφο του εγγράφου, ΧΩΡΙΣ το σήμα του (το LLM βλέπει και την ερώτηση): σταθερή κατάταξη ακόμα και με πολλά άλλα έγγραφα

// ---------------------------------------------------------------- 28.1 καθαροί κανόνες
{
  const depts = [{ id: "ta", name: "Telecom A", hidden: 0 }, { id: "tb", name: "Telecom B", hidden: 0 }, { id: "tx", name: "Secret", hidden: 1 }];
  const mem = (ids, role = "employee") => ({ role, departmentIds: ids, editorProjectIds: role === "editor" ? ids : [] });
  const adm = { role: "admin", departmentIds: [] };
  check("κανόνας: ο editor του tb ΔΕΝ διαβάζει έγγραφο του ta χωρίς ακροατήριο (Β)", !access.canReadDocument(mem(["tb"], "editor"), depts, "ta", false, []));
  check("κανόνας: ο editor του tb διαβάζει έγγραφο του ta όταν το tb είναι στο ακροατήριο", access.canReadDocument(mem(["tb"], "editor"), depts, "ta", false, ["tb"]));
  check("κανόνας: μέλος του ιδιοκτήτη διαβάζει πάντα (και το εμπιστευτικό)", access.canReadDocument(mem(["ta"]), depts, "ta", true, []));
  check("κανόνας: το εμπιστευτικό δεν διαβάζεται από ακροατήριο", !access.canReadDocument(mem(["tb"]), depts, "ta", true, ["tb"]));
  check("κανόνας: ιδιοκτήτης κρυφό project: το ακροατήριο αγνοείται", !access.canReadDocument(mem(["tb"]), depts, "tx", false, ["tb"]));
  check("κανόνας: το εταιρικό το διαβάζουν όλοι", access.canReadDocument(mem([]), depts, "_all", false, []) && !access.canReadDocument(mem([]), depts, "_all", true, []));
  check("κανόνας: ο admin διαβάζει τα πάντα", access.canReadDocument(adm, depts, "tx", true, []));
  check("κανόνας: άγνωστος ιδιοκτήτης = απόρριψη (deny by default)", !access.canReadDocument(mem(["tb"]), depts, "zz", false, ["tb"]));
  check("κανόνας: ο παράγωγος ρόλος editor δεν διαβάζει πια άλλα projects", JSON.stringify([...access.readableDepartmentIds(mem(["ta"], "editor"), depts)].sort()) === '["_all","ta"]');

  const fmt = (n) => Array.from({ length: n }, (_, i) => `d-${(i * 2654435761 % 4294967296).toString(16).padStart(8, "0")}`);
  const bytes = (f) => Buffer.byteLength(JSON.stringify(f));
  const small = access.buildVectorFilters(mem(["ta", "tb"]), ["ag-0123456789abcdef"]);
  check("φίλτρο: μικρός χρήστης = ένα φίλτρο με όλα τα ids", small.filters.length === 1 && !small.tooMany && JSON.stringify(small.filters[0].department_id.$in) === JSON.stringify(["_all", "ag-0123456789abcdef", "ta", "tb"]));
  const mid = access.buildVectorFilters(mem(fmt(250)), []);
  const midIds = mid.filters.flatMap((f) => f.department_id.$in);
  check("φίλτρο: 250 projects σπάνε σε παρτίδες, καθεμία ≤ 1800 bytes (όριο Vectorize 2048)", mid.filters.length >= 2 && !mid.tooMany && mid.filters.every((f) => bytes(f) <= 1800));
  check("φίλτρο: η ένωση των παρτίδων = ακριβώς τα ids του μέλους (κανένα δεν χάνεται, κανένα δεν διπλασιάζεται)", midIds.length === 251 && new Set(midIds).size === 251 && midIds.includes("_all") && fmt(250).every((id) => midIds.includes(id)));
  const huge = access.buildVectorFilters(mem(fmt(480)), []);
  check("φίλτρο: πάνω από 3 παρτίδες = αποτυχία κλειστά (tooMany, κανένα φίλτρο)", huge.tooMany === true && huge.filters.length === 0);
  check("φίλτρο: ο admin = ένα ερώτημα χωρίς φίλτρο", access.buildVectorFilters(adm, []).filters.length === 1 && access.buildVectorFilters(adm, []).filters[0] === undefined);
  check("φίλτρο: το όριο παρτίδας είναι ρυθμιζόμενο και τηρείται και σε μικρό όριο", access.buildVectorFilters(mem(fmt(30)), [], { maxBytes: 200, maxBatches: 99 }).filters.every((f) => bytes(f) <= 200));
}

// ---------------------------------------------------------------- 28.2 σενάριο: Telecom A και B (BPO με δύο πελάτες)
mkProject("ta", "Telecom A"); mkProject("tb", "Telecom B"); mkProject("tc", "Telecom C"); mkProject("tx", "Secret X", 1);
const idEdA = await mkMember("au_ed_a@demo.gr", ["ta"], ["ta"]);
await mkMember("au_ed_b@demo.gr", ["tb"], ["tb"]);
await mkMember("au_a@demo.gr", ["ta"]);
await mkMember("au_b@demo.gr", ["tb"]);
await mkMember("au_c@demo.gr", ["tc"]);
await mkMember("au_mixed@demo.gr", ["ta", "tc"], ["tc"]); // editor στο tc, απλός πράκτορας στο ta
await mkMember("au_mx@demo.gr", ["tx"]);
const D = {};
{
  const r = await J(call("au_ed_a@demo.gr", "POST", "/team/documents", { title: "Ακύρωση συμβολαίου Α", departmentId: "ta", text: "Η διαδικασία ακύρωσης συμβολαίου απαιτεί ειδοποίηση τριάντα ημέρες. AUDA-MARK" }));
  D.a = r.data.id;
  check("έγγραφο μόνο του ιδιοκτήτη: 201", r.status === 201 && !!D.a);
  check("... τα vectors του κρατούν το id του project (όπως πάντα, χωρίς αλλαγή)", JSON.stringify(vecGroups(D.a)) === '["ta"]' && audRows(D.a).length === 0);
  check("... ο editor του tb ΔΕΝ το βλέπει: 404, ούτε στη λίστα", (await J(call("au_ed_b@demo.gr", "GET", `/team/documents/${D.a}`))).status === 404 && !(await J(call("au_ed_b@demo.gr", "GET", "/team/documents"))).data.documents.some((d) => d.id === D.a));
  check("... το μέλος του tb: 404", (await J(call("au_b@demo.gr", "GET", `/team/documents/${D.a}`))).status === 404);
  check("... το μέλος του ta το διαβάζει", (await J(call("au_a@demo.gr", "GET", `/team/documents/${D.a}`))).status === 200);

  let x = await J(call("au_ed_a@demo.gr", "PUT", `/team/documents/${D.a}`, { title: "Ακύρωση συμβολαίου Α", departmentId: "ta", text: "Η διαδικασία ακύρωσης συμβολαίου απαιτεί ειδοποίηση τριάντα ημέρες. AUDA-MARK", audienceProjectIds: ["tb"] }));
  check("ο editor του ta ΔΕΝ βάζει στο ακροατήριο project όπου δεν είναι μέλος: 403 audience_forbidden", x.status === 403 && x.data.error === "audience_forbidden" && audRows(D.a).length === 0);
}

// ---- ο admin ορίζει ακροατήριο [tb]
{
  const body = { title: "Ακύρωση συμβολαίου Α", departmentId: "ta", text: "Η διαδικασία ακύρωσης συμβολαίου απαιτεί ειδοποίηση τριάντα ημέρες. AUDA-MARK" };
  const x = await putDoc(A, D.a, { ...body, audienceProjectIds: ["tb"] });
  const rows = audRows(D.a);
  check("admin: ακροατήριο [tb]: 200 και μία γραμμή ακροατηρίου", x.status === 200 && rows.length === 1);
  const g = rows[0] && rows[0].group_id;
  check("... η ομάδα έχει μορφή ag-<16 hex> και περιέχει ιδιοκτήτη και tb", /^ag-[0-9a-f]{16}$/.test(g || "") && JSON.stringify(groupProjects(g)) === '["ta","tb"]');
  check("... ΟΛΑ τα vectors του εγγράφου γράφτηκαν με το id της ομάδας", JSON.stringify(vecGroups(D.a)) === JSON.stringify([g]));
  D.g = g;
  const groupsBefore = db.prepare("select count(*) c from team_audience_groups").get().c;
  const sameAgain = await putDoc(A, D.a, { ...body, audienceProjectIds: ["tb", "ta", "tb"] });
  check("το ίδιο σύνολο (άλλη σειρά, διπλότυπα, με τον ιδιοκτήτη μέσα) δίνει ΤΗΝ ΙΔΙΑ ομάδα, καμία δεύτερη", sameAgain.status === 200 && audRows(D.a)[0].group_id === g && db.prepare("select count(*) c from team_audience_groups").get().c === groupsBefore);

  const gb = await J(call("au_b@demo.gr", "GET", `/team/documents/${D.a}`));
  check("το μέλος του tb διαβάζει το έγγραφο, ΜΟΝΟ για ανάγνωση", gb.status === 200 && gb.data.editable === false && gb.data.departmentId === "ta" && gb.data.departmentName === "Telecom A");
  const eb = await J(call("au_ed_b@demo.gr", "GET", `/team/documents/${D.a}`));
  check("ο editor του tb διαβάζει το έγγραφο μέσω ακροατηρίου, ΜΟΝΟ για ανάγνωση (δεν είναι δικό του)", eb.status === 200 && eb.data.editable === false);
  check("... και δεν μπορεί να το αλλάξει: PUT 403", (await call("au_ed_b@demo.gr", "PUT", `/team/documents/${D.a}`, { ...body, departmentId: "tb" })).status === 403 && (await call("au_ed_b@demo.gr", "PUT", `/team/documents/${D.a}`, { ...body, departmentId: "ta" })).status === 403);
  const lb = (await J(call("au_b@demo.gr", "GET", "/team/documents"))).data.documents.find((d) => d.id === D.a);
  check("λίστα του tb: το έγγραφο εμφανίζεται (editable:false, audienceCount:1)", !!lb && lb.editable === false && lb.audienceCount === 1);
  check("το μέλος του tc ΔΕΝ το βλέπει (404)", (await J(call("au_c@demo.gr", "GET", `/team/documents/${D.a}`))).status === 404);
  const mine = await J(call("au_ed_a@demo.gr", "GET", `/team/documents/${D.a}`));
  check("ο ιδιοκτήτης βλέπει στο ακροατήριο μόνο το πλήθος για projects που δεν γνωρίζει (hiddenCount=1, χωρίς όνομα)", mine.data.audience.hiddenCount === 1 && mine.data.audience.projects.length === 0 && !JSON.stringify(mine.data).includes("Telecom B"));
  check("ο admin βλέπει ονόματα", JSON.stringify((await J(call(A, "GET", `/team/documents/${D.a}`))).data.audience.projects) === JSON.stringify([{ id: "tb", name: "Telecom B" }]));
  check("ο editor του tb βλέπει το δικό του project στο ακροατήριο", JSON.stringify(eb.data.audience.projects) === JSON.stringify([{ id: "tb", name: "Telecom B" }]) && eb.data.audience.hiddenCount === 0);
  check("το GET του admin για όλα τα έγγραφα δίνει τη λίστα ακροατηρίου", (await J(call(A, "GET", "/team/admin/documents"))).data.documents.find((d) => d.id === D.a).audienceProjectIds.join() === "tb");

  // ---- ο βοηθός
  let q = await askQ("au_b@demo.gr", QA);
  const f0 = q.queries[0] && q.queries[0].filter && q.queries[0].filter.department_id.$in;
  check("βοηθός tb: το φίλτρο περιέχει την ομάδα ακροατηρίου", Array.isArray(f0) && f0.includes(g) && f0.includes("tb") && f0.includes("_all"));
  check("βοηθός tb: το LLM είδε το έγγραφο του ακροατηρίου", q.prompt.includes("AUDA-MARK") && q.done && q.done.primarySource && q.done.primarySource.departmentName === "Telecom A");
  q = await askQ("au_ed_b@demo.gr", QA);
  check("βοηθός editor tb: το βλέπει (το ακροατήριο ισχύει και για editors)", q.prompt.includes("AUDA-MARK"));
  q = await askQ("au_c@demo.gr", QA);
  check("βοηθός tc: ΔΕΝ είδε το έγγραφο, το φίλτρο δεν έχει την ομάδα", !q.prompt.includes("AUDA-MARK") && !q.queries[0].filter.department_id.$in.includes(g));
  q = await askQ("au_a@demo.gr", QA);
  check("βοηθός ta (ιδιοκτήτης): το βρίσκει και με το ακροατήριο", q.prompt.includes("AUDA-MARK"));

  // ---- δεύτερος έλεγχος στη βάση, όταν το Vectorize ΔΕΝ φιλτράρει (ή έχει παλιά δεδομένα)
  env.VECTORIZE.ignoreFilter = true;
  q = await askQ("au_c@demo.gr", QA);
  check("χωρίς φίλτρο Vectorize: ο έλεγχος στη βάση κόβει το έγγραφο του ακροατηρίου για το tc", !q.prompt.includes("AUDA-MARK"));
  q = await askQ("au_b@demo.gr", QA);
  check("χωρίς φίλτρο Vectorize: το tb (στο ακροατήριο) το βλέπει κανονικά", q.prompt.includes("AUDA-MARK"));
  env.VECTORIZE.ignoreFilter = false;
  const sameValues = env.VECTORIZE.vectors.get(`${D.a}-chunk-0`).values; // ίδιο διάνυσμα με το πραγματικό έγγραφο: ανακτώνται σίγουρα
  env.VECTORIZE.vectors.set("ghost-chunk-0", { id: "ghost-chunk-0", values: sameValues, namespace: "team-demo", metadata: { documentId: "doc-ffffffffffffffff", chunkIndex: 0, text: "GHOST-MARK " + QA, department_id: "tb" } });
  env.VECTORIZE.vectors.set("nodept-chunk-0", { id: "nodept-chunk-0", values: sameValues, namespace: "team-demo", metadata: { documentId: D.a, chunkIndex: 0, text: "NODEPT-MARK " + QA } });
  const qAdmin = await askQ(A, QA);
  check("(έλεγχος του ελέγχου) ο admin, που δεν περνά από τον δεύτερο έλεγχο, ανακτά τα ψεύτικα vectors: άρα οι επόμενοι έλεγχοι είναι ουσιαστικοί", qAdmin.prompt.includes("GHOST-MARK") && qAdmin.prompt.includes("NODEPT-MARK"));
  q = await askQ("au_b@demo.gr", QA);
  check("vector για έγγραφο που ΔΕΝ υπάρχει στη βάση: απορρίπτεται (deny by default)", !q.prompt.includes("GHOST-MARK"));
  check("vector χωρίς department_id: απορρίπτεται (fail closed)", !q.prompt.includes("NODEPT-MARK"));
  env.VECTORIZE.ignoreFilter = true;
  q = await askQ("au_b@demo.gr", QA);
  check("vector χωρίς department_id: απορρίπτεται ΚΑΙ όταν το Vectorize δεν φιλτράρει (fail closed στον κώδικα)", !q.prompt.includes("NODEPT-MARK") && !q.prompt.includes("GHOST-MARK"));
  env.VECTORIZE.ignoreFilter = false;
  env.VECTORIZE.vectors.delete("ghost-chunk-0"); env.VECTORIZE.vectors.delete("nodept-chunk-0");
}

// ---- επεξεργασία από τον ιδιοκτήτη: το ακροατήριο μένει
{
  const body = { title: "Ακύρωση συμβολαίου Α", departmentId: "ta", text: "Η διαδικασία ακύρωσης συμβολαίου απαιτεί ειδοποίηση σαράντα ημέρες. AUDA-MARK" };
  let x = await putDoc("au_ed_a@demo.gr", D.a, body);
  check("επεξεργασία κειμένου χωρίς πεδίο ακροατηρίου: το ακροατήριο μένει όπως ήταν", x.status === 200 && audRows(D.a).length === 1 && audRows(D.a)[0].group_id === D.g && JSON.stringify(vecGroups(D.a)) === JSON.stringify([D.g]));
  x = await putDoc("au_ed_a@demo.gr", D.a, { ...body, audienceProjectIds: [] });
  check("ο editor που ΔΕΝ βλέπει το tb δεν μπορεί να το αφαιρέσει (audienceProjectIds: [] το διατηρεί)", x.status === 200 && audRows(D.a).length === 1 && groupProjects(audRows(D.a)[0].group_id).join() === "ta,tb");
  x = await putDoc(A, D.a, { ...body, audienceProjectIds: [] });
  check("ο admin αφαιρεί το ακροατήριο: σβήνει η γραμμή, τα vectors γυρίζουν στο id του project", x.status === 200 && audRows(D.a).length === 0 && JSON.stringify(vecGroups(D.a)) === '["ta"]');
  check("... το tb χάνει αμέσως την πρόσβαση (404)", (await J(call("au_b@demo.gr", "GET", `/team/documents/${D.a}`))).status === 404);
  const q = await askQ("au_b@demo.gr", QA);
  check("... και ο βοηθός του tb δεν το βρίσκει πια", !q.prompt.includes("AUDA-MARK"));
  // παλιά vectors με την παλιά ομάδα (π.χ. αποτυχημένη ενημέρωση): το Vectorize τα επιστρέφει, ο έλεγχος στη βάση τα κόβει
  for (const v of env.VECTORIZE.vectors.values()) if (v.metadata.documentId === D.a) v.metadata.department_id = D.g;
  const q2 = await askQ("au_b@demo.gr", QA);
  check("ξεπερασμένο vector με παλιά ομάδα: δεν διαρρέει (ο έλεγχος στη βάση αποφασίζει)", !q2.prompt.includes("AUDA-MARK"));
  for (const v of env.VECTORIZE.vectors.values()) if (v.metadata.documentId === D.a) v.metadata.department_id = "ta";
  // ο editor βάζει ακροατήριο σε project όπου ΕΙΝΑΙ μέλος
  const x2 = await putDoc("au_mixed@demo.gr", D.a, body); // μέλος του ta αλλά μόνο μέλος (όχι editor): δεν γράφει
  check("απλό μέλος (όχι editor του ta): 403 στο PUT", x2.status === 403);
}

// ---- επικύρωση ακροατηρίου
{
  for (let i = 1; i <= 10; i++) mkProject(`px${i}`, `Project X${i}`);
  const body = { title: "Ακύρωση συμβολαίου Α", departmentId: "ta", text: "Η διαδικασία ακύρωσης συμβολαίου απαιτεί ειδοποίηση σαράντα ημέρες. AUDA-MARK" };
  const ids = (n) => Array.from({ length: n }, (_, i) => `px${i + 1}`);
  let x = await putDoc(A, D.a, { ...body, audienceProjectIds: ids(10) });
  check("ακροατήριο 10 άλλα projects (11 με τον ιδιοκτήτη): 400 audience_too_large", x.status === 400 && x.data.error === "audience_too_large" && audRows(D.a).length === 0);
  x = await putDoc(A, D.a, { ...body, audienceProjectIds: ids(9) });
  check("ακροατήριο 9 άλλα projects (10 με τον ιδιοκτήτη): επιτρέπεται", x.status === 200 && audRows(D.a).length === 1);
  x = await putDoc(A, D.a, { ...body, audienceProjectIds: [] });
  check("επιστροφή σε μόνο ιδιοκτήτη", x.status === 200 && audRows(D.a).length === 0);
  check("άγνωστο project στο ακροατήριο: 400 invalid_audience", (await putDoc(A, D.a, { ...body, audienceProjectIds: ["nope"] })).data.error === "invalid_audience");
  check("project άλλου οργανισμού στο ακροατήριο: 400 invalid_audience", (await putDoc(A, D.a, { ...body, audienceProjectIds: ["cc2"] })).data.error === "invalid_audience");
  check("το «_all» δεν είναι έγκυρο μέλος ακροατηρίου: 400", (await putDoc(A, D.a, { ...body, audienceProjectIds: ["_all"] })).data.error === "invalid_audience");
  check("ακροατήριο που δεν είναι πίνακας: 400", (await putDoc(A, D.a, { ...body, audienceProjectIds: "tb" })).data.error === "invalid_audience" && (await putDoc(A, D.a, { ...body, audienceProjectIds: [1] })).data.error === "invalid_audience");
  const rAll = await J(call(A, "POST", "/team/documents", { title: "Εταιρικό με ακροατήριο", departmentId: "_all", text: "κείμενο εταιρικού", audienceProjectIds: ["tb"] }));
  check("εταιρικό έγγραφο με ακροατήριο: 400 audience_not_allowed", rAll.status === 400 && rAll.data.error === "audience_not_allowed");
  const rNew = await J(call(A, "POST", "/team/documents", { title: "Νέο με ακροατήριο", departmentId: "tb", text: "Διαδικασία επιστροφής εξοπλισμού τηλεπικοινωνιών. AUDN-MARK", audienceProjectIds: ["ta", "tc"] }));
  D.n = rNew.data.id;
  check("νέο έγγραφο με ακροατήριο από την αρχή (admin): 201, ομάδα {ta,tb,tc}", rNew.status === 201 && groupProjects(audRows(D.n)[0].group_id).join() === "ta,tb,tc" && vecGroups(D.n).join() === audRows(D.n)[0].group_id);
  check("ο ιδιοκτήτης του tb και το tc το διαβάζουν, το tx όχι", (await J(call("au_c@demo.gr", "GET", `/team/documents/${D.n}`))).status === 200 && (await J(call("au_mx@demo.gr", "GET", `/team/documents/${D.n}`))).status === 404);
  // ένας editor βάζει ακροατήριο σε project όπου είναι μέλος: ο au_mixed είναι editor στο tc και μέλος στο ta
  const rMix = await J(call("au_mixed@demo.gr", "POST", "/team/documents", { title: "Από τον mixed", departmentId: "tc", text: "Κείμενο ελέγχου προσβασιμότητας. AUDM-MARK", audienceProjectIds: ["ta"] }));
  check("editor με ακροατήριο σε project όπου ΕΙΝΑΙ μέλος: 201", rMix.status === 201 && groupProjects(audRows(rMix.data.id)[0].group_id).join() === "ta,tc");
  const rMix2 = await J(call("au_mixed@demo.gr", "POST", "/team/documents", { title: "Από τον mixed 2", departmentId: "tc", text: "Κείμενο ελέγχου. AUDM2-MARK", audienceProjectIds: ["tb"] }));
  check("... σε project όπου ΔΕΝ είναι μέλος: 403 audience_forbidden και το έγγραφο ΔΕΝ δημιουργείται", rMix2.status === 403 && db.prepare("select count(*) c from team_documents where title = 'Από τον mixed 2'").get().c === 0);
  D.m = rMix.data.id;
}

// ---- εμπιστευτικό έγγραφο και κρυφό project
{
  const body = { title: "Νέο με ακροατήριο", departmentId: "tb", text: "Διαδικασία επιστροφής εξοπλισμού τηλεπικοινωνιών. AUDN-MARK" };
  let x = await J(call(A, "PATCH", `/team/admin/documents/${D.n}`, { hidden: true }));
  check("σήμανση εμπιστευτικού: 200, η γραμμή ακροατηρίου σβήνει αμέσως", x.status === 200 && audRows(D.n).length === 0);
  check("... τα vectors γυρίζουν στο id του ιδιοκτήτη (ξαναγράφονται από τη βάση χωρίς νέα embeddings)", JSON.stringify(vecGroups(D.n)) === '["tb"]');
  check("... το tc χάνει την πρόσβαση, ο ιδιοκτήτης (tb) τη διατηρεί", (await J(call("au_c@demo.gr", "GET", `/team/documents/${D.n}`))).status === 404 && (await J(call("au_b@demo.gr", "GET", `/team/documents/${D.n}`))).status === 200);
  check("... στο ιστορικό σημειώνεται η επαναφορά ακροατηρίου", JSON.stringify(db.prepare("select detail from team_audit_log where action = 'document_hidden' and target = ? order by id desc").get(D.n)).includes("audienceReset"));
  x = await putDoc(A, D.n, { ...body, audienceProjectIds: ["ta"] });
  check("ακροατήριο σε εμπιστευτικό έγγραφο: 409 hidden_cannot_have_audience", x.status === 409 && x.data.error === "hidden_cannot_have_audience" && audRows(D.n).length === 0);
  await J(call(A, "PATCH", `/team/admin/documents/${D.n}`, { hidden: false }));
  x = await putDoc(A, D.n, { ...body, audienceProjectIds: ["ta"] });
  check("μετά το «δεν είναι εμπιστευτικό» το ακροατήριο ξαναδίνεται", x.status === 200 && audRows(D.n).length === 1);

  // κρυφό project
  const rx = await J(call(A, "POST", "/team/documents", { title: "Κρυφό έγγραφο", departmentId: "tx", text: "Μυστική διαδικασία. AUDX-MARK", audienceProjectIds: ["tb"] }));
  check("έγγραφο κρυφού project με ακροατήριο: 409 hidden_cannot_have_audience", rx.status === 409 && rx.data.error === "hidden_cannot_have_audience");
  // το project tb γίνεται κρυφό ενώ το έγγραφό του έχει ακροατήριο
  const grp = audRows(D.n)[0].group_id;
  check("πριν: το ta διαβάζει το έγγραφο του tb μέσω ακροατηρίου", (await J(call("au_a@demo.gr", "GET", `/team/documents/${D.n}`))).status === 200 && vecGroups(D.n).join() === grp);
  await J(call(A, "PATCH", "/team/admin/departments/tb", { hidden: true }));
  check("το project tb γίνεται κρυφό: το ακροατήριο των εγγράφων του σβήνει, τα vectors γυρίζουν στο tb", audRows(D.n).length === 0 && JSON.stringify(vecGroups(D.n)) === '["tb"]');
  check("... το ta χάνει την πρόσβαση, τα μέλη του tb τη διατηρούν", (await J(call("au_a@demo.gr", "GET", `/team/documents/${D.n}`))).status === 404 && (await J(call("au_b@demo.gr", "GET", `/team/documents/${D.n}`))).status === 200);
  check("... το ιστορικό του project αναφέρει πόσα μοιρασμένα έγγραφα επανήλθαν", JSON.stringify(db.prepare("select detail from team_audit_log where action = 'department_hidden' and target = 'tb'").get()).includes("sharedReset"));
  await J(call(A, "PATCH", "/team/admin/departments/tb", { hidden: false }));
}

// ---- εκκρεμή updates, vectors των updates, διαγραφή
{
  const body = { title: "Ακύρωση συμβολαίου Α", departmentId: "ta", text: "Η διαδικασία ακύρωσης συμβολαίου απαιτεί ειδοποίηση σαράντα ημέρες. AUDA-MARK" };
  let x = await putDoc(A, D.a, { ...body, audienceProjectIds: ["tb"] });
  D.g = audRows(D.a)[0].group_id;
  const u = await J(call("au_ed_a@demo.gr", "POST", "/team/updates", { documentId: D.a, text: "Νέα προθεσμία ειδοποίησης είκοσι ημέρες. AUDU-MARK" }));
  const uv = [...env.VECTORIZE.vectors.values()].filter((v) => v.metadata.kind === "update" && v.metadata.updateId === u.data.id);
  check("update σε έγγραφο με ακροατήριο: τα vectors του κρατούν την ΙΔΙΑ ομάδα με το έγγραφο", u.status === 201 && uv.length > 0 && uv.every((v) => v.metadata.department_id === D.g));
  const q = await askQ("au_b@demo.gr", "Νέα προθεσμία ειδοποίησης είκοσι ημέρες.");
  check("το tb (ακροατήριο) βρίσκει και το update (η ομάδα του update είναι ίδια με του εγγράφου)", q.prompt.includes("AUDU-MARK"));
  x = await putDoc(A, D.a, { ...body, audienceProjectIds: [] });
  check("αλλαγή ακροατηρίου με εκκρεμές update: 409 has_pending_updates, τίποτα δεν αλλάζει", x.status === 409 && x.data.error === "has_pending_updates" && audRows(D.a).length === 1 && vecGroups(D.a).join() === D.g);
  x = await putDoc(A, D.a, { ...body, text: body.text + " Προσθήκη.", audienceProjectIds: ["tb"] });
  check("αποθήκευση με ΙΔΙΟ ακροατήριο και εκκρεμές update: επιτρέπεται", x.status === 200);
  await J(call("au_ed_a@demo.gr", "POST", `/team/updates/${u.data.id}/reject`));
  x = await putDoc(A, D.a, { ...body, audienceProjectIds: [] });
  check("μετά την απόρριψη του update η αλλαγή ακροατηρίου επιτρέπεται", x.status === 200 && audRows(D.a).length === 0);

  // ενσωμάτωση update σε έγγραφο με ακροατήριο: μένει η ομάδα
  await putDoc(A, D.a, { ...body, audienceProjectIds: ["tb"] });
  D.g = audRows(D.a)[0].group_id;
  const u2 = await J(call("au_ed_a@demo.gr", "POST", "/team/updates", { documentId: D.a, text: "Ενημέρωση ειδοποίησης δεκαπέντε ημέρες. AUDU2-MARK" }));
  const ap = await J(call("au_ed_a@demo.gr", "POST", `/team/updates/${u2.data.id}/apply`, { text: "Η διαδικασία ακύρωσης συμβολαίου απαιτεί ειδοποίηση δεκαπέντε ημέρες. AUDA-MARK" }));
  check("ενσωμάτωση update: το ακροατήριο και τα vectors μένουν στην ίδια ομάδα", ap.status === 200 && audRows(D.a)[0].group_id === D.g && vecGroups(D.a).join() === D.g);

  // διαγραφή
  const del = await J(call("au_ed_a@demo.gr", "DELETE", `/team/documents/${D.a}`));
  check("διαγραφή εγγράφου: σβήνει και η γραμμή ακροατηρίου (cascade)", del.status === 200 && audRows(D.a).length === 0 && db.prepare("select count(*) c from team_documents where id = ?").get(D.a).c === 0);
  check("... η ομάδα μένει (ξαναχρησιμοποιείται), αλλά ΔΕΝ μπαίνει πια στο φίλτρο του tb (κανένα έγγραφο δεν τη χρησιμοποιεί)", db.prepare("select count(*) c from team_audience_groups where id = ?").get(D.g).c === 1);
  const q2 = await askQ("au_b@demo.gr", QA);
  check("... το φίλτρο του tb δεν περιέχει ορφανή ομάδα", !q2.queries[0].filter.department_id.$in.includes(D.g));
}

// ---- αντιφάσεις, ειδοποιήσεις και εισερχόμενα με τον κανόνα Β
{
  state.judge = [{ x: "απαιτεί τρεις υπογραφές", y: "απαιτεί δύο υπογραφές", topic: "Υπογραφές ειδικής άδειας" }];
  const ra = await J(call("au_ed_a@demo.gr", "POST", "/team/documents", { title: "Άδειες Α", departmentId: "ta", text: "Η έγκριση ειδικής άδειας τηλεπικοινωνιών απαιτεί τρεις υπογραφές. ΑΔΕΙΑ-ΑΑ" }));
  const emailsBefore = state.emails.length;
  const rb = await J(call("au_ed_b@demo.gr", "POST", "/team/documents", { title: "Άδειες Β", departmentId: "tb", text: "Η έγκριση ειδικής άδειας τηλεπικοινωνιών απαιτεί δύο υπογραφές. ΑΔΕΙΑ-ΒΒ" }));
  const found = db.prepare("select count(*) c from team_contradictions where status = 'open' and topic = 'Υπογραφές ειδικής άδειας'").get().c;
  check("αντίφαση ανάμεσα σε έγγραφα δύο projects: βρέθηκε", found === 1);
  const cB = (await J(call("au_ed_b@demo.gr", "GET", "/team/contradictions"))).data.contradictions;
  const viewB = cB.find((c) => c.sides.some((s) => s.editable && /δύο υπογραφές/.test(s.quote)));
  check("ο editor του tb ΔΕΝ βλέπει το κείμενο του εγγράφου του ta (Β): η πλευρά είναι κρυμμένη, γενικός τίτλος", !!viewB && viewB.sides.some((s) => s.hidden === true) && !JSON.stringify(viewB).includes("τρεις υπογραφές") && /που δεν έχεις πρόσβαση/.test(viewB.topic));
  const sent = state.emails.slice(emailsBefore).map((e) => e.to).sort();
  check("ειδοποίηση: μόνο στους ΡΗΤΟΥΣ editors των projects (ο editor του tc που είναι απλό μέλος στο ta ΔΕΝ ειδοποιείται)", sent.includes("au_ed_a@demo.gr") && !sent.includes("au_mixed@demo.gr") && !sent.includes("au_a@demo.gr"));
  await putDoc(A, ra.data.id, { title: "Άδειες Α", departmentId: "ta", text: "Η έγκριση ειδικής άδειας τηλεπικοινωνιών απαιτεί τρεις υπογραφές. ΑΔΕΙΑ-ΑΑ", audienceProjectIds: ["tb"] });
  const cB2 = (await J(call("au_ed_b@demo.gr", "GET", "/team/contradictions"))).data.contradictions;
  const viewB2 = cB2.find((c) => c.sides.some((s) => s.editable && /δύο υπογραφές/.test(s.quote)));
  check("μόλις το tb μπει στο ακροατήριο, ο editor του tb βλέπει και τις δύο παραθέσεις (συνεννόηση)", !!viewB2 && viewB2.sides.every((s) => !s.hidden) && JSON.stringify(viewB2).includes("τρεις υπογραφές"));
  check("... η πλευρά του ta φαίνεται ΜΟΝΟ για ανάγνωση", viewB2.sides.filter((s) => !s.editable).length === 1);
  state.judge = undefined;

  // εισερχόμενα: αναπάντητες ερωτήσεις μόνο των projects όπου είσαι editor
  state.unknown = ["ΑΓΝΩΣΤΟΣΟΡΟΣ"];
  await askQ("au_a@demo.gr", "Τι ισχύει για ΑΓΝΩΣΤΟΣΟΡΟΣ ΑΙΤΗΜΑ;");
  state.unknown = [];
  const inboxEd = (await J(call("au_ed_a@demo.gr", "GET", "/team/inbox"))).data;
  const inboxMixed = (await J(call("au_mixed@demo.gr", "GET", "/team/inbox"))).data;
  check("εισερχόμενα: ο editor του ta βλέπει την αναπάντητη ερώτηση του μέλους του ta", inboxEd.questions.some((q) => /ΑΓΝΩΣΤΟΣΟΡΟΣ/.test(q.question)));
  check("εισερχόμενα: ο au_mixed (editor στο tc, απλό μέλος στο ta) ΔΕΝ βλέπει ερωτήσεις του ta", !inboxMixed.questions.some((q) => /ΑΓΝΩΣΤΟΣΟΡΟΣ/.test(q.question)));
}

// ---- αναφορές υπαλλήλων και ορατά projects
{
  const rd = await J(call("au_ed_a@demo.gr", "POST", "/team/documents", { title: "Για αναφορές", departmentId: "ta", text: "Διαδικασία αναφορών ελέγχου. AUDF-MARK", audienceProjectIds: [] }));
  await putDoc(A, rd.data.id, { title: "Για αναφορές", departmentId: "ta", text: "Διαδικασία αναφορών ελέγχου. AUDF-MARK", audienceProjectIds: ["tb"] });
  check("αναφορά ότι η απάντηση είναι λάθος: το μέλος του ακροατηρίου (tb) μπορεί", (await call("au_b@demo.gr", "POST", "/team/feedback", { documentId: rd.data.id, kind: "wrong", question: "ερώτηση" })).status === 201);
  check("... μέλος εκτός ακροατηρίου (tc): 404", (await call("au_c@demo.gr", "POST", "/team/feedback", { documentId: rd.data.id, kind: "wrong", question: "ερώτηση" })).status === 404);
  const deps1 = (await J(call("au_ed_a@demo.gr", "GET", "/team/departments"))).data.departments.map((d) => d.id);
  check("/team/departments: ο editor βλέπει ΜΟΝΟ τα δικά του projects (όχι ονόματα άλλων πελατών)", deps1.join() === "ta");
  check("/team/departments: ο admin τα βλέπει όλα", (await J(call(A, "GET", "/team/departments"))).data.departments.length >= 5);
}

// ---- μεγάλοι χρήστες: φίλτρο σε παρτίδες και αποτυχία κλειστά
{
  const mkMany = (n, tag) => { const ids = []; for (let i = 0; i < n; i++) { const id = `d-${tag}${i.toString(16).padStart(7, "0")}`; db.prepare("insert into departments(id,workspace_id,name,hidden,created_at) values (?,?,?,0,?)").run(id, "team-demo", `P ${tag} ${i}`, nowIso()); ids.push(id); } return ids.sort(); };
  const bigIds = mkMany(250, "a");
  await mkMember("au_big@demo.gr", bigIds);
  const first = bigIds[0], last = bigIds[bigIds.length - 1];
  await J(call(A, "POST", "/team/documents", { title: "Πρώτο project", departmentId: first, text: "Διαδικασία πρώτου πελάτη μεγάλου χρήστη. BIGF-MARK" }));
  await J(call(A, "POST", "/team/documents", { title: "Τελευταίο project", departmentId: last, text: "Διαδικασία τελευταίου πελάτη μεγάλου χρήστη. BIGL-MARK" }));
  const q = await askQ("au_big@demo.gr", "Διαδικασία πελάτη μεγάλου χρήστη");
  const sizes = q.queries.map((c) => Buffer.byteLength(JSON.stringify(c.filter)));
  check("μεγάλος χρήστης (250 projects): περισσότερα από ένα ερωτήματα, καθένα κάτω από το όριο 2048 bytes του Vectorize", q.queries.length >= 2 && sizes.every((s) => s <= 2048));
  check("... τα αποτελέσματα όλων των παρτίδων ενώνονται: βρίσκει έγγραφα και από την πρώτη και από την τελευταία παρτίδα", q.prompt.includes("BIGF-MARK") && q.prompt.includes("BIGL-MARK"));
  check("... κανένα project δεν χάθηκε από τα φίλτρα", new Set(q.queries.flatMap((c) => c.filter.department_id.$in)).size === 251);

  const hugeIds = mkMany(480, "b");
  await mkMember("au_huge@demo.gr", hugeIds);
  const kvBefore = [...env.DOCUMENT_REGISTRY.store.keys()].filter((k) => k.includes(":fallback:")).length;
  const qh = await askQ("au_huge@demo.gr", "Διαδικασία πελάτη μεγάλου χρήστη");
  check("πάρα πολλά projects (480): ΚΑΝΕΝΑ ερώτημα στο Vectorize (αποτυχία κλειστά)", qh.queries.length === 0 && !qh.prompt.includes("MARK"));
  const hugeText = qh.events.filter((e) => e.type === "chunk").map((e) => e.text).join("");
  check("... ρητό μήνυμα προς τον χρήστη, όχι σιωπηλή αποκοπή", /πάρα πολλά projects/.test(hugeText) && qh.done && qh.done.isFallback === true && qh.done.primarySource === null);
  check("... δεν καταγράφεται ως αναπάντητη ερώτηση (δεν φταίει το περιεχόμενο)", [...env.DOCUMENT_REGISTRY.store.keys()].filter((k) => k.includes(":fallback:")).length === kvBefore);
  const qa = await askQ(A, "Διαδικασία πελάτη μεγάλου χρήστη");
  check("ο admin δεν επηρεάζεται από τα όρια (ένα ερώτημα χωρίς φίλτρο)", qa.queries.length === 1 && qa.queries[0].filter === undefined);
}

// ---- χωρίς το migration 0015: ο βοηθός δουλεύει όπως πριν και μόνο η αλλαγή ακροατηρίου δίνει 503
{
  const rOld = await J(call("au_ed_a@demo.gr", "POST", "/team/documents", { title: "Πριν το migration", departmentId: "ta", text: "Διαδικασία ελέγχου παλιού μοντέλου συγχρονισμού. AUDO-MARK" }));
  const saved = { doc: rOld.data.id };
  db.exec("PRAGMA foreign_keys = OFF");
  for (const t of ["team_document_audience", "team_audience_group_projects", "team_audience_groups"]) db.exec(`DROP TABLE ${t}`);
  db.exec("PRAGMA foreign_keys = ON");
  const q = await askQ("au_a@demo.gr", "Διαδικασία ελέγχου παλιού μοντέλου συγχρονισμού");
  check("χωρίς πίνακες ακροατηρίου: ο βοηθός δουλεύει (μόνο ιδιοκτήτης)", q.prompt.includes("AUDO-MARK") && q.events.some((e) => e.type === "done"));
  check("... η λίστα και η ανάγνωση εγγράφων δουλεύουν", (await J(call("au_a@demo.gr", "GET", `/team/documents/${saved.doc}`))).status === 200 && (await J(call("au_a@demo.gr", "GET", "/team/documents"))).status === 200);
  const body = { title: "Πριν το migration", departmentId: "ta", text: "Διαδικασία ελέγχου παλιού μοντέλου συγχρονισμού. AUDO-MARK" };
  check("... η αποθήκευση εγγράφου χωρίς πεδίο ακροατηρίου δουλεύει", (await putDoc("au_ed_a@demo.gr", saved.doc, body)).status === 200);
  check("... το κενό ακροατήριο ([]) όταν δεν υπάρχει κανένα δουλεύει", (await putDoc("au_ed_a@demo.gr", saved.doc, { ...body, audienceProjectIds: [] })).status === 200);
  const x = await putDoc(A, saved.doc, { ...body, audienceProjectIds: ["tb"] });
  check("... η ΑΛΛΑΓΗ ακροατηρίου: 503 audience_unavailable και το έγγραφο μένει όπως ήταν", x.status === 503 && x.data.error === "audience_unavailable");
  check("... νέο έγγραφο με ακροατήριο: 503 και δεν δημιουργείται", (await J(call(A, "POST", "/team/documents", { title: "Χωρίς πίνακα ακροατηρίου", departmentId: "tb", text: "κείμενο", audienceProjectIds: ["ta"] }))).status === 503 && db.prepare("select count(*) c from team_documents where title = 'Χωρίς πίνακα ακροατηρίου'").get().c === 0);
  check("... οι ενέργειες διαχείρισης (εμπιστευτικό, κρυφό project) δουλεύουν", (await J(call(A, "PATCH", `/team/admin/documents/${saved.doc}`, { hidden: true }))).status === 200 && (await J(call(A, "PATCH", "/team/admin/departments/tc", { hidden: true }))).status === 200);
  await J(call(A, "PATCH", `/team/admin/documents/${saved.doc}`, { hidden: false }));
  await J(call(A, "PATCH", "/team/admin/departments/tc", { hidden: false }));
  // επαναφορά: το migration είναι ασφαλές να ξανατρέξει
  db.exec(readFileSync(join(REPO, "migrations", "0015_team_audience.sql"), "utf8"));
  const x2 = await putDoc(A, saved.doc, { ...body, audienceProjectIds: ["tb"] });
  check("μετά την εφαρμογή του migration 0015 η αλλαγή ακροατηρίου δουλεύει", x2.status === 200 && audRows(saved.doc).length === 1);
}

// ---- Πακέτο Β (backend): πλήθη στην επισκόπηση, «Τι διαβάζει» ανά άνθρωπο
{
  mkProject("rp", "Reading P"); mkProject("rq", "Reading Q"); mkProject("rr", "Reading R");
  const r1 = await mkMember("rd_1@demo.gr", ["rp"]);
  const r2 = await mkMember("rd_2@demo.gr", ["rp"]);
  const r3 = await mkMember("rd_3@demo.gr", ["rq"], ["rq"]);
  db.prepare("update team_members set status = 'disabled' where id = ?").run(r2);
  const mkDoc = async (title, dept, extra = {}) => (await J(call(A, "POST", "/team/documents", { title, departmentId: dept, text: `Κείμενο του ${title}. ${title}-X`, ...extra }))).data.id;
  const dA = await mkDoc("RD-A", "rp", { audienceProjectIds: ["rq"] });
  const dB = await mkDoc("RD-B", "rr");
  const dC = await mkDoc("RD-C", "rp");
  const dAll = await mkDoc("RD-ALL", "_all");
  await J(call(A, "PATCH", `/team/admin/documents/${dC}`, { hidden: true }));
  const reading = async (id, who = A) => J(call(who, "GET", `/team/admin/members/${id}/reading`));
  const mine = (r) => (r.data.documents || []).filter((d) => /^RD-/.test(d.title));

  const ov = (await J(call(A, "GET", "/team/admin/overview"))).data;
  const rp = ov.departments.find((d) => d.id === "rp");
  check("επισκόπηση: το πλήθος μελών μετράει ΜΟΝΟ τους ενεργούς, οι απενεργοποιημένοι φαίνονται χωριστά", rp.memberCount === 1 && rp.disabledCount === 1, rp);
  check("επισκόπηση: πόσα έγγραφα του project μοιράζονται με άλλα projects (sharedDocumentCount)", rp.sharedDocumentCount === 1 && ov.departments.find((d) => d.id === "rr").sharedDocumentCount === 0, rp);
  check("«Τι διαβάζει»: μόνο admin (editor 403)", (await reading(r1, "au_ed_a@demo.gr")).status === 403 && (await reading(r1, "rd_3@demo.gr")).status === 403);

  const x1 = await reading(r1);
  check("μέλος του rp: διαβάζει RD-A και το εμπιστευτικό RD-C του δικού του project (own), το εταιρικό RD-ALL (company), ΟΧΙ το RD-B", x1.status === 200 && mine(x1).map((d) => d.title + ":" + d.via).sort().join() === "RD-A:own,RD-ALL:company,RD-C:own" && mine(x1).find((d) => d.title === "RD-C").confidential === true, mine(x1));
  const x3 = await reading(r3);
  check("μέλος του rq: διαβάζει το RD-A ως «κοινό» (shared) και το εταιρικό RD-ALL, ΟΧΙ το RD-B, ΟΧΙ το εμπιστευτικό RD-C", mine(x3).map((d) => d.title + ":" + d.via).sort().join() === "RD-A:shared,RD-ALL:company" && !JSON.stringify(x3.data).includes("RD-C"), mine(x3));
  check("«Τι διαβάζει»: τα projects του με ρόλο, και το όνομα του project-ιδιοκτήτη στα έγγραφα", JSON.stringify(x3.data.projects) === JSON.stringify([{ id: "rq", name: "Reading Q", role: "editor" }]) && mine(x3).find((d) => d.title === "RD-A").projectName === "Reading P");
  check("«Τι διαβάζει»: ανενεργό μέλος: δείχνει κανονικά τι θα διάβαζε (ο admin ετοιμάζει πρόσβαση)", mine(await reading(r2)).length === 3);
  check("«Τι διαβάζει»: τα εταιρικά έγγραφα μετράνε ως «company» και ΔΕΝ εμφανίζονται ως κοινά", (x3.data.documents || []).filter((d) => d.via === "company").length >= 1 && (x3.data.documents || []).filter((d) => d.via === "company").every((d) => d.title !== "RD-A"));
  const adminId = memberId("admin@demo.gr");
  check("«Τι διαβάζει»: για admin = πρόσβαση παντού, καμία λίστα", JSON.stringify((await reading(adminId)).data) === JSON.stringify({ admin: true, projects: [], documents: [] }));
  check("«Τι διαβάζει»: άγνωστο ή άκυρο id: 404", (await reading(999999)).status === 404 && (await reading("abc")).status === 404);
  const otherId = memberId("other@other.gr");
  check("«Τι διαβάζει»: μέλος ΑΛΛΟΥ οργανισμού: 404 (δεν διαρρέει)", (await reading(otherId)).status === 404);
  check("«Τι διαβάζει»: η λίστα είναι ΑΚΡΙΒΩΣ ό,τι επιστρέφει η πραγματική ανάγνωση (μέλος rq: GET /team/documents)", JSON.stringify(mine(x3).map((d) => d.id)) === JSON.stringify(((await J(call("rd_3@demo.gr", "GET", "/team/documents"))).data.documents || []).filter((d) => /^RD-/.test(d.title)).map((d) => d.id)));

  // άμυνα σε βάθος: ακόμα κι αν μείνει (λάθος, π.χ. μισοτελειωμένη ενέργεια) γραμμή ακροατηρίου σε ΕΜΠΙΣΤΕΥΤΙΚΟ έγγραφο, δεν διαρρέει
  db.prepare("insert into team_audience_groups (id, workspace_id, created_at) values ('ag-00000000000000c1', 'team-demo', ?)").run(nowIso());
  for (const pid of ["rp", "rq"]) db.prepare("insert into team_audience_group_projects (group_id, project_id) values ('ag-00000000000000c1', ?)").run(pid);
  db.prepare("insert into team_document_audience (workspace_id, document_id, group_id) values ('team-demo', ?, 'ag-00000000000000c1')").run(dC);
  check("εμπιστευτικό έγγραφο με «ξεχασμένη» γραμμή ακροατηρίου: δεν διαρρέει ούτε στο «Τι διαβάζει» ούτε στην ανάγνωση", !JSON.stringify((await reading(r3)).data).includes("RD-C") && (await J(call("rd_3@demo.gr", "GET", `/team/documents/${dC}`))).status === 404);
  db.prepare("delete from team_document_audience where document_id = ?").run(dC);
  await putDoc(A, dA, { title: "RD-A", departmentId: "rp", text: "Κείμενο του RD-A. RD-A-X", audienceProjectIds: [] });
  check("αφαίρεση ακροατηρίου: το RD-A φεύγει από το «Τι διαβάζει» του rq (μένει μόνο το εταιρικό) και το sharedDocumentCount μηδενίζεται", mine(await reading(r3)).map((d) => d.title).join() === "RD-ALL" && (await J(call(A, "GET", "/team/admin/overview"))).data.departments.find((d) => d.id === "rp").sharedDocumentCount === 0);
}
}

// ============================================================================ 29. Οθόνες ακροατηρίου και διαχείρισης (jsdom)
section("29. Οθόνες: επιλογή ακροατηρίου, ετικέτες «κοινό», «Τι διαβάζει», επιβεβαιώσεις, μετρητές χωρίς ανενεργούς, ετικέτα AI");
{ // ένα μπλοκ: δικά του δεδομένα (νέα projects και μέλη), ανεξάρτητα από τις προηγούμενες ενότητες
  const setU = (dom, el, v) => { el.value = v; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  const tickU = (dom, el, on) => { el.checked = on; el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  const submitU = (dom, sel) => $u(dom, sel).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  const adm = async (method, path, body) => { const res = await call("admin@demo.gr", method, path, body); return { status: res.status, data: await readJson(res) }; };
  const proj = async (name) => (await adm("POST", "/team/admin/departments", { name })).data;
  const person = async (email, projectRoles) => { const r = await adm("POST", "/team/admin/members", { email, role: "member", projectRoles, sendInvite: false }); S[email] = (await login(email)).cookie; return r.data.id; };
  const pA = await proj("UI Άλφα"), pB = await proj("UI Βήτα"), pG = await proj("UI Γάμμα");
  const idEd = await person("ui_ed@demo.gr", { [pA.id]: "editor", [pB.id]: "member" });
  const idAgent = await person("ui_agent@demo.gr", { [pB.id]: "member" });
  const idOff = await person("ui_off@demo.gr", { [pA.id]: "member" });
  await adm("PATCH", `/team/admin/members/${idOff}`, { status: "disabled" });
  const mkd = async (title, dept, extra = {}) => (await adm("POST", "/team/documents", { title, departmentId: dept, text: `Κείμενο: ${title}. ${title.replace(/\s/g, "")}-X`, ...extra })).data.id;
  const dShared = await mkd("UI κοινό", pA.id, { audienceProjectIds: [pB.id] });
  await mkd("UI μόνο Άλφα", pA.id);
  await mkd("UI από Γάμμα", pG.id, { audienceProjectIds: [pA.id] });
  await mkd("UI Βήτα έγγραφο", pB.id);
  const audRowsOf = (title) => db.prepare("select gp.project_id p from team_documents d join team_document_audience da on da.document_id = d.id and da.workspace_id = d.workspace_id join team_audience_group_projects gp on gp.group_id = da.group_id where d.title = ? order by gp.project_id").all(title).map((r) => r.p);

  // ------------------------------------------------------------ editor: λίστα, ετικέτες, φόρμα ακροατηρίου
  const ed = uiFor("ui_ed@demo.gr")("team-editor.html");
  clickU(ed, await uiWait(() => $u(ed, "#tab-docs")));
  await uiWait(() => $$u(ed, ".item").length > 3);
  const itemOf = (re) => $$u(ed, ".item").find((i) => re.test(i.textContent));
  check("editor: ο ιδιοκτήτης βλέπει στη λίστα «κοινό με 1 project»", /UI κοινό.*κοινό με 1 project/.test((itemOf(/UI κοινό/) || {}).textContent || ""), (itemOf(/UI κοινό/) || {}).textContent);
  check("editor: έγγραφο ΑΛΛΟΥ project που μοιράζεται με το δικό του: «μόνο ανάγνωση · κοινό με το project σου»", /μόνο ανάγνωση · κοινό με το project σου/.test((itemOf(/UI από Γάμμα/) || {}).textContent || ""), (itemOf(/UI από Γάμμα/) || {}).textContent);
  check("editor: έγγραφο του δικού του project όπου είναι απλό μέλος: μόνο «μόνο ανάγνωση» (ΟΧΙ «κοινό με το project σου»)", /UI Βήτα έγγραφο.*μόνο ανάγνωση/.test((itemOf(/UI Βήτα έγγραφο/) || {}).textContent || "") && !/κοινό με το project σου/.test((itemOf(/UI Βήτα έγγραφο/) || {}).textContent || ""));
  clickU(ed, itemOf(/UI από Γάμμα/));
  await uiWait(() => $u(ed, ".readonly-text"));
  check("editor: το πάνελ μόνο ανάγνωσης λέει ότι είναι έγγραφο άλλου project, κοινό με το δικό του, και ΔΕΝ έχει φόρμα", /Έγγραφο άλλου project, κοινό με το δικό σου/.test($u(ed, "#panel").textContent) && !$u(ed, "#panel form"));
  clickU(ed, itemOf(/UI κοινό/));
  await uiWait(() => $u(ed, "#audience"));
  check("editor: η ενότητα «Ποιος άλλος το διαβάζει;» είναι ανοιχτή όταν το έγγραφο μοιράζεται, με το project επιλεγμένο", $u(ed, "#audience").hasAttribute("open") && $u(ed, `#audience input[data-project="${pB.id}"]`).checked === true, $u(ed, "#audience-state").textContent);
  check("editor: η περίληψη λέει «<project> + 1 project»", new RegExp("UI Άλφα \\+ 1 project").test($u(ed, "#audience-state").textContent), $u(ed, "#audience-state").textContent);
  check("editor: ΜΟΝΟ τα projects όπου είναι ο ίδιος μέλος προσφέρονται (όχι το «UI Γάμμα» ούτε άλλα)", $$u(ed, "#audience input[type=checkbox]").map((c) => c.getAttribute("data-project")).join() === pB.id);

  // νέο έγγραφο με ακροατήριο από τη φόρμα
  clickU(ed, itemOf(/Νέο έγγραφο/));
  await uiWait(() => $u(ed, "#panel form"));
  check("editor (νέο έγγραφο): η ενότητα είναι κλειστή όταν δεν υπάρχει ακροατήριο", !$u(ed, "#audience").hasAttribute("open"));
  setU(ed, $u(ed, "#title"), "UI νέο κοινό"); setU(ed, $u(ed, "#text"), "Κείμενο νέου κοινού εγγράφου. UINEO-X");
  tickU(ed, $u(ed, `#audience input[data-project="${pB.id}"]`), true);
  check("editor: μετά την επιλογή η περίληψη ενημερώνεται «UI Άλφα + 1 project»", /UI Άλφα \+ 1 project/.test($u(ed, "#audience-state").textContent));
  submitU(ed, "#panel form");
  check("editor: η αποθήκευση περνά και η βάση έχει ομάδα ακροατηρίου {Άλφα, Βήτα}", !!(await uiWait(() => audRowsOf("UI νέο κοινό").join() === [pA.id, pB.id].sort().join())), audRowsOf("UI νέο κοινό"));

  // ------------------------------------------------------------ admin: ετικέτες, μετρητές, «Τι διαβάζει», επιβεβαιώσεις
  const ad = uiFor("admin@demo.gr")("team-admin.html");
  await uiWait(() => $$u(ad, ".dept-row").length >= 3);
  const deptRowOf = (name) => $$u(ad, ".dept-row").find((r) => r.querySelector("input[type=text]").value === name);
  check("Projects: πληθυντικός και ανενεργοί χωριστά («1 μέλος · … · +1 απενεργοποιημένο»)", /^1 μέλος · \d+ έγγραφ(ο|α) · \+1 απενεργοποιημένο$/.test(deptRowOf("UI Άλφα").querySelector(".meta").textContent), deptRowOf("UI Άλφα").querySelector(".meta").textContent);
  clickU(ad, deptRowOf("UI Άλφα").querySelector(".open-project"));
  await uiWait(() => $u(ad, "#project-page"));
  check("σελίδα project: οι απενεργοποιημένοι δεν μετράνε και κρύβονται από προεπιλογή", /^1 μέλος · 1 editor · /.test($u(ad, "#project-meta").textContent) && $$u(ad, ".proj-member-row").length === 1, $u(ad, "#project-meta").textContent);
  check("σελίδα project: «Εμφάνιση απενεργοποιημένων (1)»", /Εμφάνιση απενεργοποιημένων \(1\)/.test($u(ad, "#proj-show-disabled").parentNode.textContent));
  tickU(ad, $u(ad, "#proj-show-disabled"), true);
  await uiWait(() => $$u(ad, ".proj-member-row").length === 2);
  check("... και τους δείχνει με ετικέτα «απενεργοποιημένο»", $$u(ad, ".proj-member-row").length === 2 && /απενεργοποιημένο/.test($$u(ad, ".proj-member-row").map((r) => r.textContent).join(" ")));
  // επικόλληση: κανείς δεν προστέθηκε = σφάλμα (κόκκινο), όχι επιτυχία
  const pasteBox0 = $u(ad, "#paste-emails");
  setU(ad, pasteBox0, "ghost@nowhere.gr");
  clickU(ad, $u(ad, "#paste-add"));
  const errToast = await uiWait(() => $u(ad, ".toast.err"));
  await uiWait(() => $u(ad, "#paste-emails") && $u(ad, "#paste-emails") !== pasteBox0 && !$u(ad, ".busy")); // η σελίδα ξαναχτίστηκε
  check("επικόλληση που δεν προσθέτει κανέναν: κόκκινο μήνυμα «Δεν προστέθηκε κανείς»", !!errToast && /Δεν προστέθηκε κανείς/.test(errToast.textContent) && !$u(ad, ".toast.ok"), errToast && errToast.textContent);
  // οι επιλογές μένουν μετά από προσθήκη
  tickU(ad, $u(ad, "#paste-create"), true);
  const pasteBox1 = $u(ad, "#paste-emails");
  setU(ad, pasteBox1, "ui_agent@demo.gr");
  clickU(ad, $u(ad, "#paste-add"));
  await uiWait(() => db.prepare("select 1 from member_departments md join team_members m on m.id = md.member_id where m.email = 'ui_agent@demo.gr' and md.department_id = ?").get(pA.id));
  await uiWait(() => $u(ad, "#paste-emails") && $u(ad, "#paste-emails") !== pasteBox1 && !$u(ad, ".busy")); // η σελίδα ξαναχτίστηκε
  check("η επιλογή «Δημιουργία νέων μελών» ΜΕΝΕΙ μετά την προσθήκη", $u(ad, "#paste-create").checked === true);
  clickU(ad, $u(ad, "#project-back"));

  // «Τι διαβάζει»
  clickU(ad, await uiWait(() => $u(ad, "#tab-members")));
  await uiWait(() => $u(ad, "#people-q"));
  setU(ad, $u(ad, "#people-q"), "ui_agent@demo.gr");
  const arow = await uiWait(() => { const rs = $$u(ad, ".member-row"); return rs.length === 1 ? rs[0] : null; });
  clickU(ad, arow.querySelector(".open-member"));
  const rd = await uiWait(() => $u(ad, "#member-reading details"));
  check("καρτέλα ατόμου: «Τι διαβάζει» με περίληψη εγγράφων", !!rd && /Τι διαβάζει/.test(rd.textContent) && /έγγραφ/.test($u(ad, "#member-reading .s-state").textContent), rd && rd.textContent);
  check("«Τι διαβάζει»: έγγραφο άλλου project που μοιράζεται με το project του εμφανίζεται με ετικέτα «κοινό»", $$u(ad, "#member-reading .reading-row").some((r) => /UI από Γάμμα/.test(r.textContent) && !!r.querySelector(".pill.shared")), $$u(ad, "#member-reading .reading-row").map((r) => r.textContent));
  check("καρτέλα ατόμου μετά το κλικ: παίρνει focus και tabindex (ώστε να φέρνεται στο οπτικό πεδίο)", $u(ad, "#member-detail").getAttribute("tabindex") === "-1");

  // έγγραφα: φαίνεται με ποιον μοιράζεται, και επιβεβαίωση πριν γίνει εμπιστευτικό
  clickU(ad, $u(ad, "#tab-documents"));
  const docRow = await uiWait(() => $$u(ad, ".doc-row").find((r) => /UI κοινό/.test(r.textContent)));
  check("Έγγραφα: φαίνεται «κοινό με UI Βήτα»", /κοινό με UI Βήτα/.test(docRow.querySelector(".meta").textContent), docRow.querySelector(".meta").textContent);
  clickU(ad, docRow.querySelector(".doc-hide-toggle"));
  check("σήμανση εμπιστευτικού σε έγγραφο που μοιράζεται: ζητά επιβεβαίωση και δεν αλλάζει τίποτα ακόμα", !!(await uiWait(() => $u(ad, ".confirm"))) && /μοιράζεται με 1 project/.test($u(ad, ".confirm").textContent) && db.prepare("select hidden from team_documents where id = ?").get(dShared).hidden === 0);
  clickU(ad, $u(ad, ".confirm-no"));
  check("«Όχι»: το έγγραφο μένει όπως ήταν, με το ακροατήριό του", !$u(ad, ".confirm") && db.prepare("select hidden from team_documents where id = ?").get(dShared).hidden === 0 && audRowsOf("UI κοινό").length === 2);
  clickU(ad, $$u(ad, ".doc-row").find((r) => /UI κοινό/.test(r.textContent)).querySelector(".doc-hide-toggle"));
  await uiWait(() => $u(ad, ".confirm-yes"));
  clickU(ad, $u(ad, ".confirm-yes"));
  check("«Ναι»: γίνεται εμπιστευτικό και το ακροατήριο σβήνει", !!(await uiWait(() => db.prepare("select hidden from team_documents where id = ?").get(dShared).hidden === 1)) && audRowsOf("UI κοινό").length === 0);
  // απόκρυψη project με κοινοποιημένα έγγραφα: επιβεβαίωση
  clickU(ad, $u(ad, "#tab-departments"));
  await uiWait(() => $$u(ad, ".dept-row").length >= 3);
  clickU(ad, deptRowOf("UI Γάμμα").querySelector(".hide-toggle"));
  check("απόκρυψη project με κοινοποιημένο έγγραφο: ζητά επιβεβαίωση, δεν κρύβεται ακόμα", !!(await uiWait(() => $u(ad, ".confirm"))) && /μοιράζεται με άλλα projects/.test($u(ad, ".confirm").textContent) && db.prepare("select hidden from departments where id = ?").get(pG.id).hidden === 0);
  clickU(ad, $u(ad, ".confirm-no"));
  clickU(ad, deptRowOf("UI Βήτα").querySelector(".hide-toggle"));
  check("απόκρυψη project ΧΩΡΙΣ κοινοποιημένα έγγραφα: εφαρμόζεται αμέσως, χωρίς επιβεβαίωση", !!(await uiWait(() => db.prepare("select hidden from departments where id = ?").get(pB.id).hidden === 1)));
  await uiWait(() => deptRowOf("UI Βήτα") && /κρυφό/.test(deptRowOf("UI Βήτα").textContent) && !$u(ad, ".busy")); // ξαναχτίστηκε η γραμμή
  clickU(ad, deptRowOf("UI Βήτα").querySelector(".hide-toggle"));
  await uiWait(() => db.prepare("select hidden from departments where id = ?").get(pB.id).hidden === 0);

  // ------------------------------------------------------------ portal: τίτλος, ετικέτα AI, «κοινό»
  const pt = uiFor("ui_ed@demo.gr")("portal.html");
  await uiWait(() => $u(pt, "#q"));
  check("portal: μόνιμη σημείωση ότι ο βοηθός είναι AI (άρθρο 50 του AI Act)", !!$u(pt, "#ai-note") && /AI/.test($u(pt, "#ai-note").textContent));
  await uiWait(() => $$u(pt, ".row").length > 0);
  check("portal: τίτλος στήλης «Έγγραφα που βλέπεις»", $$u(pt, "h2").some((h) => h.textContent === "Έγγραφα που βλέπεις"));
  // Τα έγγραφα του τεστ είναι φρέσκα, άρα εμφανίζονται ΚΑΙ στη στήλη «Τι άλλαξε πρόσφατα» (χωρίς ετικέτα «κοινό»). Ψάχνουμε μόνο στη στήλη εγγράφων.
  const docsColumn = $$u(pt, "h2").find((h) => h.textContent === "Έγγραφα που βλέπεις").parentNode;
  const docRowsP = Array.from(docsColumn.querySelectorAll(".row"));
  const sharedRow = docRowsP.find((r) => /UI από Γάμμα/.test(r.textContent));
  const ownRowP = docRowsP.find((r) => /UI μόνο Άλφα/.test(r.textContent));
  check("portal: έγγραφο άλλου project που μοιράζεται δείχνει «κοινό», τα δικά του όχι", !!sharedRow && !!ownRowP && !!sharedRow.querySelector(".pill.shared") && !ownRowP.querySelector(".pill.shared"), docRowsP.map((r) => r.textContent));
  setU(pt, $u(pt, "#q"), "Ποιο είναι το κείμενο του εγγράφου UI μόνο Άλφα;");
  submitU(pt, ".searchrow");
  await uiWait(() => $u(pt, ".answer .source"));
  check("portal: η απάντηση φέρει ετικέτα «Απάντηση από AI»", /Απάντηση από AI/.test($u(pt, ".answer .label").textContent) && !!$u(pt, ".answer .label .pill"), $u(pt, ".answer .label").textContent);
  clickU(pt, sharedRow);
  const rdr = await uiWait(() => $u(pt, ".overlay .reader"));
  check("portal: ο αναγνώστης δείχνει project, «κοινό με …» και ημερομηνία ενημέρωσης", !!rdr && /UI Γάμμα/.test(rdr.querySelector(".facts").textContent) && /κοινό με: UI Άλφα/.test(rdr.querySelector(".facts").textContent) && /ενημερώθηκε/.test(rdr.querySelector(".facts").textContent), rdr && rdr.querySelector(".facts").textContent);
}

// ============================================================================ 30. Προφίλ χώρου και τοίχοι πελατών (API)
section("30. Προφίλ χώρου και τοίχοι: call center με πολλούς πελάτες (τίποτα δεν περνά από τον έναν πελάτη στον άλλον)");
{ // ένα μπλοκ: δικός του οργανισμός (team-bpo), ανεξάρτητος από τους υπόλοιπους
  const nowIso = () => new Date().toISOString();
  const J = async (pending) => { const res = await pending; return { status: res.status, data: await readJson(res) }; };
  const BPO = "bpo_admin@demo.gr";
  db.prepare("insert into team_workspaces (id,name,status,created_at) values ('team-bpo','BPO Demo','pilot',?)").run(nowIso());
  db.prepare("insert into team_members (workspace_id,email,role,status,created_at) values ('team-bpo',?,'admin','active',?)").run(BPO, nowIso());
  S[BPO] = (await login(BPO)).cookie;
  const adm = (method, path, body) => J(call(BPO, method, path, body));
  const person = async (email, projectRoles) => {
    const r = await adm("POST", "/team/admin/members", { email, role: "member", projectRoles, sendInvite: false });
    S[email] = (await login(email)).cookie;
    return r.data.id;
  };
  const put = (id, body) => adm("PUT", `/team/documents/${id}`, body);
  const mkdoc = async (title, departmentId, text, extra = {}) => (await adm("POST", "/team/documents", { title, departmentId, text, ...extra })).data.id;
  const ask = async (email, body) => {
    state.prompts.length = 0;
    const res = await call(email, "POST", "/team/query/stream", body);
    if (res.status !== 200) return { status: res.status, data: await readJson(res), prompt: "" };
    await readSse(res);
    return { status: 200, prompt: state.prompts.join("\n") };
  };
  const usage = (email) => db.prepare("select coalesce(sum(count), 0) c from team_usage where member_id = ?").get(memberId(email)).c;
  const overview = async () => (await adm("GET", "/team/admin/overview")).data;
  const deptName = async (id) => (await overview()).departments.find((d) => d.id === id).name;
  const wallsOf = (r) => (r.data.walls || []).map((w) => w.name).join();

  // ---------------------------------------------------------------- 30.1 προφίλ χώρου
  {
    const o = await overview();
    check("προφίλ: ένας νέος χώρος είναι «company» και δεν έχει πελάτες", o.profile === "company" && o.clientsAvailable === true && o.clients.length === 0, o);
    check("company: δημιουργία πελάτη απορρίπτεται (409 profile_company)", (await adm("POST", "/team/admin/clients", { name: "Apple" })).data.error === "profile_company");
    check("προφίλ: άκυρη τιμή: 400 invalid_profile", (await adm("PATCH", "/team/admin/workspace", { profile: "bogus" })).data.error === "invalid_profile" && (await adm("PATCH", "/team/admin/workspace", {})).status === 400);
    const probe = await J(call("giamarigkos_nobody@demo.gr", "PATCH", "/team/admin/workspace", { profile: "multi_client" }));
    check("προφίλ: χωρίς σύνδεση: 401", probe.status === 401);
    const chg = await adm("PATCH", "/team/admin/workspace", { profile: "multi_client" });
    check("προφίλ: αλλαγή σε «multi_client»: 200", chg.status === 200 && chg.data.profile === "multi_client");
    check("προφίλ: ξανά η ίδια τιμή = χωρίς αλλαγή (200)", (await adm("PATCH", "/team/admin/workspace", { profile: "multi_client" })).status === 200);
    check("προφίλ: καταγράφεται στο ιστορικό ΜΙΑ φορά", db.prepare("select count(*) c from team_audit_log where action = 'workspace_profile_changed' and workspace_id = 'team-bpo'").get().c === 1);
    check("προφίλ: ο χώρος team-demo ΔΕΝ επηρεάζεται (ακόμα «company»)", (await J(call("admin@demo.gr", "GET", "/team/admin/overview"))).data.profile === "company");
  }

  // ---------------------------------------------------------------- 30.2 πελάτες και τμήματα
  const apple = (await adm("POST", "/team/admin/clients", { name: "Apple" })).data;
  const efood = (await adm("POST", "/team/admin/clients", { name: "eFood" })).data;
  check("πελάτης: δημιουργία: 201 με id c-… και όνομα", /^c-[0-9a-f]{8}$/.test(apple.id || "") && apple.name === "Apple" && efood.name === "eFood");
  check("πελάτης: ίδιο όνομα (και με άλλα κεφαλαία): 409 name_taken", (await adm("POST", "/team/admin/clients", { name: "APPLE" })).data.error === "name_taken");
  check("πελάτης: κενό, πολύ μεγάλο ή με το «·»: 400 invalid_name", (await adm("POST", "/team/admin/clients", { name: "  " })).status === 400 && (await adm("POST", "/team/admin/clients", { name: "x".repeat(61) })).status === 400 && (await adm("POST", "/team/admin/clients", { name: "A · B" })).status === 400);
  await person("bpo_probe_ed@demo.gr", {});
  check("πελάτης: ένας μη admin δεν δημιουργεί πελάτη (403)", (await J(call("bpo_probe_ed@demo.gr", "POST", "/team/admin/clients", { name: "Nope" }))).status === 403);

  const appleCC = (await adm("POST", "/team/admin/departments", { name: "Customer Care", clientId: apple.id })).data;
  const appleTech = (await adm("POST", "/team/admin/departments", { name: "Technical", clientId: apple.id })).data;
  const efoodCC = (await adm("POST", "/team/admin/departments", { name: "Customer Care", clientId: efood.id })).data;
  const training = (await adm("POST", "/team/admin/departments", { name: "BPO Training" })).data;
  check("τμήμα σε πελάτη: το όνομα γράφεται «πελάτης · τμήμα»", appleCC.name === "Apple · Customer Care" && efoodCC.name === "eFood · Customer Care" && appleCC.clientId === apple.id && appleCC.shortName === "Customer Care");
  check("... δύο πελάτες έχουν και οι δύο «Customer Care» χωρίς σύγκρουση", appleCC.id !== efoodCC.id && /^d-/.test(appleCC.id));
  check("τμήμα χωρίς πελάτη = εσωτερικό του call center (όνομα όπως δόθηκε)", training.name === "BPO Training" && training.clientId === null);
  check("τμήμα: ίδιο όνομα στον ίδιο πελάτη: 409 name_taken", (await adm("POST", "/team/admin/departments", { name: "Customer Care", clientId: apple.id })).data.error === "name_taken");
  check("τμήμα: άγνωστος πελάτης: 404 client_not_found, καθόλου project", (await adm("POST", "/team/admin/departments", { name: "Ghost", clientId: "c-zzzzzzzz" })).data.error === "client_not_found" && db.prepare("select count(*) c from departments where name like '%Ghost%'").get().c === 0);
  check("τμήμα: πελάτης που δεν είναι string: 400 invalid_client", (await adm("POST", "/team/admin/departments", { name: "Bad", clientId: 5 })).data.error === "invalid_client");
  const ov = await overview();
  check("επισκόπηση: πελάτες με πλήθος τμημάτων και τα τμήματα με clientId, shortName", JSON.stringify(ov.clients.map((c) => [c.name, c.projectCount])) === JSON.stringify([["Apple", 2], ["eFood", 1]]) && ov.departments.find((d) => d.id === appleTech.id).clientId === apple.id);

  // ---------------------------------------------------------------- μέλη και έγγραφα
  const aAgent = "bpo_apple_agent@demo.gr", fAgent = "bpo_efood_agent@demo.gr", bothAgent = "bpo_both_agent@demo.gr", aEd = "bpo_apple_ed@demo.gr", aMulti = "bpo_apple_multi@demo.gr", tAgent = "bpo_train_agent@demo.gr";
  await person(aAgent, { [appleCC.id]: "member" });
  await person(fAgent, { [efoodCC.id]: "member" });
  await person(bothAgent, { [appleCC.id]: "member", [efoodCC.id]: "member" });
  await person(aEd, { [appleCC.id]: "editor", [appleTech.id]: "member" });
  await person(aMulti, { [appleCC.id]: "member", [appleTech.id]: "member" });
  await person(tAgent, { [training.id]: "member" });
  const dA = await mkdoc("Apple πολιτική", appleCC.id, "Η πολιτική επιστροφών της Apple διαρκεί δεκατέσσερις ημέρες. APL-MARK");
  const dT = await mkdoc("Apple τεχνικό", appleTech.id, "Οδηγίες επανεκκίνησης συσκευής Apple. APLT-MARK");
  const dF = await mkdoc("eFood πολιτική", efoodCC.id, "Η πολιτική επιστροφών της eFood διαρκεί επτά ημέρες. EFD-MARK");
  const dI = await mkdoc("Εσωτερικό εκπαίδευσης", training.id, "Οδηγίες εκπαίδευσης νέων πρακτόρων. INT-MARK");
  const dAll = await mkdoc("Εσωτερικοί κανόνες BPO", "_all", "Το διάλειμμα των πρακτόρων διαρκεί δέκα λεπτά. ALL-MARK");
  check("έγγραφα: δημιουργήθηκαν σε όλους τους τοίχους", [dA, dT, dF, dI, dAll].every((x) => /^doc-/.test(x || "")));
  const Q = "Ποια είναι η πολιτική επιστροφών;";

  // ---------------------------------------------------------------- 30.3 κανόνας ακροατηρίου: μόνο μέσα στον ίδιο πελάτη
  {
    const base = { title: "Apple πολιτική", departmentId: appleCC.id, text: "Η πολιτική επιστροφών της Apple διαρκεί δεκατέσσερις ημέρες. APL-MARK" };
    let x = await put(dA, { ...base, audienceProjectIds: [appleTech.id] });
    check("ακροατήριο: τμήμα του ΙΔΙΟΥ πελάτη: επιτρέπεται (200)", x.status === 200);
    check("... και το διαβάζει όποιος ανήκει στο τμήμα εκείνο", (await J(call(aMulti, "GET", `/team/documents/${dA}`))).status === 200);
    x = await put(dA, { ...base, audienceProjectIds: [efoodCC.id] });
    check("ακροατήριο: τμήμα ΑΛΛΟΥ πελάτη: 400 audience_cross_client", x.status === 400 && x.data.error === "audience_cross_client");
    x = await put(dA, { ...base, audienceProjectIds: [training.id] });
    check("ακροατήριο: εσωτερικό του call center για έγγραφο πελάτη: 400 audience_cross_client", x.data.error === "audience_cross_client");
    x = await put(dA, { ...base, audienceProjectIds: [appleTech.id, efoodCC.id] });
    check("ακροατήριο: ένα ξένο μέσα σε λίστα με σωστά: απορρίπτεται ΟΛΟΚΛΗΡΗ η αίτηση", x.data.error === "audience_cross_client");
    check("... και δεν άλλαξε τίποτα (το ακροατήριο μένει {Apple Technical})", db.prepare("select count(*) c from team_document_audience where document_id = ?").get(dA).c === 1);
    x = await put(dF, { title: "eFood πολιτική", departmentId: efoodCC.id, text: "Η πολιτική επιστροφών της eFood διαρκεί επτά ημέρες. EFD-MARK", audienceProjectIds: [appleCC.id] });
    check("ακροατήριο: το αντίστροφο (eFood προς Apple): 400 audience_cross_client", x.data.error === "audience_cross_client");
    x = await J(call(aEd, "PUT", `/team/documents/${dA}`, { ...base, audienceProjectIds: [appleTech.id, efoodCC.id] }));
    check("ακροατήριο: ο editor (δεν ανήκει στο eFood) παίρνει 403, όχι εξήγηση για άλλον πελάτη", x.status === 403 && x.data.error === "audience_forbidden");
    await put(dA, { ...base, audienceProjectIds: [] });
  }

  // ---------------------------------------------------------------- 30.4 άμυνα σε βάθος: «ξεχασμένο» ακροατήριο πάνω από τον τοίχο
  {
    db.prepare("insert into team_audience_groups (id, workspace_id, created_at) values ('ag-00000000000000c3', 'team-bpo', ?)").run(nowIso());
    for (const pid of [efoodCC.id, appleCC.id]) db.prepare("insert into team_audience_group_projects (group_id, project_id) values ('ag-00000000000000c3', ?)").run(pid);
    db.prepare("insert into team_document_audience (workspace_id, document_id, group_id) values ('team-bpo', ?, 'ag-00000000000000c3')").run(dF);
    for (const v of env.VECTORIZE.vectors.values()) if (v.metadata.documentId === dF) v.metadata.department_id = "ag-00000000000000c3";
    const r = await J(call(aAgent, "GET", `/team/documents/${dF}`));
    check("τοίχος στην ανάγνωση: ακροατήριο που ξεπερνά τον τοίχο ΔΕΝ δίνει πρόσβαση (404)", r.status === 404);
    const list = (await J(call(aAgent, "GET", "/team/documents"))).data.documents;
    check("... ούτε εμφανίζεται στη λίστα", !list.some((d) => d.id === dF));
    const a = await ask(aAgent, { question: Q });
    check("... ούτε το χρησιμοποιεί ο βοηθός (ακόμα κι όταν το Vectorize το επιστρέφει)", a.status === 200 && !a.prompt.includes("EFD-MARK") && a.prompt.includes("APL-MARK"), a.prompt.slice(0, 200));
    check("... ο ιδιοκτήτης (eFood) το διαβάζει κανονικά", (await J(call(fAgent, "GET", `/team/documents/${dF}`))).status === 200);
    db.prepare("delete from team_document_audience where document_id = ?").run(dF);
    for (const v of env.VECTORIZE.vectors.values()) if (v.metadata.documentId === dF) v.metadata.department_id = efoodCC.id;
  }

  // ---------------------------------------------------------------- 30.5 μετακίνηση εγγράφων
  {
    const base = { title: "Apple πολιτική", text: "Η πολιτική επιστροφών της Apple διαρκεί δεκατέσσερις ημέρες. APL-MARK" };
    check("μετακίνηση εγγράφου σε project ΑΛΛΟΥ πελάτη: 409 cross_client_move", (await put(dA, { ...base, departmentId: efoodCC.id })).data.error === "cross_client_move");
    check("... στα εσωτερικά: 409", (await put(dA, { ...base, departmentId: training.id })).data.error === "cross_client_move");
    check("... στο «όλη η εταιρεία» (θα το έβλεπαν όλοι οι πελάτες): 409", (await put(dA, { ...base, departmentId: "_all" })).data.error === "cross_client_move");
    check("... και το έγγραφο μένει στη θέση του", db.prepare("select department_id d from team_documents where id = ?").get(dA).d === appleCC.id);
    const mv = await put(dT, { title: "Apple τεχνικό", departmentId: appleCC.id, text: "Οδηγίες επανεκκίνησης συσκευής Apple. APLT-MARK" });
    check("μετακίνηση μέσα στον ΙΔΙΟ πελάτη: επιτρέπεται", mv.status === 200);
    await put(dT, { title: "Apple τεχνικό", departmentId: appleTech.id, text: "Οδηγίες επανεκκίνησης συσκευής Apple. APLT-MARK" });
    const tmp = await mkdoc("Προσωρινό εσωτερικό", "_all", "Κείμενο προσωρινού εγγράφου. TMP-MARK");
    check("από «όλη η εταιρεία» προς ένα project (στένεμα): επιτρέπεται", (await put(tmp, { title: "Προσωρινό εσωτερικό", departmentId: appleCC.id, text: "Κείμενο προσωρινού εγγράφου. TMP-MARK" })).status === 200);
    await adm("DELETE", `/team/documents/${tmp}`);
  }

  // ---------------------------------------------------------------- 30.6 μεταφορά project ανάμεσα σε τοίχους
  {
    const put2 = (id, body) => adm("PUT", `/team/admin/departments/${id}/client`, body);
    let x = await put2(training.id, { clientId: apple.id });
    check("project: από τα εσωτερικά σε πελάτη: 200 και το όνομα γίνεται «πελάτης · τμήμα»", x.status === 200 && x.data.name === "Apple · BPO Training" && (await deptName(training.id)) === "Apple · BPO Training");
    x = await put2(training.id, { clientId: null });
    check("project: πίσω στα εσωτερικά: το όνομα γυρίζει στο σκέτο", x.status === 200 && (await deptName(training.id)) === "BPO Training" && db.prepare("select count(*) c from team_project_clients where project_id = ?").get(training.id).c === 0);
    // κοινά έγγραφα μέσα στον ίδιο πελάτη (έγκυρα) που θα γίνονταν υπερ-τοίχου
    await put(dT, { title: "Apple τεχνικό", departmentId: appleTech.id, text: "Οδηγίες επανεκκίνησης συσκευής Apple. APLT-MARK", audienceProjectIds: [appleCC.id] });
    await put(dA, { title: "Apple πολιτική", departmentId: appleCC.id, text: "Η πολιτική επιστροφών της Apple διαρκεί δεκατέσσερις ημέρες. APL-MARK", audienceProjectIds: [appleTech.id] });
    x = await put2(appleTech.id, { clientId: efood.id });
    check("project: μεταφορά σε άλλον πελάτη ενώ μοιράζονται έγγραφα: 409 cross_client_shares με πλήθη", x.status === 409 && x.data.error === "cross_client_shares" && x.data.owned === 1 && x.data.incoming === 1, x.data);
    check("... τίποτα δεν άλλαξε (ίδιο όνομα, ίδιος πελάτης)", (await deptName(appleTech.id)) === "Apple · Technical");
    await put(dT, { title: "Apple τεχνικό", departmentId: appleTech.id, text: "Οδηγίες επανεκκίνησης συσκευής Apple. APLT-MARK", audienceProjectIds: [] });
    x = await put2(appleTech.id, { clientId: efood.id });
    check("project: ΜΟΝΟ τα εισερχόμενα κοινά (άλλο project του Apple το μοιράζεται προς αυτό): πάλι 409", x.status === 409 && x.data.owned === 0 && x.data.incoming === 1, x.data);
    await put(dA, { title: "Apple πολιτική", departmentId: appleCC.id, text: "Η πολιτική επιστροφών της Apple διαρκεί δεκατέσσερις ημέρες. APL-MARK", audienceProjectIds: [] });
    check("project: όνομα που υπάρχει ήδη στον προορισμό: 409 name_taken", (await put2(appleTech.id, { clientId: efood.id, shortName: "Customer Care" })).data.error === "name_taken");
    check("project: άγνωστος πελάτης: 404 client_not_found", (await put2(appleTech.id, { clientId: "c-zzzzzzzz" })).data.error === "client_not_found");
    check("project: άκυρο clientId: 400 invalid_client", (await put2(appleTech.id, { clientId: 5 })).data.error === "invalid_client" && (await put2(appleTech.id, {})).data.error === "invalid_client");
    check("project: άκυρο σκέτο όνομα (με «·»): 400 invalid_name", (await put2(appleTech.id, { clientId: efood.id, shortName: "A · B" })).data.error === "invalid_name");
    check("project: ίδιος πελάτης (χωρίς αλλαγή): 200", (await put2(appleTech.id, { clientId: apple.id })).status === 200);
    x = await put2(appleTech.id, { clientId: efood.id });
    check("project: χωρίς κοινά έγγραφα η μεταφορά περνά: 200, νέο όνομα «eFood · Technical»", x.status === 200 && x.data.name === "eFood · Technical");
    check("... στο ιστορικό καταγράφεται η αλλαγή πελάτη", db.prepare("select count(*) c from team_audit_log where action = 'project_client_changed' and target = ?").get(appleTech.id).c >= 1);
    const wallsAfter = await J(call(aEd, "GET", "/team/me"));
    check("... ο editor που ανήκε σε Apple CC και στο μεταφερμένο project πλέον ανήκει σε ΔΥΟ τοίχους (Apple, eFood)", wallsOf(wallsAfter) === "Apple,eFood", wallsAfter.data.walls);
    await put2(appleTech.id, { clientId: apple.id });
    check("project: επαναφορά στον Apple", (await deptName(appleTech.id)) === "Apple · Technical");
  }

  // ---------------------------------------------------------------- 30.7 μετονομασίες
  {
    const ren = (id, name) => adm("PATCH", `/team/admin/clients/${id}`, { name });
    let x = await ren(apple.id, "Apple Inc");
    check("πελάτης: μετονομασία: τα ονόματα των τμημάτων του ακολουθούν («Apple Inc · …»)", x.status === 200 && (await deptName(appleCC.id)) === "Apple Inc · Customer Care" && (await deptName(appleTech.id)) === "Apple Inc · Technical");
    check("... τα τμήματα άλλων πελατών δεν αλλάζουν", (await deptName(efoodCC.id)) === "eFood · Customer Care");
    check("πελάτης: μετονομασία σε υπάρχον όνομα (και με άλλα κεφαλαία): 409 name_taken", (await ren(apple.id, "EFOOD")).data.error === "name_taken");
    check("πελάτης: άκυρο όνομα: 400, άγνωστος: 404", (await ren(apple.id, "A · B")).status === 400 && (await ren("c-zzzzzzzz", "X")).status === 404);
    await ren(apple.id, "Apple");
    // σύγκρουση με όνομα άλλου project: το όνομα «Zeta · Ops» υπάρχει ήδη ως εσωτερικό project
    const zOps = (await adm("POST", "/team/admin/departments", { name: "Zeta · Ops" })).data;
    const q = (await adm("POST", "/team/admin/clients", { name: "Qwerty" })).data;
    const qOps = (await adm("POST", "/team/admin/departments", { name: "Ops", clientId: q.id })).data;
    x = await ren(q.id, "Zeta");
    check("πελάτης: μετονομασία που θα έκανε ΔΥΟ projects να έχουν το ίδιο όνομα: 409 name_taken και τίποτα δεν αλλάζει", x.data.error === "name_taken" && (await deptName(qOps.id)) === "Qwerty · Ops" && !!zOps.id);
    // μετονομασία τμήματος μέσα σε πελάτη
    const rn = (id, name) => adm("PATCH", `/team/admin/departments/${id}`, { name });
    x = await rn(appleCC.id, "Support");
    check("τμήμα πελάτη: μετονομασία αλλάζει το σκέτο όνομα και ξαναφτιάχνει το πλήρες («Apple · Support»)", x.status === 200 && (await deptName(appleCC.id)) === "Apple · Support" && db.prepare("select short_name s from team_project_clients where project_id = ?").get(appleCC.id).s === "Support");
    check("τμήμα πελάτη: όνομα με «·»: 400, όνομα που υπάρχει στον ίδιο πελάτη: 409", (await rn(appleCC.id, "A · B")).status === 400 && (await rn(appleCC.id, "Technical")).data.error === "name_taken");
    await rn(appleCC.id, "Customer Care");
    check("εσωτερικό project: η μετονομασία δουλεύει όπως πριν", (await rn(training.id, "BPO Academy")).status === 200 && (await deptName(training.id)) === "BPO Academy");
    await rn(training.id, "BPO Training");
    // διαγραφή πελάτη
    check("πελάτης: διαγραφή με projects: 409 client_has_projects", (await adm("DELETE", `/team/admin/clients/${q.id}`)).data.error === "client_has_projects");
    await adm("PUT", `/team/admin/departments/${qOps.id}/client`, { clientId: null });
    check("πελάτης: άδειος πελάτης διαγράφεται (200) και φεύγει από την επισκόπηση", (await adm("DELETE", `/team/admin/clients/${q.id}`)).status === 200 && !(await overview()).clients.some((c) => c.id === q.id));
    check("πελάτης: άγνωστος: 404", (await adm("DELETE", "/team/admin/clients/c-zzzzzzzz")).status === 404);
    check("προφίλ: πίσω σε «company» ενώ υπάρχουν πελάτες: 409 has_clients (δεν χάνονται σιωπηλά οι τοίχοι)", (await adm("PATCH", "/team/admin/workspace", { profile: "company" })).data.error === "has_clients");
  }

  // ---------------------------------------------------------------- 30.8 /team/me και ο βοηθός ανά πελάτη
  {
    const me = await J(call(bothAgent, "GET", "/team/me"));
    check("/team/me: προφίλ και οι δύο τοίχοι του πράκτορα που δουλεύει για Apple και eFood", me.data.profile === "multi_client" && wallsOf(me) === "Apple,eFood" && me.data.departments.every((d) => d.clientId), me.data);
    const one = await J(call(aAgent, "GET", "/team/me"));
    check("/team/me: πράκτορας ενός πελάτη: ένας τοίχος", wallsOf(one) === "Apple");
    const demo = await J(call("admin@demo.gr", "GET", "/team/me"));
    check("/team/me: χώρος «company»: προφίλ company, καθόλου τοίχοι", demo.data.profile === "company" && demo.data.walls.length === 0);

    const before = usage(bothAgent);
    let r = await ask(bothAgent, { question: Q });
    check("βοηθός: πράκτορας σε ΔΥΟ πελάτες χωρίς επιλογή: 400 client_required με τη λίστα (Apple, eFood)", r.status === 400 && r.data.error === "client_required" && r.data.clients.map((c) => c.name).join() === "Apple,eFood", r.data);
    check("... ΔΕΝ καταναλώνεται ερώτηση του ημερήσιου ορίου", usage(bothAgent) === before);
    // Ένα δεύτερο τμήμα του eFood και ένα κοινό έγγραφο προς αυτό: δημιουργεί ΟΜΑΔΑ ακροατηρίου που περιέχει το eFood CC του πράκτορα.
    const efoodTech = (await adm("POST", "/team/admin/departments", { name: "Technical", clientId: efood.id })).data;
    await put(dF, { title: "eFood πολιτική", departmentId: efoodCC.id, text: "Η πολιτική επιστροφών της eFood διαρκεί επτά ημέρες. EFD-MARK", audienceProjectIds: [efoodTech.id] });
    const efoodGroup = db.prepare("select group_id g from team_document_audience where document_id = ?").get(dF).g;
    const c0 = env.VECTORIZE.calls.length;
    r = await ask(bothAgent, { question: Q, clientId: apple.id });
    check("βοηθός: επιλογή Apple: βλέπει ΜΟΝΟ έγγραφα της Apple", r.status === 200 && r.prompt.includes("APL-MARK") && !r.prompt.includes("EFD-MARK"), r.prompt.slice(0, 200));
    // ΣΤΡΩΜΑ 1: το φίλτρο προς το Vectorize. Δεν περιέχει projects ούτε ομάδες ακροατηρίου του άλλου πελάτη.
    const idsAsked = new Set(env.VECTORIZE.calls.slice(c0).flatMap((c) => (c.filter && c.filter.department_id ? c.filter.department_id.$in : [])));
    check("στρώμα φίλτρου: το ερώτημα προς το Vectorize περιέχει το Apple CC και ΚΑΝΕΝΑ project ή ομάδα του eFood", idsAsked.has(appleCC.id) && !idsAsked.has(efoodCC.id) && !idsAsked.has(efoodTech.id) && !idsAsked.has(efoodGroup), [...idsAsked]);
    // ΣΤΡΩΜΑ 2: ο έλεγχος στη βάση, ανεξάρτητα από το φίλτρο (το Vectorize "ξεχνά" να φιλτράρει)
    env.VECTORIZE.ignoreFilter = true;
    r = await ask(bothAgent, { question: Q, clientId: apple.id });
    check("στρώμα βάσης: ακόμα κι αν το Vectorize ΔΕΝ φιλτράρει, ο έλεγχος στη βάση κόβει τον άλλον πελάτη", r.status === 200 && r.prompt.includes("APL-MARK") && !r.prompt.includes("EFD-MARK"), r.prompt.slice(0, 200));
    r = await ask(bothAgent, { question: Q, clientId: efood.id });
    check("στρώμα βάσης: και αντίστροφα (επιλογή eFood, χωρίς φίλτρο Vectorize): μόνο eFood", r.status === 200 && r.prompt.includes("EFD-MARK") && !r.prompt.includes("APL-MARK"));
    env.VECTORIZE.ignoreFilter = false;
    await put(dF, { title: "eFood πολιτική", departmentId: efoodCC.id, text: "Η πολιτική επιστροφών της eFood διαρκεί επτά ημέρες. EFD-MARK", audienceProjectIds: [] });
    r = await ask(bothAgent, { question: Q, clientId: efood.id });
    check("βοηθός: επιλογή eFood: βλέπει ΜΟΝΟ έγγραφα της eFood", r.status === 200 && r.prompt.includes("EFD-MARK") && !r.prompt.includes("APL-MARK"), r.prompt.slice(0, 200));
    r = await ask(bothAgent, { question: "Πόσο διαρκεί το διάλειμμα των πρακτόρων;", clientId: apple.id });
    check("βοηθός: τα έγγραφα «όλης της εταιρείας» (εσωτερικά του BPO) φαίνονται σε κάθε επιλογή", r.status === 200 && r.prompt.includes("ALL-MARK"));
    check("βοηθός: τοίχος που δεν ανήκει στο μέλος (εσωτερικά): 403 client_forbidden", (await ask(bothAgent, { question: Q, clientId: "internal" })).data.error === "client_forbidden");
    check("βοηθός: άγνωστο clientId: 403 client_forbidden", (await ask(bothAgent, { question: Q, clientId: "c-zzzzzzzz" })).data.error === "client_forbidden");
    check("βοηθός: πράκτορας ΕΝΟΣ πελάτη δεν χρειάζεται επιλογή", (await ask(aAgent, { question: Q })).status === 200);
    check("βοηθός: ... και δεν παίρνει τον άλλον πελάτη ούτε ζητώντας τον ρητά (403)", (await ask(aAgent, { question: Q, clientId: efood.id })).data.error === "client_forbidden");
    r = await ask(aMulti, { question: Q });
    check("βοηθός: πράκτορας σε ΔΥΟ τμήματα του ΙΔΙΟΥ πελάτη: χωρίς επιλογή, μόνο Apple", r.status === 200 && r.prompt.includes("APL-MARK") && !r.prompt.includes("EFD-MARK"));
    r = await ask(BPO, { question: Q });
    check("βοηθός: ο admin χωρίς επιλογή ψάχνει παντού (όπως πάντα)", r.status === 200 && r.prompt.includes("APL-MARK") && r.prompt.includes("EFD-MARK"));
    r = await ask(BPO, { question: Q, clientId: efood.id });
    check("βοηθός: ο admin μπορεί να περιοριστεί σε έναν πελάτη", r.status === 200 && r.prompt.includes("EFD-MARK") && !r.prompt.includes("APL-MARK"));
    const demoAsk = await ask("admin@demo.gr", { question: "οδηγίες", clientId: "c-zzzzzzzz" });
    check("βοηθός: στον χώρο «company» το clientId αγνοείται (καμία αλλαγή συμπεριφοράς)", demoAsk.status === 200);
  }

  // ---------------------------------------------------------------- λίστα εγγράφων ανά πελάτη
  {
    const all = (await J(call(bothAgent, "GET", "/team/documents"))).data.documents.map((d) => d.id);
    check("λίστα: χωρίς επιλογή δείχνει έγγραφα και των δύο πελατών", all.includes(dA) && all.includes(dF));
    const forApple = await J(call(bothAgent, "GET", `/team/documents?clientId=${apple.id}`));
    const ids = forApple.data.documents.map((d) => d.id);
    check("λίστα: με clientId=Apple μόνο έγγραφα της Apple και τα εταιρικά (εσωτερικά BPO)", ids.includes(dA) && !ids.includes(dF) && ids.includes(dAll), ids);
    check("λίστα: κάθε έγγραφο φέρει το clientId του", forApple.data.documents.find((d) => d.id === dA).clientId === apple.id && forApple.data.documents.find((d) => d.id === dAll).clientId === null);
    check("λίστα: ξένος τοίχος: 403 client_forbidden", (await J(call(aAgent, "GET", `/team/documents?clientId=${efood.id}`))).status === 403);
    check("λίστα: ο χώρος «company» αγνοεί το clientId", (await J(call("admin@demo.gr", "GET", "/team/documents?clientId=zzz"))).status === 200);
    check("ανάγνωση εγγράφου άλλου πελάτη (χωρίς κανένα ακροατήριο): 404", (await J(call(aAgent, "GET", `/team/documents/${dF}`))).status === 404 && (await J(call(fAgent, "GET", `/team/documents/${dA}`))).status === 404);
    check("ο πράκτορας των εσωτερικών δεν βλέπει έγγραφα πελατών", (await J(call(tAgent, "GET", `/team/documents/${dA}`))).status === 404 && (await J(call(aAgent, "GET", `/team/documents/${dI}`))).status === 404);
  }

  // ---------------------------------------------------------------- 30.8β παλιό ακροατήριο άλλου τοίχου (από πριν υπάρξουν πελάτες)
  {
    db.prepare("insert into team_audience_groups (id, workspace_id, created_at) values ('ag-00000000000000c4', 'team-bpo', ?)").run(nowIso());
    for (const pid of [appleCC.id, efoodCC.id]) db.prepare("insert into team_audience_group_projects (group_id, project_id) values ('ag-00000000000000c4', ?)").run(pid);
    db.prepare("insert into team_document_audience (workspace_id, document_id, group_id) values ('team-bpo', ?, 'ag-00000000000000c4')").run(dA);
    const x = await J(call(aEd, "PUT", `/team/documents/${dA}`, { title: "Apple πολιτική", departmentId: appleCC.id, text: "Η πολιτική επιστροφών της Apple διαρκεί δεκατέσσερις ημέρες. APL-MARK", audienceProjectIds: [appleTech.id] }));
    const g = db.prepare("select group_id g from team_document_audience where document_id = ?").get(dA);
    const members = db.prepare("select project_id p from team_audience_group_projects where group_id = ? order by project_id").all(g.g).map((r) => r.p);
    check("παλιό ακροατήριο άλλου πελάτη που ο editor δεν βλέπει: στην αποθήκευση ΔΕΝ διατηρείται (μένουν μόνο τμήματα του ίδιου πελάτη)", x.status === 200 && JSON.stringify(members) === JSON.stringify([appleCC.id, appleTech.id].sort()), members);
    await put(dA, { title: "Apple πολιτική", departmentId: appleCC.id, text: "Η πολιτική επιστροφών της Apple διαρκεί δεκατέσσερις ημέρες. APL-MARK", audienceProjectIds: [] });
  }

  // ---------------------------------------------------------------- 30.9 αντιφάσεις: ποτέ ανάμεσα σε πελάτες
  {
    state.judge = [{ x: "δεκατέσσερις ημέρες", y: "επτά ημέρες", topic: "Προθεσμία επιστροφών τοίχου" }];
    const dF2 = await mkdoc("eFood νέα πολιτική", efoodCC.id, "Επιστροφές πολιτική eFood: επτά ημέρες. NEWF-MARK");
    const crossRows = (id) => db.prepare("select count(*) c from team_contradictions where (doc_a = ? or doc_b = ?) and topic = 'Προθεσμία επιστροφών τοίχου'").get(id, id).c;
    check("αντιφάσεις: ΜΕΤΑ από έγγραφο eFood που συγκρούεται με έγγραφο Apple: καμία αντίφαση (δεν συγκρίνονται)", crossRows(dF2) === 0);
    const dA2 = await mkdoc("Apple νέα πολιτική", appleTech.id, "Επιστροφές πολιτική Apple: επτά ημέρες. NEWA-MARK");
    check("αντιφάσεις: (έλεγχος του ελέγχου) μέσα στον ΙΔΙΟ πελάτη η σύγκρουση ανιχνεύεται", crossRows(dA2) >= 1, crossRows(dA2));
    const rows = db.prepare("select doc_a, doc_b from team_contradictions where topic = 'Προθεσμία επιστροφών τοίχου'").all();
    const wallOfDoc = (id) => db.prepare("select pc.client_id c from team_documents d left join team_project_clients pc on pc.project_id = d.department_id where d.id = ?").get(id).c;
    check("αντιφάσεις: όλες οι αντιφάσεις του θέματος είναι μέσα στον ίδιο πελάτη", rows.length >= 1 && rows.every((r) => wallOfDoc(r.doc_a) === wallOfDoc(r.doc_b)), rows);
    state.judge = undefined;
  }

  // ---------------------------------------------------------------- 30.10 χωρίς το migration 0016: δουλεύει ως «company»
  {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const t of ["team_project_clients", "team_clients", "team_workspace_settings"]) db.exec(`DROP TABLE ${t}`);
    db.exec("PRAGMA foreign_keys = ON");
    const o = await overview();
    check("χωρίς πίνακες πελατών: η επισκόπηση δουλεύει ως «company» (clientsAvailable: false, κανένας πελάτης)", o.profile === "company" && o.clientsAvailable === false && o.clients.length === 0 && o.departments.length >= 4);
    check("... τα τμήματα φορτώνουν χωρίς πελάτη (clientId null)", o.departments.every((d) => d.clientId === null));
    check("... ο κανόνας ανάγνωσης δουλεύει όπως πριν: ο πράκτορας διαβάζει το δικό του έγγραφο", (await J(call(aAgent, "GET", `/team/documents/${dA}`))).status === 200);
    const r = await ask(aAgent, { question: Q });
    check("... ο βοηθός δουλεύει (χωρίς τοίχους, μόνο ιδιοκτήτης και ακροατήρια)", r.status === 200 && r.prompt.includes("APL-MARK"));
    check("... /team/me δουλεύει (προφίλ company)", (await J(call(aAgent, "GET", "/team/me"))).data.profile === "company");
    check("... η δημιουργία πελάτη: 503 clients_unavailable", (await adm("POST", "/team/admin/clients", { name: "Late" })).data.error === "clients_unavailable");
    check("... η αλλαγή προφίλ: 503 clients_unavailable", (await adm("PATCH", "/team/admin/workspace", { profile: "multi_client" })).data.error === "clients_unavailable");
    check("... η μεταφορά project: 503 clients_unavailable", (await adm("PUT", `/team/admin/departments/${appleTech.id}/client`, { clientId: null })).data.error === "clients_unavailable");
    check("... ένα νέο project χωρίς πελάτη δημιουργείται κανονικά", (await adm("POST", "/team/admin/departments", { name: "Χωρίς πίνακες" })).status === 201);
    db.exec(readFileSync(join(REPO, "migrations", "0016_team_clients.sql"), "utf8"));
    check("μετά το migration 0016: οι πελάτες ξαναδουλεύουν (κενοί: τα δεδομένα των πινάκων χάθηκαν στη δοκιμή)", (await adm("PATCH", "/team/admin/workspace", { profile: "multi_client" })).status === 200 && (await adm("POST", "/team/admin/clients", { name: "Νέος" })).status === 201);
  }
}

// ============================================================================ 31. Οθόνες call center: πελάτες, τοίχοι, επιλογή πελάτη (jsdom)
section("31. Οθόνες call center: τύπος χώρου, πελάτες και τμήματα, μεταφορά, επιλογή πελάτη στον βοηθό, ακροατήριο μέσα στον πελάτη");
{ // ένα μπλοκ: δικός του οργανισμός (team-ui31), ανεξάρτητος από τους υπόλοιπους
  const setU = (dom, el, v) => { el.value = v; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  const submitU = (dom, sel) => $u(dom, sel).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  const nowIso = () => new Date().toISOString();
  db.prepare("insert into team_workspaces (id,name,status,created_at) values ('team-ui31','Call Center UI','pilot',?)").run(nowIso());
  const ADM = "ui31_admin@demo.gr";
  db.prepare("insert into team_members (workspace_id,email,role,status,created_at) values ('team-ui31',?,'admin','active',?)").run(ADM, nowIso());
  S[ADM] = (await login(ADM)).cookie;
  const api = async (method, path, body) => { const res = await call(ADM, method, path, body); return { status: res.status, data: await readJson(res) }; };
  const ov = async () => (await api("GET", "/team/admin/overview")).data;
  const person = async (email, projectRoles) => { await api("POST", "/team/admin/members", { email, role: "member", projectRoles, sendInvite: false }); S[email] = (await login(email)).cookie; };

  // ------------------------------------------------------------ admin: από «Εταιρεία» σε «Call center»
  const ad = uiFor(ADM)("team-admin.html");
  await uiWait(() => $u(ad, "#profile-card"));
  check("χώρος «Εταιρεία»: φαίνεται η κάρτα «Τύπος χώρου» με το κουμπί αλλαγής", /Εταιρεία/.test($u(ad, "#profile-card").textContent) && /Αλλαγή σε/.test($u(ad, "#profile-switch").textContent));
  check("χώρος «Εταιρεία»: δεν υπάρχει φόρμα πελάτη ούτε επιλογέας πελάτη", !$u(ad, "#add-client") && !$u(ad, "select.move-client"));
  clickU(ad, $u(ad, "#profile-switch"));
  const conf = await uiWait(() => $u(ad, ".confirm"));
  check("αλλαγή τύπου: ζητά επιβεβαίωση που εξηγεί τον τοίχο και δεν αλλάζει τίποτα ακόμα", !!conf && /τοίχος/.test(conf.textContent) && (await ov()).profile === "company");
  clickU(ad, $u(ad, ".confirm-no"));
  check("«Όχι»: μένει «Εταιρεία»", (await ov()).profile === "company" && !$u(ad, ".confirm"));
  clickU(ad, $u(ad, "#profile-switch"));
  await uiWait(() => $u(ad, ".confirm-yes"));
  clickU(ad, $u(ad, ".confirm-yes"));
  check("«Ναι»: ο χώρος γίνεται call center και εμφανίζεται η φόρμα νέου πελάτη", !!(await uiWait(() => $u(ad, "#add-client"))) && (await ov()).profile === "multi_client");

  // ------------------------------------------------------------ πελάτες και τμήματα από την οθόνη
  setU(ad, $u(ad, "#new-client"), "Apple UI");
  submitU(ad, "#add-client");
  await uiWait(() => $$u(ad, ".client-row .name").some((e) => e.textContent === "Apple UI"));
  setU(ad, $u(ad, "#new-client"), "eFood UI");
  submitU(ad, "#add-client");
  await uiWait(() => $$u(ad, ".client-row .name").some((e) => e.textContent === "eFood UI"));
  const clients = (await ov()).clients;
  const cA = clients.find((c) => c.name === "Apple UI"), cF = clients.find((c) => c.name === "eFood UI");
  check("πελάτες: δημιουργούνται από την οθόνη και φαίνονται ως ομάδες με ετικέτα «πελάτης»", !!cA && !!cF && $$u(ad, ".client-group").length === 2 && /πελάτης/.test($u(ad, ".client-row").textContent));
  for (const [cid, name] of [[cA.id, "Customer Care"], [cA.id, "Technical"], [cF.id, "Customer Care"]]) {
    setU(ad, $u(ad, `#add-dept-${cid} input`), name);
    submitU(ad, `#add-dept-${cid}`);
    await uiWait(() => $$u(ad, `.client-group[data-client="${cid}"] .dept-row .name`).some((e) => e.textContent === name));
  }
  const names = (await ov()).departments.map((d) => d.name).sort();
  check("τμήματα μέσα σε πελάτη: το όνομα γράφεται «πελάτης · τμήμα» και το ίδιο όνομα τμήματος χωράει σε δύο πελάτες", JSON.stringify(names) === JSON.stringify(["Apple UI · Customer Care", "Apple UI · Technical", "eFood UI · Customer Care"]), names);
  check("τμήματα: κάτω από κάθε πελάτη φαίνεται το σκέτο όνομα και υπάρχει επιλογέας πελάτη με τον τρέχοντα", $$u(ad, `.client-group[data-client="${cA.id}"] select.move-client`).length === 2 && $u(ad, `.client-group[data-client="${cA.id}"] select.move-client`).value === cA.id);
  setU(ad, $u(ad, "#new-dept"), "UI Internal");
  submitU(ad, "#add-dept");
  await uiWait(() => $$u(ad, ".internal-group .dept-row .name").some((e) => e.textContent === "UI Internal"));
  check("εσωτερικό τμήμα (χωρίς πελάτη): δημιουργείται στην ενότητα «Εσωτερικά»", (await ov()).departments.some((d) => d.name === "UI Internal" && d.clientId === null));
  setU(ad, $u(ad, `#add-dept-${cA.id} input`), "Customer Care");
  submitU(ad, `#add-dept-${cA.id}`);
  check("τμήμα με όνομα που υπάρχει ήδη στον ίδιο πελάτη: φαίνεται σφάλμα και δεν δημιουργείται", !!(await uiWait(() => $u(ad, ".note.err") && /Υπάρχει ήδη/.test($u(ad, ".note.err").textContent))) && (await ov()).departments.filter((d) => d.name === "Apple UI · Customer Care").length === 1);

  // ------------------------------------------------------------ μεταφορά project ανάμεσα σε τοίχους
  const deptId = async (name) => (await ov()).departments.find((d) => d.name === name).id;
  const dInt = await deptId("UI Internal");
  const moveSel = () => $$u(ad, ".dept-row").find((r) => r.querySelector(".name") && /UI Internal/.test(r.querySelector(".name").textContent)).querySelector("select.move-client");
  setU(ad, moveSel(), cA.id);
  const mc = await uiWait(() => $u(ad, ".confirm"));
  check("μεταφορά σε πελάτη: ζητά επιβεβαίωση με το νέο όνομα και δεν αλλάζει τίποτα ακόμα", !!mc && /Apple UI/.test(mc.textContent) && /UI Internal/.test(mc.textContent) && (await ov()).departments.find((d) => d.id === dInt).clientId === null);
  clickU(ad, $u(ad, ".confirm-no"));
  check("«Όχι» στη μεταφορά: ο επιλογέας επανέρχεται στο «Εσωτερικό»", moveSel().value === "" && (await ov()).departments.find((d) => d.id === dInt).clientId === null);
  setU(ad, moveSel(), cA.id);
  await uiWait(() => $u(ad, ".confirm-yes"));
  clickU(ad, $u(ad, ".confirm-yes"));
  check("«Ναι»: το project μεταφέρεται στον πελάτη και το όνομά του γίνεται «Apple UI · UI Internal»", !!(await uiWait(() => (db.prepare("select name from departments where id = ?").get(dInt) || {}).name === "Apple UI · UI Internal")));
  // κοινά έγγραφα μέσα στον πελάτη → η μεταφορά σε άλλον πελάτη απορρίπτεται με ξεκάθαρο μήνυμα
  const dCC = await deptId("Apple UI · Customer Care"), dTech = await deptId("Apple UI · Technical"), dFood = await deptId("eFood UI · Customer Care");
  const mkd = async (title, departmentId, text, extra = {}) => (await api("POST", "/team/documents", { title, departmentId, text, ...extra })).data.id;
  const shared = await mkd("UI κοινό Apple", dTech, "Οδηγίες επανεκκίνησης συσκευής Apple. UIAPL-MARK", { audienceProjectIds: [dCC] });
  await mkd("UI Apple πολιτική", dCC, "Η πολιτική επιστροφών της Apple διαρκεί δεκατέσσερις ημέρες. UIAPLP-MARK");
  await mkd("UI eFood πολιτική", dFood, "Η πολιτική επιστροφών της eFood διαρκεί επτά ημέρες. UIEFD-MARK");
  await mkd("UI εσωτερικοί κανόνες", "_all", "Το διάλειμμα των πρακτόρων διαρκεί δέκα λεπτά. UIALL-MARK");
  clickU(ad, $u(ad, "#tab-departments"));
  await uiWait(() => $$u(ad, ".dept-row").length >= 4);
  const techSel = () => $$u(ad, ".dept-row").find((r) => r.querySelector(".name") && r.querySelector(".name").textContent === "Technical" && r.closest(".client-group").getAttribute("data-client") === cA.id).querySelector("select.move-client");
  setU(ad, techSel(), cF.id);
  await uiWait(() => $u(ad, ".confirm-yes"));
  clickU(ad, $u(ad, ".confirm-yes"));
  const errToast = await uiWait(() => $u(ad, ".toast.err"));
  check("μεταφορά με κοινά έγγραφα: μήνυμα σφάλματος που λέει πόσα και τι να κάνει ο admin", !!errToast && /Δεν μεταφέρεται/.test(errToast.textContent) && /1 έγγραφο/.test(errToast.textContent) && /Αφαίρεσε πρώτα/.test(errToast.textContent), errToast && errToast.textContent);
  check("... και το project μένει στον Apple UI", (await ov()).departments.find((d) => d.id === dTech).clientId === cA.id);
  // διαγραφή άδειου πελάτη και προστασία του μη άδειου
  setU(ad, $u(ad, "#new-client"), "Κενός UI");
  submitU(ad, "#add-client");
  await uiWait(() => $$u(ad, ".client-row .name").some((e) => e.textContent === "Κενός UI"));
  const delFor = (name) => $$u(ad, ".client-row").find((r) => r.querySelector(".name").textContent === name).querySelector(".delete-client");
  check("διαγραφή πελάτη: το κουμπί είναι ανενεργό όταν ο πελάτης έχει τμήματα, ενεργό όταν είναι άδειος", delFor("Apple UI").disabled === true && delFor("Κενός UI").disabled === false);
  clickU(ad, delFor("Κενός UI"));
  await uiWait(() => $u(ad, ".confirm-yes"));
  clickU(ad, $u(ad, ".confirm-yes"));
  check("διαγραφή άδειου πελάτη: ζητά επιβεβαίωση και μετά φεύγει", !!(await uiWait(() => !(db.prepare("select 1 from team_clients where name = 'Κενός UI'").get()))));
  check("επιστροφή σε «Εταιρεία» όσο υπάρχουν πελάτες: το κουμπί είναι ανενεργό", $u(ad, "#profile-switch").disabled === true);

  // ------------------------------------------------------------ editor: το ακροατήριο προσφέρει μόνο τμήματα του ίδιου πελάτη
  await person("ui31_ed@demo.gr", { [dCC]: "editor", [dTech]: "member", [dFood]: "member" });
  const ed = uiFor("ui31_ed@demo.gr")("team-editor.html");
  clickU(ed, await uiWait(() => $u(ed, "#tab-docs")));
  await uiWait(() => $$u(ed, ".item").length > 2);
  clickU(ed, $$u(ed, ".item").find((i) => /UI Apple πολιτική/.test(i.textContent)));
  await uiWait(() => $u(ed, "#audience"));
  check("editor: το ακροατήριο προσφέρει ΜΟΝΟ το τμήμα του ίδιου πελάτη (όχι το eFood, παρότι ο editor είναι μέλος εκεί)", $$u(ed, "#audience input[type=checkbox]").map((c) => c.getAttribute("data-project")).join() === dTech, $$u(ed, "#audience input[type=checkbox]").map((c) => c.getAttribute("data-project")));
  check("editor: η λίστα εγγράφων δείχνει το όνομα με τον πελάτη («Apple UI · …»)", $$u(ed, ".item .m").some((m) => /Apple UI · Customer Care/.test(m.textContent)));

  // ------------------------------------------------------------ portal: πράκτορας σε δύο πελάτες
  await person("ui31_both@demo.gr", { [dCC]: "member", [dFood]: "member" });
  await person("ui31_one@demo.gr", { [dCC]: "member" });
  const pt = uiFor("ui31_both@demo.gr")("portal.html");
  await uiWait(() => $u(pt, "#wallrow"));
  check("portal: πράκτορας σε δύο πελάτες: φαίνεται η επιλογή πελάτη με τους δύο πελάτες", $$u(pt, "#wall option").map((o) => o.textContent).join() === ["Διάλεξε πελάτη…", "Apple UI", "eFood UI"].join(), $$u(pt, "#wall option").map((o) => o.textContent));
  check("portal: χωρίς επιλογή το «Ρώτα» είναι ανενεργό και το πεδίο ζητά πελάτη", $u(pt, "form.searchrow button").disabled === true && /Διάλεξε πρώτα πελάτη/.test($u(pt, "#q").placeholder));
  check("portal: χωρίς επιλογή δεν φαίνεται κανένας τίτλος εγγράφου, μόνο υπόδειξη", $$u(pt, ".row").length === 0 && $$u(pt, ".wall-hint").length === 2);
  setU(pt, $u(pt, "#wall"), cA.id);
  await uiWait(() => $$u(pt, ".row").length > 0);
  check("portal: με επιλογή Apple: ενεργοποιείται το «Ρώτα» και η λίστα έχει μόνο έγγραφα Apple και τα εσωτερικά του call center", $u(pt, "form.searchrow button").disabled === false && $$u(pt, ".cols > div:nth-child(2) .row .title").map((e) => e.textContent).sort().join() === ["UI Apple πολιτική", "UI εσωτερικοί κανόνες", "UI κοινό Apple"].sort().join(), $$u(pt, ".cols > div:nth-child(2) .row .title").map((e) => e.textContent));
  setU(pt, $u(pt, "#q"), "Ποια είναι η πολιτική επιστροφών;");
  submitU(pt, "form.searchrow");
  await uiWait(() => $u(pt, ".answer .source"));
  check("portal: η απάντηση δείχνει τον πελάτη στην ετικέτα και η πηγή είναι έγγραφο της Apple", /πελάτης: Apple UI/.test($u(pt, ".answer .label").textContent) && /Apple UI/.test($u(pt, ".answer .source").textContent) && !/eFood/.test($u(pt, ".answer").textContent), $u(pt, ".answer").textContent);
  setU(pt, $u(pt, "#wall"), cF.id);
  await uiWait(() => $$u(pt, ".cols > div:nth-child(2) .row .title").some((e) => /eFood/.test(e.textContent)));
  check("portal: αλλαγή πελάτη: σβήνει η απάντηση του προηγούμενου και αλλάζει η λίστα", $u(pt, ".answer").style.display === "none" && !$$u(pt, ".cols > div:nth-child(2) .row .title").some((e) => /Apple/.test(e.textContent)));
  const one = uiFor("ui31_one@demo.gr")("portal.html");
  await uiWait(() => $u(one, "#q"));
  check("portal: πράκτορας ενός πελάτη: καμία επιλογή πελάτη και το «Ρώτα» είναι ενεργό", !$u(one, "#wallrow") && $u(one, "form.searchrow button").disabled === false);
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
