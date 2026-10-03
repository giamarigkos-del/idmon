// lab\new-client.mjs
// Onboarding νέου πελάτη στο LAB (idmon-lab): φτιάχνει τον χώρο και τους πρώτους admins με ΕΝΑ ασφαλές βήμα,
// αντί για χειροκίνητες εντολές στη βάση (ξεχασμένο πρόθεμα "team-", email που ήδη υπάρχει αλλού, λάθος βάση).
//
// Χρήση (από τον φάκελο του repo, PowerShell):
//   node lab\new-client.mjs --id team-acme --name "Acme" --admin ceo@acme.example --admin it@acme.example
//       (ΔΟΚΙΜΗ: τυπώνει τι θα γίνει, δεν αγγίζει τίποτα)
//   node lab\new-client.mjs --id team-acme --name "Acme" --admin ceo@acme.example --admin it@acme.example --run
//       (ΕΚΤΕΛΕΣΗ στη βάση του lab)
// Προαιρετικά: --profile company|multi_client (προεπιλογή company), --status pilot|active|paused (προεπιλογή pilot).
//
// Ασφάλεια: στοχεύει ΜΟΝΟ τη βάση idmon-lab-accounts με το wrangler.lab.toml. Αν το wrangler.lab.toml δεν δείχνει σε αυτή τη βάση,
// σταματά. Πριν γράψει ελέγχει ότι ο χώρος και τα emails δεν υπάρχουν ήδη (αλλιώς δεν γράφει ΤΙΠΟΤΑ). Δεν αγγίζει το production.
//
// Εξαγωγές (validate, buildInsertSql, ...) υπάρχουν για τα τεστ (tests\onboarding-script.test.mjs). Τα IDMON_WRANGLER και IDMON_REPO_ROOT
// είναι διακόπτες ΜΟΝΟ για τα τεστ (ψεύτικο wrangler, προσωρινός φάκελος): στη χρήση δεν τα ορίζεις.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = process.env.IDMON_REPO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAB_CONFIG = "wrangler.lab.toml";
const LAB_DB = "idmon-lab-accounts";
export const WORKSPACE_PREFIX = "team-";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // ίδιο με το src\team\auth.js
const ID_RE = /^team-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID = 40;
const MAX_NAME = 60;
const STATUSES = ["pilot", "active", "paused"];
const PROFILES = ["company", "multi_client"];

// ------------------------------------------------------------------ παράμετροι
export function parseArgs(argv) {
  const out = { admins: [], run: false, help: false, errors: [] };
  const withValue = new Set(["--id", "--name", "--admin", "--profile", "--status"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") out.run = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (withValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out.errors.push(`Λείπει τιμή μετά το ${a}.`); continue; }
      i++;
      if (a === "--admin") out.admins.push(v);
      else out[a.slice(2)] = v;
    } else out.errors.push(`Άγνωστη παράμετρος: ${a}`);
  }
  return out;
}

