import { encryptToken, decryptToken } from "./crypto-helpers.js";

const CHUNK_SIZE = 300;
const CHUNK_OVERLAP = 30;
const TOP_K = 4;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MAX_UPLOAD_WORDS = 8000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const FALLBACK_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 ημέρες

// Section K: analytics -- ελαφριά ημερήσια καταγραφή (ΧΩΡΙΣ το ίδιο το
// κείμενο της ερώτησης, μόνο μετρητές). 90 ημέρες αρκούν για trend chart,
// αυτο-καθαρίζεται μέσω TTL όπως και το fallback log, καμία cron διαδικασία.
const ANALYTICS_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 ημέρες
const DEFAULT_ANALYTICS_DAYS = 30;
const MAX_ANALYTICS_DAYS = 90;

// Το πραγματικό workspace του διαχειριστή -- ΠΟΤΕ καμία λήξη σε τίποτα εδώ
// (draft, deleted, ή δημοσιευμένο). Κάθε άλλο workspace (τυχαίοι επισκέπτες
// με το δικό τους αυτόματο, τοπικά-αποθηκευμένο ID) παίρνει ενιαία λήξη
// 7 ημερών σε ΟΤΙΔΗΠΟΤΕ ανεβάσουν/αλλάξουν -- ανανεώνεται αυτόματα σε κάθε
// νέα εγγραφή, οπότε κάτι που συντηρείται ενεργά ουσιαστικά δεν λήγει ποτέ.
const PROTECTED_WORKSPACE_ID = "efood-ops-demo";
const VISITOR_DOC_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 ημέρες

// Section O: γενικό rate limiting για ευαίσθητα endpoints (login, developer
// login, signup, forgot-password) -- προστασία από brute-force/spam. 5
// προσπάθειες ανά 15 λεπτά ανά (bucket, identifier) -- π.χ. bucket="login",
// identifier=IP. Ίδιο KV get+put pattern με recordAnalytics/checkAndIncrementUsage,
// ίδιο αποδεκτό ρίσκο race condition σε αυτή την κλίμακα.
const RATE_LIMIT_WINDOW_SECONDS = 60 * 15; // 15 λεπτά
const RATE_LIMIT_MAX_ATTEMPTS = 5;

// Section Q: pricing tiers -- πραγματικά όρια μηνυμάτων/εγγράφων ανά plan,
// αντικαθιστούν το παλιό ενιαίο MONTHLY_MESSAGE_LIMIT (που παρέμενε ίδιο
// για όλους). Τα νούμερα ταιριάζουν με τα δημόσια tiers
// (decisions-and-pricing): Free/Basic/Pro. docs: Infinity σημαίνει
// "απεριόριστο" -- ελέγχεται ρητά παρακάτω πριν οποιαδήποτε σύγκριση.
const PLAN_LIMITS = {
  free:  { messages: 100,  docs: 5 },
  basic: { messages: 500,  docs: 20 },
  pro:   { messages: 2500, docs: Infinity },
};
// Ασφαλές fallback -- δεν θα έπρεπε ποτέ να χρειαστεί μετά το migration
// 0006 (η D1 στήλη έχει δικό της DEFAULT 'basic'), αλλά ρητό εδώ επίσης,
// ίδιο σκεπτικό με το LEGACY_PBKDF2_ITERATIONS παρακάτω.
const DEFAULT_PLAN = "basic";
const LIMIT_NOTIFY_COOLDOWN_SECONDS = 60 * 60 * 24; // 1 φορά/ημέρα, όχι ανά μήνυμα

function clientIp(request) {
  // Cloudflare Workers βάζει πάντα το πραγματικό IP του επισκέπτη εδώ --
  // δεν εμπιστευόμαστε X-Forwarded-For (μπορεί να πλαστογραφηθεί από τον
  // ίδιο τον client).
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function isRateLimited(env, bucket, identifier) {
  const raw = await env.DOCUMENT_REGISTRY.get(`ratelimit:${bucket}:${identifier}`);
  const count = raw ? parseInt(raw, 10) : 0;
  return count >= RATE_LIMIT_MAX_ATTEMPTS;
}

async function recordRateLimitAttempt(env, bucket, identifier) {
  const key = `ratelimit:${bucket}:${identifier}`;
  const raw = await env.DOCUMENT_REGISTRY.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  await env.DOCUMENT_REGISTRY.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
}

async function clearRateLimit(env, bucket, identifier) {
  await env.DOCUMENT_REGISTRY.delete(`ratelimit:${bucket}:${identifier}`);
}

// Section Q: επιστρέφει το plan ενός workspace. Το προστατευμένο demo
// workspace παίρνει "pro" (πρακτικά απεριόριστο, όπως ήταν εξαιρούμενο και
// πριν). Πραγματικοί λογαριασμοί (Section H) κοιτάνε τη δική τους στήλη
// plan στη D1. Οτιδήποτε άλλο -- Guest/Developer, χωρίς γραμμή στο users --
// αντιμετωπίζεται ως "free": λογικό default για ανώνυμη δοκιμαστική χρήση.
async function getPlanForWorkspace(env, workspaceId) {
  if (workspaceId === PROTECTED_WORKSPACE_ID) return "pro";
  const row = await env.DB.prepare("SELECT plan FROM users WHERE workspace_id = ?").bind(workspaceId).first();
  if (row && row.plan && PLAN_LIMITS[row.plan]) return row.plan;
  return "free";
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes.buffer;
}

// Section P: file upload (.txt/.md/.pdf). Χρειαζόμαστε base64 encoding ενός
// ArrayBuffer για να στείλουμε PDF bytes στο Gemini ως inlineData -- το
// btoa() δουλεύει μόνο πάνω σε string, όχι απευθείας σε bytes, και το
// naive String.fromCharCode(...bytes) σκάει σε μεγάλα αρχεία (υπερβαίνει το
// όριο ορισμάτων της JS engine). Επεξεργασία σε chunks των 8KB αποφεύγει
// αυτό το πρόβλημα.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// crypto.getRandomValues -- κρυπτογραφικά ασφαλές RNG, διαθέσιμο native στο
// Workers runtime. Χρησιμοποιείται ΚΑΙ για salts ΚΑΙ για session tokens.
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes.buffer);
}

async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBuffer(saltHex), iterations, hash: "SHA-256" },
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

async function verifyPassword(password, saltHex, expectedHashHex, iterations = LEGACY_PBKDF2_ITERATIONS) {
  const actualHashHex = await hashPassword(password, saltHex, iterations);
  return timingSafeEqual(actualHashHex, expectedHashHex);
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

// Section Q: ίδιο σχήμα με jsonError, αλλά με το επιπλέον πεδίο
// limitReached:true -- έτσι το frontend (index.html/widget.js) μπορεί να
// ξεχωρίσει "έφτασες το όριο του πλάνου σου" από οποιοδήποτε άλλο 429
// (π.χ. τον γενικό rate limiter login) και να δείξει το σωστό, γενικό
// μήνυμα στον τελικό επισκέπτη αντί για τεχνικό σφάλμα.
function limitReachedError(message) {
  return new Response(JSON.stringify({ error: message, limitReached: true }), { status: 429, headers: JSON_HEADERS });
}

// Section N: γενικό, ασφαλές default μέγεθος αν κάποιο workspace δεν έχει
// ακόμα ρυθμίσεις widget -- ΔΕΝ σχετίζεται με τα PLAN_LIMITS παραπάνω.
const DEFAULT_WIDGET_SETTINGS = {
  accentColor: "#6B7280",
  botName: "Assistant",
  logoUrl: null,
  notifyEmail: null,
  contactLabel: null,
  contactUrl: null,
  contactPhone: null,
};
const SETTINGS_ALLOWED_FIELDS = [
  "accentColor",
  "botName",
  "logoUrl",
  "notifyEmail",
  "contactLabel",
  "contactUrl",
  "contactPhone",
];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Section H: λογαριασμοί πελατών + sessions (D1). PBKDF2 μέσω του
// ενσωματωμένου Web Crypto του Workers. Cloudflare Workers WebCrypto ΔΕΝ
// υποστηρίζει PBKDF2 πάνω από 100.000 iterations -- σκληρό, μόνιμο όριο
// της πλατφόρμας (βρέθηκε σε ζωντανό crash, Σεπτέμβριος 2026).
const PBKDF2_ITERATIONS = 100000;
const LEGACY_PBKDF2_ITERATIONS = 100000;
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 ημέρες

// Section I: embed layer (domain allow-list).
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_EMBED_DOMAINS = 10;

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
// πέφτουμε πίσω σε ό,τι X-Workspace-Id έστειλε ο client.
//
// Χωρίς κανένα X-Session-Token (Developer password / Guest flow),
// συνεχίζουμε να εμπιστευόμαστε το X-Workspace-Id header.
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
  const ip = clientIp(request);
  if (await isRateLimited(env, "signup", ip)) {
    return jsonError(429, "Too many signup attempts. Please try again in a few minutes.");
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }
  const email = (body.email || "").trim().toLowerCase();
  const { password } = body;
  const lang = body.lang === "el" ? "el" : "en";

  if (!email || !EMAIL_RE.test(email)) return jsonError(400, "Valid email is required");
  if (!password || password.length < 8) return jsonError(400, "Password must be at least 8 characters");

  await recordRateLimitAttempt(env, "signup", ip);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return jsonError(409, "An account with this email already exists");

  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt); // χρησιμοποιεί το τρέχον PBKDF2_ITERATIONS
  const workspaceId = `ws-${randomHex(12)}`;
  const embedId = `emb-${randomHex(12)}`;
  const createdAt = new Date().toISOString();

  // Section Q: ρητά plan='free' για κάθε νέα, self-service εγγραφή -- δεν
  // βασιζόμαστε στο DEFAULT 'basic' της στήλης (αυτό υπάρχει μόνο σαν
  // ασφαλές fallback για ΠΑΛΙΟΤΕΡΕΣ γραμμές από πριν το migration 0006).
  // Πραγματικοί πληρωμένοι πελάτες αναβαθμίζονται χειροκίνητα (UPDATE users
  // SET plan=... WHERE email=...) μέχρι να μπει αυτόματη χρέωση.
  const result = await env.DB.prepare(
    "INSERT INTO users (email, password_hash, password_salt, password_iterations, workspace_id, embed_id, plan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(email, passwordHash, salt, PBKDF2_ITERATIONS, workspaceId, embedId, "free", createdAt).run();

  const session = await createSession(env, result.meta.last_row_id, workspaceId);

  await sendVerificationEmail(env, new URL(request.url).origin, result.meta.last_row_id, email, lang);

  return new Response(
    JSON.stringify({ ok: true, sessionToken: session.token, workspaceId, embedId, emailVerified: false }),
    { headers: JSON_HEADERS }
  );
}

