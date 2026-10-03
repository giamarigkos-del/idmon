// tests\onboarding-script.test.mjs
// Τεστ του lab\new-client.mjs (onboarding νέου πελάτη). Τρέχει: node tests\onboarding-script.test.mjs  (Node 22+, χωρίς δίκτυο, χωρίς Cloudflare).
// Δύο επίπεδα: (1) καθαρές συναρτήσεις και το παραγόμενο SQL πάνω στο ΠΡΑΓΜΑΤΙΚΟ schema.sql, (2) ολόκληρη η ροή με ψεύτικο wrangler
// (tests\helpers\fake-wrangler.mjs) πάνω σε πραγματική SQLite. ΔΕΝ δοκιμάζει το πραγματικό wrangler ή τη βάση του Cloudflare.
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

process.removeAllListeners("warning");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "lab", "new-client.mjs");
const FAKE = join(REPO, "tests", "helpers", "fake-wrangler.mjs");
const SCHEMA = join(REPO, "schema.sql");
const mod = await import(pathToFileURL(SCRIPT).href);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failures.push(name); console.log("  FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}
const section = (t) => console.log("\n" + t);

const good = { id: "team-acme", name: "Acme", admins: ["ceo@acme.example", "it@acme.example"] };
const errs = (o) => mod.validate({ admins: [], ...o }).errors;

// ============================================================ 1. έλεγχοι εισόδου
section("1. Έλεγχοι εισόδου (id, όνομα, emails, επιλογές)");
check("έγκυρη είσοδος: κανένα σφάλμα, προεπιλογές company και pilot", (() => { const r = mod.validate(good); return r.errors.length === 0 && r.value.profile === "company" && r.value.status === "pilot"; })());
check("id χωρίς πρόθεμα «team-»: σφάλμα που το εξηγεί", errs({ ...good, id: "acme" }).some((e) => /ΞΕΚΙΝΑ από "team-"/.test(e)));
check("id μόνο «team-»: σφάλμα", errs({ ...good, id: "team-" }).length > 0);
check("id με κεφαλαία: σφάλμα", errs({ ...good, id: "team-Acme" }).length > 0);
check("id με κενό ή ειδικό χαρακτήρα: σφάλμα", errs({ ...good, id: "team-ac me" }).length > 0 && errs({ ...good, id: "team-a/b" }).length > 0);
check("id με εισαγωγικό (προσπάθεια SQL injection): σφάλμα", errs({ ...good, id: "team-a'b" }).length > 0 && errs({ ...good, id: "team-x'; DROP TABLE team_members;--" }).length > 0);
check("id πολύ μεγάλο: σφάλμα", errs({ ...good, id: "team-" + "a".repeat(40) }).length > 0);
check("id με διπλή παύλα ή παύλα στο τέλος: σφάλμα", errs({ ...good, id: "team-a--b" }).length > 0 && errs({ ...good, id: "team-a-" }).length > 0);
check("id που ταιριάζει: team-acme-gr, team-bpo-demo", errs({ ...good, id: "team-acme-gr" }).length === 0 && errs({ ...good, id: "team-bpo-demo" }).length === 0);
check("όνομα κενό ή πολύ μεγάλο: σφάλμα", errs({ ...good, name: "  " }).length > 0 && errs({ ...good, name: "x".repeat(61) }).length > 0);
check("email λάθος μορφή: σφάλμα", errs({ ...good, admins: ["notanemail"] }).some((e) => /δεν είναι σωστό/.test(e)));
check("email διπλό (και με κεφαλαία): σφάλμα", errs({ ...good, admins: ["A@x.gr", "a@x.gr"] }).some((e) => /δύο φορές/.test(e)));
check("emails κανονικοποιούνται σε μικρά και χωρίς κενά", mod.validate({ ...good, admins: ["  CEO@Acme.Example ", "it@acme.example"] }).value.admins[0] === "ceo@acme.example");
check("κανένας admin: σφάλμα", errs({ ...good, admins: [] }).some((e) => /τουλάχιστον ένας admin/.test(e)));
{
  const one = mod.validate({ ...good, admins: ["ceo@acme.example"] });
  check("ένας admin: ΠΡΟΕΙΔΟΠΟΙΗΣΗ για δεύτερο, όχι σφάλμα", one.errors.length === 0 && one.warnings.some((w) => /ΔΥΟ/.test(w)));
  const four = mod.validate({ ...good, admins: ["a@x.gr", "b@x.gr", "c@x.gr", "d@x.gr"] });
  check("τέσσερις admins: προειδοποίηση «δύο έως τρεις», όχι σφάλμα", four.errors.length === 0 && four.warnings.some((w) => /δύο έως τρεις/.test(w)));
  check("δύο admins: καμία προειδοποίηση", mod.validate(good).warnings.length === 0);
}
check("άκυρο profile ή status: σφάλμα", errs({ ...good, profile: "x" }).length > 0 && errs({ ...good, status: "x" }).length > 0);
check("parseArgs: άγνωστη παράμετρος και λείπουσα τιμή γίνονται σφάλματα", (() => { const a = mod.parseArgs(["--foo"]); const b = mod.parseArgs(["--id"]); return a.errors.length === 1 && b.errors.length === 1; })());
check("parseArgs: πολλά --admin συγκεντρώνονται, --run είναι διακόπτης", (() => { const a = mod.parseArgs(["--id", "team-x", "--admin", "a@x.gr", "--admin", "b@x.gr", "--run"]); return a.admins.length === 2 && a.run === true && a.id === "team-x"; })());

// ============================================================ 2. SQL πάνω στο πραγματικό schema
section("2. Το SQL που παράγεται, πάνω στο πραγματικό schema.sql (με foreign keys)");
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA, "utf8"));
  return db;
}
const NOW = "2026-10-03T00:00:00.000Z";
{
  const v = mod.validate({ ...good, name: "O'Brien & Sons" }).value;
  const db = freshDb();
  db.exec(mod.buildInsertSql(v, NOW));
  const w = db.prepare("select * from team_workspaces where id = 'team-acme'").get();
  check("χώρος: γράφεται με id, κατάσταση pilot και όνομα με εισαγωγικό (O'Brien & Sons) ακέραιο", w && w.status === "pilot" && w.name === "O'Brien & Sons");
  const m = db.prepare("select email, role, status from team_members where workspace_id = 'team-acme' order by email").all();
  check("admins: δύο γραμμές, ρόλος admin, ενεργοί", m.length === 2 && m.every((r) => r.role === "admin" && r.status === "active") && m[0].email === "ceo@acme.example");
  check("προφίλ company: ΔΕΝ γράφεται γραμμή ρυθμίσεων (η απουσία σημαίνει company)", db.prepare("select count(*) c from team_workspace_settings").get().c === 0);
  const v2 = mod.validate({ ...good, id: "team-bpo-x", admins: ["ops@bpo.example"], profile: "multi_client", status: "pilot" }).value;
  db.exec(mod.buildInsertSql(v2, NOW));
  check("προφίλ multi_client: γράφεται γραμμή ρυθμίσεων", db.prepare("select profile from team_workspace_settings where workspace_id = 'team-bpo-x'").get().profile === "multi_client");
  let dup = null;
  try { db.exec(mod.buildInsertSql(mod.validate({ ...good, id: "team-other", admins: ["ceo@acme.example"] }).value, NOW)); } catch (e) { dup = e.message; }
  check("email που ανήκει ήδη σε άλλον οργανισμό: η βάση το αρνείται ΘΟΡΥΒΩΔΩΣ (UNIQUE)", /UNIQUE/i.test(String(dup)), dup);
  check("το SQL δεν περιέχει «OR IGNORE» (ένα διπλότυπο δεν πρέπει να χάνεται σιωπηλά)", !/OR\s+IGNORE/i.test(mod.buildInsertSql(v, NOW)));
  const pre = db.prepare(mod.buildPrecheckSql(mod.validate({ ...good, admins: ["ceo@acme.example", "new@x.gr"] }).value).trim().replace(/;$/, "")).all();
  check("έλεγχος πριν: βρίσκει τον υπάρχοντα χώρο και το υπάρχον email, όχι το καινούριο", pre.some((r) => r.kind === "workspace" && r.value === "team-acme") && pre.some((r) => r.kind === "member" && r.value === "ceo@acme.example") && !pre.some((r) => r.value === "new@x.gr"), pre);
  const ver = db.prepare(mod.buildVerifySql(v).trim().replace(/;$/, "")).all();
  check("επαλήθευση: γραμμή ανά admin με προφίλ company", ver.length === 2 && ver.every((r) => r.profile === "company"));
}

