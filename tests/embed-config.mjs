// Έλεγχος του δημόσιου endpoint ρυθμίσεων του widget (Βήμα 2β-1):
//   GET /embed/{embedId}/config
// και του νέου ελέγχου αποθήκευσης του logoUrl (PATCH /workspace/settings).
//
// ΔΕΝ χρειάζεται wrangler dev ούτε δίκτυο: φορτώνει ολόκληρο τον ΠΡΑΓΜΑΤΙΚΟ
// Worker (src/index.js) με ψεύτικο περιβάλλον (KV, D1). Ελέγχει τους κανόνες
// ασφαλείας: τι επιστρέφεται (και τι ΔΕΝ), το πλάνο, τον καθαρισμό στην έξοδο,
// τους κανόνες domain και τις κεφαλίδες.
//
// Τρέξιμο: node tests/embed-config.mjs

import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

// Το src/index.js είναι ES module με κατάληξη .js: προσωρινά αντίγραφα .mjs
// σε φάκελο του συστήματος (δεν αγγίζεται κανένα αρχείο του project).
const tmp = mkdtempSync(join(tmpdir(), "idmon-config-"));
writeFileSync(
  join(tmp, "index.mjs"),
  readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace("./crypto-helpers.js", "./crypto-helpers.mjs")
);
writeFileSync(join(tmp, "crypto-helpers.mjs"), readFileSync(new URL("../src/crypto-helpers.js", import.meta.url), "utf8"));
const worker = (await import(pathToFileURL(join(tmp, "index.mjs")).href)).default;

const PROTECTED = "efood-ops-demo";
const ALLOWED_ORIGIN = "https://shop.example.gr";

// --- ψεύτικο περιβάλλον -------------------------------------------------------
const kv = new Map();
const users = {}; // embedId -> { workspace_id, plan }
const domains = new Set(); // `${workspaceId}|${hostname}`

const env = {
  GEMINI_API_KEY: "k",
  DOCUMENT_REGISTRY: {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, v); },
    async delete(k) { kv.delete(k); },
    async list() { return { keys: [] }; },
  },
  DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("SELECT workspace_id, plan FROM users WHERE embed_id")) return users[args[0]] || null;
              if (sql.includes("SELECT workspace_id FROM users WHERE embed_id")) return users[args[0]] ? { workspace_id: users[args[0]].workspace_id } : null;
              if (sql.includes("FROM embed_domains")) return domains.has(`${args[0]}|${args[1]}`) ? { 1: 1 } : null;
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return {}; },
          };
        },
      };
    },
  },
};

function addEmbed(embedId, workspaceId, plan, hostnames = ["shop.example.gr"]) {
  users[embedId] = { workspace_id: workspaceId, plan };
  for (const h of hostnames) domains.add(`${workspaceId}|${h}`);
}
function setSettings(workspaceId, settings) {
  kv.set(`workspace:${workspaceId}:settings`, JSON.stringify(settings));
}

async function getConfig(embedId, origin = ALLOWED_ORIGIN) {
  const headers = origin ? { Origin: origin } : {};
  const res = await worker.fetch(new Request(`https://idmon.app/embed/${embedId}/config`, { headers }), env, { waitUntil() {} });
  let body = null;
  try { body = await res.json(); } catch (e) { /* όχι JSON */ }
  return { res, body };
}

async function patchSettings(body) {
  const res = await worker.fetch(
    new Request("https://idmon.app/workspace/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": PROTECTED },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {} }
  );
  return { res, data: await res.json() };
}

const EXPECTED_KEYS = ["accentColor", "botName", "contactLabel", "contactPhone", "contactUrl", "logoUrl", "showBranding"];

async function testAccessRules() {
  console.log("\n[Κανόνες πρόσβασης -- ίδιοι με τα /query endpoints]");
  addEmbed("emb-basic1", "ws-basic1", "basic");
  const unknown = await getConfig("emb-nope");
  assert(unknown.res.status === 404, "άγνωστο embed ID -> 404");
  const noOrigin = await getConfig("emb-basic1", null);
  assert(noOrigin.res.status === 403, "χωρίς Origin -> 403");
  const wrong = await getConfig("emb-basic1", "https://evil.example.com");
  assert(wrong.res.status === 403, "domain εκτός λίστας -> 403");
  assert(!wrong.res.headers.get("Access-Control-Allow-Origin"), "μη επιτρεπόμενο domain: ΚΑΝΕΝΑ Access-Control-Allow-Origin");
  const ok = await getConfig("emb-basic1");
  assert(ok.res.status === 200, "επιτρεπόμενο domain -> 200");
  const post = await worker.fetch(new Request("https://idmon.app/embed/emb-basic1/config", { method: "POST", headers: { Origin: ALLOWED_ORIGIN } }), env, { waitUntil() {} });
  assert(post.status !== 200, "POST στο /config δεν εξυπηρετείται (μόνο GET)");
}

