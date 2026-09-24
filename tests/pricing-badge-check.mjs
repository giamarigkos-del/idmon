// Έλεγχος του public/index.html (η αρχική/σελίδα τιμολόγησης, πρώην pricing.html) για το «Powered by Idmon» (Free/Basic ναι, Pro όχι) --
// και ότι ΔΕΝ άλλαξαν οι τιμές, τα IDs του Paddle και τα κείμενα για το ΦΠΑ (απόφαση Σεπτ. 2026:
// οι τιμές μένουν 29 και 59 ΜΕ ΦΠΑ). ΔΕΝ χρειάζεται wrangler dev ούτε δίκτυο.
//
// Τρέξιμο: node tests/pricing-badge-check.mjs
// (χρειάζεται `npm install jsdom`, όπως και τα υπόλοιπα headless tests.)

import { JSDOM } from "jsdom";
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

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const dom = new JSDOM(html); // χωρίς runScripts: μόνο ανάλυση της δομής
const doc = dom.window.document;

const blocks = { el: doc.getElementById("content-el"), en: doc.getElementById("content-en") };
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

function testBothLanguagesPresent() {
  console.log("\n[Και τα δύο γλωσσικά μπλοκ υπάρχουν]");
  assert(!!blocks.el && !!blocks.en, "content-el και content-en");
}

function plansOf(block) {
  return [...block.querySelectorAll(".plans .plan")];
}

function testBadgeMentions() {
  console.log("\n[«Powered by Idmon»: μόνο το Pro το αφαιρεί]");
  const expected = { el: "Χωρίς «Powered by Idmon» στο widget", en: "No “Powered by Idmon” on the widget" };
  for (const lang of ["el", "en"]) {
    const plans = plansOf(blocks[lang]);
    assert(plans.length === 3, `${lang}: τρεις κάρτες (Free, Basic, Pro)`);
    const [free, basic, pro] = plans;
    assert(!text(free).includes("Powered by Idmon"), `${lang}: η κάρτα Free ΔΕΝ το αναφέρει`);
    assert(!text(basic).includes("Powered by Idmon"), `${lang}: η κάρτα Basic ΔΕΝ το αναφέρει`);
    assert([...pro.querySelectorAll("li")].some((li) => text(li) === expected[lang]), `${lang}: η κάρτα Pro το έχει ως χαρακτηριστικό`);

    const rows = [...blocks[lang].querySelectorAll("table tr")];
    const row = rows.find((r) => text(r.cells[0]).includes("Powered by Idmon"));
    assert(!!row, `${lang}: υπάρχει γραμμή στον πίνακα σύγκρισης`);
    const cells = row ? [...row.cells].map(text) : [];
    assert(cells[1] === "—" && cells[2] === "—" && cells[3] === "✓", `${lang}: πίνακας: Free —, Basic —, Pro ✓`);
    assert(rows.filter((r) => r.cells.length === 4).every((r) => r.cells.length === 4), `${lang}: όλες οι γραμμές του πίνακα έχουν 4 στήλες`);

    const faq = [...blocks[lang].querySelectorAll(".faq h3")].map(text);
    assert(faq.some((q) => q.includes("Powered by Idmon")), `${lang}: υπάρχει ερώτηση FAQ`);
    const h3 = [...blocks[lang].querySelectorAll(".faq h3")].find((q) => text(q).includes("Powered by Idmon"));
    const answer = h3 ? text(h3.nextElementSibling) : "";
    assert(answer.includes("Free") && answer.includes("Basic") && answer.includes("Pro"), `${lang}: η απάντηση αναφέρει και τα τρία πλάνα`);
  }
}

