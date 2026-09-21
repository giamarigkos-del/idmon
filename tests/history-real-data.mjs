// Τεστ ιστορικού συζήτησης με ΕΚΤΕΤΑΜΕΝΑ έγγραφα (2.772 λέξεις, 13 chunks,
// ενώ η αναζήτηση φέρνει μόνο 4 κάθε φορά -- ΣΗΜΕΙΩΣΗ: ένα chunk είναι 300
// ΛΕΞΕΙΣ) και ΠΡΑΓΜΑΤΙΚΟ Gemini/Vectorize. Εδώ η διπλή αναζήτηση και το
// ιστορικό δοκιμάζονται στα σοβαρά: τα follow-ups ("Και για τα νησιά;",
// "Και πόσο κοστίζει;") δεν μπορούν να απαντηθούν χωρίς να ξέρουμε το
// προηγούμενο θέμα, και το θέμα αλλάζει στη μέση συζητήσεων. Ο κατάλογος
// προϊόντων έχει 12 προϊόντα ίδιας δομής, άρα ένα "Και πόσο κοστίζει;"
// ταιριάζει σε όλα και μόνο το ιστορικό λέει ποιο εννοούμε.
//
// Πώς τρέχει:
//   1. Σε ένα τερματικό: npx wrangler dev
//   2. Σε άλλο: node tests/history-real-data.mjs
//
// Τα έγγραφα είναι φανταστικά (κατάστημα "HomeTech"), στον φάκελο
// tests/fixtures/hometech/, ώστε να ξέρουμε ΤΗΝ σωστή απάντηση σε κάθε
// ερώτηση. Φτιάχνεται προσωρινό account (5 έγγραφα = το όριο του Free plan),
// γίνονται ~60 ερωτήσεις (μετράνε στο μηνιαίο όριο των 100 του test account)
// και στο τέλος το account διαγράφεται μαζί με τα vectors του.
//
// Κάθε follow-up ρωτιέται ΔΥΟ φορές: ΜΕ ιστορικό (αυτό ελέγχεται) και ΧΩΡΙΣ
// (ενημερωτικό, δείχνει τι θα γινόταν πριν την αλλαγή). Στο τέλος τυπώνεται
// σύγκριση. Η συμπεριφορά ενός LLM δεν είναι 100% προβλέψιμη: αν κάποιο ✗
// εμφανιστεί, διάβασε την απάντηση, μπορεί να είναι σωστή με άλλη διατύπωση.
//
// Προαιρετικά: BASE_URL=http://127.0.0.1:8787 (προεπιλογή).

import { readFileSync } from "fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8787";
const TEST_EMAIL = `history-real-${Date.now()}@example.com`;
const TEST_PASSWORD = "correct-horse-battery-staple";
const MAX_HISTORY_MESSAGES = 6; // ίδιο με το widget/backend
const MAX_HISTORY_MESSAGE_CHARS = 500;

const DOCS = [
  { id: "ht-shipping-payments", title: "Αποστολές και τρόποι πληρωμής", file: "01-shipping-payments.txt", sentinel: ["Πόσο κοστίζουν τα μεταφορικά για την ηπειρωτική Ελλάδα;", /3[,.]5/] },
  { id: "ht-returns", title: "Επιστροφές και ακυρώσεις", file: "02-returns.txt", sentinel: ["Πόσες ημέρες έχω για να επιστρέψω ένα προϊόν;", /14/] },
  { id: "ht-warranty", title: "Εγγύηση και service", file: "03-warranty.txt", sentinel: ["Πόσα χρόνια εγγύηση έχουν οι ηλεκτρικές σκούπες;", /3/] },
  { id: "ht-stores", title: "Καταστήματα και ωράρια", file: "04-stores.txt", sentinel: ["Τι ώρες είστε ανοιχτά στην Πάτρα;", /14:30|20:00/] },
  { id: "ht-catalog", title: "Κατάλογος προϊόντων", file: "05-catalog.txt", sentinel: ["Πόσο κοστίζει το air fryer AirCrisp 5L;", /129/] },
];