async function testResponseShapeAndHeaders() {
  console.log("\n[Τι επιστρέφεται, και τι ΔΕΝ επιστρέφεται ΠΟΤΕ]");
  addEmbed("emb-full1", "ws-full1", "basic");
  setSettings("ws-full1", {
    accentColor: "#2F5BEA", botName: "HomeTech Βοηθός", logoUrl: "https://cdn.example.gr/logo.png",
    contactLabel: "Επικοινωνία", contactUrl: "https://example.gr/contact", contactPhone: "+30 210 123 4567",
    notifyEmail: "owner-private@example.gr", internalSecret: "do-not-leak", plan: "pro",
  });
  const { res, body } = await getConfig("emb-full1");
  assert(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(EXPECTED_KEYS), "ακριβώς τα 7 δημόσια πεδία, τίποτα άλλο");
  const raw = JSON.stringify(body);
  assert(!raw.includes("owner-private"), "το notifyEmail ΔΕΝ διαρρέει");
  assert(!raw.includes("do-not-leak") && !("internalSecret" in body), "άγνωστα πεδία των ρυθμίσεων ΔΕΝ διαρρέουν");
  assert(!("plan" in body), "το όνομα του πλάνου ΔΕΝ διαρρέει (μόνο το showBranding)");
  assert(body.accentColor === "#2F5BEA" && body.botName === "HomeTech Βοηθός", "χρώμα και όνομα όπως αποθηκεύτηκαν");
  assert(body.logoUrl === "https://cdn.example.gr/logo.png", "έγκυρο https λογότυπο περνά");
  assert(body.contactLabel === "Επικοινωνία" && body.contactUrl === "https://example.gr/contact" && body.contactPhone === "+30 210 123 4567", "στοιχεία επικοινωνίας περνούν");
  assert(res.headers.get("Access-Control-Allow-Origin") === ALLOWED_ORIGIN, "Access-Control-Allow-Origin = το ίδιο το Origin");
  assert((res.headers.get("Vary") || "").includes("Origin"), "Vary: Origin");
  const cc = res.headers.get("Cache-Control") || "";
  assert(cc.includes("private") && cc.includes("max-age=300"), "Cache-Control: private, max-age=300");
  assert((res.headers.get("Content-Type") || "").includes("application/json"), "Content-Type JSON");
}

async function testDefaultsWhenNothingSaved() {
  console.log("\n[Workspace χωρίς αποθηκευμένες ρυθμίσεις -> προεπιλογές]");
  addEmbed("emb-fresh1", "ws-fresh1", "free");
  const { body } = await getConfig("emb-fresh1");
  assert(body.accentColor === "#111111" && body.botName === "Assistant", "προεπιλεγμένο χρώμα (μαύρο) και όνομα");
  assert(body.logoUrl === null && body.contactLabel === null && body.contactUrl === null && body.contactPhone === null, "χωρίς λογότυπο/επικοινωνία -> null");
}

async function testPlanMatrix() {
  console.log("\n[Το \"Powered by Idmon\" αποφασίζεται από το πλάνο]");
  const cases = [
    ["free", "free", true],
    ["basic", "basic", true],
    ["pro", "pro", false],
    ["άγνωστο πλάνο", "enterprise", true],
    ["κενό πλάνο", null, true],
  ];
  let i = 0;
  for (const [label, plan, expected] of cases) {
    i++;
    addEmbed(`emb-plan${i}`, `ws-plan${i}`, plan);
    const { body } = await getConfig(`emb-plan${i}`);
    assert(body.showBranding === expected, `${label}: showBranding = ${expected}`);
  }
  addEmbed("emb-demo1", PROTECTED, "free");
  const demo = await getConfig("emb-demo1");
  assert(demo.body.showBranding === false, "το προστατευμένο demo workspace = Pro: χωρίς badge");
}