// ------------------------------------------------------------------ έλεγχοι
export function validate(opts) {
  const errors = [...(opts.errors || [])];
  const warnings = [];
  const id = typeof opts.id === "string" ? opts.id.trim() : "";
  const name = typeof opts.name === "string" ? opts.name.trim().replace(/\s+/g, " ") : "";
  const profile = opts.profile === undefined ? "company" : opts.profile;
  const status = opts.status === undefined ? "pilot" : opts.status;

  if (!id) errors.push("Λείπει το --id (π.χ. team-acme).");
  else if (!id.startsWith(WORKSPACE_PREFIX)) errors.push(`Το id πρέπει να ΞΕΚΙΝΑ από "${WORKSPACE_PREFIX}" (π.χ. team-acme). Χωρίς το πρόθεμα ο χώρος δεν δουλεύει. Έδωσες: ${id}`);
  else if (id.length > MAX_ID) errors.push(`Το id είναι πολύ μεγάλο (το πολύ ${MAX_ID} χαρακτήρες).`);
  else if (!ID_RE.test(id)) errors.push(`Το id επιτρέπει μόνο μικρά λατινικά, ψηφία και παύλες, μετά το "${WORKSPACE_PREFIX}" (π.χ. team-acme-gr). Έδωσες: ${id}`);

  if (!name) errors.push('Λείπει το --name (το όνομα του οργανισμού, π.χ. "Acme").');
  else if (name.length > MAX_NAME) errors.push(`Το όνομα είναι πολύ μεγάλο (το πολύ ${MAX_NAME} χαρακτήρες).`);
  else if (/[\u0000-\u001f]/.test(name)) errors.push("Το όνομα έχει μη επιτρεπτούς χαρακτήρες.");

  if (!PROFILES.includes(profile)) errors.push(`Το --profile πρέπει να είναι company ή multi_client. Έδωσες: ${profile}`);
  if (!STATUSES.includes(status)) errors.push(`Το --status πρέπει να είναι pilot, active ή paused. Έδωσες: ${status}`);

  const admins = [];
  for (const raw of opts.admins || []) {
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) { errors.push(`Το email δεν είναι σωστό: ${raw}`); continue; }
    if (admins.includes(email)) { errors.push(`Το email εμφανίζεται δύο φορές: ${email}`); continue; }
    admins.push(email);
  }
  if (!(opts.admins || []).length) errors.push("Χρειάζεται τουλάχιστον ένας admin (--admin email).");
  else if (admins.length === 1 && !errors.length) warnings.push("Έδωσες ΕΝΑΝ admin. Σύσταση: ΔΥΟ από την αρχή (ένας admin είναι σημείο αποτυχίας: αν φύγει ή χάσει το email, ο πελάτης δεν διαχειρίζεται τίποτα).");
  if (admins.length > 3) warnings.push("Έδωσες πάνω από τρεις admins. Σύσταση: δύο έως τρεις (ο admin διαβάζει τα πάντα" + (profile === "multi_client" ? ", και στο call center περνά και τους τοίχους των πελατών: μόνο ops/IT" : "") + ").");

  return { errors, warnings, value: { id, name, profile, status, admins } };
}

// ------------------------------------------------------------------ SQL
const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // ένα string μέσα σε SQL: τα ' διπλασιάζονται

// ΠΡΟΣΟΧΗ: απλό INSERT (ΟΧΙ "OR IGNORE"), ώστε ένα διπλότυπο να αποτυγχάνει ΘΟΡΥΒΩΔΩΣ και όχι να χάνεται σιωπηλά.
export function buildInsertSql(v, nowIso) {
  const lines = [`INSERT INTO team_workspaces (id, name, status, created_at) VALUES (${q(v.id)}, ${q(v.name)}, ${q(v.status)}, ${q(nowIso)});`];
  for (const email of v.admins) {
    lines.push(`INSERT INTO team_members (workspace_id, email, role, status, created_at) VALUES (${q(v.id)}, ${q(email)}, 'admin', 'active', ${q(nowIso)});`);
  }
  if (v.profile === "multi_client") {
    lines.push(`INSERT INTO team_workspace_settings (workspace_id, profile, updated_at) VALUES (${q(v.id)}, 'multi_client', ${q(nowIso)});`);
  }
  return lines.join("\n") + "\n";
}

export function buildPrecheckSql(v) {
  const emails = v.admins.map(q).join(", ");
  return `SELECT 'workspace' AS kind, id AS value FROM team_workspaces WHERE id = ${q(v.id)} UNION ALL SELECT 'member', email FROM team_members WHERE email IN (${emails});\n`;
}

export function buildVerifySql(v) {
  return `SELECT w.id AS workspace, w.name, w.status, COALESCE(s.profile, 'company') AS profile, m.email, m.role, m.status AS member_status FROM team_workspaces w LEFT JOIN team_members m ON m.workspace_id = w.id LEFT JOIN team_workspace_settings s ON s.workspace_id = w.id WHERE w.id = ${q(v.id)} ORDER BY m.email;\n`;
}