async function handleLogin(request, env) {
  const ip = clientIp(request);
  if (await isRateLimited(env, "login", ip)) {
    return jsonError(429, "Too many login attempts. Please try again in a few minutes.");
  }

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
    "SELECT id, password_hash, password_salt, password_iterations, workspace_id, embed_id, email_verified FROM users WHERE email = ?"
  ).bind(email).first();

  if (!user) {
    await recordRateLimitAttempt(env, "login", ip);
    return jsonError(401, "Invalid email or password");
  }

  const iterations = user.password_iterations || LEGACY_PBKDF2_ITERATIONS;
  const valid = await verifyPassword(password, user.password_salt, user.password_hash, iterations);
  if (!valid) {
    await recordRateLimitAttempt(env, "login", ip);
    return jsonError(401, "Invalid email or password");
  }

  await clearRateLimit(env, "login", ip);
  const session = await createSession(env, user.id, user.workspace_id);

  return new Response(
    JSON.stringify({
      ok: true,
      sessionToken: session.token,
      workspaceId: user.workspace_id,
      embedId: user.embed_id,
      emailVerified: !!user.email_verified,
    }),
    { headers: JSON_HEADERS }
  );
}

async function handleLogout(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) return jsonError(400, "Missing X-Session-Token header");
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(sessionToken).run();
  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

const PASSWORD_RESET_TTL_SECONDS = 60 * 30; // 30 λεπτά
const EMAIL_VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

async function sendVerificationEmail(env, origin, userId, userEmail, lang) {
  const token = randomHex(32);
  await env.DOCUMENT_REGISTRY.put(
    `email-verify:${token}`,
    JSON.stringify({ userId }),
    { expirationTtl: EMAIL_VERIFICATION_TTL_SECONDS }
  );
  const verifyUrl = `${origin}/landing.html?verifyToken=${token}`;
  const subject = lang === "el" ? "Επιβεβαίωσε το email σου - Idmon" : "Verify your email - Idmon";
  const text = lang === "el"
    ? `Καλωσόρισες στο Idmon!\n\nΓια να επιβεβαιώσεις το email σου, άνοιξε αυτόν τον σύνδεσμο (ισχύει για 24 ώρες):\n${verifyUrl}\n\nΟ λογαριασμός σου ήδη δουλεύει κανονικά χωρίς επιβεβαίωση -- αυτό είναι απλά για επιπλέον ασφάλεια.`
    : `Welcome to Idmon!\n\nTo verify your email, open this link (valid for 24 hours):\n${verifyUrl}\n\nYour account already works normally without verification -- this is just for extra security.`;
  await sendEmailViaResend(env, userEmail, subject, text);
}

async function handleForgotPassword(request, env) {
  const ip = clientIp(request);
  if (await isRateLimited(env, "forgot-password", ip)) {
    return jsonError(429, "Too many requests. Please try again in a few minutes.");
  }
  await recordRateLimitAttempt(env, "forgot-password", ip);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }
  const email = (body.email || "").trim().toLowerCase();
  const lang = body.lang === "el" ? "el" : "en";
  const genericResponse = new Response(
    JSON.stringify({ ok: true, message: "If that email is registered, a reset link has been sent." }),
    { headers: JSON_HEADERS }
  );
  if (!email) return genericResponse;

  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first();
  if (!user) return genericResponse;

  const token = randomHex(32);
  await env.DOCUMENT_REGISTRY.put(
    `password-reset:${token}`,
    JSON.stringify({ userId: user.id }),
    { expirationTtl: PASSWORD_RESET_TTL_SECONDS }
  );

  const resetUrl = `${new URL(request.url).origin}/landing.html?resetToken=${token}`;
  const emailSubject = lang === "el" ? "Επαναφορά κωδικού - Idmon" : "Password reset - Idmon";
  const emailText = lang === "el"
    ? `Ζητήθηκε επαναφορά κωδικού για τον λογαριασμό σου.\n\nΓια να διαλέξεις νέο κωδικό, άνοιξε αυτόν τον σύνδεσμο (ισχύει για 30 λεπτά):\n${resetUrl}\n\nΑν δεν το ζήτησες εσύ, αγνόησε αυτό το email -- ο κωδικός σου παραμένει ίδιος.`
    : `A password reset was requested for your account.\n\nTo choose a new password, open this link (valid for 30 minutes):\n${resetUrl}\n\nIf you didn't request this, just ignore this email -- your password stays the same.`;
  await sendEmailViaResend(env, user.email, emailSubject, emailText);

  return genericResponse;
}

async function handleResetPassword(request, env) {
  const ip = clientIp(request);
  if (await isRateLimited(env, "reset-password", ip)) {
    return jsonError(429, "Too many attempts. Please try again in a few minutes.");
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }
  const { token, newPassword } = body;
  if (!token) return jsonError(400, "Reset token is required");
  if (!newPassword || newPassword.length < 8) return jsonError(400, "Password must be at least 8 characters");

  const raw = await env.DOCUMENT_REGISTRY.get(`password-reset:${token}`);
  if (!raw) {
    await recordRateLimitAttempt(env, "reset-password", ip);
    return jsonError(400, "This reset link is invalid or has expired.");
  }
  const { userId } = JSON.parse(raw);

  const user = await env.DB.prepare("SELECT workspace_id, embed_id, email_verified FROM users WHERE id = ?").bind(userId).first();
  if (!user) return jsonError(400, "This reset link is invalid or has expired.");

  const salt = randomHex(16);
  const passwordHash = await hashPassword(newPassword, salt);
  await env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?")
    .bind(passwordHash, salt, PBKDF2_ITERATIONS, userId).run();

  await env.DOCUMENT_REGISTRY.delete(`password-reset:${token}`);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();

  const session = await createSession(env, userId, user.workspace_id);
  return new Response(
    JSON.stringify({
      ok: true,
      sessionToken: session.token,
      workspaceId: user.workspace_id,
      embedId: user.embed_id,
      emailVerified: !!user.email_verified,
    }),
    { headers: JSON_HEADERS }
  );
}

async function handleVerifyEmail(request, env) {
  const ip = clientIp(request);
  if (await isRateLimited(env, "verify-email", ip)) {
    return jsonError(429, "Too many attempts. Please try again in a few minutes.");
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }
  const { token } = body;
  if (!token) return jsonError(400, "Verification token is required");

  const raw = await env.DOCUMENT_REGISTRY.get(`email-verify:${token}`);
  if (!raw) {
    await recordRateLimitAttempt(env, "verify-email", ip);
    return jsonError(400, "This verification link is invalid or has expired.");
  }
  const { userId } = JSON.parse(raw);

  await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(userId).run();
  await env.DOCUMENT_REGISTRY.delete(`email-verify:${token}`);

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

async function handleResendVerification(request, env) {
  const ip = clientIp(request);
  if (await isRateLimited(env, "resend-verification", ip)) {
    return jsonError(429, "Too many attempts. Please try again in a few minutes.");
  }
  await recordRateLimitAttempt(env, "resend-verification", ip);

  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) return jsonError(401, "Not logged in");

  const session = await env.DB.prepare(
    "SELECT user_id, expires_at FROM sessions WHERE token = ?"
  ).bind(sessionToken).first();
  if (!session || new Date(session.expires_at) <= new Date()) return jsonError(401, "Session expired");

  const user = await env.DB.prepare(
    "SELECT email, email_verified FROM users WHERE id = ?"
  ).bind(session.user_id).first();
  if (!user) return jsonError(401, "Not logged in");
  if (user.email_verified) return new Response(JSON.stringify({ ok: true, alreadyVerified: true }), { headers: JSON_HEADERS });

  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    // lang είναι προαιρετικό
  }
  const lang = body.lang === "el" ? "el" : "en";

  await sendVerificationEmail(env, new URL(request.url).origin, session.user_id, user.email, lang);
  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

