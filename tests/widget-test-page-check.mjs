// Έλεγχος της μόνιμης σελίδας δοκιμών του widget (widget-test/index.html) --
// ΔΕΝ χρειάζεται wrangler dev ούτε δίκτυο. Χρησιμοποιεί τον ΠΡΑΓΜΑΤΙΚΟ κώδικα:
// κόβει το μπλοκ βοηθητικών συναρτήσεων ανάμεσα στους δείκτες
// "widget-test-page:helpers START/END" και το τρέχει, όχι reimplementation.
//
// Ελέγχει: τη λογική (έγκυρο embed ID/server, attributes, snippet, κρίση
// απάντησης), ότι τα σενάρια στηρίζονται στα ΠΡΑΓΜΑΤΙΚΑ έγγραφα HomeTech
// (tests/fixtures/hometech), ότι η σελίδα δεν ευρετηριάζεται και δεν έχει
// εξωτερικές εξαρτήσεις, και ότι το widget.js εξακολουθεί να έχει τα στοιχεία
// που οδηγεί το σενάριο (input, κουμπί, μηνύματα).
//
// Τρέξιμο: node tests/widget-test-page-check.mjs

import { readFileSync, existsSync, readdirSync } from "fs";

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

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pageHtml = read("../widget-test/index.html");
const START = "// --- widget-test-page:helpers START ---";
const END = "// --- widget-test-page:helpers END ---";
const s = pageHtml.indexOf(START);
const e = pageHtml.indexOf(END);
if (s === -1 || e === -1 || e < s) {
  console.log("✗ Δεν βρέθηκαν οι δείκτες helpers START/END στο widget-test/index.html");
  process.exit(1);
}
const lib = new Function(
  pageHtml.slice(s, e) +
    "\nreturn { isValidEmbedId, normalizeServer, buildAttrs, buildSnippet, checkTurn, summarizeConfig, judgeBadge, SCENARIOS, COLOR_PRESETS, DEFAULT_SERVER };"
)();

function testEmbedId() {
  console.log("\n[Έλεγχος Embed ID]");
  for (const ok of ["emb-a1b2c3d4e5f6", "abcd", "EMB_test-123"]) assert(lib.isValidEmbedId(ok), `δεκτό: ${ok}`);
  for (const bad of ["", "ab", "emb x", "emb-<script>", "emb/../x", "a".repeat(65), null, undefined, 123]) {
    assert(!lib.isValidEmbedId(bad), `απορρίπτεται: ${JSON.stringify(bad)}`);
  }
  assert(lib.isValidEmbedId("  emb-a1b2c3d4  "), "κενά γύρω από το ID αγνοούνται");
}

function testNormalizeServer() {
  console.log("\n[Έλεγχος server URL -- μόνο https ή τοπικό http]");
  assert(lib.normalizeServer("https://app.idmon.app") === "https://app.idmon.app", "https δεκτό");
  assert(lib.normalizeServer("https://app.idmon.app/some/path?x=1") === "https://app.idmon.app", "κρατά μόνο το origin");
  assert(lib.normalizeServer("http://127.0.0.1:8787") === "http://127.0.0.1:8787", "http://127.0.0.1 δεκτό (wrangler dev)");
  assert(lib.normalizeServer("http://localhost:8787") === "http://localhost:8787", "http://localhost δεκτό");
  for (const bad of ["http://example.com", "javascript:alert(1)", "ftp://x.gr", "data:text/html,<b>", "not a url", "", null]) {
    assert(lib.normalizeServer(bad) === null, `απορρίπτεται: ${JSON.stringify(bad)}`);
  }
}