// ------------------------------------------------------------------ wrangler
// Τρέχει ένα αρχείο SQL στη βάση του lab. Το διαβάζει από αρχείο (--file), ώστε να μην υπάρχουν προβλήματα εισαγωγικών στο PowerShell.
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function runWrangler(sql, tmp, step) {
  const file = join(tmp, `${step}.sql`);
  writeFileSync(file, sql, "utf8");
  const base = process.env.IDMON_WRANGLER || "npx wrangler";
  const cmd = `${base} d1 execute ${LAB_DB} --remote -c ${LAB_CONFIG} --json --file "${file}"`;
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = spawnSync(cmd, { shell: true, cwd: REPO, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const text = `${last.stdout || ""}\n${last.stderr || ""}`;
    // Γνωστό διαλείπον σφάλμα του Cloudflare: συμβαίνει ΠΡΙΝ εκτελεστεί η εντολή, άρα είναι ασφαλές να ξαναδοκιμαστεί.
    if (last.status !== 0 && /Authentication error \[code: 10000\]/.test(text) && attempt < 3) {
      console.log(`  (διαλείπον σφάλμα ταυτοποίησης 10000, ξαναδοκιμάζω ${attempt}/2)`);
      sleep(2000);
      continue;
    }
    break;
  }
  return last;
}

// Βγάζει το JSON από την έξοδο του wrangler (αν έχει και άλλες γραμμές γύρω του). Ό,τι δεν διαβάζεται: null (ΑΠΟΤΥΧΙΑ, ποτέ "άδειο").
export function parseWranglerJson(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch { /* συνεχίζει */ }
  const a = t.indexOf("[");
  const b = t.lastIndexOf("]");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const rowsOf = (parsed) => (Array.isArray(parsed) && parsed[0] && Array.isArray(parsed[0].results) ? parsed[0].results : null);

function labConfigOk() {
  const p = join(REPO, LAB_CONFIG);
  if (!existsSync(p)) return `Δεν βρέθηκε το ${LAB_CONFIG} στον φάκελο ${REPO}. Τρέξε το script από τον φάκελο του repo.`;
  const toml = readFileSync(p, "utf8");
  if (!new RegExp(`database_name\\s*=\\s*"${LAB_DB}"`).test(toml)) return `Το ${LAB_CONFIG} ΔΕΝ δείχνει στη βάση ${LAB_DB}. Σταματώ για ασφάλεια (δεν γράφω ποτέ αλλού).`;
  return null;
}

// ------------------------------------------------------------------ κύρια ροή
export function main(argv, now = () => new Date()) {
  const opts = parseArgs(argv);
  if (opts.help || argv.length === 0) {
    console.log("Χρήση: node lab\\new-client.mjs --id team-acme --name \"Acme\" --admin ceo@acme.example --admin it@acme.example [--profile company|multi_client] [--status pilot|active|paused] [--run]");
    console.log("Χωρίς --run: μόνο δοκιμή (τυπώνει τι θα γίνει).");
    return 0;
  }
  const { errors, warnings, value: v } = validate(opts);
  if (errors.length) {
    console.log("ΔΕΝ ΕΓΙΝΕ ΤΙΠΟΤΑ. Διόρθωσε:");
    errors.forEach((e) => console.log("  - " + e));
    return 1;
  }
  const cfgErr = labConfigOk();
  if (cfgErr) { console.log("ΔΕΝ ΕΓΙΝΕ ΤΙΠΟΤΑ. " + cfgErr); return 1; }
  warnings.forEach((w) => console.log("ΠΡΟΣΟΧΗ: " + w));

  const nowIso = now().toISOString();
  const insertSql = buildInsertSql(v, nowIso);
  console.log(`\nΧώρος: ${v.id} ("${v.name}"), κατάσταση ${v.status}, τύπος ${v.profile === "multi_client" ? "Call center" : "Εταιρεία"}`);
  console.log(`Admins (${v.admins.length}): ${v.admins.join(", ")}`);
  console.log(`Βάση: ${LAB_DB} (lab, remote)`);
  if (!opts.run) {
    console.log("\nΔΟΚΙΜΗ (δεν έγινε καμία αλλαγή). Αυτό θα γραφόταν:\n");
    console.log(insertSql);
    console.log("Για να εκτελεστεί, ξανάτρεξε την ίδια εντολή με --run στο τέλος.");
    return 0;
  }

  const tmp = mkdtempSync(join(tmpdir(), "idmon-new-client-"));
  try {
    console.log("\n1/3 Έλεγχος ότι δεν υπάρχουν ήδη ο χώρος και τα emails...");
    const pre = runWrangler(buildPrecheckSql(v), tmp, "precheck");
    const preRows = pre.status === 0 ? rowsOf(parseWranglerJson(pre.stdout)) : null;
    if (!preRows) {
      console.log("ΔΕΝ ΕΓΙΝΕ ΤΙΠΟΤΑ. Ο έλεγχος δεν ολοκληρώθηκε (το wrangler απέτυχε ή η απάντηση δεν διαβάζεται), οπότε δεν γράφω.");
      console.log(String(pre.stdout || "").slice(0, 600) + String(pre.stderr || "").slice(0, 600));
      return 3;
    }
    if (preRows.length) {
      console.log("ΔΕΝ ΕΓΙΝΕ ΤΙΠΟΤΑ. Υπάρχουν ήδη:");
      preRows.forEach((r) => console.log(`  - ${r.kind === "workspace" ? "χώρος" : "μέλος (ένα email ανήκει σε ΕΝΑΝ οργανισμό σε όλο το σύστημα)"}: ${r.value}`));
      return 2;
    }

    console.log("2/3 Δημιουργία χώρου και admins...");
    const ins = runWrangler(insertSql, tmp, "insert");
    if (ins.status !== 0 || /"success"\s*:\s*false/.test(String(ins.stdout || ""))) {
      console.log("ΣΦΑΛΜΑ στη δημιουργία. Μην ξανατρέξεις τυφλά: τρέξε ξανά την ΙΔΙΑ εντολή, ο έλεγχος 1/3 θα δείξει τι πρόλαβε να γραφτεί (δες lab\\RUNBOOK-new-client.md, ενότητα «Αν κάτι πάει στραβά»).");
      console.log(String(ins.stdout || "").slice(0, 600) + String(ins.stderr || "").slice(0, 600));
      return 3;
    }

    console.log("3/3 Επαλήθευση...");
    const ver = runWrangler(buildVerifySql(v), tmp, "verify");
    const rows = ver.status === 0 ? rowsOf(parseWranglerJson(ver.stdout)) : null;
    const adminsFound = rows ? rows.filter((r) => r.role === "admin" && r.member_status === "active").map((r) => r.email).sort() : [];
    const ok = rows && rows.length > 0 && rows[0].workspace === v.id && adminsFound.join() === [...v.admins].sort().join() && rows[0].profile === v.profile;
    if (!ok) {
      console.log("ΠΡΟΣΟΧΗ: η επαλήθευση ΔΕΝ ταιριάζει με ό,τι ζητήθηκε. Έλεγξε με τον ίδιο έλεγχο (runbook, ενότητα «Επαλήθευση»).");
      console.log(JSON.stringify(rows));
      return 3;
    }
    console.log(`\nΕΤΟΙΜΟ. Χώρος ${v.id} (${v.status}), τύπος ${v.profile === "multi_client" ? "Call center" : "Εταιρεία"}, admins: ${adminsFound.join(", ")}`);
    console.log("\nΕπόμενο βήμα για τον πελάτη (στείλε του αυτά):");
    console.log("  1. Άνοιξε https://idmon-lab.giamarigkos.workers.dev/portal");
    console.log("  2. Γράψε το επαγγελματικό email σου και ζήτα σύνδεσμο.");
    console.log("  3. Πάτα τον σύνδεσμο που θα έρθει στο email (ισχύει 15 λεπτά, χρησιμοποιείται μία φορά, δεν υπάρχουν κωδικοί).");
    if (v.admins.length < 2) console.log("  Υπενθύμιση: ζήτα να προστεθεί ΔΕΥΤΕΡΟΣ admin την πρώτη μέρα (Διαχείριση, Άνθρωποι).");
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