async function deleteAllByPrefix(env, prefix) {
  let cursor;
  do {
    const list = await env.DOCUMENT_REGISTRY.list({ prefix, cursor });
    for (const key of list.keys) await env.DOCUMENT_REGISTRY.delete(key.name);
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

async function deleteAllWorkspaceData(env, workspaceId) {
  const docPrefix = `session:${workspaceId}:doc:`;
  let cursor;
  do {
    const list = await env.DOCUMENT_REGISTRY.list({ prefix: docPrefix, cursor });
    for (const key of list.keys) {
      const documentId = key.name.slice(docPrefix.length);
      const raw = await env.DOCUMENT_REGISTRY.get(key.name);
      if (raw) {
        const doc = JSON.parse(raw);
        if (doc.chunkCount) {
          const idsToDelete = [];
          for (let i = 0; i < doc.chunkCount; i++) idsToDelete.push(`${documentId}-chunk-${i}`);
          await env.VECTORIZE.deleteByIds(idsToDelete);
        }
      }
      await env.DOCUMENT_REGISTRY.delete(key.name);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  await deleteAllByPrefix(env, `session:${workspaceId}:contradiction:`);
  await deleteAllByPrefix(env, `session:${workspaceId}:fallback:`);
  await deleteAllByPrefix(env, `analytics:${workspaceId}:`);
  await deleteAllByPrefix(env, `usage:${workspaceId}:`);
  await env.DOCUMENT_REGISTRY.delete(`workspace:${workspaceId}:settings`);
  await env.DOCUMENT_REGISTRY.delete(`session:${workspaceId}:notify-cooldown`);
  await env.DOCUMENT_REGISTRY.delete(`session:${workspaceId}:limit-notify-cooldown`);

  const connections = await env.DB.prepare(
    "SELECT provider, refresh_token FROM connections WHERE workspace_id = ?"
  ).bind(workspaceId).all();
  for (const conn of connections.results || []) {
    if (conn.provider === "google_drive") {
      try {
        const refreshToken = await decryptToken(conn.refresh_token, env.TOKEN_ENCRYPTION_KEY);
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }),
        });
      } catch (err) {
        // Best-effort
      }
    }
  }
  await env.DB.prepare("DELETE FROM connections WHERE workspace_id = ?").bind(workspaceId).run();
  await env.DB.prepare("DELETE FROM embed_domains WHERE workspace_id = ?").bind(workspaceId).run();
}

async function handleExportAccountData(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) return jsonError(401, "Not logged in");
  const session = await env.DB.prepare(
    "SELECT user_id, workspace_id, expires_at FROM sessions WHERE token = ?"
  ).bind(sessionToken).first();
  if (!session || new Date(session.expires_at) <= new Date()) return jsonError(401, "Session expired");

  const user = await env.DB.prepare("SELECT email, created_at FROM users WHERE id = ?").bind(session.user_id).first();
  if (!user) return jsonError(401, "Not logged in");

  const workspaceId = session.workspace_id;
  const docPrefix = `session:${workspaceId}:doc:`;
  const documents = [];
  let cursor;
  do {
    const list = await env.DOCUMENT_REGISTRY.list({ prefix: docPrefix, cursor });
    for (const key of list.keys) {
      const raw = await env.DOCUMENT_REGISTRY.get(key.name);
      if (raw) {
        const doc = JSON.parse(raw);
        documents.push({
          documentId: key.name.slice(docPrefix.length),
          title: doc.title || null,
          status: doc.status || null,
          fullText: doc.fullText || null,
          sourceUrl: doc.sourceUrl || null,
          updatedAt: doc.updatedAt || null,
          publishedAt: doc.publishedAt || null,
        });
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  const settings = await getWorkspaceSettings(env, workspaceId);
  const domainsResult = await env.DB.prepare(
    "SELECT domain, created_at FROM embed_domains WHERE workspace_id = ?"
  ).bind(workspaceId).all();

  const exportData = {
    exportedAt: new Date().toISOString(),
    account: { email: user.email, createdAt: user.created_at },
    widgetSettings: settings,
    embedDomains: (domainsResult.results || []).map((r) => ({ domain: r.domain, addedAt: r.created_at })),
    documents,
  };

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="idmon-account-export.json"',
    },
  });
}

async function handleDeleteAccount(request, env) {
  const ip = clientIp(request);
  if (await isRateLimited(env, "delete-account", ip)) {
    return jsonError(429, "Too many attempts. Please try again in a few minutes.");
  }

  const sessionToken = request.headers.get("X-Session-Token");
  if (!sessionToken) return jsonError(401, "Not logged in");
  const session = await env.DB.prepare(
    "SELECT user_id, workspace_id, expires_at FROM sessions WHERE token = ?"
  ).bind(sessionToken).first();
  if (!session || new Date(session.expires_at) <= new Date()) return jsonError(401, "Session expired");

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }
  const { password } = body;
  if (!password) return jsonError(400, "Password confirmation is required");

  const user = await env.DB.prepare(
    "SELECT password_hash, password_salt, password_iterations FROM users WHERE id = ?"
  ).bind(session.user_id).first();
  if (!user) return jsonError(401, "Not logged in");

  const iterations = user.password_iterations || LEGACY_PBKDF2_ITERATIONS;
  const valid = await verifyPassword(password, user.password_salt, user.password_hash, iterations);
  if (!valid) {
    await recordRateLimitAttempt(env, "delete-account", ip);
    return jsonError(401, "Incorrect password");
  }

  const workspaceId = session.workspace_id;
  if (workspaceId === PROTECTED_WORKSPACE_ID) return jsonError(400, "This workspace cannot be deleted");

  await deleteAllWorkspaceData(env, workspaceId);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(session.user_id).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(session.user_id).run();

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

function normalizeDomain(raw) {
  let domain = String(raw || "").trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.split("/")[0];
  domain = domain.split(":")[0];
  domain = domain.replace(/\.$/, "");
  return domain;
}

async function getEmbedSettings(env, workspaceId) {
  const user = await env.DB.prepare(
    "SELECT embed_id FROM users WHERE workspace_id = ?"
  ).bind(workspaceId).first();
  const rows = await env.DB.prepare(
    "SELECT domain FROM embed_domains WHERE workspace_id = ? ORDER BY domain"
  ).bind(workspaceId).all();
  return {
    embedId: user ? user.embed_id : null,
    domains: rows.results.map((row) => row.domain),
  };
}

async function handleGetEmbedDomains(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");
  const settings = await getEmbedSettings(env, workspaceId);
  return new Response(JSON.stringify(settings), { headers: JSON_HEADERS });
}

async function handlePatchEmbedDomains(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }

  if (!Array.isArray(body.domains)) {
    return jsonError(400, "domains must be an array of strings");
  }
  if (body.domains.length > MAX_EMBED_DOMAINS) {
    return jsonError(400, `Maximum ${MAX_EMBED_DOMAINS} domains allowed`);
  }

  const normalized = [...new Set(body.domains.map(normalizeDomain).filter(Boolean))];
  const invalid = normalized.filter((domain) => domain !== "localhost" && !DOMAIN_RE.test(domain));
  if (invalid.length > 0) {
    return jsonError(400, `Invalid domain(s): ${invalid.join(", ")}`);
  }

  const createdAt = new Date().toISOString();
  const statements = [
    env.DB.prepare("DELETE FROM embed_domains WHERE workspace_id = ?").bind(workspaceId),
    ...normalized.map((domain) =>
      env.DB.prepare(
        "INSERT INTO embed_domains (workspace_id, domain, created_at) VALUES (?, ?, ?)"
      ).bind(workspaceId, domain, createdAt)
    ),
  ];
  await env.DB.batch(statements);

  const settings = await getEmbedSettings(env, workspaceId);
  return new Response(JSON.stringify(settings), { headers: JSON_HEADERS });
}

const NOTIFY_COOLDOWN_SECONDS = 60 * 60; // 1 ώρα

async function isRealAccountWorkspace(env, workspaceId) {
  const row = await env.DB.prepare(
    "SELECT id FROM users WHERE workspace_id = ?"
  ).bind(workspaceId).first();
  return !!row;
}