// ============================================================ 3. ολόκληρη η ροή με ψεύτικο wrangler
section("3. Ολόκληρη η ροή (ψεύτικο wrangler πάνω σε πραγματική SQLite)");
function env(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nc-test-"));
  const root = join(dir, "repo");
  mkdirSyncSafe(root);
  copyFileSync(join(REPO, "wrangler.lab.toml"), join(root, "wrangler.lab.toml"));
  const e = {
    ...process.env, IDMON_REPO_ROOT: root, IDMON_WRANGLER: `node "${FAKE}"`, IDMON_FAKE_DB: join(dir, "d1.sqlite"),
    IDMON_FAKE_SCHEMA: SCHEMA, IDMON_FAKE_LOG: join(dir, "calls.log"), ...extra,
  };
  return { dir, root, e };
}
function mkdirSyncSafe(p) { spawnSync(process.platform === "win32" ? "cmd" : "mkdir", process.platform === "win32" ? ["/c", "mkdir", p] : ["-p", p]); }
const run = (e, args) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: e, encoding: "utf8" }); return { code: r.status, out: `${r.stdout}\n${r.stderr}` }; };
const calls = (c) => (existsSync(c.e.IDMON_FAKE_LOG) ? readFileSync(c.e.IDMON_FAKE_LOG, "utf8").trim().split("\n").filter(Boolean) : []);
const dbq = (c, sql) => { const d = new DatabaseSync(c.e.IDMON_FAKE_DB); try { return d.prepare(sql).all(); } finally { d.close(); } };
const base = ["--id", "team-acme", "--name", "Acme", "--admin", "ceo@acme.example", "--admin", "it@acme.example"];
const cleanup = [];

