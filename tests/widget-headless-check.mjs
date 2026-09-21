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

// Προσομοιώνει ένα streaming Response.body: events (array από objects) γίνονται
// "data: {...}\n\n" κείμενο, κωδικοποιείται μία φορά σε bytes, και επιστρέφεται
// ΟΛΟΚΛΗΡΟ στην πρώτη κλήση read() (το widget.js parser χειρίζεται σωστά
// πολλαπλά events μέσα στο ίδιο chunk, δεν χρειάζεται τεχνητό split σε test).
function makeSSEBody(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      };
    },
  };
}

async function withDom(scriptAttrs, fetchImpl) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <script src="https://operations-portal-rag.giamarigkos.workers.dev/widget.js" ${scriptAttrs}></script>
    </body></html>`,
    { runScripts: "outside-only", url: "https://customer-site.gr/" }
  );
  const { window } = dom;
  window.fetch = fetchImpl || (async () => ({ ok: true, body: makeSSEBody([{ type: "chunk", text: "OK" }, { type: "done", isFallback: false }]) }));
  // jsdom δεν εγγυάται πάντα TextDecoder στο window -- το δίνουμε ρητά από
  // το Node global scope (το widget.js το χρησιμοποιεί για να διαβάσει το
  // streaming response σώμα).
  window.TextDecoder = TextDecoder;
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
    return {
      ok: true,
      body: makeSSEBody([
        { type: "chunk", text: "Η απάντηση " },
        { type: "chunk", text: "**έντονη**." },
        { type: "done", isFallback: false, primarySource: null, relatedSections: [] },
      ]),
    };
  };
  const window = await withDom('data-embed-id="emb-test123"', fetchImpl);
  const host = window.document.getElementById("rag-embed-widget-host");
  const input = host.shadowRoot.querySelector(".input-row input");
  const sendBtn = host.shadowRoot.querySelector(".input-row button");
  input.value = "Τι ώρες είστε ανοιχτά;";
  sendBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert(
    capturedUrl === "https://operations-portal-rag.giamarigkos.workers.dev/embed/emb-test123/query/stream",
    "καλεί το σωστό, πλήρες streaming URL (βασισμένο στο src του ίδιου του script tag)"
  );
  assert(capturedBody.question === "Τι ώρες είστε ανοιχτά;", "στέλνει το σωστό ερώτημα στο body");

  const messages = host.shadowRoot.querySelectorAll(".msg");
  assert(messages.length === 2, "εμφανίζονται 2 μηνύματα (χρήστης + bot)");
  assert(messages[0].classList.contains("user"), "το πρώτο μήνυμα είναι του χρήστη");
  assert(messages[1].classList.contains("bot"), "το δεύτερο μήνυμα είναι του bot");
  assert(messages[1].innerHTML.includes("<strong>έντονη</strong>"), "το **markdown bold** μετατράπηκε σε <strong> (μετά τη συνένωση των streamed κομματιών)");
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
  const fetchImpl = async () => ({ ok: false, status: 403 });
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
    body: makeSSEBody([
      { type: "chunk", text: "Δεν βρέθηκαν σχετικά έγγραφα." },
      { type: "done", isFallback: true, primarySource: null, relatedSections: [] },
    ]),
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
    body: makeSSEBody([
      { type: "chunk", text: "Δεν βρέθηκαν σχετικά έγγραφα." },
      { type: "done", isFallback: true, primarySource: null, relatedSections: [] },
    ]),
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
    body: makeSSEBody([
      { type: "chunk", text: "Είμαστε ανοιχτά 9-17." },
      { type: "done", isFallback: false, primarySource: null, relatedSections: [] },
    ]),
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

// --- Βήμα 1: ιστορικό συζήτησης ---------------------------------------------
// Στέλνει μία ερώτηση μέσα από το UI και περιμένει να τελειώσει η ροή.
async function ask(window, host, text) {
  const input = host.shadowRoot.querySelector(".input-row input");
  const sendBtn = host.shadowRoot.querySelector(".input-row button");
  input.value = text;
  sendBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
}

function answeringFetch(capturedBodies, answerFor) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    capturedBodies.push(body);
    return {
      ok: true,
      body: makeSSEBody([
        { type: "chunk", text: answerFor(body.question) },
        { type: "done", isFallback: false, primarySource: null, relatedSections: [] },
      ]),
    };
  };
}

async function testFirstQuestionHasNoHistory() {
  console.log("\n[Ιστορικό -- η ΠΡΩΤΗ ερώτηση στέλνεται ακριβώς όπως πριν, χωρίς πεδίο history]");
  const bodies = [];
  const window = await withDom('data-embed-id="emb-test123"', answeringFetch(bodies, (q) => "Απάντηση για " + q));
  const host = window.document.getElementById("rag-embed-widget-host");
  await ask(window, host, "Τι ώρες είστε ανοιχτά;");
  assert(bodies.length === 1, "έγινε μία κλήση");
  assert(!("history" in bodies[0]), "το body ΔΕΝ έχει πεδίο history στην πρώτη ερώτηση");
  assert(bodies[0].question === "Τι ώρες είστε ανοιχτά;", "η ερώτηση στέλνεται κανονικά");
}

async function testSecondQuestionSendsHistory() {
  console.log("\n[Ιστορικό -- η ΔΕΥΤΕΡΗ ερώτηση στέλνει την πρώτη ανταλλαγή]");
  const bodies = [];
  const window = await withDom('data-embed-id="emb-test123"', answeringFetch(bodies, (q) => "Απάντηση για " + q));
  const host = window.document.getElementById("rag-embed-widget-host");
  await ask(window, host, "Τι ώρες είστε ανοιχτά;");
  await ask(window, host, "Και το Σάββατο;");
  assert(bodies.length === 2, "έγιναν δύο κλήσεις");
  const h = bodies[1].history;
  assert(Array.isArray(h) && h.length === 2, "η δεύτερη κλήση στέλνει 2 μηνύματα ιστορικού");
  assert(h[0].role === "user" && h[0].text === "Τι ώρες είστε ανοιχτά;", "πρώτο: ο χρήστης, με τη σωστή ερώτηση");
  assert(h[1].role === "assistant" && h[1].text === "Απάντηση για Τι ώρες είστε ανοιχτά;", "δεύτερο: ο βοηθός (όχι \"bot\"), με την πλήρη απάντηση");
  assert(bodies[1].question === "Και το Σάββατο;", "η νέα ερώτηση ΔΕΝ είναι μέσα στο ιστορικό, στέλνεται ξεχωριστά");
  const roles = new Set(h.map((x) => x.role));
  assert([...roles].every((r) => r === "user" || r === "assistant"), "μόνο ρόλοι user/assistant");
}

async function testHistoryCappedAtSix() {
  console.log("\n[Ιστορικό -- μετά από πολλές ερωτήσεις στέλνονται μόνο τα τελευταία 6 μηνύματα]");
  const bodies = [];
  const window = await withDom('data-embed-id="emb-test123"', answeringFetch(bodies, (q) => "Α-" + q));
  const host = window.document.getElementById("rag-embed-widget-host");
  for (let i = 1; i <= 6; i++) await ask(window, host, "Ερώτηση " + i);
  const last = bodies[5].history;
  assert(last.length === 6, "στην 6η ερώτηση το ιστορικό είναι 6 μηνύματα (όχι 10)");
  assert(last[0].text === "Ερώτηση 3", "ξεκινά από την 3η ερώτηση (οι δύο παλιότερες ανταλλαγές έφυγαν)");
  assert(last[5].text === "Α-Ερώτηση 5", "τελειώνει με την τελευταία ολοκληρωμένη απάντηση");
}

async function testLongMessagesTruncated() {
  console.log("\n[Ιστορικό -- πολύ μεγάλα μηνύματα κόβονται στους 500 χαρακτήρες]");
  const bodies = [];
  const window = await withDom('data-embed-id="emb-test123"', answeringFetch(bodies, () => "β".repeat(3000)));
  const host = window.document.getElementById("rag-embed-widget-host");
  await ask(window, host, "α".repeat(2000));
  await ask(window, host, "επόμενη");
  const h = bodies[1].history;
  assert(h[0].text.length === 500, "η ερώτηση στο ιστορικό κόβεται στους 500");
  assert(h[1].text.length === 500, "η απάντηση στο ιστορικό κόβεται στους 500");
  const shown = host.shadowRoot.querySelectorAll(".msg.bot")[0].textContent.length;
  assert(shown === 3000, "αλλά στην οθόνη του επισκέπτη η απάντηση δείχνεται ολόκληρη");
}

async function testFailedExchangeNotRemembered() {
  console.log("\n[Ιστορικό -- αποτυχημένη ερώτηση (σφάλμα δικτύου) ΔΕΝ μπαίνει στο ιστορικό]");
  const bodies = [];
  let call = 0;
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    call++;
    if (call === 2) throw new Error("network down");
    return { ok: true, body: makeSSEBody([{ type: "chunk", text: "ΟΚ" + call }, { type: "done", isFallback: false }]) };
  };
  const window = await withDom('data-embed-id="emb-test123"', fetchImpl);
  const host = window.document.getElementById("rag-embed-widget-host");
  await ask(window, host, "Ερώτηση 1");
  await ask(window, host, "Ερώτηση 2 (αποτυγχάνει)");
  await ask(window, host, "Ερώτηση 3");
  const h = bodies[2].history;
  assert(h.length === 2, "στην 3η ερώτηση το ιστορικό έχει μόνο την 1η (επιτυχημένη) ανταλλαγή");
  assert(!h.some((x) => x.text.includes("αποτυγχάνει")), "η αποτυχημένη ερώτηση δεν υπάρχει στο ιστορικό");
}

async function testLimitReachedNotRemembered() {
  console.log("\n[Ιστορικό -- το μήνυμα ορίου (429) ΔΕΝ μπαίνει στο ιστορικό]");
  const bodies = [];
  let call = 0;
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    call++;
    if (call === 2) return { ok: false, status: 429, json: async () => ({ limitReached: true }) };
    return { ok: true, body: makeSSEBody([{ type: "chunk", text: "ΟΚ" }, { type: "done", isFallback: false }]) };
  };
  const window = await withDom('data-embed-id="emb-test123"', fetchImpl);
  const host = window.document.getElementById("rag-embed-widget-host");
  await ask(window, host, "Ερώτηση 1");
  await ask(window, host, "Ερώτηση 2 (όριο)");
  await ask(window, host, "Ερώτηση 3");
  assert(bodies[2].history.length === 2, "στην 3η ερώτηση το ιστορικό έχει μόνο την 1η ανταλλαγή");
}

async function testHistoryDoesNotLeakBetweenPages() {
  console.log("\n[Ιστορικό -- κάθε φόρτωση σελίδας ξεκινά νέα συζήτηση (τίποτα δεν αποθηκεύεται)]");
  const bodies = [];
  const w1 = await withDom('data-embed-id="emb-test123"', answeringFetch(bodies, () => "ΟΚ"));
  await ask(w1, w1.document.getElementById("rag-embed-widget-host"), "Ερώτηση 1");
  const bodies2 = [];
  const w2 = await withDom('data-embed-id="emb-test123"', answeringFetch(bodies2, () => "ΟΚ"));
  await ask(w2, w2.document.getElementById("rag-embed-widget-host"), "Ερώτηση σε νέα σελίδα");
  assert(!("history" in bodies2[0]), "νέα σελίδα = καθόλου ιστορικό");
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
  await testFirstQuestionHasNoHistory();
  await testSecondQuestionSendsHistory();
  await testHistoryCappedAtSix();
  await testLongMessagesTruncated();
  await testFailedExchangeNotRemembered();
  await testLimitReachedNotRemembered();
  await testHistoryDoesNotLeakBetweenPages();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