async function docTtlFor(env, workspaceId) {
  if (workspaceId === PROTECTED_WORKSPACE_ID) {
    return { putOptions: {}, expiresAt: null };
  }
  if (await isRealAccountWorkspace(env, workspaceId)) {
    return { putOptions: {}, expiresAt: null };
  }
  return {
    putOptions: { expirationTtl: VISITOR_DOC_TTL_SECONDS },
    expiresAt: new Date(Date.now() + VISITOR_DOC_TTL_SECONDS * 1000).toISOString(),
  };
}

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
  if (current.contactLabel && current.contactLabel.length > 40) {
    return new Response(
      JSON.stringify({ error: "contactLabel is too long (max 40 characters)" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  if (current.contactUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(current.contactUrl)) {
    return new Response(
      JSON.stringify({ error: "contactUrl must start with a scheme, e.g. https:// or mailto:" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  if (current.contactUrl && /^\s*(javascript|vbscript|data):/i.test(current.contactUrl)) {
    return new Response(
      JSON.stringify({ error: "contactUrl scheme not allowed" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  if (current.contactPhone && current.contactPhone.length > 30) {
    return new Response(
      JSON.stringify({ error: "contactPhone is too long (max 30 characters)" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const { putOptions } = await docTtlFor(env, workspaceId);
  await env.DOCUMENT_REGISTRY.put(`workspace:${workspaceId}:settings`, JSON.stringify(current), putOptions);

  return new Response(JSON.stringify(current), { headers: JSON_HEADERS });
}

async function sendEmailViaResend(env, toEmail, subject, text) {
  if (!env.RESEND_API_KEY) return;

  const fromEmail = env.NOTIFY_FROM_EMAIL || "notifications@example.com";
  const fromHeader = `Idmon <${fromEmail}>`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromHeader, to: [toEmail], subject, text }),
    });
  } catch (err) {
    // Σκόπιμα καταπίνουμε το error
  }
}

async function sendFallbackNotificationEmail(env, toEmail, question, workspaceId) {
  await sendEmailViaResend(
    env,
    toEmail,
    "Ο βοηθός δεν μπόρεσε να απαντήσει σε μια ερώτηση",
    `Κάποιος ρώτησε κάτι που ο AI βοηθός σου δεν μπόρεσε να απαντήσει:\n\n"${question}"\n\nΜπες στο editor (καρτέλα "Unanswered questions") για να δεις όλες τις εκκρεμείς ερωτήσεις και να προσθέσεις σχετικό περιεχόμενο.\n\n(workspace: ${workspaceId})`
  );
}

// Section Q: ειδοποίηση όταν ο πελάτης εξαντλήσει το μηνιαίο του όριο
// μηνυμάτων -- ίδιο "best-effort, ποτέ δεν σπάει το query" σκεπτικό με το
// sendFallbackNotificationEmail, ξεχωριστό cooldown key ώστε να μην
// μπερδεύεται με τις ειδοποιήσεις fallback ερωτήσεων.
async function notifyLimitReached(env, workspaceId, plan, limit) {
  try {
    const settings = await getWorkspaceSettings(env, workspaceId);
    if (!settings.notifyEmail) return;
    const cooldownKey = `session:${workspaceId}:limit-notify-cooldown`;
    const onCooldown = await env.DOCUMENT_REGISTRY.get(cooldownKey);
    if (onCooldown) return;
    await env.DOCUMENT_REGISTRY.put(cooldownKey, "1", { expirationTtl: LIMIT_NOTIFY_COOLDOWN_SECONDS });
    await sendEmailViaResend(
      env,
      settings.notifyEmail,
      "Έφτασες το μηνιαίο όριο μηνυμάτων",
      `Ο AI βοηθός σου έφτασε το μηνιαίο όριο μηνυμάτων του πλάνου σου (${plan}, ${limit} μηνύματα/μήνα).\n\nΟι επισκέπτες του site σου θα βλέπουν προσωρινά ένα γενικό μήνυμα με τα δικά σου στοιχεία επικοινωνίας, αντί για απαντήσεις από τον βοηθό, μέχρι να ανανεωθεί ο μήνας ή να αναβαθμίσεις το πλάνο σου.\n\n(workspace: ${workspaceId})`
    );
  } catch (err) {
    // best-effort, όπως και το sendFallbackNotificationEmail
  }
}

function extractTitleFromHtml(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}

function extractTextFromHtml(html) {
  let text = html;
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, " ");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(nav|header|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n");
  return text.trim();
}

function slugifyForDocId(str) {
  const base = String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "page") + "-" + randomHex(4);
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

async function extractTextFromPdfViaGemini(pdfBytes, apiKey) {
  const prompt = "Μετέγραψε ΟΛΟΚΛΗΡΟ το περιεχόμενο αυτού του εγγράφου σε απλό κείμενο (plain text). Διατήρησε τη δομή (επικεφαλίδες, λίστες, παραγράφους) όσο πιο πιστά γίνεται, αλλά ΧΩΡΙΣ markdown συμβολισμό -- μόνο το κείμενο, γραμμή προς γραμμή, όπως θα το διάβαζε ένας άνθρωπος. Μην προσθέσεις δικό σου σχόλιο, περίληψη, ή εισαγωγή -- μόνο την ίδια τη μεταγραφή.";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: "application/pdf", data: arrayBufferToBase64(pdfBytes) } },
            { text: prompt },
          ],
        }],
      }),
    }
  );

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini PDF extraction failed: " + JSON.stringify(data));
  }
  return text;
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

async function* streamGeminiChunks(context, question, apiKey) {
  const prompt = `Απάντησε στην ερώτηση χρησιμοποιώντας ΜΟΝΟ τις παρακάτω πληροφορίες. Αν η απάντηση δεν βρίσκεται στις πληροφορίες, πες ότι δεν γνωρίζεις. Απάντησε στην ίδια γλώσσα με την ερώτηση.

Πληροφορίες:
${context}

Ερώτηση: ${question}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "");
    throw new Error("Gemini streaming failed: " + errText);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let yieldedAny = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = rawEvent.trim();
      if (!line.startsWith("data:")) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) continue;

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (err) {
        continue;
      }
      const textPiece = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (textPiece) {
        yieldedAny = true;
        yield textPiece;
      }
    }
  }

  if (!yieldedAny) {
    throw new Error("Gemini streaming returned no text chunks");
  }
}

function stripMarkdownForPreview(text) {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makePreview(text, maxWords = 18) {
  const words = stripMarkdownForPreview(text).split(/\s+/);
  const preview = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? preview + "…" : preview;
}

async function logFallbackQuestion(env, workspaceId, question) {
  const key = `session:${workspaceId}:fallback:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await env.DOCUMENT_REGISTRY.put(
    key,
    JSON.stringify({ question, timestamp: new Date().toISOString() }),
    { expirationTtl: FALLBACK_TTL_SECONDS }
  );

  try {
    const settings = await getWorkspaceSettings(env, workspaceId);
    if (settings.notifyEmail) {
      const cooldownKey = `session:${workspaceId}:notify-cooldown`;
      const onCooldown = await env.DOCUMENT_REGISTRY.get(cooldownKey);
      if (!onCooldown) {
        await env.DOCUMENT_REGISTRY.put(cooldownKey, "1", { expirationTtl: NOTIFY_COOLDOWN_SECONDS });
        await sendFallbackNotificationEmail(env, settings.notifyEmail, question, workspaceId);
      }
    }
  } catch (err) {
    // Σκόπιμα καταπίνουμε το error
  }
}

function dateKeyFor(offsetDays) {
  const d = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function monthKeyFor() {
  return new Date().toISOString().slice(0, 7);
}

// Section Q: ξαναγραμμένο -- χρησιμοποιεί πλέον το πραγματικό όριο του plan
// (PLAN_LIMITS) αντί για το παλιό ενιαίο MONTHLY_MESSAGE_LIMIT. Το
// MONTHLY_MESSAGE_LIMIT_OVERRIDE (μόνο .dev.vars, τοπικά tests) παραμένει
// σαν έλεγχος πάνω από ΟΤΙΔΗΠΟΤΕ plan, όχι μόνο basic -- βολικό να δοκιμάσεις
// τη συμπεριφορά cutoff χωρίς να χρειάζεται πραγματικά 100/500/2500
// μηνύματα. Το ίδιο ΠΡΙΝ από κάθε κλήση Gemini όπως και πριν -- αν το όριο
// έχει ήδη χτυπηθεί, δεν πληρώνουμε κόστος embedding/generation.
async function checkAndIncrementUsage(env, workspaceId) {
  if (workspaceId === PROTECTED_WORKSPACE_ID) return { allowed: true };

  const plan = await getPlanForWorkspace(env, workspaceId);
  const planLimit = PLAN_LIMITS[plan] ? PLAN_LIMITS[plan].messages : PLAN_LIMITS[DEFAULT_PLAN].messages;
  const limit = env.MONTHLY_MESSAGE_LIMIT_OVERRIDE
    ? parseInt(env.MONTHLY_MESSAGE_LIMIT_OVERRIDE, 10)
    : planLimit;

  const key = `usage:${workspaceId}:${monthKeyFor()}`;
  const raw = await env.DOCUMENT_REGISTRY.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= limit) {
    await notifyLimitReached(env, workspaceId, plan, limit);
    return { allowed: false, plan, limit };
  }

  await env.DOCUMENT_REGISTRY.put(key, String(count + 1), { expirationTtl: USAGE_KEY_TTL_SECONDS });
  return { allowed: true, plan, limit };
}

// Section Q: ίδιο TTL scheme με πριν (40 μέρες -- καλύπτει τον μήνα +
// περιθώριο, αυτο-καθαρίζεται).
const USAGE_KEY_TTL_SECONDS = 60 * 60 * 24 * 40;

// Section Q: μετράει πόσα ΜΗ-διαγραμμένα έγγραφα έχει ένα workspace αυτή
// τη στιγμή (draft + published, όχι deleted -- τα deleted είναι ήδη
// "αόρατα" παντού αλλού στο app, το ίδιο εδώ). Χρησιμοποιείται και από το
// document-limit enforcement (checkDocumentLimit) και από το status endpoint
// (handleGetUsageStatus) -- μία υλοποίηση.
async function countActiveDocuments(env, workspaceId) {
  const prefix = `session:${workspaceId}:doc:`;
  let cursor;
  let count = 0;
  do {
    const list = await env.DOCUMENT_REGISTRY.list({ prefix, cursor });
    for (const key of list.keys) {
      const raw = await env.DOCUMENT_REGISTRY.get(key.name);
      if (!raw) continue;
      const doc = JSON.parse(raw);
      if (doc.status !== "deleted") count++;
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return count;
}

// Section Q: ελέγχεται ΠΡΙΝ τη δημιουργία ενός ΝΕΟΥ εγγράφου (όχι σε edit
// υπάρχοντος -- η επεξεργασία δεν αυξάνει το πλήθος). Το προστατευμένο demo
// workspace εξαιρείται, όπως και τα υπόλοιπα plan checks.
async function checkDocumentLimit(env, workspaceId) {
  if (workspaceId === PROTECTED_WORKSPACE_ID) return { allowed: true };
  const plan = await getPlanForWorkspace(env, workspaceId);
  const limit = PLAN_LIMITS[plan] ? PLAN_LIMITS[plan].docs : PLAN_LIMITS[DEFAULT_PLAN].docs;
  if (limit === Infinity) return { allowed: true, limit: null };
  const count = await countActiveDocuments(env, workspaceId);
  return { allowed: count < limit, count, limit, plan };
}

async function recordAnalytics(env, workspaceId, isFallback) {
  try {
    const key = `analytics:${workspaceId}:${dateKeyFor(0)}`;
    const raw = await env.DOCUMENT_REGISTRY.get(key);
    const current = raw ? JSON.parse(raw) : { total: 0, fallback: 0 };
    current.total += 1;
    if (isFallback) current.fallback += 1;
    await env.DOCUMENT_REGISTRY.put(key, JSON.stringify(current), { expirationTtl: ANALYTICS_TTL_SECONDS });
  } catch (err) {
    // Σκόπιμα καταπίνουμε το error
  }
}

async function readAnalyticsSummary(env, workspaceId, days) {
  const daily = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = dateKeyFor(offset);
    const raw = await env.DOCUMENT_REGISTRY.get(`analytics:${workspaceId}:${date}`);
    const entry = raw ? JSON.parse(raw) : { total: 0, fallback: 0 };
    daily.push({ date, total: entry.total, fallback: entry.fallback });
  }

  const totalQuestions = daily.reduce((sum, d) => sum + d.total, 0);
  const totalFallback = daily.reduce((sum, d) => sum + d.fallback, 0);
  const fallbackRate = totalQuestions > 0 ? Math.round((totalFallback / totalQuestions) * 100) : 0;

  return { totalQuestions, totalFallback, fallbackRate, daily };
}

async function handleGetAnalyticsSummary(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  const url = new URL(request.url);
  const requestedDays = parseInt(url.searchParams.get("days"), 10);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(requestedDays, 1), MAX_ANALYTICS_DAYS)
    : DEFAULT_ANALYTICS_DAYS;

  const summary = await readAnalyticsSummary(env, workspaceId, days);
  return new Response(JSON.stringify(summary), { headers: JSON_HEADERS });
}

// Section Q: GET /usage/status -- πηγή αλήθειας που διαβάζει το editor.html
// για να δείξει το usage-limit banner, και που θα μπορούσε αργότερα να
// τροφοδοτήσει ένα πιο αναλυτικό "πλάνο & χρήση" panel. Επιστρέφει και τα
// δύο όρια (μηνύματα + έγγραφα) μαζί, μία κλήση.
async function handleGetUsageStatus(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  const plan = await getPlanForWorkspace(env, workspaceId);
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN];

  const key = `usage:${workspaceId}:${monthKeyFor()}`;
  const raw = await env.DOCUMENT_REGISTRY.get(key);
  const messagesUsed = raw ? parseInt(raw, 10) : 0;

  const docsUsed = await countActiveDocuments(env, workspaceId);

  return new Response(
    JSON.stringify({
      plan,
      messagesUsed,
      messagesLimit: limits.messages,
      messagesLimitReached: workspaceId !== PROTECTED_WORKSPACE_ID && messagesUsed >= limits.messages,
      docsUsed,
      docsLimit: limits.docs === Infinity ? null : limits.docs,
      docsLimitReached: workspaceId !== PROTECTED_WORKSPACE_ID && limits.docs !== Infinity && docsUsed >= limits.docs,
    }),
    { headers: JSON_HEADERS }
  );
}