// Κάθε turn: q = ερώτηση, expect = όλα τα regex πρέπει να ταιριάζουν,
// forbid = κανένα δεν πρέπει να ταιριάζει.
const CONVERSATIONS = [
  {
    name: "Μεταφορικά: ηπειρωτική, νησιά, δωρεάν αποστολή",
    turns: [
      { q: "Πόσο κοστίζουν τα μεταφορικά για την ηπειρωτική Ελλάδα;", expect: [/3[,.]5/] },
      { q: "Και για τα νησιά;", expect: [/6[,.]9/] },
      // Χωρίς forbid: το Gemini συχνά απαντά ΣΩΣΤΑ αλλά με όλες τις περιοχές (60, 90, 120),
      // κάτι που δεν είναι λάθος -- το forbid τα σημείωνε ψευδώς ως αποτυχία.
      { q: "Από ποιο ποσό είναι δωρεάν;", expect: [/120/] },
    ],
  },
  {
    name: "Δόσεις: το ποσό της παραγγελίας καθορίζει τον αριθμό",
    turns: [
      { q: "Μπορώ να πληρώσω με δόσεις;", expect: [/άτοκ/i] },
      { q: "Και αν η παραγγελία μου είναι 350 ευρώ;", expect: [/\b6\b/] },
    ],
  },
  {
    name: "Εγγύηση: 4 γύροι (ξεπερνά το όριο των 6 μηνυμάτων ιστορικού)",
    turns: [
      { q: "Πόσα χρόνια εγγύηση έχουν οι ηλεκτρικές σκούπες;", expect: [/3|τρία|τρεις/i] },
      { q: "Και οι μηχανές καφέ;", expect: [/(2|δύο)\s*(έτη|χρόνια)/i] },
      { q: "Τι δεν καλύπτεται;", expect: [/άλατ|αφαλάτ/i] },
      { q: "Και οι ηλεκτρικές ξυριστικές;", expect: [/(\b1\b|ένα|ένας)\s*(έτος|χρόνο)/i] },
    ],
  },
  {
    name: "Επιστροφές, και μετά ΑΛΛΑΓΗ ΘΕΜΑΤΟΣ σε ωράριο",
    turns: [
      { q: "Πόσες ημέρες έχω για να επιστρέψω ένα προϊόν;", expect: [/14/] },
      { q: "Ποιος πληρώνει τα έξοδα;", expect: [/4[,.]0|4 ?€|4 ευρώ/] },
      { q: "Τι ώρες είναι ανοιχτό το κατάστημα στη Θεσσαλονίκη;", expect: [/9:30|09:30/, /20:30/] },
    ],
  },
  {
    name: "Ωράρια καταστημάτων: η πόλη μένει από την προηγούμενη ερώτηση",
    turns: [
      { q: "Τι ώρες είστε ανοιχτά στην Πάτρα;", expect: [/10:00/, /20:00/] },
      { q: "Και το Σάββατο;", expect: [/14:30/], forbid: [/15:00/, /16:00/] },
      { q: "Και στη Θεσσαλονίκη;", expect: [/15:00/], forbid: [/14:30/] },
    ],
  },
  {
    name: "Μεγάλες συσκευές",
    turns: [
      { q: "Πώς παραδίδονται τα πλυντήρια ρούχων;", expect: [/19/] },
      { q: "Και στα νησιά;", expect: [/35/] },
    ],
  },
  {
    name: "Αντικαταβολή",
    turns: [
      { q: "Πόσο κοστίζει η αντικαταβολή;", expect: [/2[,.]0/] },
      { q: "Υπάρχει μέγιστο ποσό;", expect: [/500/] },
    ],
  },
  {
    name: "Κατάλογος: air fryer (12 προϊόντα ίδιας δομής, το θέμα το ξέρει μόνο το ιστορικό)",
    turns: [
      { q: "Τι χωρητικότητα έχει το air fryer AirCrisp 5L;", expect: [/5 ?λίτρ|5 ?L/i] },
      { q: "Και πόσο κοστίζει;", expect: [/129/], forbid: [/179/] },
      { q: "Και το μεγαλύτερο μοντέλο;", expect: [/8 ?λίτρ|8 ?L|179/i] },
    ],
  },
  {
    name: "Κατάλογος: σκούπες (σύγκριση δύο μοντέλων με τη σειρά)",
    turns: [
      { q: "Πόση αυτονομία μπαταρίας έχει η σκούπα CleanPro V8;", expect: [/60/] },
      { q: "Και η CleanPro Lite;", expect: [/35/] },
      // Χωρίς forbid: μια σωστή απάντηση μπορεί να προσθέτει "(η V8 κοστίζει 249 €)".
      { q: "Πόσο κοστίζει;", expect: [/149/] },
    ],
  },
  {
    name: "Κατάλογος: ψυγείο",
    turns: [
      { q: "Πόσα λίτρα είναι το ψυγείο FrostLine 300;", expect: [/300/] },
      { q: "Τι ενεργειακή κλάση έχει;", expect: [/\bD\b/] },
      { q: "Και πόσο κοστίζει;", expect: [/649/] },
    ],
  },
  {
    name: "Πολλά έγγραφα σε μία συζήτηση: προϊόν, παράδοση, νησιά, εγκατάσταση",
    turns: [
      { q: "Πόσο κοστίζει το πλυντήριο WashWell 9;", expect: [/479/] },
      { q: "Πώς παραδίδεται;", expect: [/19/] },
      { q: "Και αν το θέλω σε νησί;", expect: [/35/] },
      { q: "Και υπάρχει εγκατάσταση;", expect: [/39/], forbid: [/\b29\b/, /\b49\b/] },
    ],
  },
];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonHeaders = (token) => ({ "Content-Type": "application/json", "X-Session-Token": token });
const oneLine = (s, n = 260) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

