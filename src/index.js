const CHUNK_SIZE = 300;
const CHUNK_OVERLAP = 30;
const TOP_K = 4;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MAX_UPLOAD_WORDS = 8000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const FALLBACK_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 ημέρες

// Το πραγματικό workspace του διαχειριστή -- ΠΟΤΕ καμία λήξη σε τίποτα εδώ
// (draft, deleted, ή δημοσιευμένο). Κάθε άλλο workspace (τυχαίοι επισκέπτες
// με το δικό τους αυτόματο, τοπικά-αποθηκευμένο ID) παίρνει ενιαία λήξη
// 7 ημερών σε ΟΤΙΔΗΠΟΤΕ ανεβάσουν/αλλάξουν -- ανανεώνεται αυτόματα σε κάθε
// νέα εγγραφή, οπότε κάτι που συντηρείται ενεργά ουσιαστικά δεν λήγει ποτέ.
const PROTECTED_WORKSPACE_ID = "efood-ops-demo";
const VISITOR_DOC_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 ημέρες

// Section G: ρυθμίσεις widget ανά workspace (εμφάνιση + email ειδοποίησης).
// Αποθηκεύονται σε ΕΝΑ KV record (όχι ξεχωριστό key ανά πεδίο) ώστε να μη
// χρειάζονται πολλαπλά reads/writes για κάτι που πάντα διαβάζεται/γράφεται μαζί.
const DEFAULT_WIDGET_SETTINGS = {
  accentColor: "#6B7280",
  botName: "Assistant",
  logoUrl: null,
  notifyEmail: null,
};
const SETTINGS_ALLOWED_FIELDS = ["accentColor", "botName", "logoUrl", "notifyEmail"];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Section H: λογαριασμοί πελατών + sessions (D1).
//
// PBKDF2 μέσω του ενσωματωμένου Web Crypto του Workers -- καμία εξωτερική
// βιβλιοθήκη δεν χρειάζεται. 100.000 iterations είναι ένα λογικό,
// αναγνωρισμένο standard (NIST recommends >=10.000, εδώ είμαστε πιο
// συντηρητικοί).
const PBKDF2_ITERATIONS = 100000;
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 ημέρες

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes.buffer;
}

// crypto.getRandomValues -- κρυπτογραφικά ασφαλές RNG, διαθέσιμο native στο
// Workers runtime. Χρησιμοποιείται ΚΑΙ για salts ΚΑΙ για session tokens.
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes.buffer);
}

async function hashPassword(password, saltHex) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBuffer(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bufferToHex(derivedBits);
}

// Σύγκριση σταθερού χρόνου -- ένα απλό "===" θα μπορούσε θεωρητικά να
// διαρρεύσει πληροφορία μέσω του πόσο γρήγορα επιστρέφει false (timing
// attack). Εδώ ελέγχουμε ΟΛΟΥΣ τους χαρακτήρες πάντα, ό,τι κι αν βρεθεί.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, saltHex, expectedHashHex) {
  const actualHashHex = await hashPassword(password, saltHex);
  return timingSafeEqual(actualHashHex, expectedHashHex);
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

async function createSession(env, userId, workspaceId) {
  const token = randomHex(32); // 256-bit, αδύνατο να μαντευτεί
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_DURATION_MS);
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(token, userId, workspaceId, createdAt.toISOString(), expiresAt.toISOString()).run();
  return { token, expiresAt };
}

// Η ΜΟΝΗ πύλη προς το workspaceId ενός request. Αν υπάρχει X-Session-Token,
// ΔΕΝ το εμπιστευόμαστε απευθείας -- κάνουμε lookup στη D1 να δούμε σε ποιο
// workspace αντιστοιχεί ΠΡΑΓΜΑΤΙΚΑ αυτό το token αυτή τη στιγμή (και αν έχει
// λήξει). Αν το session είναι άκυρο/ληγμένο, επιστρέφουμε null -- ΔΕΝ
// πέφτουμε πίσω σε ό,τι X-Workspace-Id έστειλε ο client, γιατί αυτό θα
// ακύρωνε τελείως το νόημα του session (ο client θα μπορούσε να προσποιηθεί
// οποιοδήποτε workspace απλά γράφοντας το header).
//
// Χωρίς κανένα X-Session-Token (Developer password / Guest flow, όπως πριν
// τα accounts), συνεχίζουμε να εμπιστευόμαστε το X-Workspace-Id header --
// backward compatible, δεν σπάει τίποτα από το προηγούμενο demo/guest flow.
async function resolveWorkspaceId(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) {
    return request.headers.get("X-Workspace-Id");
  }
  const row = await env.DB.prepare(
    "SELECT workspace_id, expires_at FROM sessions WHERE token = ?"
  ).bind(sessionToken).first();
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) return null;
  return row.workspace_id;
}

async function handleSignup(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }
  const email = (body.email || "").trim().toLowerCase();
  const { password } = body;

  if (!email || !EMAIL_RE.test(email)) return jsonError(400, "Valid email is required");
  if (!password || password.length < 8) return jsonError(400, "Password must be at least 8 characters");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return jsonError(409, "An account with this email already exists");

  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt);
  const workspaceId = `ws-${randomHex(12)}`;
  const createdAt = new Date().toISOString();

  const result = await env.DB.prepare(
    "INSERT INTO users (email, password_hash, password_salt, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(email, passwordHash, salt, workspaceId, createdAt).run();

  const session = await createSession(env, result.meta.last_row_id, workspaceId);

  return new Response(
    JSON.stringify({ ok: true, sessionToken: session.token, workspaceId }),
    { headers: JSON_HEADERS }
  );
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }
  const email = (body.email || "").trim().toLowerCase();
  const { password } = body;

  if (!email || !password) return jsonError(400, "Email and password are required");

  const user = await env.DB.prepare(
    "SELECT id, password_hash, password_salt, workspace_id FROM users WHERE email = ?"
  ).bind(email).first();

  // Το ΙΔΙΟ γενικό μήνυμα λάθους είτε δεν υπάρχει το email είτε το password
  // είναι λάθος -- ΠΟΤΕ δεν αποκαλύπτουμε ποιο από τα δύο ίσχυε (θα βοηθούσε
  // κάποιον να μαντέψει ποια emails είναι ήδη εγγεγραμμένα).
  if (!user) return jsonError(401, "Invalid email or password");

  const valid = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!valid) return jsonError(401, "Invalid email or password");

  const session = await createSession(env, user.id, user.workspace_id);

  return new Response(
    JSON.stringify({ ok: true, sessionToken: session.token, workspaceId: user.workspace_id }),
    { headers: JSON_HEADERS }
  );
}