const COMPARE_MIN_DOCS = 2;
const COMPARE_MAX_DOCS = 3;

async function askGeminiForContradictions(documents, apiKey, lang) {
  const documentsBlock = documents
    .map((doc, i) => `--- Document ${i + 1}: "${doc.title}" ---\n${doc.text}`)
    .join("\n\n");

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

  const titleToId = new Map(documents.map((d) => [d.title.trim().toLowerCase(), d.documentId]));

  const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
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

async function handleUploadFromUrl(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  // Section Q: κάθε URL sync δημιουργεί ΠΑΝΤΑ νέο έγγραφο -- ελέγχουμε το
  // όριο εγγράφων του πλάνου ΠΡΙΝ κάνουμε καν fetch στο URL, ώστε να μη
  // σπαταλάμε τίποτα σε μια εισαγωγή που θα απορριφθεί ούτως ή άλλως.
  const docLimitCheck = await checkDocumentLimit(env, workspaceId);
  if (!docLimitCheck.allowed) {
    return limitReachedError(
      `Έχεις φτάσει το όριο εγγράφων του πλάνου σου (${docLimitCheck.limit}). Διάγραψε κάποιο έγγραφο ή αναβάθμισε το πλάνο σου.`
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }

  const rawUrl = (body.url || "").trim();
  if (!rawUrl) return jsonError(400, "url is required");

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (err) {
    return jsonError(400, "Invalid URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return jsonError(400, "Only http/https URLs are supported");
  }

  let pageResponse;
  try {
    pageResponse = await fetch(parsedUrl.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RAGDemoBot/1.0; +url-sync)" },
    });
  } catch (err) {
    return jsonError(400, "Could not fetch the URL");
  }
  if (!pageResponse.ok) {
    return jsonError(400, `The URL returned an error (status ${pageResponse.status})`);
  }

  const contentType = pageResponse.headers.get("Content-Type") || "";
  if (!contentType.includes("html") && !contentType.includes("text/plain")) {
    return jsonError(400, "The URL must point to an HTML page");
  }

  const html = await pageResponse.text();
  const text = extractTextFromHtml(html);

  if (!text || text.split(/\s+/).filter(Boolean).length < 10) {
    return jsonError(400, "Could not extract enough readable text from this page");
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const byteSize = new TextEncoder().encode(text).length;
  if (wordCount > MAX_UPLOAD_WORDS || byteSize > MAX_UPLOAD_BYTES) {
    return jsonError(
      400,
      `Η σελίδα έχει πολύ περιεχόμενο (μέγιστο ${MAX_UPLOAD_WORDS} λέξεις ή 2MB). Έχει ${wordCount} λέξεις.`
    );
  }

  const title = (body.title || "").trim() || extractTitleFromHtml(html) || parsedUrl.hostname;
  const documentId = slugifyForDocId(title);

  const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  await env.DOCUMENT_REGISTRY.put(
    kvKey,
    JSON.stringify({
      title,
      chunkCount: 0,
      updatedAt: new Date().toISOString(),
      volatility: null,
      sourceUrl: parsedUrl.toString(),
      fullText: text,
      status: "draft",
      expiresAt,
    }),
    putOptions
  );

  return new Response(
    JSON.stringify({ ok: true, documentId, title, wordCount }),
    { headers: JSON_HEADERS }
  );
}

async function handleUploadFile(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  // Section Q: ίδιος έλεγχος με το URL sync -- κάθε upload αρχείου
  // δημιουργεί νέο έγγραφο, ελέγχουμε πριν από οτιδήποτε άλλο (πριν καν
  // διαβάσουμε/επεξεργαστούμε το αρχείο, ειδικά σημαντικό για .pdf που
  // κοστίζει μια κλήση Gemini).
  const docLimitCheck = await checkDocumentLimit(env, workspaceId);
  if (!docLimitCheck.allowed) {
    return limitReachedError(
      `Έχεις φτάσει το όριο εγγράφων του πλάνου σου (${docLimitCheck.limit}). Διάγραψε κάποιο έγγραφο ή αναβάθμισε το πλάνο σου.`
    );
  }

  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    return jsonError(400, "Expected multipart/form-data with a 'file' field");
  }

  const file = formData.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return jsonError(400, "file is required");
  }

  const titleOverride = (formData.get("title") || "").toString().trim();
  const filename = file.name || "document";
  const extension = (filename.split(".").pop() || "").toLowerCase();

  const SUPPORTED_EXTENSIONS = ["txt", "md", "pdf"];
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    return jsonError(
      400,
      `Unsupported file type ".${extension}". Currently supported: ${SUPPORTED_EXTENSIONS.map(e => "." + e).join(", ")}.`
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(
      400,
      `Το αρχείο ξεπερνά το επιτρεπτό όριο (μέγιστο 2MB). Το αρχείο έχει ${(file.size / 1024 / 1024).toFixed(2)}MB.`
    );
  }

  let text;
  try {
    if (extension === "pdf") {
      const pdfBytes = await file.arrayBuffer();
      text = await extractTextFromPdfViaGemini(pdfBytes, env.GEMINI_API_KEY);
    } else {
      text = await file.text();
    }
  } catch (err) {
    return jsonError(400, "Could not read the file: " + err.message);
  }

  if (!text || text.split(/\s+/).filter(Boolean).length < 10) {
    return jsonError(400, "Could not extract enough readable text from this file");
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const byteSize = new TextEncoder().encode(text).length;
  if (wordCount > MAX_UPLOAD_WORDS || byteSize > MAX_UPLOAD_BYTES) {
    return jsonError(
      400,
      `Το αρχείο έχει πολύ περιεχόμενο (μέγιστο ${MAX_UPLOAD_WORDS} λέξεις ή 2MB). Έχει ${wordCount} λέξεις.`
    );
  }

  const title = titleOverride || filename.replace(/\.[^.]+$/, "");
  const documentId = slugifyForDocId(title);

  const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  await env.DOCUMENT_REGISTRY.put(
    kvKey,
    JSON.stringify({
      title,
      chunkCount: 0,
      updatedAt: new Date().toISOString(),
      volatility: null,
      sourceUrl: null,
      fullText: text,
      status: "draft",
      expiresAt,
    }),
    putOptions
  );

  return new Response(
    JSON.stringify({ ok: true, documentId, title, wordCount }),
    { headers: JSON_HEADERS }
  );
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

  // Section Q: το όριο εγγράφων μετράει μόνο ΝΕΑ έγγραφα -- αν το
  // documentId ήδη υπάρχει (επεξεργασία), δεν αυξάνεται το πλήθος, άρα δεν
  // χρειάζεται έλεγχος. Ελέγχουμε ΜΟΝΟ όταν existing είναι null.
  if (!existing) {
    const docLimitCheck = await checkDocumentLimit(env, workspaceId);
    if (!docLimitCheck.allowed) {
      return limitReachedError(
        `Έχεις φτάσει το όριο εγγράφων του πλάνου σου (${docLimitCheck.limit}). Διάγραψε κάποιο έγγραφο ή αναβάθμισε το πλάνο σου.`
      );
    }
  }

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

  const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
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
        preview: meta.fullText ? makePreview(meta.fullText) : "",
      };
    })
  );

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

  const queryEmbedding = await getEmbedding(query, env.GEMINI_API_KEY);
  const matches = await env.VECTORIZE.query(queryEmbedding, {
    topK: 12,
    namespace: workspaceId,
    returnMetadata: "all",
  });

  if (!matches.matches || matches.matches.length === 0) {
    return new Response(JSON.stringify({ documents: [] }), { headers: JSON_HEADERS });
  }

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
  const result = await runQuery(env, workspaceId, body.question);
  return new Response(JSON.stringify(result.body), { status: result.status, headers: JSON_HEADERS });
}