async function ask(token, question, history) {
  const body = history && history.length ? { question, history } : { question };
  const res = await fetch(`${BASE_URL}/query`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) });
  const data = await res.json();
  if (res.status === 429 && data.limitReached) {
    console.log("\n❌ Χτύπησε το όριο μηνυμάτων του test account. Έλεγξε το MONTHLY_MESSAGE_LIMIT_OVERRIDE στο .dev.vars (σβήσ' το προσωρινά) και ξανατρέξε.");
    throw new Error("limit reached");
  }
  if (!res.ok) throw new Error(`/query status ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function uploadAndPublish(token, doc) {
  const text = readFileSync(new URL(`./fixtures/hometech/${doc.file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const up = await fetch(`${BASE_URL}/upload`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ documentId: doc.id, title: doc.title, text }),
  });
  if (!up.ok) throw new Error(`upload ${doc.id}: ${up.status} ${await up.text()}`);
  const pub = await fetch(`${BASE_URL}/document/${encodeURIComponent(doc.id)}/publish`, { method: "POST", headers: jsonHeaders(token) });
  if (!pub.ok) throw new Error(`publish ${doc.id}: ${pub.status} ${await pub.text()}`);
}

// Το Vectorize δεν είναι πάντα άμεσα συνεπές: περιμένουμε (μέχρι ~45") να
// φανεί το κάθε έγγραφο στις αναζητήσεις, με μία ερώτηση-δείκτη ανά έγγραφο.
async function waitUntilIndexed(token, doc) {
  const [question, regex] = doc.sentinel;
  for (let i = 0; i < 15; i++) {
    const data = await ask(token, question);
    if (!data.isFallback && regex.test(data.answer)) return true;
    await sleep(3000);
  }
  return false;
}

