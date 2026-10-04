// Έλεγχος του νέου επεξεργαστή εγγράφων του SMB (Tiptap, αντί για Toast UI) -- ΔΕΝ χρειάζεται wrangler dev ούτε δίκτυο.
// Χρησιμοποιεί τον ΠΡΑΓΜΑΤΙΚΟ κώδικα: το public/vendor/editor.js (η μηχανή), το public/idmon-toolbar.js (η γραμμή εργαλείων) και το
// public/idmon-doc-editor.js (ο «φάκελος» του SMB), μέσα σε jsdom. Τίποτα δεν αντιγράφεται στο τεστ.
//
// Ελέγχει: (1) το editor.html δεν έχει καμία αναφορά στο Toast UI και φορτώνει τα τοπικά αρχεία με τη σωστή σειρά, (2) το vendor/editor.js είναι ΑΚΡΙΒΩΣ
// αυτό που δηλώνει το MANIFEST, (3) δημιουργία, Markdown, onChange, destroy, (4) ΔΕΝ υπάρχει κουμπί «Εικόνα» και η εικόνα (επικόλληση ή σύρσιμο)
// δεν μπαίνει ποτέ: δείχνει μήνυμα και ο browser δεν ανοίγει το αρχείο, (5) ο ορθογράφος δεν κλειδώνει σε γλώσσα, (6) ελληνικά και αγγλικά,
// (7) εφεδρικό απλό πεδίο κειμένου όταν η μηχανή λείπει ή σκάει.
//
// Τρέξιμο: node tests/editor-tiptap.mjs

import { readFileSync } from "fs";
import { createHash } from "crypto";
import { JSDOM, VirtualConsole } from "jsdom";

let passed = 0;
let failed = 0;
function assert(condition, message, detail) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.log(`  ✗ ${message}${detail === undefined ? "" : "  -> " + JSON.stringify(detail)}`); }
}
const section = (t) => console.log(`\n[${t}]`);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const PAGE = read("../public/editor.html");
const ENGINE_BYTES = readFileSync(new URL("../public/vendor/editor.js", import.meta.url));
const ENGINE = ENGINE_BYTES.toString("utf8");
const TOOLBAR = read("../public/idmon-toolbar.js");
const WRAPPER = read("../public/idmon-doc-editor.js");
const MANIFEST = JSON.parse(read("../public/vendor/MANIFEST.json"));
const CSS = read("../public/idmon-editor.css");

// Το jsdom δεν έχει γεωμετρία: τα ίδια polyfill που χρησιμοποιεί και η σουίτα των ομάδων για τον ίδιο επεξεργαστή.
const POLY = "Range.prototype.getClientRects = function () { return { length: 0, item: function () { return null; }, [Symbol.iterator]: function* () {} }; };\nRange.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; };\ndocument.elementFromPoint = function () { return null; };";