// Section Q: το ΜΟΝΟ σημείο που άλλαξε εδώ μέσα είναι το usage-not-allowed
// branch -- τώρα επιστρέφει limitReached:true και ένα ελληνικό μήνυμα, ώστε
// το frontend (index.html/widget.js) να δείξει το σωστό γενικό μήνυμα στον
// επισκέπτη. Η υπόλοιπη ροή (embedding -> Vectorize -> Gemini -> fallback
// detection) είναι ΑΚΡΙΒΩΣ ίδια με πριν.
async function runQuery(env, workspaceId, question) {
  if (!question) {
    return { status: 400, body: { error: "question is required" } };
  }

  const usage = await checkAndIncrementUsage(env, workspaceId);
  if (!usage.allowed) {
    return {
      status: 429,
      body: { error: "Το μηνιαίο όριο μηνυμάτων εξαντλήθηκε.", limitReached: true },
    };
  }

  const questionEmbedding = await getEmbedding(question, env.GEMINI_API_KEY);

  let matches;
  try {
    matches = await env.VECTORIZE.query(questionEmbedding, {
      topK: TOP_K,
      namespace: workspaceId,
      returnMetadata: "all",
    });
  } catch (err) {
    matches = { matches: [] };
  }

  if (!matches.matches || matches.matches.length === 0) {
    await logFallbackQuestion(env, workspaceId, question);
    await recordAnalytics(env, workspaceId, true);
    return {
      status: 200,
      body: {
        answer: "Δεν βρέθηκαν σχετικά έγγραφα σε αυτόν τον χώρο εργασίας.",
        isFallback: true,
        primarySource: null,
        relatedSections: [],
      },
    };
  }

  const context = matches.matches
    .map((m) => m.metadata.text)
    .join("\n\n---\n\n");

  const answer = await askGemini(context, question, env.GEMINI_API_KEY);

  const normalizedAnswer = answer.toLowerCase();
  const isFallback =
    normalizedAnswer.includes("δεν γνωρίζω") ||
    normalizedAnswer.includes("δε γνωρίζω") ||
    normalizedAnswer.includes("don't know") ||
    normalizedAnswer.includes("do not know");

  if (isFallback) {
    await logFallbackQuestion(env, workspaceId, question);
  }
  await recordAnalytics(env, workspaceId, isFallback);

  const sortedMatches = [...matches.matches].sort((a, b) => b.score - a.score);

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

  const relatedSections = [];

  return { status: 200, body: { answer, isFallback, primarySource, relatedSections } };
}

function encodeSSE(obj) {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function buildStreamingQueryResponse(env, workspaceId, question) {
  return new ReadableStream({
    async start(controller) {
      try {
        if (!question) {
          controller.enqueue(encodeSSE({ type: "error", message: "question is required" }));
          controller.close();
          return;
        }

        const questionEmbedding = await getEmbedding(question, env.GEMINI_API_KEY);

        let matches;
        try {
          matches = await env.VECTORIZE.query(questionEmbedding, {
            topK: TOP_K,
            namespace: workspaceId,
            returnMetadata: "all",
          });
        } catch (err) {
          matches = { matches: [] };
        }

        if (!matches.matches || matches.matches.length === 0) {
          const fallbackAnswer = "Δεν βρέθηκαν σχετικά έγγραφα σε αυτόν τον χώρο εργασίας.";
          controller.enqueue(encodeSSE({ type: "chunk", text: fallbackAnswer }));
          await logFallbackQuestion(env, workspaceId, question);
          await recordAnalytics(env, workspaceId, true);
          controller.enqueue(encodeSSE({ type: "done", isFallback: true, primarySource: null, relatedSections: [] }));
          controller.close();
          return;
        }

        const context = matches.matches.map((m) => m.metadata.text).join("\n\n---\n\n");

        let fullAnswer = "";
        try {
          for await (const piece of streamGeminiChunks(context, question, env.GEMINI_API_KEY)) {
            if (!piece) continue;
            fullAnswer += piece;
            controller.enqueue(encodeSSE({ type: "chunk", text: piece }));
          }
        } catch (streamErr) {
          fullAnswer = "";
        }

        if (!fullAnswer) {
          fullAnswer = await askGemini(context, question, env.GEMINI_API_KEY);
          controller.enqueue(encodeSSE({ type: "chunk", text: fullAnswer }));
        }

        const normalizedAnswer = fullAnswer.toLowerCase();
        const isFallback =
          normalizedAnswer.includes("δεν γνωρίζω") ||
          normalizedAnswer.includes("δε γνωρίζω") ||
          normalizedAnswer.includes("don't know") ||
          normalizedAnswer.includes("do not know");

        const sortedMatches = [...matches.matches].sort((a, b) => b.score - a.score);
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

        if (isFallback) await logFallbackQuestion(env, workspaceId, question);
        await recordAnalytics(env, workspaceId, isFallback);

        controller.enqueue(encodeSSE({ type: "done", isFallback, primarySource, relatedSections: [] }));
        controller.close();
      } catch (err) {
        try {
          controller.enqueue(encodeSSE({ type: "error", message: "Κάτι πήγε στραβά." }));
        } catch (enqueueErr) {
          // το stream μπορεί να έχει ήδη κλείσει/σπάσει
        }
        controller.close();
      }
    },
  });
}

// Section Q: μόνο το usage-not-allowed branch άλλαξε (limitReachedError
// αντί για jsonError, ίδιο μήνυμα/σχήμα με το runQuery παραπάνω) -- αυτό
// επιστρέφεται ΠΡΙΝ ξεκινήσει καν το SSE stream, οπότε το frontend το
// βλέπει σαν κανονικό JSON response, όχι σαν μέρος του stream.
async function handleQueryStream(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }

  const usage = await checkAndIncrementUsage(env, workspaceId);
  if (!usage.allowed) return limitReachedError("Το μηνιαίο όριο μηνυμάτων εξαντλήθηκε.");

  const stream = buildStreamingQueryResponse(env, workspaceId, body.question);
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

function hostnameFromOrigin(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch (err) {
    return null;
  }
}

async function resolveWorkspaceIdFromEmbedId(env, embedId) {
  const row = await env.DB.prepare(
    "SELECT workspace_id FROM users WHERE embed_id = ?"
  ).bind(embedId).first();
  return row ? row.workspace_id : null;
}

async function isOriginAllowedForWorkspace(env, workspaceId, origin) {
  const hostname = hostnameFromOrigin(origin);
  if (!hostname) return false;
  const row = await env.DB.prepare(
    "SELECT 1 FROM embed_domains WHERE workspace_id = ? AND domain = ?"
  ).bind(workspaceId, hostname).first();
  return !!row;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleEmbedQueryPreflight(request, env, embedId) {
  const origin = request.headers.get("Origin");
  if (!origin) return new Response(null, { status: 204 });

  const workspaceId = await resolveWorkspaceIdFromEmbedId(env, embedId);
  if (!workspaceId) return new Response(null, { status: 204 });

  const allowed = await isOriginAllowedForWorkspace(env, workspaceId, origin);
  if (!allowed) return new Response(null, { status: 204 });

  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

async function handleEmbedQuery(request, env, embedId) {
  const origin = request.headers.get("Origin");

  const workspaceId = await resolveWorkspaceIdFromEmbedId(env, embedId);
  if (!workspaceId) return jsonError(404, "Unknown embed id");

  if (!origin) return jsonError(403, "Missing Origin header");

  const allowed = await isOriginAllowedForWorkspace(env, workspaceId, origin);
  if (!allowed) return jsonError(403, "This domain is not authorized for this embed");

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }

  const result = await runQuery(env, workspaceId, body.question);
  return new Response(
    JSON.stringify(result.body),
    { status: result.status, headers: { ...JSON_HEADERS, ...corsHeaders(origin) } }
  );
}

// Section Q: ίδιο edit με το handleQueryStream -- limitReachedError αντί
// για jsonError στο usage-not-allowed branch, με τα σωστά CORS headers
// μαζί (η δημόσια embed έκδοση χρειάζεται πάντα corsHeaders(origin) στο
// response, σε αντίθεση με το εσωτερικό /query/stream).
async function handleEmbedQueryStream(request, env, embedId) {
  const origin = request.headers.get("Origin");

  const workspaceId = await resolveWorkspaceIdFromEmbedId(env, embedId);
  if (!workspaceId) return jsonError(404, "Unknown embed id");

  if (!origin) return jsonError(403, "Missing Origin header");

  const allowed = await isOriginAllowedForWorkspace(env, workspaceId, origin);
  if (!allowed) return jsonError(403, "This domain is not authorized for this embed");

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }

  const usage = await checkAndIncrementUsage(env, workspaceId);
  if (!usage.allowed) {
    return new Response(
      JSON.stringify({ error: "Το μηνιαίο όριο μηνυμάτων εξαντλήθηκε.", limitReached: true }),
      { status: 429, headers: { ...JSON_HEADERS, ...corsHeaders(origin) } }
    );
  }

  const stream = buildStreamingQueryResponse(env, workspaceId, body.question);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      ...corsHeaders(origin),
    },
  });
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

  const cleaned = questions
    .filter(Boolean)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return new Response(
    JSON.stringify({ questions: cleaned }),
    { headers: JSON_HEADERS }
  );
}

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