function testBuildAttrs() {
  console.log("\n[data-attributes του snippet -- λειτουργία server και λειτουργία προεπισκόπησης]");
  const min = lib.buildAttrs({ embedId: " emb-abcd1234 " });
  assert(JSON.stringify(min) === JSON.stringify({ "data-embed-id": "emb-abcd1234" }), "προεπιλογή (server): μόνο embed ID, κενά κόβονται");
  const server = lib.buildAttrs({ embedId: "emb-abcd1234", color: "#2F5BEA", botName: "Βοηθός", contact: true, lang: "en", position: "bottom-left" });
  assert(JSON.stringify(Object.keys(server).sort()) === JSON.stringify(["data-embed-id", "data-lang", "data-position"]), "λειτουργία server: ΜΟΝΟ embed ID, γλώσσα, θέση (το χρώμα/όνομα/επικοινωνία δεν μπαίνουν στο snippet)");
  assert(!("data-config" in server), "λειτουργία server: ΚΑΝΕΝΑ data-config=off (το widget ρωτά τον server)");

  const preview = lib.buildAttrs({ serverConfig: false, embedId: "emb-abcd1234", color: "#2F5BEA", botName: " Βοηθός ", lang: "en", position: "bottom-left", contact: true });
  assert(preview["data-config"] === "off", "προεπισκόπηση: data-config=off");
  assert(preview["data-accent-color"] === "#2F5BEA", "προεπισκόπηση: χρώμα");
  assert(preview["data-bot-name"] === "Βοηθός", "προεπισκόπηση: όνομα (κενά κόβονται)");
  assert(preview["data-lang"] === "en" && preview["data-position"] === "bottom-left", "γλώσσα και θέση");
  assert(preview["data-contact-label"] && preview["data-contact-url"] && preview["data-contact-phone"], "προεπισκόπηση: τα τρία data-contact-*");
  assert(!("data-position" in lib.buildAttrs({ embedId: "emb-abcd1234", position: "bottom-right" })), "θέση δεξιά: δεν προστίθεται attribute (προεπιλογή)");
  assert(lib.buildAttrs({ serverConfig: false, embedId: "emb-abcd1234", color: "red" })["data-accent-color"] === "red", "άκυρο χρώμα περνά ΩΣ ΕΧΕΙ, ώστε να δοκιμάζεται η άμυνα του widget");
  assert(lib.COLOR_PRESETS.some((p) => p.value === "red"), "υπάρχει preset με άκυρο χρώμα για αυτόν τον έλεγχο");
  assert(!("data-bot-name" in lib.buildAttrs({ serverConfig: false, embedId: "emb-abcd1234", botName: "   " })), "κενό όνομα: χωρίς attribute");
}

function testBuildSnippet() {
  console.log("\n[Snippet που εμφανίζεται]");
  const snippet = lib.buildSnippet({ serverConfig: false, embedId: "emb-abcd1234", botName: 'Βοηθός "Α" <b>' }, "https://app.idmon.app");
  assert(snippet.startsWith('<script src="https://app.idmon.app/widget.js"'), "ξεκινά με το σωστό script src");
  assert(snippet.endsWith("></script>"), "τελειώνει με κλείσιμο script");
  assert(snippet.includes('data-embed-id="emb-abcd1234"'), "περιέχει το embed ID");
  assert(!snippet.includes('"Α"') && snippet.includes("&quot;Α&quot;"), "τα εισαγωγικά στο όνομα γίνονται &quot;");
  assert(!snippet.includes("<b>"), "το < στο όνομα ξεφεύγει");
}

function testCheckTurn() {
  console.log("\n[Κρίση απάντησης]");
  assert(lib.checkTurn("Κοστίζει 129 €.", { expect: ["129"] }).ok, "σωστή απάντηση περνά");
  const miss = lib.checkTurn("Κοστίζει 179 €.", { expect: ["129"] });
  assert(!miss.ok && miss.missing.length === 1, "λείπει το αναμενόμενο -> αποτυχία, με αναφορά του τι λείπει");
  const forb = lib.checkTurn("Κοστίζει 129 € (το XL 179 €).", { expect: ["129"], forbid: ["179"] });
  assert(!forb.ok && forb.forbidden.length === 1, "απαγορευμένο περιεχόμενο -> αποτυχία");
  assert(lib.checkTurn("Ωράριο: 09:30 έως 20:30", { expect: ["9:30", "20:30"] }).ok, "πολλαπλά expect: όλα ταιριάζουν");
  assert(!lib.checkTurn("Ωράριο: 20:30", { expect: ["9:30", "20:30"] }).ok, "πολλαπλά expect: αν λείπει ένα, αποτυγχάνει");
  assert(lib.checkTurn("Άτοκες δόσεις", { expect: ["άτοκ"] }).ok, "πεζά/κεφαλαία δεν μετράνε (Άτοκες = άτοκ)");
  assert(!lib.checkTurn("Δεν γνωρίζω.", { expectFallbackPrompt: true }, { fallbackPromptShown: false }).ok, "αναμενόμενο μήνυμα επικοινωνίας που δεν εμφανίστηκε -> αποτυχία");
  assert(lib.checkTurn("Δεν γνωρίζω.", { expectFallbackPrompt: true }, { fallbackPromptShown: true }).ok, "με το μήνυμα επικοινωνίας -> επιτυχία");
  assert(lib.checkTurn("οτιδήποτε", {}).ok, "turn χωρίς προσδοκίες περνά");
}