function testVatAndPricesUnchanged() {
  console.log("\n[Οι τιμές και το ΦΠΑ ΔΕΝ άλλαξαν -- 29 και 59 ΜΕ ΦΠΑ]");
  for (const lang of ["el", "en"]) {
    const plans = plansOf(blocks[lang]);
    const prices = plans.map((p) => text(p.querySelector(".price")));
    assert(prices[1].startsWith(lang === "el" ? "29" : "€29") && prices[2].startsWith(lang === "el" ? "59" : "€59"), `${lang}: Basic 29, Pro 59 (${prices.join(" | ")})`);
    const monthlyAttrs = [...blocks[lang].querySelectorAll("[data-monthly]")].map((e) => `${e.getAttribute("data-monthly")}/${e.getAttribute("data-annual")}`);
    assert(JSON.stringify(monthlyAttrs) === JSON.stringify(["29/290", "59/590"]), `${lang}: μηνιαίες 29 και 59, ετήσιες 290 και 590`);
    const vatLabels = [...blocks[lang].querySelectorAll(".plan .vat")].map(text);
    assert(vatLabels[1] === (lang === "el" ? "με ΦΠΑ" : "VAT included") && vatLabels[2] === vatLabels[1], `${lang}: "${vatLabels[1]}" στις κάρτες Basic και Pro`);
    const leads = [...blocks[lang].querySelectorAll(".lead")].map(text);
    assert(leads.some((l) => (lang === "el" ? l.includes("περιλαμβάνουν ΦΠΑ") : l.includes("include VAT"))), `${lang}: η εισαγωγή λέει ότι οι τιμές περιλαμβάνουν ΦΠΑ`);
    const faqVat = text(blocks[lang]);
    assert(lang === "el" ? faqVat.includes("τελικές τιμές με ΦΠΑ") : faqVat.includes("final prices, VAT included"), `${lang}: το FAQ για το ΦΠΑ λέει «τελικές τιμές με ΦΠΑ»`);
    assert(!/\+\s*ΦΠΑ|excl(?:uding|usive of)?\s+VAT|\+\s*VAT/i.test(text(blocks[lang])), `${lang}: πουθενά «+ΦΠΑ» ή «excluding VAT»`);
  }
}

function testUpgradeGoesToAccount() {
  // Από 24 Σεπ 2026: η σελίδα τιμολόγησης ΔΕΝ ανοίγει checkout (μια πληρωμή χωρίς λογαριασμό
  // δεν συνδέεται με κανέναν). Το "Αναβάθμιση" πάει στην εγγραφή με πλάνο και περίοδο.
  console.log("\n[Η Αναβάθμιση πάει στην εγγραφή, όχι σε checkout]");
  for (const lang of ["el", "en"]) {
    const buttons = [...blocks[lang].querySelectorAll(".checkout-btn")];
    assert(buttons.length === 2, `${lang}: δύο κουμπιά αναβάθμισης`);
    assert(buttons.map((b) => b.getAttribute("data-plan")).join() === "basic,pro", `${lang}: basic και pro`);
    assert(buttons.every((b) => !b.hasAttribute("data-monthly-price") && !b.hasAttribute("data-annual-price")), `${lang}: κανένα price ID στη σελίδα (ζουν μόνο στον server)`);
  }
  assert(!html.includes("cdn.paddle.com"), "δεν φορτώνεται το Paddle.js");
  assert(!html.includes("Checkout.open"), "κανένα Checkout.open");
  assert(!/live_[0-9a-f]{20,}/.test(html), "κανένα client token στη σελίδα");
  assert(html.includes("'/landing.html?plan=' + plan + '&period=' + billingPeriod"), "το κουμπί πάει στο /landing.html?plan=...&period=...");
}

