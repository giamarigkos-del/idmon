// src\team\admin.js
// Section W (Φέτα 4): διαχείριση ομάδας από τον admin: τμήματα (δημιουργία, μετονομασία, κρυφό),
// μέλη (πρόσκληση, ρόλος, τμήματα, απενεργοποίηση) και ιστορικό ενεργειών.
// ΟΛΑ τα endpoints είναι μόνο για admin και δουλεύουν πάντα μέσα στο workspace του admin.
// Οι αλλαγές ισχύουν ΑΜΕΣΩΣ: ο ρόλος και η κατάσταση διαβάζονται από τη βάση σε κάθε request.

import { json, loadWorkspaceDepartments, normalizeEmail } from "./auth.js";
import { AUDIT_RETENTION_DAYS, recordAudit } from "./audit.js";
import { COMPANY_WIDE, ROLES } from "./access.js";
import { DOC_ID_RE, departmentName, listDocIndex, pendingUpdateSummary, readDoc, writeDocRecord } from "./store.js";
import { runDueRechecks } from "./contradictions.js";

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
  const editorsOf = new Map();
  try {
    const eds = await env.DB.prepare(
      "SELECT e.member_id, e.project_id FROM team_project_editors e JOIN team_members m ON m.id = e.member_id WHERE m.workspace_id = ?"
    ).bind(workspaceId).all();
    for (const e of (eds && eds.results) || []) {
      if (!editorsOf.has(e.member_id)) editorsOf.set(e.member_id, new Set());
      editorsOf.get(e.member_id).add(e.project_id);
    }
  } catch {
    /* migration 0014 δεν έχει εφαρμοστεί: χωρίς ρόλους ανά project */
  }
  return ((members && members.results) || []).map((m) => {
    const departmentIds = byMember.get(m.id) || [];
    const ed = editorsOf.get(m.id) || new Set();
    const projectRoles = {};
    for (const d of departmentIds) projectRoles[d] = ed.has(d) ? "editor" : "member";
    return {
      id: m.id, email: m.email, role: m.role === "admin" ? "admin" : departmentIds.some((d) => ed.has(d)) ? "editor" : "employee",
      status: m.status, createdAt: m.created_at, departmentIds, projectRoles,
    };
  });
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

// "member" = όχι admin, χωρίς να αγγίζει τους ρόλους ανά project. Οι "editor"/"employee" μένουν ως συντομογραφίες (editor σε όλα
// τα projects του, ή σε κανένα), για συμβατότητα με την παλιά οθόνη.
const ROLE_INPUTS = [...ROLES, "member"];
const PROJECT_ROLES = ["member", "editor"];

// Χάρτης {projectId: "member"|"editor"} -> { departmentIds, editorIds } ή null αν είναι άκυρος ή ξένου οργανισμού.
async function validProjectRoles(env, workspaceId, map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const ids = Object.keys(map);
  if (ids.length > 50 || !ids.every((id) => PROJECT_ROLES.includes(map[id]))) return null;
  const valid = await validDepartmentIds(env, workspaceId, ids);
  return valid === null ? null : { departmentIds: valid, editorIds: valid.filter((id) => map[id] === "editor") };
}

async function setEditors(env, memberId, projectIds) {
  await env.DB.prepare("DELETE FROM team_project_editors WHERE member_id = ?").bind(memberId).run();
  for (const p of projectIds) {
    await env.DB.prepare("INSERT INTO team_project_editors (member_id, project_id, created_at) VALUES (?, ?, ?)")
      .bind(memberId, p, new Date().toISOString()).run();
  }
}

