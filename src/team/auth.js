// src\team\auth.js
// Section W: σύνδεση υπαλλήλων με link στο email (χωρίς κωδικό) και sessions ομάδων.
//
// Ροή: (1) POST /team/login/start {email} -> στέλνει email με link
//      (2) ο υπάλληλος ανοίγει το link, η σελίδα διαβάζει το token από το fragment (#login=...)
//          και κάνει POST /team/login/verify {token} -> δημιουργείται session (cookie).
// Το token μπαίνει στο fragment (#), ΟΧΙ στο query, ώστε να μη φτάνει ποτέ σε server logs
// ή Referer, και ο έλεγχος να γίνεται με POST -- έτσι ένα εργαλείο ασφαλείας email που
// "ανοίγει" τα links για προεπισκόπηση (GET) δεν καταναλώνει το token.
//
// Κανένα token δεν αποθηκεύεται αυτούσιο: μόνο το sha256 του (KV για το link, D1 για το
// session), ώστε μια διαρροή της αποθήκευσης να μη δίνει χρησιμοποιήσιμα tokens.

import { recordAudit } from "./audit.js";

export const LOGIN_TOKEN_TTL_SECONDS = 60 * 15; // 15 λεπτά, μίας χρήσης
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ώρες: σύντομα, για γρήγορη αποχώρηση
export const SESSION_COOKIE = "team_session";
export const TEAM_WORKSPACE_PREFIX = "team-";

// Ρυθμίσεις rate limiting (δικές μας, όχι του SMB: ένα γραφείο μοιράζεται μία IP, άρα το
// όριο ανά IP πρέπει να είναι πολύ μεγαλύτερο από το όριο ανά email).
const LIMIT_WINDOW_SECONDS = 60 * 15;
const LIMIT_PER_EMAIL = 5;
const LIMIT_PER_IP = 40;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Μετρητής με όριο και λήξη, πάνω στο ίδιο KV. true = επιτρέπεται, false = ξεπεράστηκε.
async function hitLimit(env, key, limit) {
  const raw = await env.DOCUMENT_REGISTRY.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return false;
  await env.DOCUMENT_REGISTRY.put(key, String(count + 1), { expirationTtl: LIMIT_WINDOW_SECONDS });
  return true;
}

// Το workspace μιας ομάδας ΠΡΕΠΕΙ να ξεκινά με "team-". Έτσι το legacy μονοπάτι του SMB
// (X-Workspace-Id) μπορεί να τα αποκλείει με ένα πρόθεμα (βλ. resolveWorkspaceId).
function isTeamWorkspaceId(id) {
  return typeof id === "string" && id.startsWith(TEAM_WORKSPACE_PREFIX);
}

// ---------------------------------------------------------------- login/start
export async function handleLoginStart(request, env, url, deps) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const email = normalizeEmail(body && body.email);
  if (!email) return json(400, { error: "invalid_email" });

  const ip = deps.clientIp(request);
  const okIp = await hitLimit(env, `team-login-ip:${ip}`, LIMIT_PER_IP);
  const okEmail = await hitLimit(env, `team-login-email:${email}`, LIMIT_PER_EMAIL);
  if (!okIp || !okEmail) return json(429, { error: "too_many_requests" });

  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.status AS member_status, w.id AS workspace_id, w.status AS ws_status
       FROM team_members m JOIN team_workspaces w ON w.id = m.workspace_id
      WHERE m.email = ?`
  ).bind(email).first();

  const allowed =
    row &&
    row.member_status === "active" &&
    row.ws_status !== "paused" &&
    isTeamWorkspaceId(row.workspace_id);

  if (allowed) {
    const token = deps.randomHex(32); // 256-bit
    await env.DOCUMENT_REGISTRY.put(
      `team-login:${await sha256Hex(token)}`,
      JSON.stringify({ memberId: row.member_id, createdAt: new Date().toISOString() }),
      { expirationTtl: LOGIN_TOKEN_TTL_SECONDS }
    );
    const link = `${url.origin}/portal.html#login=${token}`;
    await deps.sendEmailViaResend(
      env,
      email,
      "Σύνδεση στο Idmon",
      `Πάτησε τον παρακάτω σύνδεσμο για να συνδεθείς. Ισχύει για 15 λεπτά και μπορεί να χρησιμοποιηθεί μία φορά.\n\n${link}\n\nΑν δεν το ζήτησες εσύ, αγνόησε αυτό το μήνυμα.`
    );
  }

  // ΠΑΝΤΑ η ίδια απάντηση, είτε το email υπάρχει είτε όχι: κανείς δεν μπορεί να ανακαλύψει
  // ποια emails ανήκουν σε εταιρεία.
  return json(200, { ok: true });
}

