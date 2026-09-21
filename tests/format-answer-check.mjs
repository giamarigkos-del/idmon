// Έλεγχος του μορφοποιητή απαντήσεων (Βήμα 2δ): κουκκίδες, αριθμημένες λίστες, πλάγια,
// έντονα, ασφάλεια, και ότι το widget.js και το shared.js δίνουν ΠΑΝΤΑ το ίδιο αποτέλεσμα.
//
// ΔΕΝ χρειάζεται wrangler dev ούτε δίκτυο. Κόβει τον ΠΡΑΓΜΑΤΙΚΟ κώδικα του μορφοποιητή από
// τα δύο αρχεία (ανάμεσα στους δείκτες "formatAnswer (Βήμα 2δ) -- ΑΡΧΗ/ΤΕΛΟΣ") και τον τρέχει.
//
// Τρέξιμο: node tests/format-answer-check.mjs

import { readFileSync } from "fs";

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
const START = "// --- formatAnswer (Βήμα 2δ) -- ΑΡΧΗ ---";
const END = "// --- formatAnswer (Βήμα 2δ) -- ΤΕΛΟΣ ---";

function slice(source, name) {
  const s = source.indexOf(START);
  const e = source.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    console.log(`✗ Δεν βρέθηκαν οι δείκτες του μορφοποιητή στο ${name}`);
    process.exit(1);
  }
  return source.slice(s, e);
}

// Ο escapeHtml κάθε αρχείου (διαβάζεται από το ίδιο το αρχείο, όχι αντιγραμμένος εδώ).
function escapeFrom(source) {
  const m = /function escapeHtml\(str\) \{[\s\S]*?\n\s*\}\n/.exec(source);
  if (!m) { console.log("✗ Δεν βρέθηκε ο escapeHtml"); process.exit(1); }
  return m[0];
}

const widgetSrc = read("../public/widget.js");
const sharedSrc = read("../public/shared.js");
const widgetFmt = new Function(escapeFrom(widgetSrc) + "\n" + slice(widgetSrc, "widget.js") + "\nreturn formatAnswer;")();
const sharedFmt = new Function(escapeFrom(sharedSrc) + "\n" + slice(sharedSrc, "shared.js") + "\nreturn formatAnswer;")();

// Τα ίδια assertions σε ΚΑΘΕ υλοποίηση.
function eachImpl(fn) {
  fn(widgetFmt, "widget.js");
  fn(sharedFmt, "shared.js");
}

const balanced = (html) => ["ul", "ol", "li", "strong", "em"].every((t) => (html.match(new RegExp(`<${t}[ >]`, "g")) || []).length === (html.match(new RegExp(`</${t}>`, "g")) || []).length);

function testBasics() {
  console.log("\n[Βασικά -- συμβατότητα με την παλιά συμπεριφορά]");
  eachImpl((f, name) => {
    assert(f("Καλημέρα") === "Καλημέρα", `${name}: απλό κείμενο αμετάβλητο`);
    assert(f("a\nb") === "a<br>b", `${name}: αλλαγή γραμμής -> <br>`);
    assert(f("**έντονη** λέξη") === "<strong>έντονη</strong> λέξη", `${name}: **έντονο** -> <strong>`);
    assert(f("") === "" && f("   \n  ") === "", `${name}: κενό -> κενό`);
    assert(f("a\n\n\n\nb") === "a<br><br>b", `${name}: πολλές κενές γραμμές -> ένας διαχωρισμός παραγράφων`);
    assert(f("Τίτλος:\n\nκείμενο") === "Τίτλος:<br><br>κείμενο", `${name}: κενή γραμμή ανάμεσα σε παραγράφους = διαχωρισμός`);
  });
}

