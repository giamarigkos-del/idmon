// Έλεγχος του public/pricing.html για το «Powered by Idmon» (Free/Basic ναι, Pro όχι) --
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

const html = readFileSync(new URL("../public/pricing.html", import.meta.url), "utf8");
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

function testPaddleIdsUnchanged() {
  console.log("\n[Τα IDs των τιμών του Paddle (live) ΔΕΝ άλλαξαν]");
  const expected = {
    basic: ["pri_01m2ynemr2t4dnes8rz775p090", "pri_01m2ynemzv76wbb37zvr1q9fnb"],
    pro: ["pri_01m2ynen6sh5949wn1pnsr1s51", "pri_01m2ynend8w7383t0nqzgd0f1z"],
  };
  for (const lang of ["el", "en"]) {
    const buttons = [...blocks[lang].querySelectorAll(".checkout-btn")];
    assert(buttons.length === 2, `${lang}: δύο κουμπιά αγοράς`);
    for (const b of buttons) {
      const plan = b.getAttribute("data-plan");
      assert(b.getAttribute("data-monthly-price") === expected[plan][0] && b.getAttribute("data-annual-price") === expected[plan][1], `${lang}: ${plan}: σωστά μηνιαίο/ετήσιο price ID`);
    }
  }
  assert(html.includes("live_d06ea77dbb7841c5652998a2c8e"), "το client token του Paddle παραμένει");
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
testPaddleIdsUnchanged();
testLimitsUnchanged();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