// --------------------------------------------------------------- login/verify
export async function handleLoginVerify(request, env, url, deps) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const token = body && typeof body.token === "string" ? body.token : "";
  if (!/^[a-f0-9]{64}$/.test(token)) return json(400, { error: "invalid_or_expired" });

  const kvKey = `team-login:${await sha256Hex(token)}`;
  const raw = await env.DOCUMENT_REGISTRY.get(kvKey);
  if (!raw) return json(400, { error: "invalid_or_expired" });
  // Μίας χρήσης: σβήνεται ΑΜΕΣΩΣ, πριν οτιδήποτε άλλο.
  await env.DOCUMENT_REGISTRY.delete(kvKey);

  let memberId;
  try {
    memberId = JSON.parse(raw).memberId;
  } catch {
    return json(400, { error: "invalid_or_expired" });
  }

  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.email, m.role, m.status AS member_status,
            w.id AS workspace_id, w.status AS ws_status
       FROM team_members m JOIN team_workspaces w ON w.id = m.workspace_id
      WHERE m.id = ?`
  ).bind(memberId).first();

  if (
    !row ||
    row.member_status !== "active" ||
    row.ws_status === "paused" ||
    !isTeamWorkspaceId(row.workspace_id)
  ) {
    return json(400, { error: "invalid_or_expired" });
  }

  const sessionToken = deps.randomHex(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await env.DB.prepare(
    "INSERT INTO team_sessions (token, member_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(await sha256Hex(sessionToken), row.member_id, row.workspace_id, now.toISOString(), expiresAt.toISOString()).run();

  // Καθαρισμός ληγμένων sessions αυτού του μέλους (ώστε ο πίνακας να μη μεγαλώνει).
  await env.DB.prepare("DELETE FROM team_sessions WHERE member_id = ? AND expires_at <= ?")
    .bind(row.member_id, now.toISOString()).run();

  await recordAudit(env, { workspaceId: row.workspace_id, id: row.member_id, email: row.email }, "login", null, null);

  const cookie =
    `${SESSION_COOKIE}=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/team; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return json(200, { ok: true, member: { email: row.email, role: row.role } }, { "Set-Cookie": cookie });
}

// ------------------------------------------------------------------- session
// Επιστρέφει το μέλος του τρέχοντος request ή null. ΟΛΑ ελέγχονται σε ΚΑΘΕ request
// (μέλος ενεργό, workspace όχι paused, session όχι ληγμένο), οπότε η απενεργοποίηση ενός
// μέλους από τον admin ισχύει αμέσως, χωρίς να περιμένει να λήξει το session.
export async function getSession(request, env) {
  const sessionToken = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (!sessionToken || !/^[a-f0-9]{64}$/.test(sessionToken)) return null;

  const row = await env.DB.prepare(
    `SELECT s.member_id, s.workspace_id, s.expires_at,
            m.email, m.role, m.status AS member_status, m.workspace_id AS member_workspace_id,
            w.name AS workspace_name, w.status AS ws_status
       FROM team_sessions s
       JOIN team_members m ON m.id = s.member_id
       JOIN team_workspaces w ON w.id = s.workspace_id
      WHERE s.token = ?`
  ).bind(await sha256Hex(sessionToken)).first();

  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) return null;
  if (row.member_status !== "active" || row.ws_status === "paused") return null;
  if (row.member_workspace_id !== row.workspace_id) return null;
  if (!isTeamWorkspaceId(row.workspace_id)) return null;

  const deptRows = await env.DB.prepare(
    `SELECT d.id, d.name, d.hidden
       FROM member_departments md JOIN departments d ON d.id = md.department_id
      WHERE md.member_id = ? AND d.workspace_id = ?`
  ).bind(row.member_id, row.workspace_id).all();
  const departments = (deptRows && deptRows.results) || [];
  const departmentIds = departments.map((d) => d.id);

  // Ρόλος ανά project: editor μόνο στα projects που έχει ρητή ανάθεση ΚΑΙ είναι μέλος. Ο ρόλος του μέλους είναι παράγωγος.
  // Αν το migration 0014 δεν έχει εφαρμοστεί ακόμα (λείπει ο πίνακας), ισχύει το παλιό μοντέλο (ένας ρόλος ανά άνθρωπο),
  // ώστε ένα deploy πριν το migration να μη χαλά τίποτα.
  let editorProjectIds;
  try {
    const edRows = await env.DB.prepare("SELECT project_id FROM team_project_editors WHERE member_id = ?").bind(row.member_id).all();
    const assigned = new Set(((edRows && edRows.results) || []).map((r) => r.project_id));
    editorProjectIds = departmentIds.filter((id) => assigned.has(id));
  } catch {
    editorProjectIds = row.role === "editor" ? departmentIds.slice() : [];
  }
  const role = row.role === "admin" ? "admin" : editorProjectIds.length > 0 ? "editor" : "employee";

  return {
    id: row.member_id,
    email: row.email,
    role,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    departmentIds,
    editorProjectIds,
    departments,
  };
}

export async function handleLogout(request, env) {
  const sessionToken = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (sessionToken && /^[a-f0-9]{64}$/.test(sessionToken)) {
    await env.DB.prepare("DELETE FROM team_sessions WHERE token = ?")
      .bind(await sha256Hex(sessionToken)).run();
  }
  const cookie = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/team; Max-Age=0`;
  return json(200, { ok: true }, { "Set-Cookie": cookie });
}

// Όλα τα τμήματα του workspace (id, name, hidden), για τους κανόνες πρόσβασης.
export async function loadWorkspaceDepartments(env, workspaceId) {
  const res = await env.DB.prepare(
    "SELECT id, name, hidden FROM departments WHERE workspace_id = ? ORDER BY name"
  ).bind(workspaceId).all();
  return (res && res.results) || [];
}