// Έλεγχος της εφεδρείας LLM (Section R, Στάδιο Β): αν το Gemini δεν γράψει απάντηση,
// την ίδια ερώτηση την απαντάει το Workers AI (env.AI). Τρέχει ΧΩΡΙΣ wrangler dev, ΧΩΡΙΣ
// Gemini και ΧΩΡΙΣ Workers AI: φορτώνει τον πραγματικό src/index.js και του δίνει ψεύτικα
// D1/KV/Vectorize, ψεύτικο Gemini (μέσω fetch) και ψεύτικο env.AI.
// Χρήση (PowerShell, από τον φάκελο idmon):
//   node tests/llm-fallback.mjs
import { loadWorker } from "./helpers/load-worker.mjs";

// Φόρτωση του ΠΡΑΓΜΑΤΙΚΟΥ src/index.js στο Node: βλ. tests/helpers/load-worker.mjs
const worker = await loadWorker();

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

const GEMINI_ANSWER = "Απάντηση από το Gemini.";
const FALLBACK_ANSWER = "Απάντηση από την εφεδρεία.";

// Ψεύτικο Gemini. mode: "ok" | "http500" | "empty" | "hang" | "network"
// stream: "ok" | "fail" | "partial" | "hang" (για το /query/stream)
function makeGemini({ mode = "ok", stream = "ok" } = {}) {
  const calls = { generate: 0, stream: 0, embed: 0 };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes(":embedContent")) {
      calls.embed++;
      return new Response(JSON.stringify({ embedding: { values: new Array(768).fill(0.01) } }), { headers: { "Content-Type": "application/json" } });
    }
    if (u.includes(":streamGenerateContent")) {
      calls.stream++;
      if (stream === "fail") return new Response("boom", { status: 503 });
      if (stream === "hang") return hang(init.signal);
      const enc = new TextEncoder();
      const piece = (t) => enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\r\n\r\n`);
      // pull: κάθε κομμάτι παραδίδεται όταν το ζητήσει ο αναγνώστης, ώστε στο "partial"
      // το πρώτο κομμάτι να ΕΧΕΙ διαβαστεί πριν σπάσει η σύνδεση.
      let step = 0;
      const body = new ReadableStream({
        pull(c) {
          step++;
          if (step === 1) { c.enqueue(piece("Πρώτο κομμάτι. ")); return; }
          if (stream === "partial") { c.error(new Error("connection reset")); return; }
          if (step === 2) { c.enqueue(piece("Δεύτερο κομμάτι.")); return; }
          c.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (u.includes(":generateContent")) {
      calls.generate++;
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "hang") return hang(init.signal);
      if (mode === "http500") return new Response(JSON.stringify({ error: { code: 500, message: "internal" } }), { status: 500 });
      if (mode === "empty") return new Response(JSON.stringify({ candidates: [] }), { headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: GEMINI_ANSWER }] } }] }), { headers: { "Content-Type": "application/json" } });
    }
    throw new Error("Unexpected fetch in test: " + u);
  };
  return { fetchImpl, calls };
}

// Ένα αίτημα που δεν απαντάει ποτέ, εκτός αν ακυρωθεί από το signal (όπως το AbortSignal.timeout).
function hang(signal) {
  return new Promise((_, reject) => {
    if (signal) signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")));
  });
}

// Ψεύτικο Workers AI. mode: "ok" | "choices" | "fail" | "empty" | "missing" | "thinking-only" | "thought-tags"
function makeAI(mode = "ok") {
  const calls = [];
  if (mode === "missing") return { ai: undefined, calls };
  const ai = {
    async run(model, input, options) {
      calls.push({ model, input, options });
      if (mode === "fail") throw new Error("3040: Out of capacity");
      if (mode === "empty") return { response: "   " };
      if (mode === "choices") return { choices: [{ message: { role: "assistant", content: FALLBACK_ANSWER } }] };
      // Όπως στην πρώτη πραγματική δοκιμή: όλο το όριο πήγε σε σκέψη, καμία τελική απάντηση.
      if (mode === "thinking-only") return { choices: [{ message: { role: "assistant", content: null, reasoning: "Let me think..." }, finish_reason: "length" }] };
      if (mode === "thought-tags") return { choices: [{ message: { role: "assistant", content: "<|channel>thought\n<channel|>" + FALLBACK_ANSWER } }] };
      return { response: FALLBACK_ANSWER };
    },
  };
  return { ai, calls };
}

function makeEnv({ ai, vars = {} } = {}) {
  const kv = new Map();
  const DB = {
    prepare() {
      const stmt = {
        bind() { return stmt; },
        async first() { return null; },
        async run() { return { success: true, meta: {} }; },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
  const KV = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, v); },
    async delete(k) { kv.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
  const VECTORIZE = {
    async query() {
      return { matches: [{ id: "doc-1:0", score: 0.9, metadata: { documentId: "doc-1", chunkIndex: 0, text: "Το κατάστημα είναι ανοιχτό 9:00 με 17:00." } }] };
    },
  };
  return {
    DB, DOCUMENT_REGISTRY: KV, VECTORIZE, AI: ai,
    GEMINI_API_KEY: "test-key", AI_GATEWAY_TOKEN: "t", CF_ACCOUNT_ID: "acc", AI_GATEWAY_ID: "idmon-ai",
    ...vars,
  };
}

async function ask(env, gemini, path = "/query") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = gemini.fetchImpl;
  // Στο Node τα χρονόμετρα του AbortSignal.timeout δεν κρατάνε "ζωντανή" τη διεργασία:
  // χωρίς αυτό, στα σενάρια "κολλημένο Gemini" το Node θα τερμάτιζε πριν λήξει το όριο.
  const keepAlive = setInterval(() => {}, 1000);
  const logs = [];
  const origErr = console.error, origLog = console.log;
  console.error = (...a) => logs.push(a.join(" "));
  console.log = (...a) => { if (String(a[0]).startsWith("LLM fallback")) logs.push(a.join(" ")); else origLog(...a); };
  try {
    const res = await worker.fetch(new Request("https://idmon.app" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": "ws-test" },
      body: JSON.stringify({ question: "Τι ώρα ανοίγει;" }),
    }), env, { waitUntil() {}, passThroughOnException() {} });
    let body;
    if (path === "/query/stream" && (res.headers.get("Content-Type") || "").includes("text/event-stream")) {
      const text = await res.text();
      body = text.split("\n\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    } else {
      body = await res.json().catch(() => null);
    }
    return { res, body, logs };
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = realFetch;
    console.error = origErr;
    console.log = origLog;
  }
}

const streamText = (events) => events.filter((e) => e.type === "chunk").map((e) => e.text).join("");

console.log("Gemini works: the fallback is never used");
{
  const g = makeGemini(); const a = makeAI();
  const { res, body, logs } = await ask(makeEnv({ ai: a.ai }), g);
  check("answer comes from Gemini", res.status === 200 && body.answer === GEMINI_ANSWER, JSON.stringify(body));
  check("Workers AI is not called", a.calls.length === 0);
  check("nothing logged about a fallback", logs.length === 0, logs.join(" | "));
}

console.log("Gemini fails: Workers AI answers the same question");
for (const mode of ["http500", "empty", "network"]) {
  const g = makeGemini({ mode }); const a = makeAI();
  const { res, body, logs } = await ask(makeEnv({ ai: a.ai }), g);
  check(`${mode}: the visitor still gets an answer (from the fallback)`, res.status === 200 && body.answer === FALLBACK_ANSWER, JSON.stringify(body));
  check(`${mode}: exactly one Workers AI call, to the Gemma 4 model`, a.calls.length === 1 && a.calls[0].model === "@cf/google/gemma-4-26b-a4b-it");
  check(`${mode}: the fallback is logged`, logs.some((l) => l.includes("LLM fallback: Gemini failed")), logs.join(" | "));
}
{
  const g = makeGemini({ mode: "http500" }); const a = makeAI();
  await ask(makeEnv({ ai: a.ai }), g);
  const c = a.calls[0];
  check("the SAME prompt goes to the fallback (with the document text and the question)", c && c.input.messages.length === 1 && c.input.messages[0].role === "user" && c.input.messages[0].content.includes("9:00 με 17:00") && c.input.messages[0].content.includes("Τι ώρα ανοίγει;"));
  check("fails fast when Workers AI is busy (rejectIfBusy), with an answer length limit", c && c.options && c.options.rejectIfBusy === true && c.input.max_tokens > 0);
  check("thinking is turned OFF (otherwise Gemma 4 can spend the whole budget thinking and return nothing)", c && c.input.chat_template_kwargs && c.input.chat_template_kwargs.enable_thinking === false);
}
{
  const g = makeGemini({ mode: "http500" }); const a = makeAI("choices");
  const { body } = await ask(makeEnv({ ai: a.ai }), g);
  check("also reads the chat-completions answer shape ({choices:[{message}]})", body && body.answer === FALLBACK_ANSWER, JSON.stringify(body));
}

{
  const g = makeGemini({ mode: "http500" }); const a = makeAI("thought-tags");
  const { body } = await ask(makeEnv({ ai: a.ai }), g);
  check("an (empty) thought block before the answer is removed", body && body.answer === FALLBACK_ANSWER, JSON.stringify(body));
}
{
  const g = makeGemini({ mode: "http500" }); const a = makeAI("thinking-only");
  let threw = false, logs = [];
  try { const r = await ask(makeEnv({ ai: a.ai }), g); logs = r.logs; } catch (e) { threw = true; }
  check("only thinking, no answer: treated as a failure, never an empty reply to the visitor", threw);
}

console.log("Gemini hangs: the time limit gives the question to the fallback");
{
  const g = makeGemini({ mode: "hang" }); const a = makeAI();
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 50); // 50ms αντί για 20s, μόνο στο test
  const started = Date.now();
  const { res, body } = await ask(makeEnv({ ai: a.ai }), g);
  AbortSignal.timeout = realTimeout;
  check("the stuck Gemini call is cut and the fallback answers", res.status === 200 && body.answer === FALLBACK_ANSWER, JSON.stringify(body));
  check("it did not wait forever", Date.now() - started < 5000);
}

console.log("both fail: same behaviour as before (an error, not a made-up answer)");
for (const aiMode of ["fail", "empty", "missing"]) {
  const g = makeGemini({ mode: "http500" }); const a = makeAI(aiMode);
  let threw = false, status = null;
  try { const r = await ask(makeEnv({ ai: a.ai }), g); status = r.res.status; } catch (e) { threw = true; }
  check(`fallback ${aiMode}: no answer is invented (error, like before the fallback existed)`, threw || (status >= 500), String(status));
}

console.log("local test switch FORCE_LLM_FALLBACK=1");
{
  const g = makeGemini(); const a = makeAI();
  const { body, logs } = await ask(makeEnv({ ai: a.ai, vars: { FORCE_LLM_FALLBACK: "1" } }), g);
  check("answers with Workers AI without even asking Gemini", body && body.answer === FALLBACK_ANSWER && g.calls.generate === 0, JSON.stringify(body));
  check("says so in the log", logs.some((l) => l.includes("FORCE_LLM_FALLBACK=1")));
}
{
  const g = makeGemini(); const a = makeAI();
  const { body } = await ask(makeEnv({ ai: a.ai, vars: { FORCE_LLM_FALLBACK: "0" } }), g);
  check("any other value: normal Gemini", body && body.answer === GEMINI_ANSWER && a.calls.length === 0);
}

console.log("streaming (/query/stream)");
{
  const g = makeGemini(); const a = makeAI();
  const { body } = await ask(makeEnv({ ai: a.ai }), g, "/query/stream");
  check("Gemini streams normally: two pieces, no fallback", streamText(body) === "Πρώτο κομμάτι. Δεύτερο κομμάτι." && a.calls.length === 0 && g.calls.generate === 0, JSON.stringify(body));
}
{
  const g = makeGemini({ stream: "fail", mode: "http500" }); const a = makeAI();
  const { body } = await ask(makeEnv({ ai: a.ai }), g, "/query/stream");
  check("streaming fails and Gemini fails: the fallback answer arrives in one piece", streamText(body) === FALLBACK_ANSWER && body.some((e) => e.type === "done"), JSON.stringify(body));
}
{
  const g = makeGemini({ stream: "fail" }); const a = makeAI();
  const { body } = await ask(makeEnv({ ai: a.ai }), g, "/query/stream");
  check("streaming fails but Gemini works: Gemini answers in one piece, no fallback (as before)", streamText(body) === GEMINI_ANSWER && a.calls.length === 0, JSON.stringify(body));
}
{
  const g = makeGemini({ stream: "partial" }); const a = makeAI();
  const { body } = await ask(makeEnv({ ai: a.ai }), g, "/query/stream");
  const text = streamText(body);
  check("streaming breaks AFTER sending text: no second copy of the answer", text === "Πρώτο κομμάτι. " && g.calls.generate === 0 && a.calls.length === 0, JSON.stringify(text));
  check("...and the stream still ends properly", body.some((e) => e.type === "done"));
}
{
  const g = makeGemini({ stream: "hang", mode: "http500" }); const a = makeAI();
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 50 : ms, ...rest); // 50ms αντί για 20s, μόνο στο test
  const started = Date.now();
  const { body } = await ask(makeEnv({ ai: a.ai }), g, "/query/stream");
  globalThis.setTimeout = realSetTimeout;
  check("streaming hangs before the first piece: cut, then the fallback answers", streamText(body) === FALLBACK_ANSWER, JSON.stringify(body));
  check("it did not wait forever", Date.now() - started < 5000);
}
{
  const g = makeGemini(); const a = makeAI();
  const { body } = await ask(makeEnv({ ai: a.ai, vars: { FORCE_LLM_FALLBACK: "1" } }), g, "/query/stream");
  check("FORCE_LLM_FALLBACK=1 on the stream: no Gemini streaming, the fallback answers", streamText(body) === FALLBACK_ANSWER && g.calls.stream === 0 && g.calls.generate === 0, JSON.stringify(body));
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