function makeWindow({ lang = "en", engine = true, toolbar = true, wrapper = true } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html lang="${lang}"><body><div id="tuiEditor"></div></body></html>`, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.eval(POLY);
  if (engine) w.eval(ENGINE);
  if (toolbar) w.eval(TOOLBAR);
  if (wrapper) w.eval(WRAPPER);
  return w;
}
const mount = (w, opts) => { const host = w.document.getElementById("tuiEditor"); const ed = w.IdmonDocEditor.create(host, opts); return { host, ed }; };

// ---------------------------------------------------------------------------------------------------------------------
section("1. Η σελίδα editor.html: καμία αναφορά στο Toast UI, τα τοπικά αρχεία φορτώνουν με τη σωστή σειρά");
{
  assert(!/toastui|toast-ui|uicdn\.toast\.com/i.test(PAGE), "δεν υπάρχει πια καμία αναφορά στο Toast UI (ούτε σκριπτ, ούτε στυλ, ούτε κώδικας)");
  const srcs = [...PAGE.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const iEngine = srcs.indexOf("/vendor/editor.js"), iBar = srcs.indexOf("/idmon-toolbar.js"), iDoc = srcs.indexOf("/idmon-doc-editor.js");
  assert(iEngine >= 0 && iBar > iEngine && iDoc > iBar, "φορτώνουν με τη σειρά: μηχανή, γραμμή εργαλείων, φάκελος SMB (κάθε αρχείο χρειάζεται το προηγούμενο)", srcs);
  assert(/<link rel="stylesheet" href="\/idmon-editor\.css">/.test(PAGE), "φορτώνει το κοινό CSS του επεξεργαστή (/idmon-editor.css)");
  assert(/marked\.min\.js/.test(PAGE) && /purify\.min\.js/.test(PAGE), "η προεπισκόπηση μένει όπως ήταν: τα marked και DOMPurify ΔΕΝ αφαιρέθηκαν");
  assert(/tuiEditorInstance = IdmonDocEditor\.create\(el\("tuiEditor"\)/.test(PAGE), "ο επεξεργαστής δημιουργείται από το IdmonDocEditor.create στο στοιχείο #tuiEditor");
  assert((PAGE.match(/tuiEditorInstance\.destroy\(\)/g) || []).length >= 10, "οι θέσεις που καθαρίζουν τον επεξεργαστή (destroy) έμειναν όπως ήταν (το ιστορικό όνομα tuiEditorInstance κρατήθηκε επίτηδες)");
  assert((PAGE.match(/tuiEditorInstance\.getMarkdown\(\)/g) || []).length >= 3, "οι θέσεις που διαβάζουν το Markdown (προεπισκόπηση και δύο αποθηκεύσεις) έμειναν όπως ήταν");
  assert(!/<script[^>]+src="https?:[^"]*(toast|tiptap|prosemirror)/i.test(PAGE), "κανένα σκριπτ του επεξεργαστή από εξωτερικό CDN: μόνο τοπικά αρχεία (τα marked και DOMPurify είναι ξεχωριστό θέμα)");
}

// ---------------------------------------------------------------------------------------------------------------------
section("2. Ακεραιότητα του vendor/editor.js (δεν αλλάζει με το χέρι)");
{
  const sha = createHash("sha256").update(ENGINE_BYTES).digest("hex");
  assert(MANIFEST.files && MANIFEST.files["editor.js"], "το MANIFEST έχει εγγραφή για το editor.js");
  assert(MANIFEST.files["editor.js"].sha256 === sha, "το SHA-256 του editor.js ταιριάζει με το MANIFEST", { manifest: MANIFEST.files["editor.js"].sha256, actual: sha });
  assert(MANIFEST.files["editor.js"].bytes === ENGINE_BYTES.length, "το μέγεθος του editor.js ταιριάζει με το MANIFEST", { manifest: MANIFEST.files["editor.js"].bytes, actual: ENGINE_BYTES.length });
  assert(Object.keys(MANIFEST.files).join() === "editor.js", "το MANIFEST του SMB έχει ΜΟΝΟ το editor.js (ο reader.js δεν χρειάζεται εδώ)");
  assert(Object.values(MANIFEST.dependencies || {}).every((d) => d.license === "MIT" || /MIT|ISC|BSD|Apache/.test(d.license)), "όλες οι βιβλιοθήκες που συσκευάστηκαν έχουν άδεια που επιτρέπει εμπορική χρήση (MIT, ISC, BSD, Apache)", Object.entries(MANIFEST.dependencies || {}).map(([k, v]) => k + ":" + v.license));
}

// ---------------------------------------------------------------------------------------------------------------------
section("3. Δημιουργία, Markdown, onChange, destroy");
{
  const w = makeWindow();
  assert(typeof w.IdmonEditor.create === "function" && typeof w.IdmonToolbar.create === "function" && typeof w.IdmonDocEditor.create === "function", "φορτώνουν και τα τρία (μηχανή, γραμμή, φάκελος)");
  let changes = 0;
  const { host, ed } = mount(w, { markdown: "# Τίτλος\n\nΚείμενο με **έντονο**.\n\n- α\n- β", onChange: () => { changes++; } });
  assert(ed.kind === "rich" && !!host.querySelector(".rte .ProseMirror") && !!host.querySelector(".rte-toolbar"), "δημιουργείται ο πλούσιος επεξεργαστής με τη γραμμή εργαλείων μέσα στο #tuiEditor");
  const md = ed.getMarkdown();
  assert(/^# Τίτλος/.test(md) && /\*\*έντονο\*\*/.test(md) && /- α\n- β/.test(md), "το υπάρχον Markdown ανοίγει και ξαναβγαίνει ως Markdown (τίτλος, έντονο, λίστα)", md);
  assert(changes === 0, "το άνοιγμα ΔΕΝ μετράει ως αλλαγή (δεν τρέχει onChange όσο δεν έχει πειράξει κάτι ο χρήστης)", changes);
  w.document.querySelector("#tb-bold").dispatchEvent(new w.Event("click", { bubbles: true }));
  ed.setMarkdown("Νέο κείμενο");
  assert(ed.getMarkdown() === "Νέο κείμενο", "το setMarkdown αλλάζει το περιεχόμενο");
  const t1 = w.document.querySelector("#tb-bold");
  assert(t1.getAttribute("aria-label") === "Bold" && t1.getAttribute("aria-pressed") === "false", "η γραμμή είναι συνδεδεμένη με τον επεξεργαστή (aria-pressed ενημερώνεται)");
  ed.destroy();
  assert(host.children.length === 0 && !w.document.querySelector(".ProseMirror"), "το destroy αδειάζει το #tuiEditor ΚΑΙ σβήνει τον επεξεργαστή (καμία κρεμασμένη επιφάνεια)");
  const again = mount(w, { markdown: "δεύτερο" });
  assert(w.document.querySelectorAll(".rte").length === 1 && again.ed.getMarkdown() === "δεύτερο", "νέα δημιουργία μετά το destroy: ΕΝΑΣ επεξεργαστής, όχι δύο (όπως όταν ανοίγεις άλλο έγγραφο)");
  const e = mount(w, {}).ed; assert(e.getMarkdown() === "", "χωρίς markdown ξεκινά με άδειο κείμενο και χωρίς σφάλμα");
}

// ---------------------------------------------------------------------------------------------------------------------
section("4. ΧΩΡΙΣ εικόνες: ούτε κουμπί, ούτε επικόλληση, ούτε σύρσιμο (το πρόβλημα της αποτυχημένης δημοσίευσης)");
{
  const w = makeWindow();
  const { host, ed } = mount(w, { markdown: "αρχικό" });
  const ids = [...host.querySelectorAll("button.tb")].map((b) => b.id);
  assert(!ids.includes("tb-image") && ids.includes("tb-link") && ids.includes("tb-table") && ids.includes("tb-bold"), "ΔΕΝ υπάρχει κουμπί «Εικόνα», οι υπόλοιπες ομάδες μένουν", ids);
  assert(!host.querySelector("input[type=file]"), "δεν υπάρχει πεδίο επιλογής αρχείου");
  const pm = host.querySelector(".ProseMirror");
  const note = () => host.querySelector(".rte-note");
  const paste = (files, texts = {}) => { const ev = new w.Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(ev, "clipboardData", { value: { files, types: ["Files", ...Object.keys(texts)], items: [], getData: (t) => texts[t] || "" } }); pm.dispatchEvent(ev); return ev.defaultPrevented; };
  const drop = (files) => { const ev = new w.Event("drop", { bubbles: true, cancelable: true }); Object.defineProperty(ev, "dataTransfer", { value: { files, types: ["Files"], items: [], getData: () => "" } }); ev.clientX = 5; ev.clientY = 5; pm.dispatchEvent(ev); return ev.defaultPrevented; };
  w.document.elementFromPoint = () => pm; // το jsdom δεν έχει γεωμετρία οθόνης: το ProseMirror χρειάζεται ένα στοιχείο κάτω από τον δείκτη για να βρει θέση στο έγγραφο (στον πραγματικό Chromium δοκιμάστηκε χωρίς αυτό)
  const png = { type: "image/png", name: "a.png" };
  assert(paste([png]) === true && /Images aren't supported/.test(note().textContent) && note().className === "rte-note err" && note().hidden === false, "επικόλληση εικόνας: ο browser ΔΕΝ την επεξεργάζεται (preventDefault) και ο χρήστης βλέπει μήνυμα σφάλματος", note().textContent);
  assert(ed.getMarkdown() === "αρχικό" && host.querySelectorAll("img").length === 0, "... και δεν μπήκε τίποτα στο κείμενο");
  assert(paste([{ type: "image/jpeg", name: "a.jpg" }]) && paste([{ type: "image/webp", name: "a.webp" }]) && paste([{ type: "image/gif", name: "a.gif" }]), "το ίδιο για jpeg, webp, gif");
  assert(paste([{ type: "application/pdf", name: "a.pdf" }]) === true, "άλλο αρχείο (pdf) μέσα στο πρόχειρο: κι αυτό σταματά με μήνυμα (ο browser δεν θα το άνοιγε)");
  note().textContent = ""; note().hidden = true;
  assert(drop([png]) === true && /Images aren't supported/.test(note().textContent), "ΣΥΡΣΙΜΟ εικόνας μέσα στο πεδίο: σταματά (preventDefault) και δείχνει μήνυμα: αλλιώς ο browser θα άνοιγε την εικόνα και θα έφευγε από τη σελίδα, χάνοντας το κείμενο που δεν αποθηκεύτηκε", note().textContent);
  assert(drop([{ type: "application/pdf", name: "a.pdf" }]) === true, "σύρσιμο άλλου αρχείου (pdf): το ίδιο");
  note().textContent = ""; note().hidden = true;
  paste([], { "text/plain": "απλό κείμενο", "text/html": "<p>απλό κείμενο</p>" });
  assert(note().hidden === true && note().textContent === "" && /απλό κείμενο/.test(ed.getMarkdown()), "επικόλληση ΚΕΙΜΕΝΟΥ δεν σταματά: το κείμενο μπαίνει κανονικά και ΔΕΝ εμφανίζεται μήνυμα για εικόνες (μόνο τα αρχεία σταματούν)", [note().textContent, ed.getMarkdown()]);
  ed.setMarkdown("Κείμενο <img src=x onerror=\"window.__x=1\"> μέσα");
  assert(!pm.querySelector("img[onerror]") && w.__x === undefined, "εικόνα μέσα σε HTML στο κείμενο δεν γίνεται εικόνα με χειριστή γεγονότος");
}
{
  const w = makeWindow();
  const ed = mount(w, { markdown: "Εικόνα: ![στιγμιότυπο](data:image/png;base64,AAAA) τέλος" }).ed;
  const note = w.document.querySelector(".rte-note");
  assert(/embedded images/.test(note.textContent) && note.className === "rte-note err", "έγγραφο που ΗΔΗ έχει ενσωματωμένη (base64) εικόνα: ο χρήστης προειδοποιείται ότι μπορεί να εμποδίσει τη δημοσίευση", note.textContent);
  const w2 = makeWindow();
  mount(w2, { markdown: "Εικόνα από σύνδεσμο: ![λογότυπο](https://example.com/a.png) τέλος" });
  assert(w2.document.querySelector(".rte-note").hidden === true, "εικόνα με απλό σύνδεσμο https (όχι base64) ΔΕΝ προκαλεί προειδοποίηση");
}

// ---------------------------------------------------------------------------------------------------------------------
section("5. Ορθογράφος: καμία κλειδωμένη γλώσσα (έγγραφα σε ελληνικά ΚΑΙ αγγλικά)");
{
  const w = makeWindow();
  const { host } = mount(w, { markdown: "α" });
  const pm = host.querySelector(".ProseMirror");
  assert(!pm.hasAttribute("lang") && pm.getAttribute("spellcheck") === "true" && pm.getAttribute("role") === "textbox", "η επιφάνεια γραφής ΔΕΝ έχει lang (ο ορθογράφος του browser διαλέγει μόνος του), έχει spellcheck και role=textbox");
  const ed = w.IdmonDocEditor.create(host, { markdown: "α" });
  ed.setMarkdown("β"); w.document.querySelector("#tb-bold").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert(!host.querySelector(".ProseMirror").hasAttribute("lang"), "... ούτε μετά από αλλαγές στο κείμενο");
}

// ---------------------------------------------------------------------------------------------------------------------
section("6. Ελληνικά και αγγλικά (η γλώσσα διαβάζεται τη στιγμή της δημιουργίας)");
{
  const en = makeWindow({ lang: "en" });
  const a = mount(en, { markdown: "α" }).host;
  assert(a.querySelector("#tb-bold").getAttribute("aria-label") === "Bold" && a.querySelector(".rte-toolbar").getAttribute("aria-label") === "Text formatting" && a.querySelector(".ProseMirror").getAttribute("aria-label") === "Document text", "αγγλικά: γραμμή και επιφάνεια γραφής");
  // Όπως στο SMB: το <html lang> είναι αρχικά «en» και το shared.js το αλλάζει ΜΕΤΑ το φόρτωμα των σκριπτ.
  const w = makeWindow({ lang: "en" });
  w.document.documentElement.lang = "el";
  const g = mount(w, { markdown: "α" }).host;
  assert(g.querySelector("#tb-bold").getAttribute("aria-label") === "Έντονα" && g.querySelector("#tb-heading").getAttribute("aria-label") === "Επικεφαλίδα" && g.querySelector(".ProseMirror").getAttribute("aria-label") === "Κείμενο εγγράφου", "ελληνικά ΑΚΟΜΑ κι όταν το lang άλλαξε μετά το φόρτωμα των σκριπτ (η πραγματική σειρά στο SMB)");
  const pm = g.querySelector(".ProseMirror");
  const ev = new w.Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(ev, "clipboardData", { value: { files: [{ type: "image/png", name: "a.png" }], types: ["Files"], items: [], getData: () => "" } }); pm.dispatchEvent(ev);
  assert(/Οι εικόνες δεν υποστηρίζονται ακόμα/.test(g.querySelector(".rte-note").textContent), "το μήνυμα για την εικόνα είναι στα ελληνικά όταν η σελίδα είναι ελληνική");
}

// ---------------------------------------------------------------------------------------------------------------------
section("7. Εφεδρικό απλό πεδίο κειμένου: ο πελάτης δεν μένει ποτέ χωρίς τρόπο να γράψει");
{
  const noEngine = makeWindow({ engine: false });
  let changes = 0;
  const { host, ed } = mount(noEngine, { markdown: "# υπάρχον κείμενο", onChange: () => { changes++; } });
  const ta = host.querySelector("textarea.doc-fallback");
  assert(ed.kind === "plain" && !!ta && ta.value === "# υπάρχον κείμενο" && !host.querySelector(".rte"), "χωρίς μηχανή: απλό πεδίο κειμένου με το υπάρχον κείμενο μέσα");
  ta.value = "# αλλαγμένο"; ta.dispatchEvent(new noEngine.Event("input", { bubbles: true }));
  assert(ed.getMarkdown() === "# αλλαγμένο" && changes === 1, "γράφεις και το getMarkdown() επιστρέφει το κείμενο, το onChange τρέχει (προεπισκόπηση)");
  assert(ta.getAttribute("aria-label") === "Document text", "το πεδίο έχει όνομα για αναγνώστη οθόνης");
  ed.setMarkdown("νέο"); assert(ta.value === "νέο", "setMarkdown δουλεύει και στο εφεδρικό");
  ed.destroy(); assert(host.children.length === 0, "destroy αδειάζει το στοιχείο");

  const noBar = makeWindow({ toolbar: false });
  assert(mount(noBar, { markdown: "α" }).ed.kind === "plain", "χωρίς τη γραμμή εργαλείων: κι εδώ πέφτει σε απλό πεδίο");

  const boom = makeWindow();
  boom.IdmonEditor.create = () => { throw new Error("η μηχανή έσκασε"); };
  const b = mount(boom, { markdown: "κείμενο που δεν πρέπει να χαθεί" });
  assert(b.ed.kind === "plain" && b.host.querySelector("textarea").value === "κείμενο που δεν πρέπει να χαθεί" && !b.host.querySelector(".rte"), "αν η μηχανή ΣΚΑΣΕΙ κατά την εκκίνηση: απλό πεδίο με το κείμενο ΙΔΙΟ, και κανένα μισοφτιαγμένο ίχνος του πλούσιου επεξεργαστή");
  const el = makeWindow({ lang: "el", engine: false }); const f = mount(el, { markdown: "α" }).host.querySelector("textarea");
  assert(f.getAttribute("aria-label") === "Κείμενο εγγράφου", "το εφεδρικό πεδίο έχει όνομα στα ελληνικά όταν η σελίδα είναι ελληνική");
}

// ---------------------------------------------------------------------------------------------------------------------
section("8. Εμφάνιση: το κοινό CSS δουλεύει χωρίς το team.css (το SMB δεν το φορτώνει)");
{
  assert(/\.rte \.btn\{display:inline-flex/.test(CSS) && /\.rte \.btn\.secondary\{/.test(CSS) && /\.rte input\[type=text\]\{/.test(CSS), "τα βασικά στυλ κουμπιών και πεδίων της γραμμής είναι ΜΕΣΑ στο idmon-editor.css (όχι μόνο στο team.css)");
  assert(/:where\(:root\)\{[^}]*--h-btn:44px[^}]*--r:8px/.test(CSS) && /--fs-md:1rem/.test(CSS) && /--field-border:/.test(CSS), "έχει προεπιλογές για τα tokens που το shared.css του SMB δεν ορίζει (μεγέθη, ύψος κουμπιού, ακτίνα, χρώμα πεδίου)");
  assert(/#tuiEditor \.rte-body\{height:420px/.test(PAGE) && /#tuiEditor \.doc-fallback\{/.test(PAGE), "η σελίδα δίνει στον επεξεργαστή και στο εφεδρικό πεδίο το ύψος του παλιού Toast (420px)");
  assert(!/(^|\n)\.btn\{/.test(CSS) && !/(^|\n)(input|textarea|button)\s*\{/.test(CSS), "το κοινό CSS δεν έχει καθολικούς κανόνες για button, input ή textarea (δεν επηρεάζει τίποτα έξω από τον επεξεργαστή)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
