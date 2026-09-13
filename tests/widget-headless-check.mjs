// Headless DOM simulation του public/widget.js (jsdom) -- ΔΕΝ χρειάζεται
// wrangler dev, τρέχει εντελώς αυτόνομα. Χρησιμοποιεί τον ΠΡΑΓΜΑΤΙΚΟ
// κώδικα του αρχείου (readFileSync + eval μέσα σε jsdom context), όχι
// reimplementation -- αν το αρχείο αλλάξει, το test ελέγχει τη νέα του
// μορφή αυτόματα.
//
// Τρέξιμο: node tests/widget-headless-check.mjs
// (χρειάζεται `npm install jsdom` πρώτα, ΜΟΝΟ για αυτό το test -- δεν
// χρειάζεται στο production build, δεν μπαίνει στο package.json.)

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

const widgetSource = readFileSync(new URL("../public/widget.js", import.meta.url), "utf8");

async function withDom(scriptAttrs, fetchImpl) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <script src="https://operations-portal-rag.giamarigkos.workers.dev/widget.js" ${scriptAttrs}></script>
    </body></html>`,
    { runScripts: "outside-only", url: "https://customer-site.gr/" }
  );
  const { window } = dom;
  window.fetch = fetchImpl || (async () => ({ ok: true, json: async () => ({ answer: "OK" }) }));
  // document.currentScript δεν λειτουργεί με runScripts:"outside-only" +
  // εξωτερικό eval, οπότε δίνουμε το ίδιο αντικείμενο σαν fallback --
  // ΤΟ ΙΔΙΟ fallback path (querySelectorAll) που το widget.js ήδη έχει
  // για ακριβώς αυτή την περίπτωση (π.χ. dynamic script injection).
  window.eval(widgetSource);
  // Δώσε χρόνο σε τυχόν pending microtasks (π.χ. constructor logic) να τρέξουν.
  await new Promise((r) => setTimeout(r, 0));
  return window;
}

async function testCreatesHostAndShadowRoot() {
  console.log("\n[Αρχικοποίηση -- host element + Shadow DOM]");
  const window = await withDom('data-embed-id="emb-test123"');
  const host = window.document.getElementById("rag-embed-widget-host");
  assert(!!host, "δημιουργεί το host div");
  assert(!!host.shadowRoot, "προσαρτά Shadow DOM (mode: open)");
  const bubble = host.shadowRoot.querySelector(".bubble");
  assert(!!bubble, "το bubble button υπάρχει μέσα στο shadow root");
  const panel = host.shadowRoot.querySelector(".panel");
  assert(!!panel, "το chat panel υπάρχει μέσα στο shadow root");
  assert(!panel.classList.contains("open"), "το panel ΞΕΚΙΝΑΕΙ κλειστό");
}

async function testMissingEmbedIdDoesNothing() {
  console.log("\n[Χωρίς data-embed-id -- ΔΕΝ πρέπει να φτιάξει τίποτα]");
  const window = await withDom("");
  const host = window.document.getElementById("rag-embed-widget-host");
  assert(!host, "κανένα widget δεν δημιουργείται χωρίς embed-id");
}

async function testBubbleTogglesPanel() {
  console.log("\n[Κλικ στο bubble -- ανοίγει/κλείνει το panel]");
  const window = await withDom('data-embed-id="emb-test123"');
  const host = window.document.getElementById("rag-embed-widget-host");
  const bubble = host.shadowRoot.querySelector(".bubble");
  const panel = host.shadowRoot.querySelector(".panel");
  bubble.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(panel.classList.contains("open"), "πρώτο κλικ ανοίγει το panel");
  bubble.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(!panel.classList.contains("open"), "δεύτερο κλικ ξανακλείνει το panel");
}

async function testAiDisclosureVisible() {
  console.log("\n[AI disclosure label -- πρέπει να υπάρχει πάντα στο header]");
  const window = await withDom('data-embed-id="emb-test123" data-lang="el"');
  const host = window.document.getElementById("rag-embed-widget-host");
  const sub = host.shadowRoot.querySelector(".header-sub").textContent;
  assert(sub.includes("AI"), "το header-sub αναφέρει ρητά AI (AI Act Article 50 disclosure)");
}

async function testSendQuestionCallsCorrectUrl() {
  console.log("\n[Αποστολή ερώτησης -- σωστό URL + σωστό body]");
  let capturedUrl = null;
  let capturedBody = null;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ answer: "Η απάντηση **έντονη**." }) };
  };
  const window = await withDom('data-embed-id="emb-test123"', fetchImpl);
  const host = window.document.getElementById("rag-embed-widget-host");
  const input = host.shadowRoot.querySelector(".input-row input");
  const sendBtn = host.shadowRoot.querySelector(".input-row button");
  input.value = "Τι ώρες είστε ανοιχτά;";
  sendBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(
    capturedUrl === "https://operations-portal-rag.giamarigkos.workers.dev/embed/emb-test123/query",
    "καλεί το σωστό, πλήρες URL (βασισμένο στο src του ίδιου του script tag)"
  );
  assert(capturedBody.question === "Τι ώρες είστε ανοιχτά;", "στέλνει το σωστό ερώτημα στο body");

  const messages = host.shadowRoot.querySelectorAll(".msg");
  assert(messages.length === 2, "εμφανίζονται 2 μηνύματα (χρήστης + bot)");
  assert(messages[0].classList.contains("user"), "το πρώτο μήνυμα είναι του χρήστη");
  assert(messages[1].classList.contains("bot"), "το δεύτερο μήνυμα είναι του bot");
  assert(messages[1].innerHTML.includes("<strong>έντονη</strong>"), "το **markdown bold** μετατράπηκε σε <strong>");
}

async function testNetworkErrorShowsFallbackMessage() {
  console.log("\n[Αποτυχία δικτύου -- εμφανίζει γενικό μήνυμα, όχι crash]");
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const window = await withDom('data-embed-id="emb-test123" data-lang="en"', fetchImpl);
  const host = window.document.getElementById("rag-embed-widget-host");
  const input = host.shadowRoot.querySelector(".input-row input");
  const sendBtn = host.shadowRoot.querySelector(".input-row button");
  input.value = "hello";
  sendBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  const messages = host.shadowRoot.querySelectorAll(".msg");
  assert(messages.length === 2, "εμφανίζονται 2 μηνύματα ακόμα και μετά από σφάλμα δικτύου");
  assert(
    messages[1].textContent.includes("wrong"),
    "το bot μήνυμα δείχνει το γενικό μήνυμα λάθους (αγγλικά, βάσει data-lang)"
  );
}

async function testForbiddenResponseShowsUnavailableMessage() {
  console.log("\n[403 από τον server (μη επιτρεπόμενο domain) -- γενικό μήνυμα, καμία διαρροή λεπτομερειών]");
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: "This domain is not authorized for this embed" }) });
  const window = await withDom('data-embed-id="emb-test123"', fetchImpl);
  const host = window.document.getElementById("rag-embed-widget-host");
  const input = host.shadowRoot.querySelector(".input-row input");
  const sendBtn = host.shadowRoot.querySelector(".input-row button");
  input.value = "γεια";
  sendBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  const messages = host.shadowRoot.querySelectorAll(".msg");
  const botMessage = messages[1].textContent;
  assert(!botMessage.includes("authorized"), "ΔΕΝ διαρρέει το εσωτερικό μήνυμα λάθους του server στον επισκέπτη");
  assert(botMessage.length > 0, "εμφανίζεται κάποιο γενικό μήνυμα αντ' αυτού");
}

async function testNoContactBarByDefault() {
  console.log("\n[Χωρίς κανένα data-contact-* -- ΔΕΝ εμφανίζεται contact bar]");
  const window = await withDom('data-embed-id="emb-test123"');
  const host = window.document.getElementById("rag-embed-widget-host");
  assert(!host.shadowRoot.querySelector(".contact-bar"), "κανένα contact-bar χωρίς ρυθμισμένη επικοινωνία");
}

async function testPersistentContactBarShown() {
  console.log("\n[Με data-contact-label/url/phone -- persistent contact bar πάντα ορατό]");
  const window = await withDom(
    'data-embed-id="emb-test123" data-contact-label="Μίλα μαζί μας" ' +
      'data-contact-url="https://wa.me/306912345678" data-contact-phone="+30 210 1234567"'
  );
  const host = window.document.getElementById("rag-embed-widget-host");
  const bar = host.shadowRoot.querySelector(".contact-bar");
  assert(!!bar, "εμφανίζεται το contact-bar όταν υπάρχει ρυθμισμένη επικοινωνία");
  const links = bar.querySelectorAll(".contact-link");
  assert(links.length === 2, "δύο links μέσα στο bar (link + τηλέφωνο)");
  assert(links[0].getAttribute("href") === "https://wa.me/306912345678", "το πρώτο link δείχνει στο σωστό contactUrl");
  assert(links[0].getAttribute("target") === "_blank", "το link ανοίγει σε νέο tab");
  assert(links[1].getAttribute("href") === "tel:+30 210 1234567", "το δεύτερο link είναι tel: με το σωστό τηλέφωνο");
}

async function testFallbackShowsContactPrompt() {
  console.log("\n[isFallback:true ΚΑΙ ρυθμισμένη επικοινωνία -- εμφανίζεται το fallback CTA μήνυμα]");
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ answer: "Δεν βρέθηκαν σχετικά έγγραφα.", isFallback: true }),
  });
  const window = await withDom(
    'data-embed-id="emb-test123" data-contact-label="Μίλα μαζί μας" data-contact-url="https://wa.me/306912345678"',
    fetchImpl
  );
  const host = window.document.getElementById("rag-embed-widget-host");
  const input = host.shadowRoot.querySelector(".input-row input");
  const sendBtn = host.shadowRoot.querySelector(".input-row button");
  input.value = "κάτι που δεν ξέρει";
  sendBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  const fallbackMsg = host.shadowRoot.querySelector(".msg.fallback-contact");
  assert(!!fallbackMsg, "εμφανίζεται ξεχωριστό fallback-contact μήνυμα");
  assert(fallbackMsg.textContent.includes("Δεν βρήκες"), "δείχνει το σωστό (ελληνικό, default lang) κείμενο προτροπής");
  assert(!!fallbackMsg.querySelector(".contact-link"), "περιέχει το contact link");
}

async function testFallbackWithoutContactConfiguredShowsNothingExtra() {
  console.log("\n[isFallback:true ΧΩΡΙΣ ρυθμισμένη επικοινωνία -- ΚΑΝΕΝΑ επιπλέον μήνυμα]");
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ answer: "Δεν βρέθηκαν σχετικά έγγραφα.", isFallback: true }),
  });
  const window = await withDom('data-embed-id="emb-test123"', fetchImpl);
  const host = window.document.getElementById("rag-embed-widget-host");
  const input = host.shadowRoot.querySelector(".input-row input");
  const sendBtn = host.shadowRoot.querySelector(".input-row button");
  input.value = "κάτι που δεν ξέρει";
  sendBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(
    !host.shadowRoot.querySelector(".msg.fallback-contact"),
    "καμία fallback-contact προτροπή χωρίς ρυθμισμένη επικοινωνία (τίποτα να δείξει)"
  );
  const messages = host.shadowRoot.querySelectorAll(".msg");
  assert(messages.length === 2, "μόνο τα 2 κανονικά μηνύματα (χρήστης + bot απάντηση)");
}

async function testNormalAnswerNeverShowsContactPrompt() {
  console.log("\n[isFallback:false ΜΕ ρυθμισμένη επικοινωνία -- ΔΕΝ εμφανίζεται το CTA σε κανονική απάντηση]");
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ answer: "Είμαστε ανοιχτά 9-17.", isFallback: false }),
  });
  const window = await withDom(
    'data-embed-id="emb-test123" data-contact-label="Μίλα μαζί μας" data-contact-url="https://wa.me/306912345678"',
    fetchImpl
  );
  const host = window.document.getElementById("rag-embed-widget-host");
  const input = host.shadowRoot.querySelector(".input-row input");
  const sendBtn = host.shadowRoot.querySelector(".input-row button");
  input.value = "τι ώρες είστε ανοιχτά";
  sendBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(
    !host.shadowRoot.querySelector(".msg.fallback-contact"),
    "καμία fallback-contact προτροπή όταν η απάντηση δεν είναι fallback (η persistent bar αρκεί)"
  );
}

async function run() {
  await testCreatesHostAndShadowRoot();
  await testMissingEmbedIdDoesNothing();
  await testBubbleTogglesPanel();
  await testAiDisclosureVisible();
  await testSendQuestionCallsCorrectUrl();
  await testNetworkErrorShowsFallbackMessage();
  await testForbiddenResponseShowsUnavailableMessage();
  await testNoContactBarByDefault();
  await testPersistentContactBarShown();
  await testFallbackShowsContactPrompt();
  await testFallbackWithoutContactConfiguredShowsNothingExtra();
  await testNormalAnswerNeverShowsContactPrompt();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