function testBulletLists() {
  console.log("\n[Κουκκίδες]");
  eachImpl((f, name) => {
    assert(f("Τίτλος:\n* α\n* β") === "Τίτλος:<ul><li>α</li><li>β</li></ul>", `${name}: κείμενο και μετά λίστα με *`);
    assert(f("- α\n- β") === "<ul><li>α</li><li>β</li></ul>", `${name}: λίστα με -`);
    assert(f("• α\n• β") === "<ul><li>α</li><li>β</li></ul>", `${name}: λίστα με •`);
    assert(f("* α\n\nΚείμενο μετά") === "<ul><li>α</li></ul>Κείμενο μετά", `${name}: παράγραφος μετά από λίστα χωρίς έξτρα <br>`);
    const real = "Για τα νησιά (Κυκλάδες, Δωδεκάνησα):\n* Το κόστος είναι 6,90 €, δωρεάν άνω των 120 €.\n\nΓια την Κρήτη (έχει δική της τιμολόγηση):\n* Το κόστος είναι 4,90 €.";
    assert(f(real) === "Για τα νησιά (Κυκλάδες, Δωδεκάνησα):<ul><li>Το κόστος είναι 6,90 €, δωρεάν άνω των 120 €.</li></ul>Για την Κρήτη (έχει δική της τιμολόγηση):<ul><li>Το κόστος είναι 4,90 €.</li></ul>", `${name}: πραγματική απάντηση του Gemini (νησιά/Κρήτη)`);
    assert(f("-5 °C τη νύχτα") === "-5 °C τη νύχτα", `${name}: "-5" χωρίς κενό ΔΕΝ είναι κουκκίδα`);
    assert(f("* **Κόστος:** *περίπου* 5 €") === "<ul><li><strong>Κόστος:</strong> <em>περίπου</em> 5 €</li></ul>", `${name}: έντονο και πλάγιο μέσα σε κουκκίδα`);
  });
}

function testNumberedAndNested() {
  console.log("\n[Αριθμημένες λίστες και υπο-κουκκίδες]");
  eachImpl((f, name) => {
    assert(f("1. α\n2. β") === "<ol><li>α</li><li>β</li></ol>", `${name}: αριθμημένη λίστα`);
    assert(f("3. γ\n4. δ") === '<ol start="3"><li>γ</li><li>δ</li></ol>', `${name}: λίστα που ξεκινά από 3 κρατά την αρίθμηση`);
    assert(f("1) α\n2) β") === "<ol><li>α</li><li>β</li></ol>", `${name}: 1) όπως 1.`);
    assert(f("1. Α:\nΠαράγραφος:\n* κ1\n* κ2\n2. Β") === '<ol><li>Α:</li></ol>Παράγραφος:<ul><li>κ1</li><li>κ2</li></ul><ol start="2"><li>Β</li></ol>', `${name}: 1. / κείμενο / κουκκίδες / 2. (το είδος που έβγαλε το Gemini στο έγγραφο προμήθειας)`);
    assert(f("* α\n  * α1\n  * α2\n* β") === "<ul><li>α<ul><li>α1</li><li>α2</li></ul></li><li>β</li></ul>", `${name}: υπο-κουκκίδες με εσοχή`);
    assert(f("12. Δώδεκα") === '<ol start="12"><li>Δώδεκα</li></ol>', `${name}: διψήφιος αριθμός`);
    assert(f("2026. Ξεκίνησε το κατάστημα") === "2026. Ξεκίνησε το κατάστημα", `${name}: τετραψήφιος αριθμός (χρονολογία) ΔΕΝ γίνεται λίστα`);
  });
}

function testInline() {
  console.log("\n[Πλάγια και επικεφαλίδες]");
  eachImpl((f, name) => {
    assert(f("*Σημείωση:* κείμενο") === "<em>Σημείωση:</em> κείμενο", `${name}: *πλάγιο* στην αρχή`);
    assert(f("κάτι (*σημείωση*) εδώ") === "κάτι (<em>σημείωση</em>) εδώ", `${name}: πλάγιο μέσα σε παρένθεση`);
    assert(f("2 * 3 * 4") === "2 * 3 * 4", `${name}: πολλαπλασιασμός ΔΕΝ γίνεται πλάγιο`);
    assert(f("5* και 6*") === "5* και 6*", `${name}: αστεράκια χωρίς ζευγάρι μένουν`);
    assert(f("*") === "*" && f("**") === "**", `${name}: μοναχικά αστεράκια μένουν`);
    assert(f("## Τίτλος") === "<strong>Τίτλος</strong>", `${name}: ## Τίτλος -> έντονο`);
    assert(f("Το AI λέει **ναι** και *ίσως*.") === "Το AI λέει <strong>ναι</strong> και <em>ίσως</em>.", `${name}: έντονο και πλάγιο στην ίδια γραμμή`);
  });
}

