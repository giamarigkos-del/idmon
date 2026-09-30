// Section W (Φέτα 4): διαχείριση ομάδας από τον admin: τμήματα (δημιουργία, μετονομασία, κρυφό),
// μέλη (πρόσκληση, ρόλος, τμήματα, απενεργοποίηση) και ιστορικό ενεργειών.
// ΟΛΑ τα endpoints είναι μόνο για admin και δουλεύουν πάντα μέσα στο workspace του admin.
// Οι αλλαγές ισχύουν ΑΜΕΣΩΣ: ο ρόλος και η κατάσταση διαβάζονται από τη βάση σε κάθε request.

import { json, loadWorkspaceDepartments, normalizeEmail } from "./auth.js";
import { AUDIT_RETENTION_DAYS, recordAudit } from "./audit.js";
import { listDocIndex } from "./store.js";
import { ROLES } from "./access.js";

const MAX_NAME_CHARS = 80;
const AUDIT_PAGE_SIZE = 100;

const cleanName = (raw) => (typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "");

async function membersWithDepartments(env, workspaceId) {
  const members = await env.DB.prepare(
    "SELECT id, email, role, status, created_at FROM team_members WHERE workspace_id = ? ORDER BY email"
  ).bind(workspaceId).all();
  const links = await env.DB.prepare(
    `SELECT md.member_id, md.department_id FROM member_departments md
       JOIN team_members m ON m.id = md.member_id WHERE m.workspace_id = ?`
  ).bind(workspaceId).all();
  const byMember = new Map();
  for (const l of (links && links.results) || []) {
    if (!byMember.has(l.member_id)) byMember.set(l.member_id, []);
    byMember.get(l.member_id).push(l.department_id);
  }
  return ((members && members.results) || []).map((m) => ({
    id: m.id, email: m.email, role: m.role, status: m.status, createdAt: m.created_at,
    departmentIds: byMember.get(m.id) || [],
  }));
}

async function activeAdminCount(env, workspaceId) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM team_members WHERE workspace_id = ? AND role = 'admin' AND status = 'active'"
  ).bind(workspaceId).first();
  return r ? r.c : 0;
}

// Ελέγχει ότι όλα τα id τμημάτων ανήκουν στο workspace. Επιστρέφει τη λίστα ή null.
async function validDepartmentIds(env, workspaceId, ids) {
  if (!Array.isArray(ids)) return null;
  const unique = [...new Set(ids)];
  if (unique.length > 50 || unique.some((d) => typeof d !== "string")) return null;
  const known = new Set((await loadWorkspaceDepartments(env, workspaceId)).map((d) => d.id));
  return unique.every((d) => known.has(d)) ? unique : null;
}

async function setMemberDepartments(env, memberId, departmentIds) {
  await env.DB.prepare("DELETE FROM member_departments WHERE member_id = ?").bind(memberId).run();
  for (const d of departmentIds) {
    await env.DB.prepare("INSERT INTO member_departments (member_id, department_id) VALUES (?, ?)").bind(memberId, d).run();
  }
}

// ------------------------------------------------------------------ GET /team/admin/overview
export async function handleAdminOverview(env, member) {
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const members = await membersWithDepartments(env, member.workspaceId);
  const docs = await listDocIndex(env, member.workspaceId);
  return json(200, {
    workspaceName: member.workspaceName,
    departments: departments.map((d) => ({
      id: d.id,
      name: d.name,
      hidden: !!d.hidden,
      memberCount: members.filter((m) => m.departmentIds.includes(d.id)).length,
      documentCount: docs.filter((x) => x.departmentId === d.id).length,
    })),
    companyWideDocumentCount: docs.filter((x) => x.departmentId === "_all").length,
    members,
  });
}

// ------------------------------------------------------------------ POST /team/admin/departments
export async function handleCreateDepartment(request, rc) {
  const { env, deps, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const name = cleanName(body.name);
  if (!name || name.length > MAX_NAME_CHARS) return json(400, { error: "invalid_name" });
  const existing = await loadWorkspaceDepartments(env, member.workspaceId);
  if (existing.some((d) => d.name.toLowerCase() === name.toLowerCase())) return json(409, { error: "name_taken" });
  // Το id πάει αυτούσιο στα metadata του Vectorize: λατινικά μόνο, τυχαίο (τα ελληνικά ονόματα δεν χωράνε).
  const id = `d-${deps.randomHex(4)}`;
  await env.DB.prepare(
    "INSERT INTO departments (id, workspace_id, name, hidden, created_at) VALUES (?, ?, ?, 0, ?)"
  ).bind(id, member.workspaceId, name, new Date().toISOString()).run();
  await recordAudit(env, member, "department_created", id, { name });
  return json(201, { id, name, hidden: false });
}

// ------------------------------------------------------------------ PATCH /team/admin/departments/{id}
export async function handleUpdateDepartment(request, rc, id) {
  const { env, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const dept = await env.DB.prepare("SELECT id, name, hidden FROM departments WHERE id = ? AND workspace_id = ?")
    .bind(id, member.workspaceId).first();
  if (!dept) return json(404, { error: "not_found" });

  const changes = {};
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name || name.length > MAX_NAME_CHARS) return json(400, { error: "invalid_name" });
    const others = (await loadWorkspaceDepartments(env, member.workspaceId)).filter((d) => d.id !== id);
    if (others.some((d) => d.name.toLowerCase() === name.toLowerCase())) return json(409, { error: "name_taken" });
    changes.name = name;
  }
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== "boolean") return json(400, { error: "invalid_hidden" });
    changes.hidden = body.hidden ? 1 : 0;
  }
  if (!Object.keys(changes).length) return json(400, { error: "nothing_to_change" });

  await env.DB.prepare("UPDATE departments SET name = ?, hidden = ? WHERE id = ?")
    .bind(changes.name !== undefined ? changes.name : dept.name, changes.hidden !== undefined ? changes.hidden : dept.hidden, id).run();
  if (changes.name !== undefined) await recordAudit(env, member, "department_renamed", id, { from: dept.name, to: changes.name });
  if (changes.hidden !== undefined) await recordAudit(env, member, changes.hidden ? "department_hidden" : "department_unhidden", id, { name: dept.name });
  return json(200, { ok: true });
}