function testSummarizeConfig() {
  console.log("\n[Περιγραφή απάντησης του /config]");
  const free = lib.summarizeConfig(200, { accentColor: "#6B7280", botName: "Assistant", logoUrl: null, contactLabel: null, contactUrl: null, contactPhone: null, showBranding: true });
  assert(free[0] === "200 OK" && free.some((l) => l === "logoUrl: (κενό)"), "200: κενά πεδία εμφανίζονται ως (κενό)");
  assert(free.some((l) => l === "accentColor: #6B7280") && free.some((l) => l === "botName: Assistant"), "200: εμφανίζονται οι τιμές");
  assert(free[free.length - 1].includes("ΘΑ φαίνεται"), "showBranding=true: λέει ότι το badge ΘΑ φαίνεται");
  const pro = lib.summarizeConfig(200, { showBranding: false });
  assert(pro[pro.length - 1].includes("ΔΕΝ θα φαίνεται"), "showBranding=false: λέει ότι ΔΕΝ θα φαίνεται (Pro)");
  assert(lib.summarizeConfig(403, null)[0].includes("ΔΕΝ είναι στη λίστα"), "403: εξηγεί ότι λείπει το domain από τη λίστα");
  assert(lib.summarizeConfig(404, null)[0].includes("άγνωστο Embed ID"), "404: εξηγεί ότι το Embed ID είναι άγνωστο");
  assert(lib.summarizeConfig(500, null)[0].startsWith("500"), "άλλος κωδικός: αναφέρεται");
  assert(lib.summarizeConfig(200, null)[0].includes("απροσδόκητη"), "200 χωρίς σώμα: απροσδόκητο");
}

function testJudgeBadge() {
  console.log("\n[Κρίση του badge: το widget πρέπει να συμφωνεί με τον server]");
  const goodLink = { text: "Powered by Idmon", href: "https://idmon.app/" };
  assert(lib.judgeBadge(true, { showBranding: true }, goodLink).ok, "ο server λέει true, το badge φαίνεται με σωστό σύνδεσμο: OK");
  assert(lib.judgeBadge(false, { showBranding: false }, null).ok, "ο server λέει false (Pro), το badge κρύβεται: OK");
  assert(lib.judgeBadge(true, {}, goodLink).ok, "χωρίς το πεδίο ο server: αναμένεται να φαίνεται");
  const leak = lib.judgeBadge(true, { showBranding: false }, goodLink);
  assert(!leak.ok && leak.why.includes("φαίνεται"), "ο server λέει false αλλά το badge φαίνεται: ΑΠΟΤΥΧΙΑ (ένας Pro θα έβλεπε το badge)");
  const missing = lib.judgeBadge(false, { showBranding: true }, null);
  assert(!missing.ok && missing.why.includes("ΔΕΝ φαίνεται"), "ο server λέει true αλλά το badge λείπει: ΑΠΟΤΥΧΙΑ");
  assert(!lib.judgeBadge(true, { showBranding: true }, { text: "Powered by Someone", href: "https://idmon.app/" }).ok, "λάθος κείμενο: ΑΠΟΤΥΧΙΑ");
  assert(!lib.judgeBadge(true, { showBranding: true }, { text: "Powered by Idmon", href: "https://evil.example.com/" }).ok, "λάθος σύνδεσμος: ΑΠΟΤΥΧΙΑ");
  assert(!lib.judgeBadge(true, { showBranding: true }, null).ok, "badge χωρίς σύνδεσμο: ΑΠΟΤΥΧΙΑ");
  assert(lib.judgeBadge(true, null, goodLink).ok, "χωρίς σώμα (null): αναμένεται να φαίνεται");
}

function testScenarioStructure() {
  console.log("\n[Δομή σεναρίων]");
  const ids = lib.SCENARIOS.map((x) => x.id);
  assert(new Set(ids).size === ids.length, "μοναδικά id");
  for (const sc of lib.SCENARIOS) {
    assert(typeof sc.title === "string" && (sc.kind === "badge" || sc.turns.length >= 1), `«${sc.id}»: έχει τίτλο και τουλάχιστον ένα turn (ή είναι ειδικό σενάριο)`);
    for (const t of sc.turns || []) {
      assert(typeof t.q === "string" && t.q.length > 3, `«${sc.id}»: ερώτηση "${t.q}"`);
      for (const p of [...(t.expect || []), ...(t.forbid || [])]) {
        let valid = true;
        try { new RegExp(p, "i"); } catch { valid = false; }
        assert(valid, `«${sc.id}»: έγκυρο regex "${p}"`);
      }
    }
  }
  const fb = lib.SCENARIOS.find((x) => x.id === "fallback");
  assert(fb.settings.contact === true && fb.settings.serverConfig === false, "το σενάριο fallback ενεργοποιεί τα στοιχεία επικοινωνίας μέσω attributes (προεπισκόπηση), γιατί ο λογαριασμός δοκιμών δεν έχει ρυθμισμένη επικοινωνία");
  assert(lib.SCENARIOS.some((x) => x.id === "badge" && x.kind === "badge"), "υπάρχει σενάριο ελέγχου του badge");
  assert(lib.SCENARIOS.some((x) => x.turns.length >= 4), "υπάρχει σενάριο με 4+ γύρους (ξεπερνά το όριο ιστορικού των 6 μηνυμάτων)");
}