function testSecurity() {
  console.log("\n[Ασφάλεια -- τίποτα από το κείμενο δεν γίνεται ετικέτα]");
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "* <b>x</b>\n* <i onclick=1>y</i>",
    "**<i>x</i>**",
    "1. <a href=javascript:alert(1)>x</a>",
    "## <h1>Τίτλος</h1>",
    "* α\n  * <script>1</script>",
  ];
  eachImpl((f, name) => {
    for (const h of hostile) {
      const out = f(h);
      assert(!/<(script|img|a|b|i|h1)[\s>]/i.test(out.replace(/<\/?(strong|em|ul|ol|li|br)( start="\d+")?>/g, "")), `${name}: ${JSON.stringify(h).slice(0, 40)} -> καμία επικίνδυνη ετικέτα`);
      assert(!/on\w+=/i.test(out.replace(/&lt;[^]*?&gt;/g, "")), `${name}: ${JSON.stringify(h).slice(0, 40)} -> κανένα ενεργό event attribute`);
    }
    assert(f("<b>x</b>") === "&lt;b&gt;x&lt;/b&gt;", `${name}: οι ετικέτες ξεφεύγουν σαν κείμενο`);
    assert(f("Q&A") === "Q&amp;A", `${name}: το & ξεφεύγει`);
    assert(/^<ol start="\d+">/.test(f("7. x")) && !f("7. x").includes("<ol start=\"7\" "), `${name}: το start είναι μόνο αριθμός`);
  });
}

function testStreamingPrefixes() {
  console.log("\n[Streaming -- κάθε ημιτελές πρόθεμα μιας απάντησης δεν σπάει και δίνει ισορροπημένο HTML]");
  const sample = "Ναι, παρέχεται εγκατάσταση:\n\n* **Κόστος:** 39 €\n* *Περιοχές:* Αττική\n  * Μαρούσι\n\n1. Πρώτο\n2. Δεύτερο\n\n## Σημείωση\nΤέλος (*ίσως*) και **έντονο**.";
  eachImpl((f, name) => {
    let ok = true;
    let allBalanced = true;
    for (let i = 0; i <= sample.length; i++) {
      try {
        const out = f(sample.slice(0, i));
        if (typeof out !== "string") ok = false;
        if (!balanced(out)) allBalanced = false;
      } catch (e) {
        ok = false;
      }
    }
    assert(ok, `${name}: και τα ${sample.length + 1} πρόθεματα εκτελούνται χωρίς σφάλμα`);
    assert(allBalanced, `${name}: σε κάθε πρόθεμα οι ετικέτες κλείνουν σωστά`);
    assert(f("**Κόστ") === "**Κόστ", `${name}: ανοιχτό ** μένει κείμενο μέχρι να κλείσει`);
    assert(f("* Το κόστ") === "<ul><li>Το κόστ</li></ul>", `${name}: ημιτελής κουκκίδα εμφανίζεται ήδη ως λίστα`);
  });
}

function testPerformance() {
  console.log("\n[Επιδόσεις -- μεγάλες και δύσκολες απαντήσεις]");
  const hard = ("* α *β γ δ ".repeat(500) + "\n").repeat(20);
  const veryLong = "λέξη ".repeat(20000) + "*";
  eachImpl((f, name) => {
    let t = Date.now();
    f(hard);
    assert(Date.now() - t < 500, `${name}: 100.000 χαρακτήρες με πολλά ανοιχτά αστεράκια σε < 0,5"`);
    t = Date.now();
    f(veryLong);
    assert(Date.now() - t < 500, `${name}: 100.000 χαρακτήρες σε μία γραμμή σε < 0,5"`);
  });
}

function testParity() {
  console.log("\n[Ισοδυναμία widget.js και shared.js]");
  // Χωρίς εισαγωγικά (' "): ο escapeHtml του widget τα ξεφεύγει, του shared.js όχι -- προϋπάρχουσα διαφορά, ασήμαντη
  // γιατί το αποτέλεσμα μπαίνει σε κείμενο και όχι σε attribute.
  const corpus = [
    "Καλημέρα", "a\nb", "**a**", "* α\n* β", "1. α\n2. β\n\nΚείμενο", "* α\n  * β\n* γ", "*Σημείωση:* x", "## Τ\nκείμενο",
    "Για τα νησιά:\n* 6,90 €\n\nΓια την Κρήτη:\n* 4,90 €", "<b>x</b> & <script>", "1. Α:\nΠ:\n* κ\n2. Β", "2 * 3 * 4", "**Κόστ", "* ", "", "\n\n",
    "Ναι, παρέχεται εγκατάσταση:\n* **Κόστος:** 39 €\n* Περιοχές: Αττική\n\nΔιαδικασία: κατόπιν ραντεβού.",
  ];
  let same = 0;
  for (const c of corpus) if (widgetFmt(c) === sharedFmt(c)) same++;
  assert(same === corpus.length, `ίδιο αποτέλεσμα σε όλες τις ${corpus.length} περιπτώσεις (${same}/${corpus.length})`);
}

testBasics();
testBulletLists();
testNumberedAndNested();
testInline();
testSecurity();
testStreamingPrefixes();
testPerformance();
testParity();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
