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

// Section N: βασικό μηνιαίο όριο μηνυμάτων ανά workspace -- ΔΕΝ είναι ακόμα
// επιβολή pricing tier (δεν υπάρχει ακόμα πεδίο "plan" στους λογαριασμούς,
// βλ. decisions-and-pricing), απλά ένα φρένο κόστους: αν κάποιος (bug, bot,
// κακόβουλη χρήση) χτυπήσει το widget πολλές φορές, δεν πληρώνουμε απεριόριστο
// Gemini API χωρίς όριο. 3000/μήνα είναι σκόπιμα ΠΑΝΩ από το πιο ακριβό tier
// (Pro = 2.500 μηνύματα) ώστε να μην μπλοκάρει ποτέ έναν πραγματικό πελάτη
// μέσα στα φυσιολογικά όρια χρήσης του, μόνο ασυνήθιστη κίνηση πάνω από αυτό.
const MONTHLY_MESSAGE_LIMIT = 3000;
const USAGE_KEY_TTL_SECONDS = 60 * 60 * 24 * 40; // 40 μέρες -- καλύπτει τον μήνα + περιθώριο, αυτο-καθαρίζεται

// Section G: ρυθμίσεις widget ανά workspace (εμφάνιση + email ειδοποίησης).
// Αποθηκεύονται σε ΕΝΑ KV record (όχι ξεχωριστό key ανά πεδίο) ώστε να μη
// χρειάζονται πολλαπλά reads/writes για κάτι που πάντα διαβάζεται/γράφεται μαζί.
const DEFAULT_WIDGET_SETTINGS = {
  accentColor: "#6B7280",
  botName: "Assistant",
  logoUrl: null,
  notifyEmail: null,
  // Section J: human handoff -- ελεύθερο link (WhatsApp/email/ό,τι θέλει ο
  // πελάτης) ΚΑΙ ξεχωριστό τηλέφωνο, γιατί το τηλέφωνο είναι το πιο
  // καθολικά κατανοητό κανάλι (δεν χρειάζεται WhatsApp/email εγκατεστημένο).
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

// Section H: λογαριασμοί πελατών + sessions (D1).
//
// PBKDF2 μέσω του ενσωματωμένου Web Crypto του Workers -- καμία εξωτερική
// βιβλιοθήκη δεν χρειάζεται. 100.000 iterations είναι ένα λογικό,
// αναγνωρισμένο standard (NIST recommends >=10.000, εδώ είμαστε πιο
// συντηρητικοί).
const PBKDF2_ITERATIONS = 100000;
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 ημέρες

// Section I: embed layer (domain allow-list).
//
// Απλή, αυστηρή μορφή "domain.tld" ή "sub.domain.tld" -- χωρίς πρωτόκολλο,
// χωρίς path, χωρίς wildcards. Το "localhost" επιτρέπεται ξεχωριστά (δεν
// έχει τελεία) για να μπορεί κάποιος να δοκιμάσει το embed script τοπικά
// πριν το βάλει σε πραγματικό domain.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_EMBED_DOMAINS = 10;

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
  const passwordHash = await hashPassword(password, salt);
  const workspaceId = `ws-${randomHex(12)}`;
  // Ξεχωριστό από το workspaceId ρητά -- αυτό είναι το ΜΟΝΟ αναγνωριστικό
  // που επιτρέπεται να εμφανίζεται σε δημόσιο <script> tag (βλ. Section I).
  const embedId = `emb-${randomHex(12)}`;
  const createdAt = new Date().toISOString();

  const result = await env.DB.prepare(
    "INSERT INTO users (email, password_hash, password_salt, workspace_id, embed_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(email, passwordHash, salt, workspaceId, embedId, createdAt).run();

  const session = await createSession(env, result.meta.last_row_id, workspaceId);

  // Best-effort, δεν μπλοκάρει ποτέ το signup αν αργήσει/αποτύχει το email
  // (ίδια φιλοσοφία με sendEmailViaResend -- "soft" verification, ο
  // λογαριασμός ήδη δουλεύει κανονικά).
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
    "SELECT id, password_hash, password_salt, workspace_id, embed_id, email_verified FROM users WHERE email = ?"
  ).bind(email).first();

  // Το ΙΔΙΟ γενικό μήνυμα λάθους είτε δεν υπάρχει το email είτε το password
  // είναι λάθος -- ΠΟΤΕ δεν αποκαλύπτουμε ποιο από τα δύο ίσχυε (θα βοηθούσε
  // κάποιον να μαντέψει ποια emails είναι ήδη εγγεγραμμένα).
  if (!user) {
    await recordRateLimitAttempt(env, "login", ip);
    return jsonError(401, "Invalid email or password");
  }

  const valid = await verifyPassword(password, user.password_salt, user.password_hash);
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

// Section O: password reset -- token σε KV (όχι νέο D1 table, το ίδιο
// pattern με το OAuth state), αυτο-καθαρίζεται μέσω TTL, μιας χρήσης
// (διαγράφεται αμέσως μόλις χρησιμοποιηθεί).
const PASSWORD_RESET_TTL_SECONDS = 60 * 30; // 30 λεπτά

// Section O follow-up: email verification. 24 ώρες -- πιο γενναιόδωρο από
// το password reset (30 λεπτά) γιατί δεν είναι time-critical σαν αλλαγή
// κωδικού, ο χρήστης μπορεί εύλογα να μην ανοίξει το email αμέσως.
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

// ΠΑΝΤΑ το ΙΔΙΟ γενικό μήνυμα, ανεξάρτητα από το αν το email υπάρχει --
// αλλιώς κάποιος θα μπορούσε να δοκιμάζει emails εδώ για να μάθει ποια
// είναι ήδη εγγεγραμμένα (ίδια λογική με το login error message παραπάνω).
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
  const lang = body.lang === "el" ? "el" : "en"; // ίδια λογική με τη γλώσσα του bot -- default en
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
  await env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?")
    .bind(passwordHash, salt, userId).run();

  // Token μιας χρήσης -- διαγράφεται αμέσως, δεν ξαναχρησιμοποιείται.
  await env.DOCUMENT_REGISTRY.delete(`password-reset:${token}`);

  // Ασφάλεια: ένας κωδικός που μόλις άλλαξε (π.χ. επειδή διέρρευσε ο παλιός)
  // πρέπει να ακυρώσει ΚΑΘΕ υπάρχον session αυτού του χρήστη, όχι μόνο να
  // επιτρέψει νέο login.
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
  // Token μιας χρήσης -- διαγράφεται αμέσως, όπως και το password-reset token.
  await env.DOCUMENT_REGISTRY.delete(`email-verify:${token}`);

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

// Απαιτεί ενεργό session (σε αντίθεση με forgot-password) -- το "resend"
// είναι πάντα για τον ΔΙΚΟ σου λογαριασμό, όχι για οποιοδήποτε email δοθεί.
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
    // lang είναι προαιρετικό εδώ -- αν λείψει/είναι άκυρο, απλά default en.
  }
  const lang = body.lang === "el" ? "el" : "en";

  await sendVerificationEmail(env, new URL(request.url).origin, session.user_id, user.email, lang);
  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