function testScenariosGroundedInFixtures() {
  console.log("\n[Τα σενάρια στηρίζονται στα ΠΡΑΓΜΑΤΙΚΑ έγγραφα HomeTech]");
  const dir = new URL("./fixtures/hometech/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
  assert(files.length === 5, `υπάρχουν 5 έγγραφα δοκιμής (βρέθηκαν ${files.length})`);
  const corpus = files.map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  for (const sc of lib.SCENARIOS) {
    for (const t of sc.turns || []) {
      for (const p of t.expect || []) assert(new RegExp(p, "i").test(corpus), `«${sc.id}»: το αναμενόμενο "${p}" υπάρχει στα έγγραφα`);
      for (const p of t.forbid || []) assert(new RegExp(p, "i").test(corpus), `«${sc.id}»: το απαγορευμένο "${p}" υπάρχει στα έγγραφα (ουσιαστικό δολώμα)`);
    }
  }
}

function testPageHygiene() {
  console.log("\n[Σελίδα: χωρίς ευρετηρίαση, χωρίς εξωτερικές εξαρτήσεις, σωστή δομή]");
  assert(/<meta name="robots" content="noindex,nofollow">/.test(pageHtml), "meta robots noindex,nofollow");
  const headersPath = new URL("../widget-test/_headers", import.meta.url);
  assert(existsSync(headersPath) && /X-Robots-Tag:\s*noindex/i.test(readFileSync(headersPath, "utf8")), "το _headers στέλνει X-Robots-Tag: noindex");
  assert((pageHtml.match(/<\/script/gi) || []).length === 1, "ΜΟΝΟ ένα κλείσιμο script (ένα literal κλείσιμο μέσα στον κώδικα θα έκοβε τη σελίδα)");
  // Αφαιρούμε πρώτα το ΕΝΑ inline script (ο κώδικας/τα σχόλιά του αναφέρουν "<script src=...").
  const outsideInline = pageHtml.replace(/<script>[\s\S]*?<\/script>/, "");
  assert(!/<script/i.test(outsideInline), "κανένα άλλο script στη σελίδα εκτός από το ένα inline (κανένα εξωτερικό)");
  assert(!/<link[^>]*href=/i.test(pageHtml), "κανένα εξωτερικό stylesheet");
  assert(!/<img[^>]*src=/i.test(pageHtml), "καμία εξωτερική εικόνα");
  assert(lib.DEFAULT_SERVER === "https://app.idmon.app", "ο προεπιλεγμένος server είναι το production");
  const toml = read("../wrangler.widget-test.toml");
  assert(/^name\s*=\s*"idmon-widget-test"/m.test(toml), "wrangler: όνομα Worker idmon-widget-test");
  assert(/directory\s*=\s*"\.\/widget-test"/.test(toml), "wrangler: assets από τον φάκελο widget-test");
  assert(!/^main\s*=/m.test(toml), "wrangler: assets-only (καμία λογική στον server)");
}

function testWidgetContract() {
  console.log("\n[Το widget.js έχει ακόμα τα στοιχεία που οδηγεί το σενάριο]");
  const widget = read("../public/widget.js");
  for (const needle of ["rag-embed-widget-host", "input-row", "fallback-contact", 'className = "bubble pending"', 'className = "msg "', "attachShadow({ mode: \"open\" })", 'class="powered"', "/config", 'data-config']) {
    assert(widget.includes(needle), `widget.js περιέχει: ${needle}`);
  }
  assert(pageHtml.includes('.input-row input') && pageHtml.includes('.input-row button') && pageHtml.includes(".msg.bot") && pageHtml.includes(".msg.fallback-contact"), "η σελίδα χρησιμοποιεί ακριβώς αυτούς τους selectors");
  assert(pageHtml.includes('.powered') && pageHtml.includes('.bubble') && pageHtml.includes('"pending"'), "η σελίδα χρησιμοποιεί τα .powered και .bubble.pending του widget");
  for (const id of ["serverConfig", "configBtn", "serverNote"]) assert(pageHtml.includes(`id="${id}"`), `η σελίδα έχει το στοιχείο #${id}`);
  assert(pageHtml.includes("textWithBreaks") && /white-space:pre-wrap/.test(pageHtml), "οι αλλαγές γραμμής των απαντήσεων διατηρούνται στο log");
}

testEmbedId();
testNormalizeServer();
testBuildAttrs();
testBuildSnippet();
testCheckTurn();
testSummarizeConfig();
testJudgeBadge();
testScenarioStructure();
testScenariosGroundedInFixtures();
testPageHygiene();
testWidgetContract();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
