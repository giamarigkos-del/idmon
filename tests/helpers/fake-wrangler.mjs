// tests\helpers\fake-wrangler.mjs
// Ψεύτικο "wrangler d1 execute" ΜΟΝΟ για τα τεστ του lab\new-client.mjs. Εκτελεί το --file πάνω σε πραγματική SQLite (node:sqlite)
// με το πραγματικό schema.sql και foreign keys ενεργά, όπως η D1.
// Περιβάλλον: IDMON_FAKE_DB (αρχείο βάσης), IDMON_FAKE_SCHEMA (schema.sql), IDMON_FAKE_LOG (αρχείο καταγραφής κλήσεων),
//   IDMON_FAKE_AUTH_FAIL (αρχείο μετρητή: τόσες πρώτες κλήσεις αποτυγχάνουν με "Authentication error [code: 10000]"),
//   IDMON_FAKE_MODE: "garbage" (η απάντηση του SELECT δεν είναι JSON), "insert_fail" (το INSERT αποτυγχάνει),
//   "verify_drop_admin" (η επαλήθευση επιστρέφει έναν admin λιγότερο).
// Η εκτέλεση ΔΕΝ είναι σε ενιαία συναλλαγή (χειρότερη περίπτωση): ένα σφάλμα στη μέση αφήνει ό,τι είχε ήδη γραφτεί.
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

process.removeAllListeners("warning");
const args = process.argv.slice(2);
const fileIdx = args.indexOf("--file");
const sqlFile = fileIdx >= 0 ? args[fileIdx + 1] : null;
const log = process.env.IDMON_FAKE_LOG;
const sql = sqlFile ? readFileSync(sqlFile, "utf8") : "";
if (log) appendFileSync(log, (/^\s*SELECT/i.test(sql) ? "SELECT" : "WRITE") + "\n");

const failFile = process.env.IDMON_FAKE_AUTH_FAIL;
if (failFile && existsSync(failFile)) {
  const left = Number(readFileSync(failFile, "utf8")) || 0;
  if (left > 0) {
    writeFileSync(failFile, String(left - 1));
    console.error("✘ [ERROR] A request to the Cloudflare API failed.\n  Authentication error [code: 10000]");
    process.exit(1);
  }
}

const db = new DatabaseSync(process.env.IDMON_FAKE_DB);
db.exec("PRAGMA foreign_keys = ON;");
if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='team_workspaces'").get()) db.exec(readFileSync(process.env.IDMON_FAKE_SCHEMA, "utf8"));

console.log(" ⛅️ wrangler 4.0.0-fake"); // θόρυβος πριν το JSON, όπως μπορεί να γίνει στο πραγματικό
if (/^\s*SELECT/i.test(sql)) {
  if (process.env.IDMON_FAKE_MODE === "garbage") { console.log("this is not json"); process.exit(0); }
  let rows = db.prepare(sql.trim().replace(/;$/, "")).all().map((r) => ({ ...r }));
  if (process.env.IDMON_FAKE_MODE === "verify_drop_admin" && /LEFT JOIN team_members m/.test(sql)) rows = rows.slice(0, -1); // η επαλήθευση "χάνει" έναν admin
  console.log(JSON.stringify([{ results: rows, success: true, meta: {} }], null, 2));
} else {
  if (process.env.IDMON_FAKE_MODE === "insert_fail") { console.error("D1_ERROR: simulated failure"); process.exit(1); }
  try {
    db.exec(sql);
  } catch (err) {
    console.error("D1_ERROR: " + err.message);
    process.exit(1);
  }
  console.log(JSON.stringify([{ results: [], success: true, meta: {} }], null, 2));
}