async function handleLogout(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) return jsonError(400, "Missing X-Session-Token header");
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(sessionToken).run();
  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

// Ειδοποίηση email όταν το bot απαντάει "δεν γνωρίζω" -- ΤΟ ΠΟΛΥ μία φορά
// την ώρα ανά workspace, ώστε μια σειρά αναπάντητων ερωτήσεων να μη γεμίσει
// το inbox του πελάτη με ένα email ανά ερώτηση.
const NOTIFY_COOLDOWN_SECONDS = 60 * 60; // 1 ώρα

// Επιστρέφει τα options που πρέπει να περάσουν στο env.DOCUMENT_REGISTRY.put(),
// και το ισοδύναμο expiresAt (για να το δείχνουμε στο frontend), ανάλογα με
// το αν το workspace είναι το προστατευμένο ή όχι.
function docTtlFor(workspaceId) {
  if (workspaceId === PROTECTED_WORKSPACE_ID) {
    return { putOptions: {}, expiresAt: null };
  }
  return {
    putOptions: { expirationTtl: VISITOR_DOC_TTL_SECONDS },
    expiresAt: new Date(Date.now() + VISITOR_DOC_TTL_SECONDS * 1000).toISOString(),
  };
}

// Διαβάζει τις ρυθμίσεις widget ενός workspace, με τα defaults σαν βάση
// (ώστε ένα workspace που ποτέ δεν έκανε save να παίρνει πάντα πλήρες,
// έγκυρο αντικείμενο -- όχι undefined πεδία που σπάνε το frontend).
async function getWorkspaceSettings(env, workspaceId) {
  const raw = await env.DOCUMENT_REGISTRY.get(`workspace:${workspaceId}:settings`);
  if (!raw) return { ...DEFAULT_WIDGET_SETTINGS };
  return { ...DEFAULT_WIDGET_SETTINGS, ...JSON.parse(raw) };
}

async function handleGetSettings(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  const settings = await getWorkspaceSettings(env, workspaceId);
  return new Response(JSON.stringify(settings), { headers: JSON_HEADERS });
}