{ // a. δοκιμή (χωρίς --run)
  const c = env(); cleanup.push(c.dir);
  const r = run(c.e, base);
  check("χωρίς --run: έξοδος 0, τυπώνει το SQL και ΔΕΝ καλεί καθόλου το wrangler", r.code === 0 && /ΔΟΚΙΜΗ/.test(r.out) && /INSERT INTO team_workspaces/.test(r.out) && calls(c).length === 0, { code: r.code, calls: calls(c) });
  check("χωρίς --run: δεν δημιουργήθηκε βάση", !existsSync(c.e.IDMON_FAKE_DB));
}
{ // b. εκτέλεση, και ξανά εκτέλεση
  const c = env(); cleanup.push(c.dir);
  const r = run(c.e, [...base, "--run"]);
  check("--run: έξοδος 0 και μήνυμα ΕΤΟΙΜΟ με τους admins", r.code === 0 && /ΕΤΟΙΜΟ/.test(r.out) && /ceo@acme\.example, it@acme\.example/.test(r.out), r.out.slice(-400));
  check("--run: ακριβώς τρεις κλήσεις (έλεγχος, εγγραφή, επαλήθευση) με τη σειρά", calls(c).join() === "SELECT,WRITE,SELECT", calls(c));
  check("--run: ο χώρος και οι δύο admins υπάρχουν στη βάση", dbq(c, "select count(*) c from team_members where workspace_id='team-acme' and role='admin' and status='active'")[0].c === 2 && dbq(c, "select count(*) c from team_workspaces where id='team-acme'")[0].c === 1);
  const before = calls(c).length;
  const r2 = run(c.e, [...base, "--run"]);
  check("δεύτερη εκτέλεση της ίδιας εντολής: έξοδος 2, «υπάρχουν ήδη», ΚΑΜΙΑ εγγραφή", r2.code === 2 && /Υπάρχουν ήδη/.test(r2.out) && calls(c).length === before + 1 && calls(c).slice(before).join() === "SELECT", { code: r2.code, extra: calls(c).slice(before) });
  check("... και δεν διπλογράφηκε τίποτα", dbq(c, "select count(*) c from team_members")[0].c === 2 && dbq(c, "select count(*) c from team_workspaces")[0].c === 1);
  // email άλλου οργανισμού
  const r3 = run(c.e, ["--id", "team-beta", "--name", "Beta", "--admin", "it@acme.example", "--admin", "new@beta.example", "--run"]);
  check("νέος χώρος με email που ανήκει σε άλλον οργανισμό: έξοδος 2 και ΔΕΝ δημιουργείται ούτε ο χώρος ούτε ο άλλος admin (καμία μερική εγγραφή)", r3.code === 2 && /it@acme\.example/.test(r3.out) && dbq(c, "select count(*) c from team_workspaces where id='team-beta'")[0].c === 0 && dbq(c, "select count(*) c from team_members where email='new@beta.example'")[0].c === 0, r3.out.slice(-300));
}
{ // c. multi_client και κεφαλαία emails
  const c = env(); cleanup.push(c.dir);
  const r = run(c.e, ["--id", "team-bpo-x", "--name", "BPO X", "--admin", "OPS@BPO.example", "--profile", "multi_client", "--status", "active", "--run"]);
  check("call center: δημιουργείται με profile multi_client, κατάσταση active και email σε μικρά", r.code === 0 && dbq(c, "select profile from team_workspace_settings where workspace_id='team-bpo-x'")[0].profile === "multi_client" && dbq(c, "select status from team_workspaces where id='team-bpo-x'")[0].status === "active" && dbq(c, "select email from team_members where workspace_id='team-bpo-x'")[0].email === "ops@bpo.example", r.out.slice(-300));
  check("ένας admin: τυπώνει προειδοποίηση για δεύτερο και υπενθύμιση στο τέλος", /ΔΥΟ/.test(r.out) && /ΔΕΥΤΕΡΟΣ admin/.test(r.out));
}
{ // d. άκυρα δεδομένα: δεν καλείται το wrangler
  const c = env(); cleanup.push(c.dir);
  const r = run(c.e, ["--id", "acme", "--name", "Acme", "--admin", "ceo@acme.example", "--run"]);
  check("id χωρίς πρόθεμα ακόμα και με --run: έξοδος 1, ΔΕΝ καλείται το wrangler", r.code === 1 && /ΞΕΚΙΝΑ/.test(r.out) && calls(c).length === 0 && !existsSync(c.e.IDMON_FAKE_DB));
}
{ // e. διαλείπον σφάλμα 10000
  const c = env(); cleanup.push(c.dir);
  const counter = join(c.dir, "auth.cnt"); writeFileSync(counter, "1");
  c.e.IDMON_FAKE_AUTH_FAIL = counter;
  const r = run(c.e, [...base, "--run"]);
  check("διαλείπον «Authentication error 10000»: ξαναδοκιμάζει μόνο του και ολοκληρώνεται", r.code === 0 && /ξαναδοκιμάζω/.test(r.out) && dbq(c, "select count(*) c from team_workspaces where id='team-acme'")[0].c === 1, r.out.slice(-300));
}
{ // f. fail closed όταν η απάντηση του ελέγχου δεν διαβάζεται
  const c = env({ IDMON_FAKE_MODE: "garbage" }); cleanup.push(c.dir);
  const r = run(c.e, [...base, "--run"]);
  check("απάντηση ελέγχου που δεν διαβάζεται: έξοδος 3 και ΔΕΝ γράφει τίποτα (fail closed)", r.code === 3 && calls(c).join() === "SELECT" && !/INSERT/.test(calls(c).join()), { code: r.code, calls: calls(c) });
}
{ // g. αποτυχία στην εγγραφή
  const c = env({ IDMON_FAKE_MODE: "insert_fail" }); cleanup.push(c.dir);
  const r = run(c.e, [...base, "--run"]);
  check("αποτυχία εγγραφής: έξοδος 3 με οδηγία να μη ξανατρέξει τυφλά", r.code === 3 && /Μην ξανατρέξεις τυφλά/.test(r.out));
}
{ // g2. η επαλήθευση δεν ταιριάζει
  const c = env({ IDMON_FAKE_MODE: "verify_drop_admin" }); cleanup.push(c.dir);
  const r = run(c.e, [...base, "--run"]);
  check("επαλήθευση που βρίσκει λιγότερους admins από όσους ζητήθηκαν: έξοδος 3 και προειδοποίηση (όχι «ΕΤΟΙΜΟ»)", r.code === 3 && /η επαλήθευση ΔΕΝ ταιριάζει/.test(r.out) && !/ΕΤΟΙΜΟ/.test(r.out), r.out.slice(-300));
}
{ // h. λάθος βάση στο toml
  const c = env(); cleanup.push(c.dir);
  writeFileSync(join(c.root, "wrangler.lab.toml"), 'name = "x"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "idmon-accounts"\ndatabase_id = "x"\n');
  const r = run(c.e, [...base, "--run"]);
  check("το wrangler.lab.toml δείχνει ΑΛΛΗ βάση: έξοδος 1 και ΔΕΝ καλείται το wrangler", r.code === 1 && /ΔΕΝ δείχνει στη βάση idmon-lab-accounts/.test(r.out) && calls(c).length === 0, r.out.slice(-300));
  const c2 = env(); cleanup.push(c2.dir); rmSync(join(c2.root, "wrangler.lab.toml"));
  const r2 = run(c2.e, [...base, "--run"]);
  check("λείπει το wrangler.lab.toml: έξοδος 1 με σαφές μήνυμα", r2.code === 1 && /Δεν βρέθηκε το wrangler\.lab\.toml/.test(r2.out) && calls(c2).length === 0);
}
{ // i. στατικοί έλεγχοι ασφαλείας
  const src = readFileSync(SCRIPT, "utf8");
  check("το script δεν αναφέρεται ποτέ στο production (wrangler.toml χωρίς .lab, βάση idmon-accounts)", !/wrangler\.toml/.test(src.replace(/wrangler\.lab\.toml/g, "")) && !/idmon-accounts/.test(src));
  check("το script δεν περιέχει μακριά παύλα (em dash)", !src.includes("\u2014"));
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log("\n" + "=".repeat(60));
if (failures.length) { console.log(`ΑΠΟΤΥΧΙΑ: ${failures.length} τεστ απέτυχαν, ${passed} πέρασαν.`); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log(`ΟΛΑ ΤΑ ΤΕΣΤ ΠΕΡΑΣΑΝ: ${passed}`);