// Ίδιος κανόνας με το widget: μετά από κάθε επιτυχημένη ανταλλαγή προστίθενται
// 2 μηνύματα, κρατάμε τα τελευταία 6, κάθε μήνυμα το πολύ 500 χαρακτήρες.
function remember(history, question, answer) {
  const next = [
    ...history,
    { role: "user", text: question.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
    { role: "assistant", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
  ];
  return next.length > MAX_HISTORY_MESSAGES ? next.slice(-MAX_HISTORY_MESSAGES) : next;
}

function check(answer, turn) {
  const missing = (turn.expect || []).filter((re) => !re.test(answer));
  const forbidden = (turn.forbid || []).filter((re) => re.test(answer));
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

async function run() {
  console.log(`Test email: ${TEST_EMAIL}`);

  const signupRes = await fetch(`${BASE_URL}/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const signup = await signupRes.json();
  const token = signup.sessionToken;
  if (!token) throw new Error("signup απέτυχε: " + JSON.stringify(signup));

  let followUps = 0;
  let withHistoryOk = 0;
  let controlOk = 0;
  let helped = 0; // με ιστορικό ΣΩΣΤΟ, χωρίς ιστορικό ΛΑΘΟΣ
  let sourceChanged = 0; // η πηγή (top έγγραφο) άλλαξε χάρη στο ιστορικό

  try {
    console.log("\n[Ανέβασμα 5 εγγράφων (2.772 λέξεις, 13 chunks)]");
    for (const doc of DOCS) await uploadAndPublish(token, doc);
    console.log("  ✓ ανέβηκαν και δημοσιεύτηκαν");

    console.log("\n[Αναμονή να ευρετηριαστούν στο Vectorize]");
    for (const doc of DOCS) {
      const ok = await waitUntilIndexed(token, doc);
      assert(ok, `βρέθηκε το έγγραφο "${doc.title}"`);
      if (!ok) throw new Error("Τα έγγραφα δεν ευρετηριάστηκαν έγκαιρα, ξανατρέξε σε λίγο");
    }

    for (const conv of CONVERSATIONS) {
      console.log(`\n=== ${conv.name} ===`);
      let history = [];

      for (let i = 0; i < conv.turns.length; i++) {
        const turn = conv.turns[i];
        const isFollowUp = i > 0;
        const data = await ask(token, turn.q, history);
        const verdict = check(data.answer, turn);

        console.log(`\n  ❯ ${turn.q}${isFollowUp ? "   (με ιστορικό " + history.length + " μηνυμάτων)" : ""}`);
        console.log(`     απάντηση: ${oneLine(data.answer)}`);
        console.log(`     πηγή: ${data.primarySource ? data.primarySource.title : "(καμία)"}`);
        const detail = [];
        if (verdict.missing.length) detail.push("λείπει: " + verdict.missing.map(String).join(", "));
        if (verdict.forbidden.length) detail.push("δεν έπρεπε να υπάρχει: " + verdict.forbidden.map(String).join(", "));
        assert(verdict.ok && !data.isFallback, `ΜΕ ιστορικό: σωστή απάντηση${detail.length ? " (" + detail.join(" | ") + ")" : ""}`);

        if (isFollowUp) {
          followUps++;
          if (verdict.ok && !data.isFallback) withHistoryOk++;

          // Ενημερωτικό: η ίδια ερώτηση ΧΩΡΙΣ ιστορικό.
          const control = await ask(token, turn.q);
          const cv = check(control.answer, turn);
          const controlPassed = cv.ok && !control.isFallback;
          if (controlPassed) controlOk++;
          if (verdict.ok && !data.isFallback && !controlPassed) helped++;
          const s1 = data.primarySource ? data.primarySource.documentId : null;
          const s2 = control.primarySource ? control.primarySource.documentId : null;
          if (s1 !== s2) sourceChanged++;
          console.log(`     [ενημερωτικό] ΧΩΡΙΣ ιστορικό: ${controlPassed ? "επίσης σωστή" : "ΛΑΘΟΣ/άγνωστο"} -> ${oneLine(control.answer, 200)}`);
          console.log(`     [ενημερωτικό] πηγή χωρίς ιστορικό: ${control.primarySource ? control.primarySource.title : "(καμία)"}`);
        }

        // Όπως το widget: θυμόμαστε μόνο ολοκληρωμένες ανταλλαγές.
        history = remember(history, turn.q, data.answer);
      }
    }
  } finally {
    console.log("\n[Καθαρισμός -- διαγραφή του test account και των vectors του]");
    try {
      const del = await fetch(`${BASE_URL}/account/delete`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      assert(del.ok, "το test account διαγράφηκε");
    } catch (err) {
      console.log("  ✗ ο καθαρισμός απέτυχε: " + err.message);
      failed++;
    }
  }

  console.log("\n=== ΣΥΓΚΡΙΣΗ (μόνο τα follow-ups, όπου το ιστορικό μετράει) ===");
  console.log(`  follow-ups συνολικά:                 ${followUps}`);
  console.log(`  σωστά ΜΕ ιστορικό:                   ${withHistoryOk} / ${followUps}`);
  console.log(`  σωστά ΧΩΡΙΣ ιστορικό (πριν):         ${controlOk} / ${followUps}`);
  console.log(`  διορθώθηκαν χάρη στο ιστορικό:       ${helped}`);
  console.log(`  άλλαξε το κύριο έγγραφο-πηγή:        ${sourceChanged} / ${followUps}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("\nΣφάλμα:", err.message);
  process.exit(1);
});