async function handlePatchSettings(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: JSON_HEADERS });
  }

  const current = await getWorkspaceSettings(env, workspaceId);

  // Whitelist -- αγνοούμε οτιδήποτε άλλο πεδίο σταλεί, ποτέ δεν κάνουμε
  // spread ολόκληρου του body πάνω στο αποθηκευμένο αντικείμενο.
  for (const field of SETTINGS_ALLOWED_FIELDS) {
    if (field in body) current[field] = body[field];
  }

  if (current.accentColor && !HEX_COLOR_RE.test(current.accentColor)) {
    return new Response(
      JSON.stringify({ error: "accentColor must be a hex color like #6B7280" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  if (current.notifyEmail && !EMAIL_RE.test(current.notifyEmail)) {
    return new Response(
      JSON.stringify({ error: "notifyEmail is not a valid email address" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  if (current.botName && current.botName.length > 60) {
    return new Response(
      JSON.stringify({ error: "botName is too long (max 60 characters)" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Ίδια πολιτική TTL με τα υπόλοιπα δεδομένα του workspace: το προστατευμένο
  // demo workspace δεν λήγει ποτέ, οι επισκέπτες παίρνουν 7 ημέρες που
  // ανανεώνονται αυτόματα σε κάθε save.
  const { putOptions } = docTtlFor(workspaceId);
  await env.DOCUMENT_REGISTRY.put(`workspace:${workspaceId}:settings`, JSON.stringify(current), putOptions);

  return new Response(JSON.stringify(current), { headers: JSON_HEADERS });
}

// Στέλνει ένα απλό transactional email μέσω Resend (https://resend.com).
// Best-effort: ΠΟΤΕ δεν πετάει exception προς τα έξω -- μια αποτυχία στέλνοντας
// notification δεν πρέπει ποτέ να χαλάσει την απάντηση που παίρνει ο χρήστης
// του widget. Αν δεν έχει ρυθμιστεί ακόμα το RESEND_API_KEY secret, απλά δεν
// στέλνει τίποτα (σιωπηλά) -- έτσι το feature είναι "add-on", όχι hard requirement.
async function sendFallbackNotificationEmail(env, toEmail, question, workspaceId) {
  if (!env.RESEND_API_KEY) return;

  const fromEmail = env.NOTIFY_FROM_EMAIL || "notifications@example.com";

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: "Ο βοηθός δεν μπόρεσε να απαντήσει σε μια ερώτηση",
        text: `Κάποιος ρώτησε κάτι που ο AI βοηθός σου δεν μπόρεσε να απαντήσει:\n\n"${question}"\n\nΜπες στο editor (καρτέλα "Unanswered questions") για να δεις όλες τις εκκρεμείς ερωτήσεις και να προσθέσεις σχετικό περιεχόμενο.\n\n(workspace: ${workspaceId})`,
      }),
    });
  } catch (err) {
    // Σκόπιμα καταπίνουμε το error -- βλ. σχόλιο πάνω από τη function.
  }
}

function chunkText(text) {
  const words = text.trim().split(/\s+/);
  const chunks = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + CHUNK_SIZE, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  return chunks;
}

async function getEmbedding(text, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    }
  );

  const data = await response.json();

  if (!data.embedding || !data.embedding.values) {
    throw new Error("Embedding failed: " + JSON.stringify(data));
  }

  return data.embedding.values;
}

async function askGemini(context, question, apiKey) {
  const prompt = `Απάντησε στην ερώτηση χρησιμοποιώντας ΜΟΝΟ τις παρακάτω πληροφορίες. Αν η απάντηση δεν βρίσκεται στις πληροφορίες, πες ότι δεν γνωρίζεις. Απάντησε στην ίδια γλώσσα με την ερώτηση.

Πληροφορίες:
${context}

Ερώτηση: ${question}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await response.json();

  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!answer) {
    throw new Error("Gemini generation failed: " + JSON.stringify(data));
  }

  return answer;
}

// Αφαιρεί τα σύμβολα markdown (#, **, _, [](), κλπ) ώστε τα σύντομα
// αποσπάσματα (preview) στις κάρτες λίστας να δείχνουν καθαρό κείμενο,
// όχι raw σύνταξη. Χρησιμοποιείται ΜΟΝΟ για preview -- το πλήρες κείμενο
// συνεχίζει να αποθηκεύεται/εμφανίζεται ως markdown παντού αλλού.
function stripMarkdownForPreview(text) {
  return text
    .replace(/^#{1,6}\s+/gm, "")           // επικεφαλίδες: # ## ### ...
    .replace(/```[\s\S]*?```/g, " ")        // code blocks
    .replace(/`([^`]+)`/g, "$1")            // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // εικόνες -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")  // links -> κείμενο
    .replace(/^\s*>\s?/gm, "")              // blockquote >
    .replace(/^\s*[-*+]\s+/gm, "")          // bullet lists
    .replace(/^\s*\d+\.\s+/gm, "")          // αριθμημένες λίστες
    .replace(/\*\*([^*]+)\*\*/g, "$1")      // **bold**
    .replace(/__([^_]+)__/g, "$1")          // __bold__
    .replace(/\*([^*]+)\*/g, "$1")          // *italic*
    .replace(/_([^_]+)_/g, "$1")            // _italic_
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")     // οριζόντιες γραμμές ---
    .replace(/\s+/g, " ")
    .trim();
}

function makePreview(text, maxWords = 18) {
  const words = stripMarkdownForPreview(text).split(/\s+/);
  const preview = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? preview + "…" : preview;
}

// Καταγράφει μια ερώτηση που δεν βρήκε απάντηση, με αυτόματη λήξη μετά
// από FALLBACK_TTL_SECONDS -- καμία ενεργή διαδικασία καθαρισμού δεν
// χρειάζεται, το KV το κάνει μόνο του (passive TTL, όχι background cron).
async function logFallbackQuestion(env, workspaceId, question) {
  const key = `session:${workspaceId}:fallback:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await env.DOCUMENT_REGISTRY.put(
    key,
    JSON.stringify({ question, timestamp: new Date().toISOString() }),
    { expirationTtl: FALLBACK_TTL_SECONDS }
  );

  // Ειδοποίηση email, best-effort -- ΠΟΤΕ δεν πρέπει να μπλοκάρει ή να σπάσει
  // την απάντηση προς τον χρήστη του widget αν κάτι πάει στραβά εδώ.
  try {
    const settings = await getWorkspaceSettings(env, workspaceId);
    if (settings.notifyEmail) {
      const cooldownKey = `session:${workspaceId}:notify-cooldown`;
      const onCooldown = await env.DOCUMENT_REGISTRY.get(cooldownKey);
      if (!onCooldown) {
        // Το cooldown key μπαίνει ΠΡΙΝ σταλεί το email, όχι μετά -- έτσι
        // ακόμα κι αν δύο ερωτήσεις έρθουν ταυτόχρονα (race condition), η
        // χειρότερη περίπτωση είναι δύο emails κοντά στο όριο, ποτέ μηδέν.
        await env.DOCUMENT_REGISTRY.put(cooldownKey, "1", { expirationTtl: NOTIFY_COOLDOWN_SECONDS });
        await sendFallbackNotificationEmail(env, settings.notifyEmail, question, workspaceId);
      }
    }
  } catch (err) {
    // Σκόπιμα καταπίνουμε το error -- δες σχόλιο πάνω.
  }
}

// Χειροκίνητος έλεγχος αντιφάσεων: ο editor επιλέγει 2-3 έγγραφα, ΕΝΑ ΜΟΝΟ
// Gemini call τα συγκρίνει όλα μαζί (όχι ζευγάρι-ζευγάρι -- πιο φθηνό, και ο
// agent βλέπει όλο το context μαζί, οπότε μπορεί να πιάσει και αντιφάσεις
// που εμπλέκουν και τα 3 έγγραφα ταυτόχρονα, όχι μόνο ζεύγη).
const COMPARE_MIN_DOCS = 2;
const COMPARE_MAX_DOCS = 3;

async function askGeminiForContradictions(documents, apiKey, lang) {
  const documentsBlock = documents
    .map((doc, i) => `--- Document ${i + 1}: "${doc.title}" ---\n${doc.text}`)
    .join("\n\n");

  // Η περιγραφή ακολουθεί τη γλώσσα του UI editor (EN/GR) που στέλνει το
  // frontend -- ΟΧΙ αυτόματα τη γλώσσα των ίδιων των εγγράφων, ώστε να
  // ταιριάζει πάντα με το υπόλοιπο περιβάλλον (τίτλοι κουμπιών, μηνύματα).
  const descriptionLanguage = lang === "el" ? "Greek" : "English";

  const prompt = `You are reviewing internal operational documents for contradictions or inconsistencies -- cases where two or more documents give conflicting instructions, numbers, or rules about the same situation.

${documentsBlock}

Respond with ONLY a valid JSON array, no markdown code fences, no extra text. Each item must have exactly these fields:
- "documentTitles": array of the exact document titles involved in this contradiction (use the titles exactly as given above)
- "description": a short, specific description IN ${descriptionLanguage.toUpperCase()} of what each document says and why they conflict

If you find no contradictions, respond with exactly: []`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error("Gemini comparison failed: " + JSON.stringify(data));
  }

  // Ο Gemini μερικές φορές τυλίγει το JSON σε ```json ... ``` code fence
  // παρά τη ρητή οδηγία -- το αφαιρούμε πριν το parse.
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let findings;
  try {
    findings = JSON.parse(cleaned);
  } catch (err) {
    throw new Error("Could not parse Gemini comparison response as JSON: " + cleaned.slice(0, 200));
  }

  if (!Array.isArray(findings)) {
    throw new Error("Gemini comparison response was not a JSON array");
  }

  return findings;
}

// Ίδια λογική ανάγνωσης με το handleGetDocument (fullText πρώτα, fallback σε
// ανακατασκευή από chunks για παλιά έγγραφα χωρίς fullText) -- ξεχωριστό
// helper, ώστε να μην αγγίξουμε το ήδη δουλεμένο handleGetDocument.
async function getDocumentForCompare(env, workspaceId, documentId) {
  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  const raw = await env.DOCUMENT_REGISTRY.get(kvKey);
  if (!raw) return null;

  const existing = JSON.parse(raw);
  if (existing.status === "deleted") return null;

  let fullText = existing.fullText;
  if (!fullText) {
    const ids = [];
    for (let i = 0; i < (existing.chunkCount || 0); i++) {
      ids.push(`${documentId}-chunk-${i}`);
    }
    const result = await env.VECTORIZE.getByIds(ids);
    const sorted = result.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
    fullText = sorted.map((v) => v.metadata.text).join(" ");
  }

  return { documentId, title: existing.title || documentId, fullText };
}

async function handleCompareDocuments(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const body = await request.json();
  const { documentIds, lang } = body;

  if (
    !Array.isArray(documentIds) ||
    documentIds.length < COMPARE_MIN_DOCS ||
    documentIds.length > COMPARE_MAX_DOCS
  ) {
    return new Response(
      JSON.stringify({
        error: `Select between ${COMPARE_MIN_DOCS} and ${COMPARE_MAX_DOCS} documents to compare.`,
      }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const uniqueIds = [...new Set(documentIds)];
  if (uniqueIds.length !== documentIds.length) {
    return new Response(
      JSON.stringify({ error: "Duplicate document selected." }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const documents = await Promise.all(
    uniqueIds.map((id) => getDocumentForCompare(env, workspaceId, id))
  );

  const missingIndex = documents.findIndex((d) => !d);
  if (missingIndex !== -1) {
    return new Response(
      JSON.stringify({ error: `Document not found or unavailable: ${uniqueIds[missingIndex]}` }),
      { status: 404, headers: JSON_HEADERS }
    );
  }

  const rawFindings = await askGeminiForContradictions(
    documents.map((d) => ({ title: d.title, text: d.fullText })),
    env.GEMINI_API_KEY,
    lang
  );

  // Χαρτογράφηση τίτλων -> documentIds, ώστε το frontend να μπορεί να δείχνει
  // links προς τα σχετικά έγγραφα, όχι μόνο ονόματα.
  const titleToId = new Map(documents.map((d) => [d.title.trim().toLowerCase(), d.documentId]));

  // Ίδια πολιτική λήξης με τα ίδια τα έγγραφα (docTtlFor) -- ΟΧΙ το σύντομο
  // fallback TTL. Ένα εύρημα αντίφασης είναι πραγματικό, χρήσιμο περιεχόμενο
  // που μπορεί να θες να κρατήσεις μέχρι να το λύσεις, όχι "θόρυβος".
  const { putOptions, expiresAt } = docTtlFor(workspaceId);
  const savedFindings = [];

  for (const finding of rawFindings) {
    const titles = Array.isArray(finding.documentTitles) ? finding.documentTitles : [];
    const ids = titles
      .map((t) => titleToId.get(String(t).trim().toLowerCase()))
      .filter(Boolean);

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `session:${workspaceId}:contradiction:${id}`;
    const record = {
      documentTitles: titles,
      documentIds: ids,
      description: finding.description || "",
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    await env.DOCUMENT_REGISTRY.put(key, JSON.stringify(record), putOptions);
    savedFindings.push({ id, ...record });
  }

  return new Response(JSON.stringify({ findings: savedFindings }), { headers: JSON_HEADERS });
}

async function handleGetContradictions(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const prefix = `session:${workspaceId}:contradiction:`;
  const list = await env.DOCUMENT_REGISTRY.list({ prefix });

  const findings = await Promise.all(
    list.keys.map(async (key) => {
      const raw = await env.DOCUMENT_REGISTRY.get(key.name);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return { id: key.name.slice(prefix.length), ...parsed };
    })
  );

  const cleaned = findings
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return new Response(JSON.stringify({ findings: cleaned }), { headers: JSON_HEADERS });
}

async function handleDeleteContradiction(request, env, id) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:contradiction:${id}`;
  await env.DOCUMENT_REGISTRY.delete(kvKey);

  return new Response(JSON.stringify({ id, deleted: true }), { headers: JSON_HEADERS });
}

async function handleUpload(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const body = await request.json();
  const { documentId, text, title, volatility, sourceUrl } = body;

  if (!documentId || !text) {
    return new Response(
      JSON.stringify({ error: "documentId and text are required" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Όριο μεγέθους -- προστασία δημόσιου demo από ακραία/κατά λάθος μεγάλα
  // uploads. Ελέγχεται ΠΡΙΝ το chunking/embedding, ώστε να μη σπαταλάμε
  // κλήσεις στο Gemini για κείμενο που θα απορριφθεί ούτως ή άλλως.
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const byteSize = new TextEncoder().encode(text).length;

  if (wordCount > MAX_UPLOAD_WORDS || byteSize > MAX_UPLOAD_BYTES) {
    return new Response(
      JSON.stringify({
        error: `Το κείμενο ξεπερνά το επιτρεπτό όριο (μέγιστο ${MAX_UPLOAD_WORDS} λέξεις ή 2MB). Το έγγραφο έχει ${wordCount} λέξεις (${(byteSize / 1024 / 1024).toFixed(2)}MB).`,
      }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:doc:${documentId}`;

  const existingRaw = await env.DOCUMENT_REGISTRY.get(kvKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;

  // Section D: νέο έγγραφο -> ξεκινάει πάντα ως "draft" (κανείς εκτός από
  // τον editor δεν το βλέπει, δεν μπαίνει καν στο Vectorize ακόμα -- γλιτώνουμε
  // τις κλήσεις Gemini μέχρι να δημοσιευτεί ρητά). Υπάρχον έγγραφο -> κρατάει
  // το status που είχε ήδη (παλιά έγγραφα χωρίς πεδίο status θεωρούνται ήδη
  // δημοσιευμένα, για συμβατότητα προς τα πίσω).
  const status = existing ? (existing.status || "published") : "draft";

  if (existing) {
    const idsToDelete = [];
    for (let i = 0; i < (existing.chunkCount || 0); i++) {
      idsToDelete.push(`${documentId}-chunk-${i}`);
    }
    if (idsToDelete.length) await env.VECTORIZE.deleteByIds(idsToDelete);
  }

  let chunkCount = 0;

  if (status === "published") {
    const chunks = chunkText(text);
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await getEmbedding(chunks[i], env.GEMINI_API_KEY);
      vectors.push({
        id: `${documentId}-chunk-${i}`,
        values: embedding,
        namespace: workspaceId,
        metadata: {
          documentId,
          chunkIndex: i,
          text: chunks[i],
        },
      });
    }
    await env.VECTORIZE.upsert(vectors);
    chunkCount = chunks.length;
  }
  // status "draft" ή "deleted" -- καμία δουλειά στο Vectorize, το έγγραφο
  // δεν είναι (ακόμα) αναζητήσιμο από το bot.

  // Αποθηκεύουμε το κείμενο όπως ακριβώς το έστειλε ο editor (παράγραφοι,
  // κενές γραμμές, τίτλοι -- ό,τι δομή είχε ήδη) μία φορά, αυτούσιο.
  // Το chunking παραπάνω παραμένει ξεχωριστό και χρησιμεύει ΜΟΝΟ για
  // embeddings/αναζήτηση -- ποτέ πια δεν το χρησιμοποιούμε για να δείξουμε
  // κείμενο σε άνθρωπο.
  const { putOptions, expiresAt } = docTtlFor(workspaceId);
  await env.DOCUMENT_REGISTRY.put(
    kvKey,
    JSON.stringify({
      title: title || null,
      chunkCount,
      updatedAt: new Date().toISOString(),
      volatility: volatility || null,
      sourceUrl: sourceUrl || null,
      fullText: text,
      status,
      expiresAt,
    }),
    putOptions
  );

  return new Response(
    JSON.stringify({ documentId, status, chunksCreated: chunkCount }),
    { headers: JSON_HEADERS }
  );
}

async function handleGetDocument(request, env, documentId) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  const existingRaw = await env.DOCUMENT_REGISTRY.get(kvKey);

  if (!existingRaw) {
    return new Response(
      JSON.stringify({ error: "Document not found" }),
      { status: 404, headers: JSON_HEADERS }
    );
  }

  const existing = JSON.parse(existingRaw);

  // Διαβάζουμε απευθείας το αυτούσιο κείμενο από το KV -- καμία ανακατασκευή
  // από chunks πλέον, άρα καμία απώλεια δομής (παράγραφοι, κενές γραμμές κ.λπ.).
  //
  // Fallback: έγγραφα που ανέβηκαν ΠΡΙΝ αυτή την αλλαγή δεν έχουν ακόμα
  // αποθηκευμένο fullText. Γι' αυτά κάνουμε την παλιά ανακατασκευή από τα
  // chunks, ώστε να μη σπάσουν -- μέχρι να ξανα-ανέβουν και να αποκτήσουν
  // κανονικό fullText.
  let fullText = existing.fullText;

  if (!fullText) {
    const ids = [];
    for (let i = 0; i < existing.chunkCount; i++) {
      ids.push(`${documentId}-chunk-${i}`);
    }
    const result = await env.VECTORIZE.getByIds(ids);
    const sorted = result.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
    fullText = sorted.map((v) => v.metadata.text).join(" ");
  }

  return new Response(
    JSON.stringify({
      documentId,
      title: existing.title || null,
      chunkCount: existing.chunkCount,
      updatedAt: existing.updatedAt,
      sourceUrl: existing.sourceUrl || null,
      status: existing.status || "published",
      expiresAt: existing.expiresAt || null,
      text: fullText,
    }),
    { headers: JSON_HEADERS }
  );
}

async function handleListDocuments(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const prefix = `session:${workspaceId}:doc:`;
  const list = await env.DOCUMENT_REGISTRY.list({ prefix });

  const documents = await Promise.all(
    list.keys.map(async (key) => {
      const documentId = key.name.slice(prefix.length);
      const raw = await env.DOCUMENT_REGISTRY.get(key.name);
      const meta = raw ? JSON.parse(raw) : {};
      return {
        documentId,
        title: meta.title || null,
        chunkCount: meta.chunkCount,
        updatedAt: meta.updatedAt,
        sourceUrl: meta.sourceUrl || null,
        status: meta.status || "published",
        expiresAt: meta.expiresAt || null,
        // ΝΕΟ: μικρό απόσπασμα του περιεχομένου, ώστε ο editor να αναγνωρίζει
        // το έγγραφο "με το μάτι" στη λίστα, όχι μόνο από τον τίτλο/documentId.
        // Reuse του ήδη υπάρχοντος makePreview() -- τίποτα καινούριο.
        preview: meta.fullText ? makePreview(meta.fullText) : "",
      };
    })
  );

  // Πιο πρόσφατα ενημερωμένα πρώτα -- προεπιλεγμένη ταξινόμηση για το
  // editor dashboard (αυτό που άγγιξες τελευταία είναι το πιο πιθανό
  // να ψάχνεις τώρα).
  documents.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  return new Response(
    JSON.stringify({ documents }),
    { headers: JSON_HEADERS }
  );
}

async function handleSearchDocuments(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const body = await request.json();
  const { query } = body;

  if (!query) {
    return new Response(
      JSON.stringify({ error: "query is required" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Ίδιο search με το /query, αλλά topK μεγαλύτερο -- θέλουμε αρκετά chunks
  // ώστε να καλύψουμε πολλά διαφορετικά έγγραφα, όχι μόνο το κορυφαίο ένα.
  const queryEmbedding = await getEmbedding(query, env.GEMINI_API_KEY);
  const matches = await env.VECTORIZE.query(queryEmbedding, {
    topK: 12,
    namespace: workspaceId,
    returnMetadata: "all",
  });

  if (!matches.matches || matches.matches.length === 0) {
    return new Response(JSON.stringify({ documents: [] }), { headers: JSON_HEADERS });
  }

  // Ομαδοποίηση chunks ανά έγγραφο -- κρατάμε μόνο το καλύτερο score
  // και το καλύτερο απόσπασμα (preview) ανά documentId.
  const byDocument = new Map();
  for (const m of matches.matches) {
    const docId = m.metadata.documentId;
    const existing = byDocument.get(docId);
    if (!existing || m.score > existing.score) {
      byDocument.set(docId, { score: m.score, text: m.metadata.text });
    }
  }

  const getDocMeta = createDocMetaCache(env, workspaceId);

  const grouped = [...byDocument.entries()].sort((a, b) => b[1].score - a[1].score);

  const documents = await Promise.all(
    grouped.slice(0, 5).map(async ([documentId, info]) => {
      const meta = await getDocMeta(documentId);
      return {
        documentId,
        title: meta.title || null,
        score: info.score,
        preview: makePreview(info.text),
      };
    })
  );

  return new Response(JSON.stringify({ documents }), { headers: JSON_HEADERS });
}

// Μικρό cache ώστε να μη διαβάζουμε το ίδιο έγγραφο δύο φορές από το KV
// μέσα στο ίδιο request. Χρησιμοποιείται τόσο στο handleQuery όσο και στο
// handleSearchDocuments -- μία κοινή υλοποίηση αντί για δύο πανομοιότυπες.
function createDocMetaCache(env, workspaceId) {
  const cache = new Map();
  return async function getDocMeta(documentId) {
    if (cache.has(documentId)) return cache.get(documentId);
    const docKvKey = `session:${workspaceId}:doc:${documentId}`;
    const docRaw = await env.DOCUMENT_REGISTRY.get(docKvKey);
    const meta = docRaw ? JSON.parse(docRaw) : {};
    cache.set(documentId, meta);
    return meta;
  };
}

async function handleQuery(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const body = await request.json();
  const { question } = body;

  if (!question) {
    return new Response(
      JSON.stringify({ error: "question is required" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Βήμα 1: embedding της ερώτησης
  const questionEmbedding = await getEmbedding(question, env.GEMINI_API_KEY);

  // Βήμα 2: semantic search στο Vectorize, μόνο μέσα στο σωστό workspace
  const matches = await env.VECTORIZE.query(questionEmbedding, {
    topK: TOP_K,
    namespace: workspaceId,
    returnMetadata: "all",
  });

  if (!matches.matches || matches.matches.length === 0) {
    await logFallbackQuestion(env, workspaceId, question);
    return new Response(
      JSON.stringify({
        answer: "Δεν βρέθηκαν σχετικά έγγραφα σε αυτόν τον χώρο εργασίας.",
        isFallback: true,
        primarySource: null,
        relatedSections: [],
      }),
      { headers: JSON_HEADERS }
    );
  }

  // Βήμα 3: χτίσε το context από τα πιο σχετικά chunks
  const context = matches.matches
    .map((m) => m.metadata.text)
    .join("\n\n---\n\n");

  // Βήμα 4: ρώτα το Gemini
  const answer = await askGemini(context, question, env.GEMINI_API_KEY);

  // Βήμα 5: εντόπισε αν η απάντηση είναι "δεν γνωρίζω" (fallback). Ελέγχουμε
  // ΚΑΙ τις δύο γλώσσες -- τώρα που ο Gemini απαντάει στη γλώσσα της
  // ερώτησης, μια αγγλική ερώτηση μπορεί να φέρει αγγλική άρνηση γνώσης.
  const normalizedAnswer = answer.toLowerCase();
  const isFallback =
    normalizedAnswer.includes("δεν γνωρίζω") ||
    normalizedAnswer.includes("δε γνωρίζω") ||
    normalizedAnswer.includes("don't know") ||
    normalizedAnswer.includes("do not know");

  if (isFallback) {
    await logFallbackQuestion(env, workspaceId, question);
  }

  // Βήμα 6: ταξινόμηση κατά score (το Vectorize συνήθως το κάνει ήδη, αλλά το εξασφαλίζουμε)
  const sortedMatches = [...matches.matches].sort((a, b) => b.score - a.score);

  // Η πιο σχετική πηγή -- αυτή που "κουβαλάει" κυρίως την απάντηση
  const topMatch = sortedMatches[0];

  let primarySource = null;
  if (!isFallback) {
    const getDocMeta = createDocMetaCache(env, workspaceId);
    const docMeta = await getDocMeta(topMatch.metadata.documentId);

    primarySource = {
      documentId: topMatch.metadata.documentId,
      title: docMeta.title || null,
      chunkIndex: topMatch.metadata.chunkIndex,
      score: topMatch.score,
      text: topMatch.metadata.text,
      sourceUrl: docMeta.sourceUrl || null,
    };
  }

  // Σημείωση: παλιότερα υπολογίζαμε εδώ και "σχετικές ενότητες" (τα
  // υπόλοιπα matches εκτός του πρώτου), αλλά κανένα frontend δεν τις
  // δείχνει πια -- αφαιρέθηκε ο υπολογισμός για να μη γίνονται άσκοπα
  // KV reads σε κάθε ερώτηση. Το πεδίο μένει άδειο για συμβατότητα.
  const relatedSections = [];

  return new Response(
    JSON.stringify({ answer, isFallback, primarySource, relatedSections }),
    { headers: JSON_HEADERS }
  );
}

async function handleGetFallbackQuestions(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const prefix = `session:${workspaceId}:fallback:`;
  const list = await env.DOCUMENT_REGISTRY.list({ prefix });

  const questions = await Promise.all(
    list.keys.map(async (key) => {
      const raw = await env.DOCUMENT_REGISTRY.get(key.name);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return { id: key.name.slice(prefix.length), question: parsed.question, timestamp: parsed.timestamp };
    })
  );

  // Πιο πρόσφατες πρώτα -- αυτό που ρωτήθηκε τελευταία είναι το πιο
  // πιθανό να θέλεις να δεις πρώτο.
  const cleaned = questions
    .filter(Boolean)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return new Response(
    JSON.stringify({ questions: cleaned }),
    { headers: JSON_HEADERS }
  );
}

// Ο editor διαχειρίστηκε ήδη μια ερώτηση χωρίς απάντηση (π.χ. πρόσθεσε
// περιεχόμενο γι' αυτήν) -- τη διαγράφει από τη λίστα χειροκίνητα, χωρίς
// να περιμένει το 7ήμερο TTL να τη σβήσει μόνο του.
async function handleDeleteFallbackQuestion(request, env, id) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:fallback:${id}`;
  await env.DOCUMENT_REGISTRY.delete(kvKey);

  return new Response(JSON.stringify({ id, deleted: true }), { headers: JSON_HEADERS });
}

// Section D: "Δημοσίευση" -- παίρνει το ήδη αποθηκευμένο fullText ενός
// πρόχειρου εγγράφου και κάνει (τώρα πρώτη φορά) chunking + embeddings +
// upsert στο Vectorize. Ίδιο ακριβώς μοτίβο με το /upload, απλά χωρίς νέο
// κείμενο -- ο χρήστης απλά εγκρίνει αυτό που ήδη έγραψε.
async function handlePublishDocument(request, env, documentId) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  const raw = await env.DOCUMENT_REGISTRY.get(kvKey);
  if (!raw) {
    return new Response(
      JSON.stringify({ error: "Document not found" }),
      { status: 404, headers: JSON_HEADERS }
    );
  }

  const doc = JSON.parse(raw);

  // Defensive καθάρισμα -- κανονικά δεν θα υπάρχουν ήδη vectors αφού ήταν
  // draft, αλλά δεν κοστίζει τίποτα να το εξασφαλίσουμε.
  if (doc.chunkCount) {
    const idsToDelete = [];
    for (let i = 0; i < doc.chunkCount; i++) idsToDelete.push(`${documentId}-chunk-${i}`);
    await env.VECTORIZE.deleteByIds(idsToDelete);
  }

  const chunks = chunkText(doc.fullText || "");
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await getEmbedding(chunks[i], env.GEMINI_API_KEY);
    vectors.push({
      id: `${documentId}-chunk-${i}`,
      values: embedding,
      namespace: workspaceId,
      metadata: { documentId, chunkIndex: i, text: chunks[i] },
    });
  }
  await env.VECTORIZE.upsert(vectors);

  doc.status = "published";
  doc.chunkCount = chunks.length;
  doc.publishedAt = new Date().toISOString();

  const { putOptions, expiresAt } = docTtlFor(workspaceId);
  doc.expiresAt = expiresAt;
  await env.DOCUMENT_REGISTRY.put(kvKey, JSON.stringify(doc), putOptions);

  return new Response(
    JSON.stringify({ documentId, status: "published", chunksCreated: chunks.length }),
    { headers: JSON_HEADERS }
  );
}

// Section D: "Διαγραφή" (soft-delete) -- σβήνει τα vectors (το bot σταματάει
// αμέσως να το ξέρει) αλλά ΔΕΝ σβήνει το KV record, ώστε να υπάρχει "Undo".
async function handleDeleteDocument(request, env, documentId) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  const raw = await env.DOCUMENT_REGISTRY.get(kvKey);
  if (!raw) {
    return new Response(
      JSON.stringify({ error: "Document not found" }),
      { status: 404, headers: JSON_HEADERS }
    );
  }

  const doc = JSON.parse(raw);

  if (doc.chunkCount) {
    const idsToDelete = [];
    for (let i = 0; i < doc.chunkCount; i++) idsToDelete.push(`${documentId}-chunk-${i}`);
    await env.VECTORIZE.deleteByIds(idsToDelete);
  }

  doc.status = "deleted";
  doc.chunkCount = 0;

  const { putOptions, expiresAt } = docTtlFor(workspaceId);
  doc.expiresAt = expiresAt;
  await env.DOCUMENT_REGISTRY.put(kvKey, JSON.stringify(doc), putOptions);

  return new Response(
    JSON.stringify({ documentId, status: "deleted" }),
    { headers: JSON_HEADERS }
  );
}

// Section D: "Επαναφορά" -- ξαναφέρνει ένα διαγραμμένο έγγραφο σαν πρόχειρο.
// Σκόπιμα ΔΕΝ το ξαναδημοσιεύει αυτόματα -- ο χρήστης πρέπει να πατήσει
// ρητά "Δημοσίευση" ξανά, ώστε να μην ξαναγίνει κάτι ζωντανό χωρίς έλεγχο.
async function handleRestoreDocument(request, env, documentId) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  const raw = await env.DOCUMENT_REGISTRY.get(kvKey);
  if (!raw) {
    return new Response(
      JSON.stringify({ error: "Document not found" }),
      { status: 404, headers: JSON_HEADERS }
    );
  }

  const doc = JSON.parse(raw);
  doc.status = "draft";

  const { putOptions, expiresAt } = docTtlFor(workspaceId);
  doc.expiresAt = expiresAt;
  await env.DOCUMENT_REGISTRY.put(kvKey, JSON.stringify(doc), putOptions);

  return new Response(
    JSON.stringify({ documentId, status: "draft" }),
    { headers: JSON_HEADERS }
  );
}

// Απλός έλεγχος κωδικού για τη λειτουργία "Developer" στη landing page.
// Ο πραγματικός κωδικός ζει ΜΟΝΟ σαν Worker secret (env.DEVELOPER_PASSWORD),
// ποτέ μέσα στον κώδικα. Καμία session/cookie/token -- το frontend απλά
// θυμάται την επιτυχία τοπικά (localStorage) μετά από αυτόν τον έλεγχο.
async function handleDeveloperLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: "Άκυρο αίτημα" }), { status: 400, headers: JSON_HEADERS });
  }

  const { password } = body;
  if (!env.DEVELOPER_PASSWORD || password !== env.DEVELOPER_PASSWORD) {
    return new Response(JSON.stringify({ ok: false, error: "Λάθος κωδικός" }), { status: 401, headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ ok: true, workspaceId: PROTECTED_WORKSPACE_ID }), { headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", message: "Operations Portal RAG is alive" }),
        { headers: JSON_HEADERS }
      );
    }

    if (url.pathname === "/developer-login" && request.method === "POST") {
      return handleDeveloperLogin(request, env);
    }

    if (url.pathname === "/account/signup" && request.method === "POST") {
      return handleSignup(request, env);
    }

    if (url.pathname === "/account/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    if (url.pathname === "/account/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }

    if (url.pathname === "/workspace/settings" && request.method === "GET") {
      return handleGetSettings(request, env);
    }

    if (url.pathname === "/workspace/settings" && request.method === "PATCH") {
      return handlePatchSettings(request, env);
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    if (url.pathname === "/documents" && request.method === "GET") {
      return handleListDocuments(request, env);
    }

    if (url.pathname.startsWith("/document/") && request.method === "POST") {
      const rawTail = url.pathname.split("/document/")[1] || "";
      const segments = rawTail.split("/");
      if (segments.length === 2) {
        let documentId = segments[0];
        try {
          documentId = decodeURIComponent(documentId);
        } catch (err) {
          // κρατάμε το raw αν το decode αποτύχει
        }
        const action = segments[1];
        if (action === "publish") return handlePublishDocument(request, env, documentId);
        if (action === "delete") return handleDeleteDocument(request, env, documentId);
        if (action === "restore") return handleRestoreDocument(request, env, documentId);
      }
    }

    if (url.pathname.startsWith("/document/") && request.method === "GET") {
      // Safety net: αν το documentId περιέχει κενά ή ειδικούς χαρακτήρες
      // (π.χ. "Verification process" -> "Verification%20process" στο URL),
      // αποκωδικοποιούμε πριν το χρησιμοποιήσουμε ως KV key. Χωρίς αυτό,
      // το lookup αποτυγχάνει σιωπηλά με "Document not found" ακόμα κι όταν
      // το έγγραφο υπάρχει.
      const rawId = url.pathname.split("/document/")[1];
      let documentId = rawId;
      try {
        documentId = decodeURIComponent(rawId);
      } catch (err) {
        // Αν το decode αποτύχει (κατεστραμμένη ακολουθία), προχωράμε με το raw.
      }
      return handleGetDocument(request, env, documentId);
    }

    if (url.pathname === "/search-documents" && request.method === "POST") {
      return handleSearchDocuments(request, env);
    }

    if (url.pathname === "/query" && request.method === "POST") {
      return handleQuery(request, env);
    }

    if (url.pathname === "/fallback-questions" && request.method === "GET") {
      return handleGetFallbackQuestions(request, env);
    }

    if (url.pathname.startsWith("/fallback-questions/") && request.method === "DELETE") {
      const rawId = url.pathname.split("/fallback-questions/")[1] || "";
      let id = rawId;
      try {
        id = decodeURIComponent(rawId);
      } catch (err) {
        // κρατάμε το raw αν το decode αποτύχει
      }
      return handleDeleteFallbackQuestion(request, env, id);
    }

    if (url.pathname === "/compare-documents" && request.method === "POST") {
      return handleCompareDocuments(request, env);
    }

    if (url.pathname === "/contradictions" && request.method === "GET") {
      return handleGetContradictions(request, env);
    }

    if (url.pathname.startsWith("/contradictions/") && request.method === "DELETE") {
      const rawId = url.pathname.split("/contradictions/")[1] || "";
      let id = rawId;
      try {
        id = decodeURIComponent(rawId);
      } catch (err) {
        // κρατάμε το raw αν το decode αποτύχει
      }
      return handleDeleteContradiction(request, env, id);
    }

    return new Response("Not found", { status: 404 });
  },
};