// Δέχεται είτε σκέτο domain ("pelatis.gr") είτε ολόκληρο URL
// ("https://www.pelatis.gr/"), και επιστρέφει πάντα το ίδιο, καθαρό
// αποτέλεσμα ("www.pelatis.gr"). Ο χρήστης δεν χρειάζεται να ξέρει ποια
// μορφή είναι "σωστή" -- το καθαρίζουμε εμείς πριν το validation.
function normalizeDomain(raw) {
  let domain = String(raw || "").trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.split("/")[0];
  domain = domain.split(":")[0];
  domain = domain.replace(/\.$/, "");
  return domain;
}

// embedId + domains μαζί -- το editor τα δείχνει πάντα μαζί (χωρίς domain
// δεν εμφανίζεται καν το embedId/script), οπότε ένα endpoint αρκεί.
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

// PATCH αντικαθιστά ΟΛΟΚΛΗΡΗ τη λίστα (ο client στέλνει το πλήρες, τελικό
// σύνολο domains) -- ίδια λογική με το ήδη υπάρχον whitelist pattern των
// widget settings, απλά εφαρμοσμένη σε λίστα αντί για μεμονωμένα πεδία.
// env.DB.batch() εκτελεί DELETE+INSERT σαν ΜΙΑ atomic πράξη -- είτε
// περάσουν όλα είτε καμία αλλαγή, ποτέ ενδιάμεση/μισή κατάσταση.
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
  if (current.contactLabel && current.contactLabel.length > 40) {
    return new Response(
      JSON.stringify({ error: "contactLabel is too long (max 40 characters)" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  if (current.contactUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(current.contactUrl)) {
    // Χαλαρός έλεγχος -- απλά ζητάμε ένα κανονικό URI scheme (https:,
    // mailto:, tel:, whatsapp: κλπ), όχι αυστηρή επαλήθευση domain. Ο
    // πελάτης μπορεί να βάλει ό,τι link χρησιμοποιεί πραγματικά.
    return new Response(
      JSON.stringify({ error: "contactUrl must start with a scheme, e.g. https:// or mailto:" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }
  if (current.contactUrl && /^\s*(javascript|vbscript|data):/i.test(current.contactUrl)) {
    // Αυτά τα schemes δεν είναι ποτέ έγκυρα contact links -- μόνο τρόπος να
    // τρέξει κώδικας στον browser του επισκέπτη του widget (XSS), αν το
    // href γίνει click. Ο παραπάνω γενικός έλεγχος scheme τα αφήνει περνάνε
    // (είναι έγκυρα URI schemes), γι' αυτό ξεχωριστός, ρητός αποκλεισμός.
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

  // Ίδια πολιτική TTL με τα υπόλοιπα δεδομένα του workspace: το προστατευμένο
  // demo workspace δεν λήγει ποτέ, οι επισκέπτες παίρνουν 7 ημέρες που
  // ανανεώνονται αυτόματα σε κάθε save.
  const { putOptions } = docTtlFor(workspaceId);
  await env.DOCUMENT_REGISTRY.put(`workspace:${workspaceId}:settings`, JSON.stringify(current), putOptions);

  return new Response(JSON.stringify(current), { headers: JSON_HEADERS });
}

// Στέλνει ένα απλό transactional email μέσω Resend (https://resend.com).
// Best-effort: ΠΟΤΕ δεν πετάει exception προς τα έξω -- μια αποτυχία στέλνοντας
// email δεν πρέπει ποτέ να χαλάσει την απάντηση προς τον χρήστη. Αν δεν έχει
// ρυθμιστεί ακόμα το RESEND_API_KEY secret, απλά δεν στέλνει τίποτα (σιωπηλά).
//
// Κοινό σημείο για ΟΛΑ τα transactional emails (fallback notification, password
// reset) -- ένα σημείο να ρυθμίσεις/αλλάξεις τον πάροχο, όχι δύο αντίγραφα.
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
    // Σκόπιμα καταπίνουμε το error -- βλ. σχόλιο πάνω από τη function.
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

// Section M: URL sync -- προσθήκη εγγράφου διαβάζοντας μια δημόσια σελίδα
// αντί για copy-paste. Απλή, "αρκετά καλή" εξαγωγή κειμένου από HTML: όχι
// πλήρης parser, μόνο αφαίρεση script/style/σχολίων + βασικών tags,
// μετατροπή block-level στοιχείων σε νέες γραμμές πριν αφαιρεθούν οι
// υπόλοιπες ετικέτες, αποκωδικοποίηση των πιο κοινών HTML entities.
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
  // Ευριστική αφαίρεση nav/header/footer -- συχνά κουβαλάνε μενού/copyright,
  // όχι πραγματικό περιεχόμενο. Δεν πιάνει 100% τις περιπτώσεις, αλλά
  // βελτιώνει σημαντικά την ποιότητα σε τυπικές σελίδες.
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

// Ελαφρύ slug (λατινικοί χαρακτήρες μόνο) + τυχαία κατάληξη, ώστε το
// documentId να είναι πάντα μη-κενό και μοναδικό ακόμα κι αν ο τίτλος
// είναι εξ ολοκλήρου στα ελληνικά (τα ελληνικά γράμματα δεν περνάνε το
// φίλτρο a-z0-9, οπότε μένει μόνο η τυχαία κατάληξη -- αποδεκτό, το
// documentId είναι εσωτερικό κλειδί, δεν το βλέπει ποτέ ο χρήστης).
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

// Section L: streaming.
//
// Ίδιο prompt/model με το askGemini(), αλλά καλεί το streamGenerateContent
// endpoint (alt=sse) και επιστρέφει τα κομμάτια κειμένου ΚΑΘΩΣ φτάνουν, όχι
// όλα μαζί στο τέλος. async generator -- ο καλών κάνει "for await (const
// piece of ...)" για να τα διαβάσει ένα-ένα.
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

  // Το Google SSE format είναι ίδιο με το δικό μας: γραμμές "data: {...}",
  // χωρισμένες με κενή γραμμή. Κάθε JSON κομμάτι κουβαλάει ΝΕΟ κείμενο
  // (incremental), όχι το σωρευμένο μέχρι τώρα -- ο καλών είναι υπεύθυνος
  // να τα ενώσει. ΣΗΜΑΝΤΙΚΟ: κανονικοποιούμε \r\n σε \n πριν το boundary
  // detection -- το Google στέλνει CRLF, όχι σκέτο \n (βρέθηκε live, μετά
  // από debugging: χωρίς αυτό ο parser δεν έβρισκε ΠΟΤΕ πλήρες "data:"
  // event, οπότε ΚΑΝΕΝΑ κομμάτι κειμένου δεν έβγαινε ποτέ).
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

// Section K: analytics.
//
// "YYYY-MM-DD" σε UTC -- σταθερό, χωρίς εξάρτηση από timezone του server ή
// του χρήστη. Το offsetDays=0 είναι σήμερα, offsetDays=1 είναι χθες, κλπ.
function dateKeyFor(offsetDays) {
  const d = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// Section N: επιστρέφει "YYYY-MM" σε UTC -- ίδια λογική με το dateKeyFor
// του analytics, απλά σε επίπεδο μήνα αντί για ημέρα.
function monthKeyFor() {
  return new Date().toISOString().slice(0, 7);
}

// Ελέγχει (ΚΑΙ αυξάνει, αν επιτρέπεται) τον μετρητή μηνυμάτων του μήνα για
// αυτό το workspace. Το PROTECTED_WORKSPACE_ID (το πραγματικό demo/developer
// workspace) εξαιρείται -- δεν είναι πελάτης προς προστασία από κόστος, το
// ελέγχει ο ίδιος ο Giannis.
//
// ΣΚΟΠΙΜΑ ελέγχεται ΠΡΙΝ από οποιοδήποτε κλήση προς το Gemini API (βλ. πού
// καλείται παρακάτω) -- αν το όριο έχει ήδη χτυπηθεί, δεν πληρώνουμε κόστος
// embedding/generation για μια ερώτηση που έτσι κι αλλιώς θα απορριφθεί.
//
// Ίδιο αποδεκτό ρίσκο race condition με το recordAnalytics (KV χωρίς atomic
// increment) -- σε πολύ σπάνιο ταυτόχρονο traffic το όριο μπορεί να ξεπεραστεί
// κατά λίγο, αποδεκτό για ένα φρένο κόστους σε αυτή την κλίμακα.
async function checkAndIncrementUsage(env, workspaceId) {
  if (workspaceId === PROTECTED_WORKSPACE_ID) return { allowed: true };

  // MONTHLY_MESSAGE_LIMIT_OVERRIDE: ΜΟΝΟ για τοπικά tests (μπαίνει στο
  // .dev.vars, ποτέ στο wrangler.toml/production) -- έτσι ένα test μπορεί να
  // ελέγξει το "χτύπημα" του ορίου με π.χ. 3 ερωτήσεις αντί για 3000
  // πραγματικά (και ακριβά) Gemini calls.
  const limit = env.MONTHLY_MESSAGE_LIMIT_OVERRIDE
    ? parseInt(env.MONTHLY_MESSAGE_LIMIT_OVERRIDE, 10)
    : MONTHLY_MESSAGE_LIMIT;

  const key = `usage:${workspaceId}:${monthKeyFor()}`;
  const raw = await env.DOCUMENT_REGISTRY.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= limit) {
    return { allowed: false };
  }

  await env.DOCUMENT_REGISTRY.put(key, String(count + 1), { expirationTtl: USAGE_KEY_TTL_SECONDS });
  return { allowed: true };
}

// Best-effort, ΠΟΤΕ δεν πρέπει να μπλοκάρει ή να σπάσει την απάντηση προς
// τον χρήστη -- ίδια φιλοσοφία με το logFallbackQuestion. ΔΕΝ αποθηκεύεται
// το ίδιο το κείμενο της ερώτησης εδώ, μόνο μετρητές ανά ημέρα.
//
// KV δεν έχει atomic increment -- get+put με πιθανό race condition σε πολύ
// σπάνια ταυτόχρονα requests. Αποδεκτό ρίσκο για αυτή την κλίμακα (demo/
// μικρή επιχείρηση), ίδιο επίπεδο συνέπειας με άλλα σημεία του κώδικα.
async function recordAnalytics(env, workspaceId, isFallback) {
  try {
    const key = `analytics:${workspaceId}:${dateKeyFor(0)}`;
    const raw = await env.DOCUMENT_REGISTRY.get(key);
    const current = raw ? JSON.parse(raw) : { total: 0, fallback: 0 };
    current.total += 1;
    if (isFallback) current.fallback += 1;
    await env.DOCUMENT_REGISTRY.put(key, JSON.stringify(current), { expirationTtl: ANALYTICS_TTL_SECONDS });
  } catch (err) {
    // Σκόπιμα καταπίνουμε το error -- τα analytics ΠΟΤΕ δεν πρέπει να
    // σπάσουν μια πραγματική απάντηση προς τον χρήστη.
  }
}

// Διαβάζει τις τελευταίες `days` ημέρες (πιο παλιά→πιο πρόσφατη, βολικό για
// γράφημα), γεμίζει με {total:0, fallback:0} τις ημέρες χωρίς καμία
// ερώτηση, και υπολογίζει τα συνολικά νούμερα.
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

// Section M: φτιάχνει ΝΕΟ έγγραφο διαβάζοντας μια δημόσια σελίδα. Πάντα
// ξεκινάει ως "draft" -- ΙΔΙΑ πολιτική με τα χειροκίνητα uploads (Section
// D), ώστε ο πελάτης να μπορεί να ελέγξει το αυτόματα εξαγμένο κείμενο
// πριν το δημοσιεύσει. Καμία κλήση Gemini/Vectorize εδώ -- αυτές γίνονται
// μόνο στο ρητό "Δημοσίευση", όπως και στα κανονικά uploads.
async function handleUploadFromUrl(request, env) {
  const workspaceId = await resolveWorkspaceId(request, env);
  if (!workspaceId) return jsonError(400, "Missing X-Workspace-Id header");

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

  // 10 λέξεις είναι αρκετές για να ξεχωρίσουμε μια πραγματική σελίδα από
  // μια άδεια/σπασμένη (π.χ. SPA που δεν αποδίδει τίποτα server-side).
  // ΔΕΝ απαιτούμε "μεγάλο" περιεχόμενο -- πολλές πραγματικές σελίδες
  // (π.χ. ένα σύντομο FAQ) είναι νόμιμα σύντομες.
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

  const { putOptions, expiresAt } = docTtlFor(workspaceId);
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
  const result = await runQuery(env, workspaceId, body.question);
  return new Response(JSON.stringify(result.body), { status: result.status, headers: JSON_HEADERS });
}

// Η πραγματική ροή RAG (embedding → semantic search → Gemini), ξεχωρισμένη
// από το πώς φτάνουμε στο workspaceId. Έτσι το ΙΔΙΟ pipeline εξυπηρετεί
// τόσο το υπάρχον /query (session/X-Workspace-Id, editor + demo σελίδα)
// όσο και το νέο δημόσιο /embed/{embedId}/query (Section I, embedded
// widget σε ξένο site) -- καμία λογική δεν γράφεται δύο φορές.
async function runQuery(env, workspaceId, question) {
  if (!question) {
    return { status: 400, body: { error: "question is required" } };
  }

  const usage = await checkAndIncrementUsage(env, workspaceId);
  if (!usage.allowed) {
    return { status: 429, body: { error: "Monthly message limit reached for this workspace.", limitReached: true } };
  }

  // Βήμα 1: embedding της ερώτησης
  const questionEmbedding = await getEmbedding(question, env.GEMINI_API_KEY);

  // Βήμα 2: semantic search στο Vectorize, μόνο μέσα στο σωστό workspace.
  //
  // Ένα workspace που ΠΟΤΕ δεν πήρε κανένα δημοσιευμένο έγγραφο δεν έχει
  // καν δημιουργηθεί σαν namespace στο Vectorize ακόμα -- το Vectorize
  // πετάει σφάλμα σε αυτή την περίπτωση, ΔΕΝ επιστρέφει απλά άδεια
  // αποτελέσματα. Το αντιμετωπίζουμε ακριβώς σαν "καμία σχετική
  // τεκμηρίωση", ίδια συμπεριφορά με το ήδη υπάρχον fallback παρακάτω.
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
  await recordAnalytics(env, workspaceId, isFallback);

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

  return { status: 200, body: { answer, isFallback, primarySource, relatedSections } };
}

// Section L: streaming version του runQuery(). ΙΔΙΟ pipeline (embedding →
// semantic search → Gemini), αλλά το βήμα Gemini στέλνει το κείμενο
// σταδιακά αντί να περιμένουμε ολόκληρη την απάντηση. Χρησιμοποιεί δικό
// του, απλό SSE πρωτόκολλο (ΟΧΙ το raw format του Google) ώστε το frontend
// να μη χρειάζεται να ξέρει τίποτα για τα εσωτερικά του Gemini:
//   {type:"chunk", text} -- ένα νέο κομμάτι κειμένου προς προσθήκη
//   {type:"done", isFallback, primarySource, relatedSections} -- τέλος
//   {type:"error", message} -- κάτι πήγε στραβά, το frontend δείχνει γενικό μήνυμα
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

        // Δοκιμάζουμε πρώτα το πραγματικό streaming. Αν για οποιονδήποτε
        // λόγο δεν αποδώσει ΚΑΝΕΝΑ κομμάτι κειμένου (π.χ. προσωρινό
        // πρόβλημα δικτύου στο ενδιάμεσο fetch προς το Gemini), κάνουμε
        // fallback στο ήδη δοκιμασμένο, μη-streaming askGemini() -- ο
        // επισκέπτης παίρνει ΟΠΩΣΔΗΠΟΤΕ απάντηση, έστω μονομιάς αντί για
        // σταδιακά.
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
          // το stream μπορεί να έχει ήδη κλείσει/σπάσει -- αγνόησέ το
        }
        controller.close();
      }
    },
  });
}

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
  if (!usage.allowed) return jsonError(429, "Monthly message limit reached for this workspace.");

  const stream = buildStreamingQueryResponse(env, workspaceId, body.question);
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

// Section I: CORS + embed-id → workspaceId, για το δημόσιο embed endpoint.
//
// Το Origin header έχει μορφή "https://www.site.gr" (ΧΩΡΙΣ path) -- το
// URL API μας δίνει καθαρά το hostname χωρίς να χρειάζεται χειροκίνητο
// parsing με regex.
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

// ΠΡΟΣΟΧΗ: αυτά τα headers μπαίνουν ΜΟΝΟ όταν το origin έχει ήδη περάσει
// το isOriginAllowedForWorkspace έλεγχο. Ποτέ δεν επιστρέφουμε
// Access-Control-Allow-Origin σε μη-επιτρεπόμενο origin -- έτσι ο browser
// του επισκέπτη μπλοκάρει μόνος του την ανάγνωση της απάντησης, ακόμα κι
// αν το request έφτασε μέχρι τον Worker.
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// Preflight: ο browser στέλνει ΠΡΩΤΑ ένα OPTIONS request (χωρίς body) πριν
// το πραγματικό POST, ακριβώς επειδή το request έχει Content-Type:
// application/json. Το embedId έρχεται από το ΙΔΙΟ path -- ΟΧΙ από body ή
// custom header -- ακριβώς επειδή στο preflight δεν υπάρχει καθόλου body
// να διαβάσουμε.
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

  // ΧΩΡΙΣ Origin header καθόλου (π.χ. ένα script/server, όχι πραγματικός
  // browser) απορρίπτεται ρητά -- ένα embedded widget ΠΑΝΤΑ τρέχει μέσα σε
  // browser σε ξένο domain, άρα ΠΑΝΤΑ στέλνει Origin.
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

// Streaming εκδοχή του παραπάνω -- ΙΔΙΑ CORS/embed-id λογική, διαφορετικό
// pipeline (buildStreamingQueryResponse αντί για runQuery) και response
// (SSE stream αντί για ένα JSON σώμα).
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
  if (!usage.allowed) return jsonError(429, "Monthly message limit reached for this workspace.");

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
// Section M: ξαναδιαβάζει το ΗΔΗ αποθηκευμένο sourceUrl ενός εγγράφου (π.χ.
// η σελίδα του πελάτη άλλαξε μετά το αρχικό sync). Αν το έγγραφο ήταν ήδη
// δημοσιευμένο, ξανακάνει chunking/embedding ώστε το bot να βλέπει αμέσως
// το νέο περιεχόμενο -- ΙΔΙΑ λογική με το handlePublishDocument. Αν είναι
// ακόμα draft, απλά ενημερώνει το fullText, χωρίς καμία κλήση Gemini.
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

  const { putOptions, expiresAt } = docTtlFor(workspaceId);
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

// Section N: Google Drive OAuth connector.
//
// Δύο endpoints: /oauth/google/start ξεκινάει τη ροή (redirect στη Google),
// /oauth/google/callback την ολοκληρώνει (ανταλλάσσει το code για tokens
// και τα αποθηκεύει κρυπτογραφημένα στη D1). Ο workspaceId περνάει σαν
// query param -- αυτό είναι top-level browser navigation (ο χρήστης
// ανοίγει ένα link, δεν υπάρχει X-Session-Token header σε redirect flow),
// ίδιο μοντέλο εμπιστοσύνης με το ήδη υπάρχον Guest/Developer flow (βλ.
// Known limitations στο README).
//
// CSRF protection: ένα τυχαίο "state" αποθηκεύεται στο KV με σύντομη λήξη
// (10 λεπτά), δείχνοντας ποιο workspaceId ξεκίνησε τη ροή. Το callback το
// ελέγχει και το διαγράφει αμέσως μετά τη χρήση -- ένα state δεν
// ξαναχρησιμοποιείται ποτέ, ίδια passive-TTL φιλοσοφία με τα υπόλοιπα
// δεδομένα του project (καμία cron διαδικασία).
const OAUTH_STATE_TTL_SECONDS = 60 * 10; // 10 λεπτά
// openid + email δεν είναι ευαίσθητα scopes -- χρειάζονται μόνο για να
// μπορούμε να καλέσουμε το userinfo endpoint και να δείξουμε ποιος
// λογαριασμός συνδέθηκε (connected_by_email). Χωρίς αυτά, το drive.readonly
// access token δεν έχει δικαίωμα να διαβάσει καν το email του χρήστη.
const GOOGLE_DRIVE_SCOPE_REQUIRED = "https://www.googleapis.com/auth/drive.readonly";
const GOOGLE_DRIVE_SCOPE =
  `${GOOGLE_DRIVE_SCOPE_REQUIRED} openid email`;

async function handleOAuthGoogleStart(request, env) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspace_id");
  if (!workspaceId) {
    return jsonError(400, "Missing workspace_id query parameter");
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
  authUrl.searchParams.set("access_type", "offline"); // ζητάμε refresh_token
  authUrl.searchParams.set("prompt", "consent select_account"); // πάντα ζητά consent ΚΑΙ επιλογή λογαριασμού (ποτέ σιωπηλή παράλειψη λόγω ενεργού session)
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleOAuthGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    // Ο χρήστης πάτησε "Deny" στη Google, ή κάτι άλλο ακυρώθηκε εκεί.
    return Response.redirect(new URL("/editor.html?google_drive_error=denied", url).toString(), 302);
  }

  if (!code || !state) {
    return Response.redirect(new URL("/editor.html?google_drive_error=missing_params", url).toString(), 302);
  }

  const stateKey = `oauth:state:${state}`;
  const workspaceId = await env.DOCUMENT_REGISTRY.get(stateKey);
  if (!workspaceId) {
    // Άκυρο, ληγμένο, ή ήδη χρησιμοποιημένο state -- ποτέ δεν προχωράμε.
    return Response.redirect(new URL("/editor.html?google_drive_error=invalid_state", url).toString(), 302);
  }
  await env.DOCUMENT_REGISTRY.delete(stateKey); // ένα state, μία χρήση

  // Ανταλλαγή του authorization code για access_token + refresh_token.
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

  // refresh_token λείπει αν ο χρήστης έχει ΞΑΝΑδώσει consent στο παρελθόν
  // και για κάποιο λόγο το prompt=consent δεν το ανάγκασε -- σε αυτή την
  // περίπτωση δεν μπορούμε να ανανεώσουμε αργότερα, οπότε το αντιμετωπίζουμε
  // ως αποτυχία και ζητάμε να ξαναδοκιμάσει τη σύνδεση.
  if (!tokenData.refresh_token) {
    return Response.redirect(new URL("/editor.html?google_drive_error=no_refresh_token", url).toString(), 302);
  }

  // Η Google επιστρέφει το πραγματικά εγκεκριμένο scope στο ίδιο το token
  // response (πεδίο "scope", χωρισμένο με κενά). ΠΟΤΕ δεν το εμπιστευόμαστε
  // σιωπηλά -- η νεότερη, πιο αναλυτική οθόνη συναίνεσης της Google επιτρέπει
  // στον χρήστη να ξε-τσεκάρει μεμονωμένα δικαιώματα (π.χ. να εγκρίνει μόνο
  // το email αλλά όχι το Drive). Αν λείπει το scope που χρειαζόμαστε, δεν
  // αποθηκεύουμε καθόλου σύνδεση -- θα ήταν άχρηστη και θα απέτυχε αργότερα
  // με ασαφές σφάλμα στο πρώτο πραγματικό API call.
  const grantedScopes = (tokenData.scope || "").split(/\s+/);
  if (!grantedScopes.includes(GOOGLE_DRIVE_SCOPE_REQUIRED)) {
    return Response.redirect(new URL("/editor.html?google_drive_error=missing_drive_scope", url).toString(), 302);
  }

  // Ποιος Google λογαριασμός συνδέθηκε -- μόνο για εμφάνιση στο UI
  // ("Συνδεδεμένο ως x@gmail.com"), ποτέ για authorization logic.
  let connectedByEmail = null;
  try {
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userInfoResponse.json();
    connectedByEmail = userInfo.email || null;
  } catch (err) {
    // Best-effort -- η σύνδεση δουλεύει κανονικά ακόμα κι αν αυτό αποτύχει.
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

// Section N (συνέχεια): χρήση της σύνδεσης Google Drive.
//
// getValidGoogleDriveAccessToken() είναι το ΜΟΝΟ σημείο που διαβάζει την
// D1, αποκρυπτογραφεί, και -- αν χρειάζεται -- ανανεώνει το access token.
// Κάθε άλλος handler που χρειάζεται να μιλήσει στο Drive API περνάει από
// εδώ, ποτέ δεν διαβάζει το connections table απευθείας.
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // ανανεώνουμε 1 λεπτό πριν τη λήξη, όχι ακριβώς πάνω στη λήξη

async function getValidGoogleDriveAccessToken(env, workspaceId) {
  const row = await env.DB.prepare(
    "SELECT access_token, refresh_token, expires_at, connected_by_email FROM connections WHERE workspace_id = ? AND provider = ?"
  ).bind(workspaceId, "google_drive").first();

  if (!row) {
    const err = new Error("Google Drive δεν είναι συνδεδεμένο για αυτό το workspace");
    err.code = "not_connected";
    throw err;
  }

  // Ακόμα έγκυρο -- δεν χρειάζεται καμία κλήση στη Google.
  if (row.expires_at - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    const accessToken = await decryptToken(row.access_token, env.TOKEN_ENCRYPTION_KEY);
    return { accessToken, connectedByEmail: row.connected_by_email };
  }

  // Έληξε (ή κοντεύει) -- ανανέωση μέσω του refresh_token. Το refresh_token
  // ΔΕΝ αλλάζει σε αυτή τη ροή (η Google συνήθως δεν στέλνει καινούργιο),
  // οπότε ενημερώνουμε ΜΟΝΟ το access_token/expires_at στη D1.
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
    // Το refresh token μπορεί να έχει ανακληθεί χειροκίνητα από τον χρήστη
    // (Google Account settings) -- σε αυτή την περίπτωση δεν υπάρχει τίποτα
    // άλλο να κάνουμε εκτός από το να ζητήσουμε νέα σύνδεση.
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

// Section N (συνέχεια): αποσύνδεση. Καλεί το revoke endpoint της Google
// (best-effort -- ακόμα κι αν αποτύχει, π.χ. το token είχε ήδη ανακληθεί
// χειροκίνητα, συνεχίζουμε ούτως ή άλλως να διαγράψουμε τη γραμμή μας)
// ΚΑΙ διαγράφει τη γραμμή από τη D1. Μετά την αποσύνδεση, ο χρήστης βλέπει
// ξανά την αρχική οθόνη "Σύνδεση Google Drive".
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
      // Best-effort -- η τοπική αποσύνδεση προχωράει ούτως ή άλλως παρακάτω.
    }
  }

  await env.DB.prepare(
    "DELETE FROM connections WHERE workspace_id = ? AND provider = ?"
  ).bind(workspaceId, "google_drive").run();

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

// Ποια Google Workspace mimeTypes υποστηρίζουμε, και πώς εξάγεται η καθεμία
// σε απλό κείμενο κατάλληλο για το ίδιο draft-then-publish pipeline που
// έχουν ήδη τα χειροκίνητα uploads και το URL sync (Section D/M). Το Sheets
// export βγάζει ΜΟΝΟ το πρώτο φύλλο σαν CSV -- γνωστός περιορισμός, αρκετό
// για πρώτη έκδοση.
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

  // Μόνο Google Docs/Sheets, όχι folders/PDFs/εικόνες κλπ -- αυτά είναι τα
  // δύο τύποι που ξέρουμε να εξάγουμε σε καθαρό κείμενο (βλ. πίνακα πάνω).
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
    const { putOptions, expiresAt } = docTtlFor(workspaceId);
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

// Απλός έλεγχος κωδικού για τη λειτουργία "Developer" στη landing page.
// Ο πραγματικός κωδικός ζει ΜΟΝΟ σαν Worker secret (env.DEVELOPER_PASSWORD),
// ποτέ μέσα στον κώδικα. Καμία session/cookie/token -- το frontend απλά
// θυμάται την επιτυχία τοπικά (localStorage) μετά από αυτόν τον έλεγχο.
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

    if (url.pathname === "/embed/domains" && request.method === "GET") {
      return handleGetEmbedDomains(request, env);
    }

    if (url.pathname === "/embed/domains" && request.method === "PATCH") {
      return handlePatchEmbedDomains(request, env);
    }

    if (url.pathname === "/analytics/summary" && request.method === "GET") {
      return handleGetAnalyticsSummary(request, env);
    }

    // Public embed endpoint -- ΔΕΝ χρησιμοποιεί resolveWorkspaceId (session/
    // X-Workspace-Id). Το embedId έρχεται από το path, το CORS middleware
    // ελέγχει το Origin πριν προχωρήσει καθόλου στη λογική RAG.
    const embedQueryMatch = url.pathname.match(/^\/embed\/([^/]+)\/query$/);
    if (embedQueryMatch) {
      const embedId = embedQueryMatch[1];
      if (request.method === "OPTIONS") return handleEmbedQueryPreflight(request, env, embedId);
      if (request.method === "POST") return handleEmbedQuery(request, env, embedId);
    }

    // Section L: streaming -- ίδιο path pattern, /stream στο τέλος. Το
    // preflight είναι το ΙΔΙΟ (ελέγχει μόνο Origin/embedId, δεν διαφέρει
    // ανάλογα με streaming ή όχι), απλά καλείται και για τα δύο paths.
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