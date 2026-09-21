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

// Το widget κάνει πλέον ένα GET στο .../config όταν φορτώνει (Βήμα 2β). Για να
// μη μπερδεύει τα υπάρχοντα τεστ (που καταγράφουν ΟΛΕΣ τις κλήσεις fetch), το
// /config περνά από ξεχωριστό configImpl· αν δεν δοθεί, "αποτυγχάνει" (το widget
// τότε χρησιμοποιεί τα attributes και δείχνει το badge -- εφεδρική διαδρομή).
async function withDom(scriptAttrs, fetchImpl, configImpl) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <script src="https://operations-portal-rag.giamarigkos.workers.dev/widget.js" ${scriptAttrs}></script>
    </body></html>`,
    { runScripts: "outside-only", url: "https://customer-site.gr/" }
  );
  const { window } = dom;
  const queryFetch = fetchImpl || (async () => ({ ok: true, body: makeSSEBody([{ type: "chunk", text: "OK" }, { type: "done", isFallback: false }]) }));
  window.__configCalls = [];
  window.fetch = async (url, options) => {
    if (String(url).endsWith("/config")) {
      window.__configCalls.push({ url: String(url), options });
      if (configImpl) return configImpl(url, options);
      throw new Error("config unavailable in this test");
    }
    return queryFetch(url, options);
  };
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

// --- Βήμα 2α: νέο στυλ (header, avatar, χρώμα πελάτη, pill κουμπιά) ----------
function widgetCss(window) {
  const host = window.document.getElementById("rag-embed-widget-host");
  // Το χρώμα ζει σε ξεχωριστό <style> (theme) -- ενώνουμε όλα.
  return [...host.shadowRoot.querySelectorAll("style")].map((el) => el.textContent).join("");
}

async function testNewHeaderStructure() {
  console.log("\n[Νέο στυλ -- header: avatar, τίτλος δύο γραμμών, κλείσιμο]");
  const window = await withDom('data-embed-id="emb-test123" data-bot-name="HomeTech Βοηθός" data-lang="el"');
  const root = window.document.getElementById("rag-embed-widget-host").shadowRoot;
  const header = root.querySelector(".header");
  assert(!!header.querySelector(".avatar svg"), "υπάρχει avatar με προεπιλεγμένο εικονίδιο");
  assert(header.querySelector(".header-text .header-title").textContent === "HomeTech Βοηθός", "ο τίτλος είναι το όνομα του bot");
  const sub = header.querySelector(".header-text .header-sub").textContent;
  assert(sub.includes("AI"), "ο υπότιτλος αναφέρει AI (AI Act Article 50)");
  assert(!sub.includes("🤖"), "ο υπότιτλος δεν έχει πια emoji (το avatar κάνει τη δουλειά)");
  assert(!root.querySelector(".header-top"), "δεν υπάρχει το παλιό .header-top");
  const kids = [...header.children].map((c) => c.className);
  assert(kids[0] === "avatar" && kids[1] === "header-text" && kids[2] === "close-btn", "σειρά: avatar, κείμενο, κουμπί κλεισίματος");
  const close = header.querySelector(".close-btn");
  assert(!!close.querySelector("svg") && close.getAttribute("aria-label") === "Κλείσιμο", "το κλείσιμο έχει εικονίδιο και aria-label");
  assert(root.querySelectorAll(".msg").length === 0, "δεν προστέθηκαν στοιχεία .msg (τα μηνύματα μετριούνται από τα τεστ)");
}

async function testLauncherIcon() {
  console.log("\n[Νέο στυλ -- ο εκκινητής (bubble) έχει εικονίδιο και aria-label]");
  const window = await withDom('data-embed-id="emb-test123" data-lang="el"');
  const bubble = window.document.getElementById("rag-embed-widget-host").shadowRoot.querySelector(".bubble");
  assert(!!bubble.querySelector("svg"), "εικονίδιο SVG αντί για emoji");
  assert(bubble.getAttribute("aria-label") === "Άνοιγμα βοηθού", "aria-label διατηρείται");
}

async function testAccentColorHandling() {
  console.log("\n[Νέο στυλ -- το χρώμα του πελάτη: έγκυρα hex περνούν, όλα τα άλλα πέφτουν στο προεπιλεγμένο]");
  const accentOf = async (attr) => {
    const window = await withDom('data-embed-id="emb-test123"' + (attr === null ? "" : ` data-accent-color="${attr}"`));
    const m = /\.bubble,\.panel\{--accent:([^;]+);/.exec(widgetCss(window));
    return m ? m[1].toLowerCase() : null;
  };
  assert((await accentOf("#112233")) === "#112233", "#112233 περνά όπως είναι");
  assert((await accentOf("#ABC")) === "#aabbcc", "το 3ψήφιο #ABC γίνεται #aabbcc");
  assert((await accentOf("  #2F5BEA ")) === "#2f5bea", "κενά γύρω από την τιμή αγνοούνται");
  assert((await accentOf(null)) === "#6b7280", "χωρίς attribute: προεπιλεγμένο");
  for (const bad of ["red", "rgb(1,2,3)", "#12", "#12345g", "#1234567", "javascript:alert(1)"]) {
    assert((await accentOf(bad)) === "#6b7280", `άκυρη τιμή "${bad}" -> προεπιλεγμένο`);
  }
  const injected = "#fff;} body{display:none";
  const window = await withDom('data-embed-id="emb-test123" data-accent-color="' + injected + '"');
  const css = widgetCss(window);
  assert(!css.includes("body{"), "προσπάθεια εισαγωγής CSS μέσω του attribute δεν περνά (κανένας κανόνας body{...} στο στυλ)");
}

async function testAutomaticContrast() {
  console.log("\n[Νέο στυλ -- το χρώμα κειμένου πάνω στο χρώμα του πελάτη διαλέγεται αυτόματα]");
  const onAccentOf = async (hex) => {
    const window = await withDom(`data-embed-id="emb-test123" data-accent-color="${hex}"`);
    const m = /--on-accent:([^;]+);/.exec(widgetCss(window));
    return m ? m[1] : null;
  };
  for (const dark of ["#111111", "#000000", "#2F5BEA", "#6B7280", "#8B0000", "#0A7B3E"]) {
    assert((await onAccentOf(dark)) === "#ffffff", `σκούρο/μεσαίο ${dark} -> άσπρο κείμενο`);
  }
  for (const light of ["#FFE14D", "#FFFFFF", "#FFEB3B", "#00FF00", "#F5F5F5", "#7FDBFF"]) {
    assert((await onAccentOf(light)) === "#111111", `ανοιχτό ${light} -> σκούρο κείμενο`);
  }
}

async function testPillShapesAndAccessibilityCss() {
  console.log("\n[Νέο στυλ -- pill κουμπιά παντού, ορατό focus, σεβασμός στο reduced-motion]");
  const window = await withDom('data-embed-id="emb-test123" data-contact-label="Επικοινωνία" data-contact-url="https://x.gr"');
  const css = widgetCss(window);
  const radiusOf = (selector) => {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{[^}]*border-radius:([^;}]+)");
    const m = re.exec(css);
    return m ? m[1] : null;
  };
  assert(radiusOf(".input-row button") === "999px", "το κουμπί αποστολής είναι pill");
  assert(radiusOf(".input-row input") === "999px", "το πεδίο ερώτησης είναι pill");
  assert(radiusOf(".contact-link") === "999px", "τα κουμπιά επικοινωνίας είναι pill");
  assert(css.includes(".bubble:focus-visible"), "ορατό focus στον εκκινητή (bubble) για πληκτρολόγιο");
  assert(css.includes(".input-row button:focus-visible"), "ορατό focus στο κουμπί αποστολής");
  assert(css.includes(".close-btn:focus-visible"), "ορατό focus στο κουμπί κλεισίματος");
  assert(css.includes("prefers-reduced-motion"), "η κίνηση απενεργοποιείται όταν ζητείται reduced-motion");
}

async function testPositionStillWorks() {
  console.log("\n[Νέο στυλ -- η θέση bottom-left/bottom-right εξακολουθεί να δουλεύει]");
  const left = widgetCss(await withDom('data-embed-id="emb-test123" data-position="bottom-left"'));
  assert(/\.bubble\{[^}]*left:20px/.test(left) && /\.panel\{[^}]*left:20px/.test(left), "bottom-left: και το bubble και το panel αριστερά");
  const right = widgetCss(await withDom('data-embed-id="emb-test123"'));
  assert(/\.bubble\{[^}]*right:20px/.test(right) && /\.panel\{[^}]*right:20px/.test(right), "προεπιλογή: δεξιά");
}

// --- Βήμα 2β-2: ρυθμίσεις από τον server, λογότυπο, "Powered by Idmon" -------
const cfgOk = (cfg) => async () => ({ ok: true, json: async () => cfg });
const FULL_CFG = {
  accentColor: "#2F5BEA", botName: "Server Name", logoUrl: "https://cdn.example.gr/l.png",
  contactLabel: "Επικοινωνία", contactUrl: "https://x.gr/c", contactPhone: "+30 210 123 4567", showBranding: false,
};
const rootOf = (window) => window.document.getElementById("rag-embed-widget-host").shadowRoot;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function testConfigRequest() {
  console.log("\n[Ρυθμίσεις -- το αίτημα που στέλνει το widget]");
  const window = await withDom('data-embed-id="emb-test123"', null, cfgOk(FULL_CFG));
  assert(window.__configCalls.length === 1, "ΕΝΑ αίτημα ρυθμίσεων ανά φόρτωση");
  const call = window.__configCalls[0];
  assert(call.url === "https://operations-portal-rag.giamarigkos.workers.dev/embed/emb-test123/config", "σωστό URL (origin του script + embed ID)");
  assert(call.options.method === "GET" && call.options.credentials === "omit", "GET χωρίς credentials");
  assert(!call.options.headers && !call.options.body, "χωρίς custom headers/body (απλό cross-origin αίτημα, καμία preflight)");
}

async function testConfigApplied() {
  console.log("\n[Ρυθμίσεις -- εφαρμόζονται όλα τα πεδία]");
  const window = await withDom('data-embed-id="emb-test123"', null, cfgOk(FULL_CFG));
  await wait(20);
  const root = rootOf(window);
  const css = widgetCss(window);
  assert(/--accent:#2f5bea;/i.test(css) && css.includes("--on-accent:#ffffff;"), "το χρώμα του server και το κατάλληλο χρώμα κειμένου");
  assert(root.querySelector(".header-title").textContent === "Server Name", "το όνομα του server");
  const img = root.querySelector(".avatar img");
  assert(!!img && img.getAttribute("src") === "https://cdn.example.gr/l.png", "το λογότυπο μπαίνει στον avatar");
  assert(img.getAttribute("referrerpolicy") === "no-referrer", "το λογότυπο φορτώνεται χωρίς referrer");
  assert(!root.querySelector(".avatar svg"), "το προεπιλεγμένο εικονίδιο αντικαταστάθηκε");
  const links = root.querySelectorAll(".contact-bar .contact-link");
  assert(links.length === 2 && links[0].getAttribute("href") === "https://x.gr/c" && links[1].getAttribute("href") === "tel:+30 210 123 4567", "τα στοιχεία επικοινωνίας δημιουργήθηκαν");
  assert(root.querySelector(".powered").hidden === true, "showBranding=false: το badge κρύβεται");
  assert(!root.querySelector(".bubble").classList.contains("pending"), "το κουμπί του widget εμφανίστηκε");
}

async function testServerWinsOverAttributes() {
  console.log("\n[Ρυθμίσεις -- ο server κερδίζει τα data-attributes του snippet]");
  const attrs = 'data-embed-id="emb-test123" data-accent-color="#FF0000" data-bot-name="Snippet Name" data-contact-label="Παλιό" data-contact-url="https://old.gr" data-contact-phone="111 222"';
  const window = await withDom(attrs, null, cfgOk({ accentColor: "#2F5BEA", botName: "Server Name", contactLabel: null, contactUrl: null, contactPhone: null, logoUrl: null, showBranding: true }));
  await wait(20);
  const root = rootOf(window);
  assert(root.querySelector(".header-title").textContent === "Server Name", "όνομα: του server, όχι του snippet");
  assert(/--accent:#2f5bea;/i.test(widgetCss(window)) && !/--accent:#ff0000;/i.test(widgetCss(window)), "χρώμα: του server, όχι του snippet");
  assert(!root.querySelector(".contact-bar"), "η επικοινωνία που αφαιρέθηκε από τις ρυθμίσεις ΦΕΥΓΕΙ, παρά το παλιό snippet");
  assert(!!root.querySelector(".avatar svg"), "χωρίς λογότυπο: προεπιλεγμένο εικονίδιο");
}

async function testBrandingRules() {
  console.log("\n[\"Powered by Idmon\" -- το κρύβει ΜΟΝΟ ένα ρητό false από τον server]");
  const badge = async (cfg, lang) => {
    const window = await withDom(`data-embed-id="emb-test123"${lang ? ` data-lang="${lang}"` : ""}`, null, cfgOk(cfg));
    await wait(20);
    return rootOf(window).querySelector(".powered");
  };
  const shown = await badge({ showBranding: true });
  assert(shown.hidden === false, "showBranding=true: φαίνεται");
  const a = shown.querySelector("a");
  assert(a.textContent === "Powered by Idmon", "κείμενο \"Powered by Idmon\"");
  assert(a.getAttribute("href") === "https://idmon.app" && a.getAttribute("target") === "_blank" && a.getAttribute("rel") === "noopener noreferrer", "σύνδεσμος στο idmon.app, σε νέο tab, με noopener");
  assert((await badge({ showBranding: false })).hidden === true, "showBranding=false (Pro): κρύβεται");
  assert((await badge({})).hidden === false, "χωρίς το πεδίο: φαίνεται");
  for (const weird of ["false", 0, null, "no", []]) {
    assert((await badge({ showBranding: weird })).hidden === false, `μη-boolean ${JSON.stringify(weird)}: φαίνεται (μόνο ρητό false το κρύβει)`);
  }
  assert((await badge({ showBranding: true }, "en")).querySelector("a").textContent === "Powered by Idmon", "ίδιο κείμενο και στα αγγλικά");
}

async function testConfigFailureFallsBack() {
  console.log("\n[Αν ο server δεν απαντά -- εφεδρικά attributes, και το badge ΦΑΙΝΕΤΑΙ]");
  const attrs = 'data-embed-id="emb-test123" data-accent-color="#FF0000" data-bot-name="Snippet Name"';
  const failures = {
    "σφάλμα δικτύου": async () => { throw new Error("network down"); },
    "403 (domain εκτός λίστας)": async () => ({ ok: false, status: 403, json: async () => ({ error: "x" }) }),
    "404": async () => ({ ok: false, status: 404, json: async () => ({}) }),
    "μη έγκυρο JSON": async () => ({ ok: true, json: async () => { throw new Error("Unexpected token <"); } }),
    "απάντηση null": cfgOk(null),
    "απάντηση array": cfgOk([1, 2]),
    "απάντηση string": cfgOk("hello"),
  };
  for (const [label, impl] of Object.entries(failures)) {
    const window = await withDom(attrs, null, impl);
    await wait(20);
    const root = rootOf(window);
    assert(root.querySelector(".powered").hidden === false, `${label}: το badge φαίνεται (ασφαλής προεπιλογή)`);
    assert(root.querySelector(".header-title").textContent === "Snippet Name" && /--accent:#ff0000;/i.test(widgetCss(window)), `${label}: ισχύουν τα attributes του snippet`);
    assert(!root.querySelector(".bubble").classList.contains("pending"), `${label}: το κουμπί του widget εμφανίζεται`);
  }
}

async function testLauncherPendingAndTimeout() {
  console.log("\n[Κουμπί κρυφό μέχρι να έρθουν οι ρυθμίσεις -- και timeout 1,5\"]");
  let release;
  const gate = new Promise((r) => (release = r));
  const window = await withDom('data-embed-id="emb-test123" data-accent-color="#FF0000"', null, async () => { await gate; return { ok: true, json: async () => FULL_CFG }; });
  const root = rootOf(window);
  await wait(30);
  assert(root.querySelector(".bubble").classList.contains("pending"), "όσο περιμένει τον server το κουμπί είναι κρυφό");
  assert(root.querySelector(".powered").hidden === true, "και το badge δεν έχει αποφασιστεί ακόμα");
  await wait(1600);
  assert(!root.querySelector(".bubble").classList.contains("pending"), "μετά το timeout το κουμπί εμφανίζεται");
  assert(root.querySelector(".powered").hidden === false, "μετά το timeout το badge φαίνεται (ασφαλής προεπιλογή)");
  assert(/--accent:#ff0000;/i.test(widgetCss(window)), "μετά το timeout ισχύει το χρώμα του snippet");
  release();
  await wait(30);
  assert(root.querySelector(".header-title").textContent === "Server Name" && /--accent:#2f5bea;/i.test(widgetCss(window)), "αν η απάντηση έρθει ΑΡΓΟΤΕΡΑ, εφαρμόζεται τότε");
  assert(root.querySelector(".powered").hidden === true, "και η απόφαση του server για το badge (Pro) εφαρμόζεται τότε");
}

async function testConfigOffMode() {
  console.log("\n[data-config=\"off\" -- προεπισκόπηση: κανένα αίτημα, ισχύουν τα attributes, το badge φαίνεται]");
  const window = await withDom('data-embed-id="emb-test123" data-config="off" data-accent-color="#2F5BEA" data-bot-name="Preview"', null, cfgOk({ ...FULL_CFG, showBranding: false }));
  await wait(20);
  const root = rootOf(window);
  assert(window.__configCalls.length === 0, "ΚΑΝΕΝΑ αίτημα ρυθμίσεων");
  assert(!root.querySelector(".bubble").classList.contains("pending"), "το κουμπί εμφανίζεται αμέσως");
  assert(root.querySelector(".header-title").textContent === "Preview" && /--accent:#2f5bea;/i.test(widgetCss(window)), "ισχύουν τα attributes");
  assert(root.querySelector(".powered").hidden === false, "το badge φαίνεται πάντα (δεν παρακάμπτεται με data-config=off)");
}

async function testHostileConfig() {
  console.log("\n[Επιθετικές τιμές από τον server -- δεύτερη γραμμή άμυνας στο widget]");
  const attrs = 'data-embed-id="emb-test123" data-accent-color="#FF0000" data-bot-name="Safe Name"';
  const run = async (cfg) => {
    const window = await withDom(attrs, null, cfgOk({ showBranding: true, ...cfg }));
    await wait(20);
    return window;
  };
  let w = await run({ botName: "<img src=x onerror=alert(1)>" });
  let root = rootOf(w);
  assert(root.querySelector(".header-title").textContent === "<img src=x onerror=alert(1)>" && !root.querySelector(".header-title img"), "όνομα με HTML: εμφανίζεται ως κείμενο, καμία ετικέτα δεν ενεργοποιείται");
  w = await run({ botName: "x".repeat(61) });
  assert(rootOf(w).querySelector(".header-title").textContent === "Safe Name", "όνομα 61 χαρακτήρων: αγνοείται");
  for (const bad of ["red", "#12", "javascript:1", "#fff;} body{display:none", 123]) {
    w = await run({ accentColor: bad });
    assert(/--accent:#ff0000;/i.test(widgetCss(w)) && !widgetCss(w).includes("body{"), `άκυρο χρώμα ${JSON.stringify(bad)}: μένει του snippet`);
  }
  for (const bad of ["http://cdn.example.gr/l.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "//cdn.example.gr/l.png", "https://cdn.example.gr/a b.png", 123]) {
    w = await run({ logoUrl: bad });
    assert(!rootOf(w).querySelector(".avatar img"), `λογότυπο ${JSON.stringify(bad)}: δεν φορτώνεται`);
  }
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:1", "data:text/html,x", "vbscript:x", " javascript:1", "no-scheme.gr"]) {
    w = await run({ contactLabel: "Επικοινωνία", contactUrl: bad });
    assert(!rootOf(w).querySelector(".contact-bar"), `contactUrl ${JSON.stringify(bad)}: δεν δημιουργείται link`);
  }
  for (const bad of ['210" onclick="x', "call me", "<b>1</b>"]) {
    w = await run({ contactPhone: bad });
    assert(!rootOf(w).querySelector(".contact-bar"), `τηλέφωνο ${JSON.stringify(bad)}: αγνοείται`);
  }
  w = await run({ contactLabel: "x".repeat(41), contactUrl: "https://x.gr/c" });
  assert(!rootOf(w).querySelector(".contact-bar"), "contactLabel 41 χαρακτήρων: αγνοείται (χωρίς label δεν υπάρχει link)");
  w = await run({ contactPhone: "(210) 123-4567" });
  assert(rootOf(w).querySelectorAll(".contact-bar .contact-link").length === 1, "έγκυρο τηλέφωνο μόνο του: δημιουργεί ένα κουμπί");
}

async function testLogoLoadFailureFallsBack() {
  console.log("\n[Λογότυπο που δεν φορτώνει -- επιστρέφει το προεπιλεγμένο εικονίδιο]");
  const window = await withDom('data-embed-id="emb-test123"', null, cfgOk({ logoUrl: "https://cdn.example.gr/missing.png", showBranding: true }));
  await wait(20);
  const root = rootOf(window);
  const img = root.querySelector(".avatar img");
  assert(!!img, "το λογότυπο δοκιμάστηκε");
  img.dispatchEvent(new window.Event("error"));
  assert(!root.querySelector(".avatar img") && !!root.querySelector(".avatar svg"), "μετά από σφάλμα φόρτωσης: πάλι το προεπιλεγμένο εικονίδιο");
}

async function testConversationStillWorksAfterConfig() {
  console.log("\n[Η συζήτηση δουλεύει κανονικά μετά τις ρυθμίσεις (ιστορικό, contact prompt)]");
  const bodies = [];
  const window = await withDom('data-embed-id="emb-test123"', async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, body: makeSSEBody([{ type: "chunk", text: "Δεν γνωρίζω." }, { type: "done", isFallback: true }]) };
  }, cfgOk(FULL_CFG));
  await wait(20);
  const host = window.document.getElementById("rag-embed-widget-host");
  await ask(window, host, "Ερώτηση 1");
  await ask(window, host, "Ερώτηση 2");
  assert(bodies.length === 2 && bodies[1].history.length === 2, "το ιστορικό δουλεύει (2 μηνύματα στη δεύτερη ερώτηση)");
  const prompts = rootOf(window).querySelectorAll(".msg.fallback-contact");
  assert(prompts.length === 2 && prompts[0].querySelectorAll(".contact-link").length === 2, "το μήνυμα επικοινωνίας μετά από \"δεν γνωρίζω\" χρησιμοποιεί τα στοιχεία του server");
  assert(rootOf(window).querySelectorAll(".msg").length === 6, "3 μηνύματα ανά ερώτηση: χρήστης, bot, επικοινωνία");
}

async function testServerColorContrast() {
  console.log("\n[Ρυθμίσεις -- το χρώμα κειμένου προσαρμόζεται και στο χρώμα που έρχεται από τον server]");
  const onAccent = async (attrColor, serverColor) => {
    const attrs = 'data-embed-id="emb-test123"' + (attrColor ? ` data-accent-color="${attrColor}"` : "");
    const window = await withDom(attrs, null, cfgOk({ accentColor: serverColor, showBranding: true }));
    await wait(20);
    const css = widgetCss(window);
    return { on: /--on-accent:([^;]+);/.exec(css)[1], accent: /--accent:([^;]+);/.exec(css)[1].toLowerCase(), avatar: /--avatar-bg:([^;]+);/.exec(css)[1] };
  };
  let r = await onAccent(null, "#FFE14D");
  assert(r.accent === "#ffe14d" && r.on === "#111111", "ανοιχτό κίτρινο από τον server (πάνω σε γκρι snippet): σκούρο κείμενο");
  assert(r.avatar.startsWith("rgba(0,0,0"), "και σκούρο περίγραμμα avatar (όχι λευκό)");
  r = await onAccent("#FFE14D", "#111111");
  assert(r.accent === "#111111" && r.on === "#ffffff", "σκούρο από τον server (πάνω σε κίτρινο snippet): άσπρο κείμενο");
  assert(r.avatar.startsWith("rgba(255,255,255"), "και λευκό περίγραμμα avatar");
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
  await testNewHeaderStructure();
  await testLauncherIcon();
  await testAccentColorHandling();
  await testAutomaticContrast();
  await testPillShapesAndAccessibilityCss();
  await testPositionStillWorks();
  await testConfigRequest();
  await testConfigApplied();
  await testServerWinsOverAttributes();
  await testBrandingRules();
  await testConfigFailureFallsBack();
  await testLauncherPendingAndTimeout();
  await testConfigOffMode();
  await testHostileConfig();
  await testLogoLoadFailureFallsBack();
  await testConversationStillWorksAfterConfig();
  await testServerColorContrast();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