// ------------------------------------------------------------------ POST /team/admin/members
export async function handleCreateMember(request, rc) {
  const { env, deps, member, origin } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const email = normalizeEmail(body.email);
  if (!email) return json(400, { error: "invalid_email" });
  if (!ROLES.includes(body.role)) return json(400, { error: "invalid_role" });
  const departmentIds = await validDepartmentIds(env, member.workspaceId, body.departmentIds || []);
  if (departmentIds === null) return json(400, { error: "invalid_departments" });

  // Το email είναι μοναδικό σε όλο το σύστημα (ένας άνθρωπος, ένας οργανισμός). Δεν αποκαλύπτουμε
  // σε ποιον οργανισμό ανήκει αν υπάρχει ήδη.
  const taken = await env.DB.prepare("SELECT id FROM team_members WHERE email = ?").bind(email).first();
  if (taken) return json(409, { error: "email_in_use" });

  const ins = await env.DB.prepare(
    "INSERT INTO team_members (workspace_id, email, role, status, created_at) VALUES (?, ?, ?, 'active', ?)"
  ).bind(member.workspaceId, email, body.role, new Date().toISOString()).run();
  const memberId = ins.meta.last_row_id;
  await setMemberDepartments(env, memberId, departmentIds);
  await recordAudit(env, member, "member_added", email, { role: body.role, departmentIds });

  if (body.sendInvite) {
    await deps.sendEmailViaResend(
      env, email, "Πρόσκληση στο Idmon",
      `Έχεις προστεθεί στον χώρο γνώσης της ομάδας σου. Για να μπεις, γράψε το email σου εδώ και θα σου στείλουμε σύνδεσμο (δεν χρειάζεσαι κωδικό):\n\n${origin}/portal.html`
    );
  }
  return json(201, { id: memberId, email });
}

// ------------------------------------------------------------------ PATCH /team/admin/members/{id}
export async function handleUpdateMember(request, rc, id) {
  const { env, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const numericId = parseInt(id, 10);
  const target = Number.isInteger(numericId)
    ? await env.DB.prepare("SELECT id, email, role, status FROM team_members WHERE id = ? AND workspace_id = ?")
        .bind(numericId, member.workspaceId).first()
    : null;
  if (!target) return json(404, { error: "not_found" });

  const newRole = body.role !== undefined ? body.role : target.role;
  const newStatus = body.status !== undefined ? body.status : target.status;
  if (!ROLES.includes(newRole)) return json(400, { error: "invalid_role" });
  if (!["active", "disabled"].includes(newStatus)) return json(400, { error: "invalid_status" });
  let departmentIds = null;
  if (body.departmentIds !== undefined) {
    departmentIds = await validDepartmentIds(env, member.workspaceId, body.departmentIds);
    if (departmentIds === null) return json(400, { error: "invalid_departments" });
  }

  // Ο workspace δεν μένει ποτέ χωρίς ενεργό admin (αλλιώς κανείς δεν θα μπορούσε να τον διαχειριστεί).
  const losesAdmin = target.role === "admin" && target.status === "active" && (newRole !== "admin" || newStatus !== "active");
  if (losesAdmin && (await activeAdminCount(env, member.workspaceId)) <= 1) return json(409, { error: "last_admin" });

  await env.DB.prepare("UPDATE team_members SET role = ?, status = ? WHERE id = ?").bind(newRole, newStatus, target.id).run();
  if (departmentIds !== null) await setMemberDepartments(env, target.id, departmentIds);
  if (newStatus === "disabled") await env.DB.prepare("DELETE FROM team_sessions WHERE member_id = ?").bind(target.id).run();

  if (newRole !== target.role) await recordAudit(env, member, "member_role_changed", target.email, { from: target.role, to: newRole });
  if (newStatus !== target.status) await recordAudit(env, member, newStatus === "disabled" ? "member_disabled" : "member_enabled", target.email, null);
  if (departmentIds !== null) await recordAudit(env, member, "member_departments_changed", target.email, { departmentIds });
  return json(200, { ok: true });
}

// ------------------------------------------------------------------ GET /team/admin/audit
export async function handleAdminAudit(env, member) {
  // Διατήρηση: εγγραφές παλαιότερες από ένα έτος σβήνονται.
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400000).toISOString();
  await env.DB.prepare("DELETE FROM team_audit_log WHERE workspace_id = ? AND created_at < ?").bind(member.workspaceId, cutoff).run();
  const res = await env.DB.prepare(
    "SELECT id, actor_email, action, target, detail, created_at FROM team_audit_log WHERE workspace_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(member.workspaceId, AUDIT_PAGE_SIZE).all();
  return json(200, {
    retentionDays: AUDIT_RETENTION_DAYS,
    entries: ((res && res.results) || []).map((r) => ({
      id: r.id, actor: r.actor_email, action: r.action, target: r.target,
      detail: r.detail ? safeParse(r.detail) : null, at: r.created_at,
    })),
  });
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