async function testOutputSanitization() {
  console.log("\n[Καθαρισμός στην ΕΞΟΔΟ -- κακές τιμές που έχουν ήδη αποθηκευτεί δεν φεύγουν ποτέ]");
  addEmbed("emb-bad1", "ws-bad1", "basic");
  const cfg = async (settings) => {
    setSettings("ws-bad1", settings);
    return (await getConfig("emb-bad1")).body;
  };
  for (const bad of ["red", "#12", "#12345", "#12345g", "rgb(1,2,3)", "#fff;} body{display:none", 123, null]) {
    assert((await cfg({ accentColor: bad })).accentColor === "#111111", `χρώμα ${JSON.stringify(bad)} -> προεπιλεγμένο`);
  }
  assert((await cfg({ botName: "x".repeat(61) })).botName === "Assistant", "όνομα 61 χαρακτήρων -> προεπιλεγμένο");
  assert((await cfg({ botName: "   " })).botName === "Assistant", "κενό όνομα -> προεπιλεγμένο");
  assert((await cfg({ botName: "  Βοηθός  " })).botName === "Βοηθός", "το όνομα κόβεται από κενά");

  for (const bad of ["http://cdn.example.gr/l.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "//cdn.example.gr/l.png",
    "https://cdn.example.gr/a b.png", " https://cdn.example.gr/l.png", "https://cdn.example.gr/" + "a".repeat(500), 12345, {}]) {
    assert((await cfg({ logoUrl: bad })).logoUrl === null, `λογότυπο ${JSON.stringify(bad).slice(0, 50)} -> null`);
  }
  assert((await cfg({ logoUrl: "https://cdn.example.gr/logo.png?v=2" })).logoUrl === "https://cdn.example.gr/logo.png?v=2", "https με query περνά");

  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>", "vbscript:x", " javascript:alert(1)", "example.gr/contact", "https://a.gr/with space"]) {
    assert((await cfg({ contactUrl: bad })).contactUrl === null, `contactUrl ${JSON.stringify(bad)} -> null`);
  }
  for (const good of ["https://example.gr/c", "mailto:info@example.gr", "tel:+302101234567", "whatsapp://send?phone=30"]) {
    assert((await cfg({ contactUrl: good })).contactUrl === good, `contactUrl ${good} περνά`);
  }
  assert((await cfg({ contactLabel: "x".repeat(41) })).contactLabel === null, "contactLabel 41 χαρακτήρων -> null");
  for (const bad of ['210" onclick="x', "call me", "1", "+".repeat(31), "<b>210</b>"]) {
    assert((await cfg({ contactPhone: bad })).contactPhone === null, `τηλέφωνο ${JSON.stringify(bad)} -> null`);
  }
  assert((await cfg({ contactPhone: "(210) 123-4567 #2" })).contactPhone === "(210) 123-4567 #2", "τηλέφωνο με ( ) - # περνά");
}

async function testLogoSaveValidation() {
  console.log("\n[Αποθήκευση logoUrl -- νέος έλεγχος, μόνο όταν το πεδίο αλλάζει]");
  for (const bad of ["http://x.gr/l.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "https://x.gr/" + "a".repeat(500), 123, "not a url", "https://x.gr/a b"]) {
    const { res, data } = await patchSettings({ logoUrl: bad });
    assert(res.status === 400 && /logoUrl/.test(data.error), `αποθήκευση ${JSON.stringify(bad).slice(0, 45)} -> 400`);
  }
  const good = await patchSettings({ logoUrl: "https://cdn.example.gr/logo.png" });
  assert(good.res.status === 200 && good.data.logoUrl === "https://cdn.example.gr/logo.png", "έγκυρο https λογότυπο αποθηκεύεται");
  const cleared = await patchSettings({ logoUrl: null });
  assert(cleared.res.status === 200 && cleared.data.logoUrl === null, "το null καθαρίζει το λογότυπο");
  const clearedEmpty = await patchSettings({ logoUrl: "" });
  assert(clearedEmpty.res.status === 200, "το κενό string επιτρέπεται (καθαρισμός)");

  // Παλιά, ήδη αποθηκευμένη κακή τιμή ΔΕΝ πρέπει να μπλοκάρει άσχετες αποθηκεύσεις.
  setSettings(PROTECTED, { logoUrl: "http://old-bad.example.com/l.png", accentColor: "#6B7280", botName: "Assistant" });
  const unrelated = await patchSettings({ botName: "Νέο όνομα" });
  assert(unrelated.res.status === 200 && unrelated.data.botName === "Νέο όνομα", "άσχετη ρύθμιση αποθηκεύεται παρά την παλιά κακή τιμή");

  // Οι υπάρχοντες έλεγχοι εξακολουθούν να δουλεύουν.
  const badColor = await patchSettings({ accentColor: "red" });
  assert(badColor.res.status === 400, "ο υπάρχων έλεγχος χρώματος εξακολουθεί να δουλεύει");
  const badContact = await patchSettings({ contactUrl: "javascript:alert(1)" });
  assert(badContact.res.status === 400, "ο υπάρχων έλεγχος contactUrl εξακολουθεί να δουλεύει");
}

await testAccessRules();
await testResponseShapeAndHeaders();
await testDefaultsWhenNothingSaved();
await testPlanMatrix();
await testOutputSanitization();
await testLogoSaveValidation();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