async function currentAccess(env, memberId) {
  const deps = await env.DB.prepare("SELECT department_id FROM member_departments WHERE member_id = ?").bind(memberId).all();
  const eds = await env.DB.prepare("SELECT project_id FROM team_project_editors WHERE member_id = ?").bind(memberId).all();
  const departmentIds = ((deps && deps.results) || []).map((r) => r.department_id);
  const editorIds = ((eds && eds.results) || []).map((r) => r.project_id).filter((id) => departmentIds.includes(id));
  return { departmentIds, editorIds };
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
  if (!ROLE_INPUTS.includes(body.role)) return json(400, { error: "invalid_role" });
  let departmentIds;
  let editorIds;
  if (body.projectRoles !== undefined) {
    const pr = await validProjectRoles(env, member.workspaceId, body.projectRoles);
    if (pr === null) return json(400, { error: "invalid_projects" });
    departmentIds = pr.departmentIds;
    editorIds = pr.editorIds;
  } else {
    departmentIds = await validDepartmentIds(env, member.workspaceId, body.departmentIds || []);
    if (departmentIds === null) return json(400, { error: "invalid_departments" });
    editorIds = body.role === "editor" ? departmentIds.slice() : [];
  }
  if (body.role === "admin") editorIds = [];
  const storedRole = body.role === "admin" ? "admin" : editorIds.length > 0 ? "editor" : "employee";

  // Το email είναι μοναδικό σε όλο το σύστημα (ένας άνθρωπος, ένας οργανισμός). Δεν αποκαλύπτουμε
  // σε ποιον οργανισμό ανήκει αν υπάρχει ήδη.
  const taken = await env.DB.prepare("SELECT id FROM team_members WHERE email = ?").bind(email).first();
  if (taken) return json(409, { error: "email_in_use" });

  const ins = await env.DB.prepare(
    "INSERT INTO team_members (workspace_id, email, role, status, created_at) VALUES (?, ?, ?, 'active', ?)"
  ).bind(member.workspaceId, email, storedRole, new Date().toISOString()).run();
  const memberId = ins.meta.last_row_id;
  await setMemberDepartments(env, memberId, departmentIds);
  await setEditors(env, memberId, editorIds);
  await recordAudit(env, member, "member_added", email, { role: storedRole, departmentIds, editorIds });

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

  if (body.role !== undefined && !ROLE_INPUTS.includes(body.role)) return json(400, { error: "invalid_role" });
  const newStatus = body.status !== undefined ? body.status : target.status;
  if (!["active", "disabled"].includes(newStatus)) return json(400, { error: "invalid_status" });

  // Πρόσβαση ανά project: τρέχουσα κατάσταση, και μετά οι αλλαγές του αιτήματος.
  const cur = await currentAccess(env, target.id);
  let departmentIds = cur.departmentIds;
  let editorIds = cur.editorIds;
  let accessChanged = false;
  if (body.departmentIds !== undefined) {
    const v = await validDepartmentIds(env, member.workspaceId, body.departmentIds);
    if (v === null) return json(400, { error: "invalid_departments" });
    departmentIds = v;
    editorIds = editorIds.filter((x) => departmentIds.includes(x));
    accessChanged = true;
  }
  let projectRolesChanged = false;
  if (body.projectRoles !== undefined) {
    const pr = await validProjectRoles(env, member.workspaceId, body.projectRoles);
    if (pr === null) return json(400, { error: "invalid_projects" });
    departmentIds = pr.departmentIds;
    editorIds = pr.editorIds;
    accessChanged = true;
    projectRolesChanged = true;
  }
  const targetIsAdmin = body.role !== undefined ? body.role === "admin" : target.role === "admin";
  if (targetIsAdmin) editorIds = [];
  else if (body.role === "editor") editorIds = departmentIds.slice();
  else if (body.role === "employee") editorIds = [];
  const newRole = targetIsAdmin ? "admin" : editorIds.length > 0 ? "editor" : "employee";

  // Ο workspace δεν μένει ποτέ χωρίς ενεργό admin (αλλιώς κανείς δεν θα μπορούσε να τον διαχειριστεί).
  const losesAdmin = target.role === "admin" && target.status === "active" && (newRole !== "admin" || newStatus !== "active");
  if (losesAdmin && (await activeAdminCount(env, member.workspaceId)) <= 1) return json(409, { error: "last_admin" });

  await env.DB.prepare("UPDATE team_members SET role = ?, status = ? WHERE id = ?").bind(newRole, newStatus, target.id).run();
  if (accessChanged) await setMemberDepartments(env, target.id, departmentIds);
  await setEditors(env, target.id, editorIds);
  if (newStatus === "disabled") await env.DB.prepare("DELETE FROM team_sessions WHERE member_id = ?").bind(target.id).run();

  if (newRole !== target.role) await recordAudit(env, member, "member_role_changed", target.email, { from: target.role, to: newRole });
  if (newStatus !== target.status) await recordAudit(env, member, newStatus === "disabled" ? "member_disabled" : "member_enabled", target.email, null);
  if (body.departmentIds !== undefined) await recordAudit(env, member, "member_departments_changed", target.email, { departmentIds });
  if (projectRolesChanged) await recordAudit(env, member, "member_project_roles_changed", target.email, { projectRoles: body.projectRoles });
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
  // Ονόματα αντί για τεχνικά id (έγγραφα, τμήματα). Διαγραμμένα έγγραφα: ο τίτλος που κρατήθηκε στην εγγραφή.
  const docTitles = new Map((await listDocIndex(env, member.workspaceId)).map((d) => [d.id, d.title]));
  const deptNames = new Map((await loadWorkspaceDepartments(env, member.workspaceId)).map((d) => [d.id, d.name]));
  return json(200, {
    retentionDays: AUDIT_RETENTION_DAYS,
    entries: ((res && res.results) || []).map((r) => {
      const detail = r.detail ? safeParse(r.detail) : null;
      let targetLabel = null;
      if (r.target) {
        if (docTitles.has(r.target)) targetLabel = docTitles.get(r.target);
        else if (deptNames.has(r.target)) targetLabel = deptNames.get(r.target);
        else if (/^doc-/.test(r.target) && detail && typeof detail.title === "string") targetLabel = detail.title;
      }
      return { id: r.id, actor: r.actor_email, action: r.action, target: r.target, targetLabel, detail, at: r.created_at };
    }),
  });
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ έγγραφα (επισκόπηση και "εμπιστευτικά")
// GET /team/admin/documents: όλα τα έγγραφα, με τμήμα, σήμανση εμπιστευτικού, εκκρεμή updates και ανοιχτές αντιφάσεις.
export async function handleAdminDocuments(env, member) {
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const index = await listDocIndex(env, member.workspaceId);
  const pending = await pendingUpdateSummary(env, member.workspaceId);
  const open = new Map();
  try {
    const res = await env.DB.prepare("SELECT doc_a, doc_b FROM team_contradictions WHERE workspace_id = ? AND status = 'open'").bind(member.workspaceId).all();
    for (const r of (res && res.results) || []) for (const id of [r.doc_a, r.doc_b]) open.set(id, (open.get(id) || 0) + 1);
  } catch {
    /* χωρίς πίνακα: μηδενικά */
  }
  return json(200, {
    documents: index
      .map((d) => ({
        id: d.id, title: d.title, departmentId: d.departmentId, departmentName: departmentName(departments, d.departmentId),
        hidden: d.hidden, updatedAt: d.updatedAt,
        pendingUpdates: (pending.get(d.id) || { count: 0 }).count, openContradictions: open.get(d.id) || 0,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
  });
}

// PATCH /team/admin/documents/{id}  {hidden: boolean}: σήμανση "εμπιστευτικό" (μόνο admin και μέλη του τμήματος το διαβάζουν).
export async function handleHideDocument(request, rc, id) {
  const { env, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (typeof body.hidden !== "boolean") return json(400, { error: "invalid_hidden" });
  if (!DOC_ID_RE.test(id)) return json(404, { error: "not_found" });
  const doc = await readDoc(env, member.workspaceId, id);
  if (!doc) return json(404, { error: "not_found" });
  if (body.hidden && doc.departmentId === COMPANY_WIDE) return json(400, { error: "company_wide_cannot_hide" });
  if (!!doc.hidden === body.hidden) return json(200, { ok: true });
  doc.hidden = body.hidden;
  await writeDocRecord(env, member.workspaceId, doc);
  await recordAudit(env, member, body.hidden ? "document_hidden" : "document_unhidden", id, { title: String(doc.title).slice(0, 80) });
  return json(200, { ok: true });
}

// POST /team/admin/rechecks/run: τρέχει ΤΩΡΑ τους εκκρεμείς επανελέγχους αντιφάσεων του οργανισμού (αντί να περιμένει το cron).
export async function handleRunRechecks(rc) {
  const { env, deps, member } = rc;
  const out = await runDueRechecks(env, deps, { force: true, workspaceId: member.workspaceId });
  await recordAudit(env, member, "rechecks_run", null, { processed: out.processed, created: out.created });
  return json(200, out);
}