async function handleRefreshFromUrl(request, env, documentId) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  const raw = await env.DOCUMENT_REGISTRY.get(kvKey);
  if (!raw) return jsonError(404, "Document not found");

  const doc = JSON.parse(raw);
  if (!doc.sourceUrl) {
    return jsonError(400, "This document has no source URL to refresh from");
  }

  let pageResponse;
  try {
    pageResponse = await fetch(doc.sourceUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RAGDemoBot/1.0; +url-sync)" },
    });
  } catch (err) {
    return jsonError(400, "Could not fetch the URL");
  }
  if (!pageResponse.ok) {
    return jsonError(400, `The URL returned an error (status ${pageResponse.status})`);
  }

  const html = await pageResponse.text();
  const text = extractTextFromHtml(html);
  if (!text || text.split(/\s+/).filter(Boolean).length < 10) {
    return jsonError(400, "Could not extract enough readable text from this page");
  }

  doc.fullText = text;
  doc.updatedAt = new Date().toISOString();

  if (doc.status === "published") {
    if (doc.chunkCount) {
      const idsToDelete = [];
      for (let i = 0; i < doc.chunkCount; i++) idsToDelete.push(`${documentId}-chunk-${i}`);
      await env.VECTORIZE.deleteByIds(idsToDelete);
    }
    const chunks = chunkText(text);
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
    doc.chunkCount = chunks.length;
  }

  const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
  doc.expiresAt = expiresAt;
  await env.DOCUMENT_REGISTRY.put(kvKey, JSON.stringify(doc), putOptions);

  return new Response(
    JSON.stringify({ ok: true, documentId, status: doc.status, chunkCount: doc.chunkCount, updatedAt: doc.updatedAt }),
    { headers: JSON_HEADERS }
  );
}

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

  const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
  doc.expiresAt = expiresAt;
  await env.DOCUMENT_REGISTRY.put(kvKey, JSON.stringify(doc), putOptions);

  return new Response(
    JSON.stringify({ documentId, status: "published", chunksCreated: chunks.length }),
    { headers: JSON_HEADERS }
  );
}

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

  const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
  doc.expiresAt = expiresAt;
  await env.DOCUMENT_REGISTRY.put(kvKey, JSON.stringify(doc), putOptions);

  return new Response(
    JSON.stringify({ documentId, status: "deleted" }),
    { headers: JSON_HEADERS }
  );
}

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

  if (doc.status !== "deleted") {
    return new Response(
      JSON.stringify({ error: "Only deleted documents can be restored" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Section Q: η επαναφορά ενός διαγραμμένου εγγράφου ουσιαστικά ξαναφέρνει
  // ένα ενεργό έγγραφο -- ίδιο σκεπτικό με νέο έγγραφο, ελέγχουμε το όριο
  // πριν το κάνουμε ξανά "μετρήσιμο".
  const docLimitCheck = await checkDocumentLimit(env, workspaceId);
  if (!docLimitCheck.allowed) {
    return limitReachedError(
      `Έχεις φτάσει το όριο εγγράφων του πλάνου σου (${docLimitCheck.limit}). Διάγραψε κάποιο άλλο έγγραφο πρώτα, ή αναβάθμισε το πλάνο σου.`
    );
  }

  doc.status = "draft";

  const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
  doc.expiresAt = expiresAt;
  await env.DOCUMENT_REGISTRY.put(kvKey, JSON.stringify(doc), putOptions);

  return new Response(
    JSON.stringify({ documentId, status: "draft" }),
    { headers: JSON_HEADERS }
  );
}

const OAUTH_STATE_TTL_SECONDS = 60 * 10; // 10 λεπτά
const GOOGLE_DRIVE_SCOPE_REQUIRED = "https://www.googleapis.com/auth/drive.readonly";
const GOOGLE_DRIVE_SCOPE =
  `${GOOGLE_DRIVE_SCOPE_REQUIRED} openid email`;

async function resolveWorkspaceIdForOAuthStart(request, env) {
  const url = new URL(request.url);
  const sessionToken = url.searchParams.get("session_token");
  if (sessionToken) {
    const row = await env.DB.prepare(
      "SELECT workspace_id, expires_at FROM sessions WHERE token = ?"
    ).bind(sessionToken).first();
    if (!row) return null;
    if (new Date(row.expires_at) <= new Date()) return null;
    return row.workspace_id;
  }
  return url.searchParams.get("workspace_id");
}

async function handleOAuthGoogleStart(request, env) {
  const workspaceId = await resolveWorkspaceIdForOAuthStart(request, env);
  if (!workspaceId) {
    return jsonError(400, "Missing or invalid session_token/workspace_id query parameter");
  }

  const state = randomHex(16);
  await env.DOCUMENT_REGISTRY.put(`oauth:state:${state}`, workspaceId, {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_DRIVE_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent select_account");
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleOAuthGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return Response.redirect(new URL("/editor.html?google_drive_error=denied", url).toString(), 302);
  }

  if (!code || !state) {
    return Response.redirect(new URL("/editor.html?google_drive_error=missing_params", url).toString(), 302);
  }

  const stateKey = `oauth:state:${state}`;
  const workspaceId = await env.DOCUMENT_REGISTRY.get(stateKey);
  if (!workspaceId) {
    return Response.redirect(new URL("/editor.html?google_drive_error=invalid_state", url).toString(), 302);
  }
  await env.DOCUMENT_REGISTRY.delete(stateKey);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_REDIRECT_URI,
    }),
  });

  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenData.access_token) {
    return Response.redirect(new URL("/editor.html?google_drive_error=token_exchange_failed", url).toString(), 302);
  }

  if (!tokenData.refresh_token) {
    return Response.redirect(new URL("/editor.html?google_drive_error=no_refresh_token", url).toString(), 302);
  }

  const grantedScopes = (tokenData.scope || "").split(/\s+/);
  if (!grantedScopes.includes(GOOGLE_DRIVE_SCOPE_REQUIRED)) {
    return Response.redirect(new URL("/editor.html?google_drive_error=missing_drive_scope", url).toString(), 302);
  }

  let connectedByEmail = null;
  try {
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userInfoResponse.json();
    connectedByEmail = userInfo.email || null;
  } catch (err) {
    // Best-effort
  }

  const encryptedAccessToken = await encryptToken(tokenData.access_token, env.TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = await encryptToken(tokenData.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const expiresAt = Date.now() + tokenData.expires_in * 1000;
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO connections
       (id, workspace_id, provider, access_token, refresh_token, expires_at, connected_by_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       connected_by_email = excluded.connected_by_email,
       updated_at = excluded.updated_at`
  ).bind(
    `conn-${randomHex(12)}`,
    workspaceId,
    "google_drive",
    encryptedAccessToken,
    encryptedRefreshToken,
    expiresAt,
    connectedByEmail,
    now,
    now
  ).run();

  return Response.redirect(new URL("/editor.html?google_drive_connected=1", url).toString(), 302);
}

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

async function getValidGoogleDriveAccessToken(env, workspaceId) {
  const row = await env.DB.prepare(
    "SELECT access_token, refresh_token, expires_at, connected_by_email FROM connections WHERE workspace_id = ? AND provider = ?"
  ).bind(workspaceId, "google_drive").first();

  if (!row) {
    const err = new Error("Google Drive δεν είναι συνδεδεμένο για αυτό το workspace");
    err.code = "not_connected";
    throw err;
  }

  if (row.expires_at - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    const accessToken = await decryptToken(row.access_token, env.TOKEN_ENCRYPTION_KEY);
    return { accessToken, connectedByEmail: row.connected_by_email };
  }

  const refreshToken = await decryptToken(row.refresh_token, env.TOKEN_ENCRYPTION_KEY);

  const refreshResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const refreshData = await refreshResponse.json();
  if (!refreshResponse.ok || !refreshData.access_token) {
    const err = new Error("Η ανανέωση του Google Drive token απέτυχε, χρειάζεται νέα σύνδεση");
    err.code = "refresh_failed";
    throw err;
  }

  const newAccessToken = refreshData.access_token;
  const newExpiresAt = Date.now() + refreshData.expires_in * 1000;
  const encryptedNewAccessToken = await encryptToken(newAccessToken, env.TOKEN_ENCRYPTION_KEY);

  await env.DB.prepare(
    "UPDATE connections SET access_token = ?, expires_at = ?, updated_at = ? WHERE workspace_id = ? AND provider = ?"
  ).bind(encryptedNewAccessToken, newExpiresAt, new Date().toISOString(), workspaceId, "google_drive").run();

  return { accessToken: newAccessToken, connectedByEmail: row.connected_by_email };
}

async function handleDisconnectGoogleDrive(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  const row = await env.DB.prepare(
    "SELECT refresh_token FROM connections WHERE workspace_id = ? AND provider = ?"
  ).bind(workspaceId, "google_drive").first();

  if (row) {
    try {
      const refreshToken = await decryptToken(row.refresh_token, env.TOKEN_ENCRYPTION_KEY);
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }),
      });
    } catch (err) {
      // Best-effort
    }
  }

  await env.DB.prepare(
    "DELETE FROM connections WHERE workspace_id = ? AND provider = ?"
  ).bind(workspaceId, "google_drive").run();

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

const GOOGLE_DRIVE_EXPORT_MIME_TYPES = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

async function handleListGoogleDriveFiles(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  let accessToken, connectedByEmail;
  try {
    ({ accessToken, connectedByEmail } = await getValidGoogleDriveAccessToken(env, workspaceId));
  } catch (err) {
    if (err.code === "not_connected") return jsonError(404, err.message);
    return jsonError(502, err.message);
  }

  const query =
    "(mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet') and trashed=false";

  const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("fields", "files(id,name,mimeType,modifiedTime)");
  listUrl.searchParams.set("pageSize", "100");
  listUrl.searchParams.set("orderBy", "modifiedTime desc");

  const listResponse = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listData = await listResponse.json();

  if (!listResponse.ok) {
    return jsonError(502, "Η λίστα αρχείων από το Google Drive απέτυχε: " + JSON.stringify(listData));
  }

  return new Response(
    JSON.stringify({ files: listData.files || [], connectedByEmail: connectedByEmail || null }),
    { headers: JSON_HEADERS }
  );
}

async function handleImportGoogleDriveFiles(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Invalid JSON body");
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    return jsonError(400, "files must be a non-empty array of {id, name, mimeType}");
  }
  if (body.files.length > 20) {
    return jsonError(400, "Maximum 20 files per import request");
  }

  // Section Q: εισαγωγή από Drive δημιουργεί επίσης ΝΕΑ έγγραφα -- ελέγχουμε
  // το όριο ΜΙΑ φορά πριν την εισαγωγή, με βάση το πόσα ζητάει να εισάγει
  // ο χρήστης, ώστε να μην ξεφύγει το πλήθος ενδιάμεσα σε ένα batch import.
  const docLimitCheck = await checkDocumentLimit(env, workspaceId);
  if (docLimitCheck.limit !== null && docLimitCheck.limit !== undefined) {
    const currentCount = await countActiveDocuments(env, workspaceId);
    if (currentCount >= docLimitCheck.limit) {
      return limitReachedError(
        `Έχεις φτάσει το όριο εγγράφων του πλάνου σου (${docLimitCheck.limit}). Διάγραψε κάποιο έγγραφο ή αναβάθμισε το πλάνο σου.`
      );
    }
  }

  let accessToken;
  try {
    ({ accessToken } = await getValidGoogleDriveAccessToken(env, workspaceId));
  } catch (err) {
    if (err.code === "not_connected") return jsonError(404, err.message);
    return jsonError(502, err.message);
  }

  const imported = [];
  const failed = [];

  for (const file of body.files) {
    const exportMimeType = GOOGLE_DRIVE_EXPORT_MIME_TYPES[file.mimeType];
    if (!exportMimeType) {
      failed.push({ id: file.id, name: file.name, error: "Μη υποστηριζόμενος τύπος αρχείου" });
      continue;
    }

    const exportUrl = new URL(`https://www.googleapis.com/drive/v3/files/${file.id}/export`);
    exportUrl.searchParams.set("mimeType", exportMimeType);

    let exportResponse;
    try {
      exportResponse = await fetch(exportUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      failed.push({ id: file.id, name: file.name, error: "Αποτυχία σύνδεσης με το Google Drive" });
      continue;
    }

    if (!exportResponse.ok) {
      failed.push({ id: file.id, name: file.name, error: `Η εξαγωγή απέτυχε (status ${exportResponse.status})` });
      continue;
    }

    const text = (await exportResponse.text()).trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const byteSize = new TextEncoder().encode(text).length;

    if (wordCount < 3) {
      failed.push({ id: file.id, name: file.name, error: "Το αρχείο φαίνεται άδειο" });
      continue;
    }
    if (wordCount > MAX_UPLOAD_WORDS || byteSize > MAX_UPLOAD_BYTES) {
      failed.push({
        id: file.id,
        name: file.name,
        error: `Πολύ μεγάλο αρχείο (μέγιστο ${MAX_UPLOAD_WORDS} λέξεις ή 2MB, έχει ${wordCount} λέξεις)`,
      });
      continue;
    }

    const title = file.name || "Χωρίς τίτλο";
    const documentId = slugifyForDocId(title);
    const { putOptions, expiresAt } = await docTtlFor(env, workspaceId);
    const kvKey = `session:${workspaceId}:doc:${documentId}`;

    await env.DOCUMENT_REGISTRY.put(
      kvKey,
      JSON.stringify({
        title,
        chunkCount: 0,
        updatedAt: new Date().toISOString(),
        volatility: null,
        sourceUrl: `google-drive:${file.id}`,
        fullText: text,
        status: "draft",
        expiresAt,
      }),
      putOptions
    );

    imported.push({ documentId, title, wordCount, sourceFileId: file.id });
  }

  return new Response(JSON.stringify({ imported, failed }), { headers: JSON_HEADERS });
}

async function handleDeveloperLogin(request, env) {
  const ip = clientIp(request);
  if (await isRateLimited(env, "developer-login", ip)) {
    return new Response(JSON.stringify({ ok: false, error: "Πολλές προσπάθειες. Δοκίμασε ξανά σε λίγα λεπτά." }), { status: 429, headers: JSON_HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: "Άκυρο αίτημα" }), { status: 400, headers: JSON_HEADERS });
  }

  const { password } = body;
  if (!env.DEVELOPER_PASSWORD || password !== env.DEVELOPER_PASSWORD) {
    await recordRateLimitAttempt(env, "developer-login", ip);
    return new Response(JSON.stringify({ ok: false, error: "Λάθος κωδικός" }), { status: 401, headers: JSON_HEADERS });
  }

  await clearRateLimit(env, "developer-login", ip);
  return new Response(JSON.stringify({ ok: true, workspaceId: PROTECTED_WORKSPACE_ID }), { headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", message: "Idmon RAG is alive" }),
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

    if (url.pathname === "/account/forgot-password" && request.method === "POST") {
      return handleForgotPassword(request, env);
    }

    if (url.pathname === "/account/reset-password" && request.method === "POST") {
      return handleResetPassword(request, env);
    }

    if (url.pathname === "/account/verify-email" && request.method === "POST") {
      return handleVerifyEmail(request, env);
    }

    if (url.pathname === "/account/resend-verification" && request.method === "POST") {
      return handleResendVerification(request, env);
    }

    if (url.pathname === "/account/export" && request.method === "GET") {
      return handleExportAccountData(request, env);
    }

    if (url.pathname === "/account/delete" && request.method === "POST") {
      return handleDeleteAccount(request, env);
    }

    if (url.pathname === "/oauth/google/start" && request.method === "GET") {
      return handleOAuthGoogleStart(request, env);
    }

    if (url.pathname === "/oauth/google/callback" && request.method === "GET") {
      return handleOAuthGoogleCallback(request, env);
    }

    if (url.pathname === "/connections/google-drive/files" && request.method === "GET") {
      return handleListGoogleDriveFiles(request, env);
    }

    if (url.pathname === "/connections/google-drive/import" && request.method === "POST") {
      return handleImportGoogleDriveFiles(request, env);
    }

    if (url.pathname === "/connections/google-drive" && request.method === "DELETE") {
      return handleDisconnectGoogleDrive(request, env);
    }

    if (url.pathname === "/workspace/settings" && request.method === "GET") {
      return handleGetSettings(request, env);
    }

    if (url.pathname === "/workspace/settings" && request.method === "PATCH") {
      return handlePatchSettings(request, env);
    }

    // Section Q: usage/plan status -- διαβάζεται από το editor.html για να
    // αποφασίσει αν θα δείξει το usage-limit banner (και μελλοντικά,
    // πιθανό αναλυτικό "πλάνο & χρήση" panel).
    if (url.pathname === "/usage/status" && request.method === "GET") {
      return handleGetUsageStatus(request, env);
    }

    if (url.pathname === "/embed/domains" && request.method === "GET") {
      return handleGetEmbedDomains(request, env);
    }

    if (url.pathname === "/embed/domains" && request.method === "PATCH") {
      return handlePatchEmbedDomains(request, env);
    }

    if (url.pathname === "/analytics/summary" && request.method === "GET") {
      return handleGetAnalyticsSummary(request, env);
    }

    const embedQueryMatch = url.pathname.match(/^\/embed\/([^/]+)\/query$/);
    if (embedQueryMatch) {
      const embedId = embedQueryMatch[1];
      if (request.method === "OPTIONS") return handleEmbedQueryPreflight(request, env, embedId);
      if (request.method === "POST") return handleEmbedQuery(request, env, embedId);
    }

    const embedQueryStreamMatch = url.pathname.match(/^\/embed\/([^/]+)\/query\/stream$/);
    if (embedQueryStreamMatch) {
      const embedId = embedQueryStreamMatch[1];
      if (request.method === "OPTIONS") return handleEmbedQueryPreflight(request, env, embedId);
      if (request.method === "POST") return handleEmbedQueryStream(request, env, embedId);
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    if (url.pathname === "/upload-from-url" && request.method === "POST") {
      return handleUploadFromUrl(request, env);
    }

    if (url.pathname === "/upload-file" && request.method === "POST") {
      return handleUploadFile(request, env);
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
        if (action === "refresh-from-url") return handleRefreshFromUrl(request, env, documentId);
      }
    }

    if (url.pathname.startsWith("/document/") && request.method === "GET") {
      const rawId = url.pathname.split("/document/")[1];
      let documentId = rawId;
      try {
        documentId = decodeURIComponent(rawId);
      } catch (err) {
        // Αν το decode αποτύχει, προχωράμε με το raw.
      }
      return handleGetDocument(request, env, documentId);
    }

    if (url.pathname === "/search-documents" && request.method === "POST") {
      return handleSearchDocuments(request, env);
    }

    if (url.pathname === "/query" && request.method === "POST") {
      return handleQuery(request, env);
    }

    if (url.pathname === "/query/stream" && request.method === "POST") {
      return handleQueryStream(request, env);
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