function testCardsAlign() {
  // Το jsdom δεν μετράει ύψη, οπότε ελέγχουμε τη ΔΟΜΗ: κάθε κάρτα έχει την ίδια σειρά
  // στοιχείων πριν τη λίστα με τα όρια (τιμή, ΦΠΑ/κάρτα, γραμμή έκπτωσης), άρα η λίστα
  // ξεκινάει στο ίδιο ύψος και στις τρεις.
  console.log("\n[Οι τρεις κάρτες έχουν την ίδια δομή πριν τα όρια]");
  for (const lang of ["el", "en"]) {
    const shapes = plansOf(blocks[lang]).map((plan) =>
      [...plan.children].filter((c) => !c.classList.contains("badge")).map((c) => c.tagName.toLowerCase() + (c.className ? "." + c.className.split(" ")[0] : "")).slice(0, 5).join(" > ")
    );
    assert(shapes.length === 3 && shapes.every((sh) => sh === "h2 > div.price > p.vat > p.annual-savings > ul"), `${lang}: ίδια σειρά σε Free/Basic/Pro (${shapes.join(" | ")})`);
    const freeSavings = plansOf(blocks[lang])[0].querySelector(".annual-savings");
    if (lang === "el") {
      const rule = (html.match(/\.annual-savings\{[^}]*\}/) || [""])[0];
      assert(/min-height:1\.2em/.test(rule) && /line-height:1\.2em/.test(rule), "η γραμμή έκπτωσης έχει ίδιο ύψος κενή ή γεμάτη (min-height = line-height)");
    }
    assert(freeSavings && !freeSavings.hasAttribute("data-savings") && freeSavings.textContent === "", `${lang}: η γραμμή του Free είναι κενή και δεν γεμίζει ποτέ`);
  }
}

async function testAnnualSavings() {
  console.log("\n[Ετήσια: ποσό έκπτωσης, όχι «2 μήνες δωρεάν»]");
  const shared = readFileSync(new URL("../public/shared.js", import.meta.url), "utf8");
  for (const [lang, basic, pro] of [["el", "Κερδίζεις 58 €", "Κερδίζεις 118 €"], ["en", "You save €58", "You save €118"]]) {
    const live = new JSDOM(html.replace('<script src="shared.js"></script>', () => "<script>" + shared + "</script>"), {
      runScripts: "dangerously",
      url: "https://idmon.app/",
      beforeParse(w) { w.localStorage.setItem("uiLang", lang); },
    });
    await new Promise((r) => setTimeout(r, 20));
    const d = live.window.document;
    const plans = [...d.querySelectorAll(`#content-${lang} .plans .plan`)];
    const savingsText = () => plans.map((p) => (p.querySelector(".annual-savings") || {}).textContent || "");
    assert(savingsText().every((t) => t === ""), `${lang}: στο Μηνιαία όλες οι γραμμές έκπτωσης είναι κενές`);
    d.querySelector(`#content-${lang} [data-billing="annual"]`).click();
    const [free, b, p] = savingsText();
    assert(b === basic && p === pro, `${lang}: Ετήσια -> "${b}" / "${p}"`);
    assert(free === "", `${lang}: Ετήσια -> το Free μένει κενό (όχι NaN, όχι 0)`);
    assert(!/2 μήνες δωρεάν|2 months free/.test(d.getElementById(`content-${lang}`).textContent), `${lang}: πουθενά "2 μήνες δωρεάν" / "2 months free"`);
    d.querySelector(`#content-${lang} [data-billing="monthly"]`).click();
    assert(savingsText().every((t) => t === ""), `${lang}: πίσω στο Μηνιαία, οι γραμμές αδειάζουν ξανά`);
    live.window.close();
  }
}

function testLimitsUnchanged() {
  console.log("\n[Τα όρια των πλάνων ΔΕΝ άλλαξαν]");
  for (const lang of ["el", "en"]) {
    const t = text(blocks[lang]);
    for (const n of lang === "el" ? ["100", "500", "2.500"] : ["100", "500", "2,500"]) assert(t.includes(n), `${lang}: αναφέρεται το όριο ${n}`);
  }
}

testBothLanguagesPresent();
testBadgeMentions();
testVatAndPricesUnchanged();
testUpgradeGoesToAccount();
testLimitsUnchanged();
testCardsAlign();
await testAnnualSavings();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
