// src\team\index.js
// Section W: είσοδος (router) για όλα τα /team/* endpoints του "Idmon για ομάδες".
// Καλείται από το src/index.js, στο οποίο περνάμε (deps) τις υπάρχουσες κοινές συναρτήσεις,
// ώστε αυτός ο φάκελος να μην εισάγει ποτέ το index.js (κανένας κυκλικός δεσμός) και το
// υπάρχον προϊόν να μη χρειάζεται καμία αλλαγή στη λογική του.

import {
  getSession,
  handleLoginStart,
  handleLoginVerify,
  handleLogout,
  json,
  loadWorkspaceDepartments,
} from "./auth.js";
import {
  handleDeleteDocument,
  handleGetDocument,
  handleListDocuments,
  handleSaveDocument,
} from "./docs.js";
import { handleTeamQuery } from "./query.js";
import { COMPANY_WIDE } from "./access.js";
import { handleDismissQuestion, handleInbox } from "./inbox.js";
import {
  handleCheckDocument,
  handleDismissContradiction,
  handleListContradictions,
  handleRemindContradiction,
} from "./contradictions.js";
import { handleApplyUpdate, handleCreateUpdate, handleProposeMerge, handleRejectUpdate } from "./updates.js";
import {
  handleAdminAudit,
  handleAdminDocuments,
  handleAdminOverview,
  handleBulkMemberships,
  handleBulkStatus,
  handleCreateDepartment,
  handleCreateMember,
  handleHideDocument,
  handleRunRechecks,
  handleUpdateDepartment,
  handleUpdateMember,
} from "./admin.js";
import { handleCloseFeedback, handleCreateFeedback } from "./feedback.js";

const DOC_PATH_RE = /^\/team\/documents\/([^/]+)$/;
const DOC_CHECK_RE = /^\/team\/documents\/([^/]+)\/check$/;
const CONTRADICTION_RE = /^\/team\/contradictions\/(\d+)\/(dismiss|remind)$/;
const UPDATE_RE = /^\/team\/updates\/(\d+)\/(propose|apply|reject)$/;
const ADMIN_DEPT_RE = /^\/team\/admin\/departments\/([^/]+)$/;
const ADMIN_MEMBER_RE = /^\/team\/admin\/members\/([^/]+)$/;
const ADMIN_DOC_RE = /^\/team\/admin\/documents\/([^/]+)$/;

// Προστασία από cross-site αιτήματα: ένα αίτημα που αλλάζει κάτι πρέπει να έρχεται από
// την ίδια προέλευση. (Το cookie είναι επιπλέον SameSite=Strict.)
function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

// Τμήματα ορατά στο μέλος (για επιλογείς και ετικέτες).
function visibleDepartments(member, all) {
  if (member.role === "admin") return all;
  const own = new Set(member.departmentIds);
  return all.filter((d) => own.has(d.id) || (member.role === "editor" && !d.hidden));
}

const isStaff = (member) => member.role === "editor" || member.role === "admin";

// ctx: το execution context του Worker (για ctx.waitUntil), προαιρετικό.
async function routeTeamRequest(request, env, url, deps, ctx) {
  const path = url.pathname;
  if (!path.startsWith("/team/")) return null;
  const method = request.method;

  if (method !== "GET" && !sameOrigin(request, url)) return json(403, { error: "forbidden_origin" });

  // --- χωρίς session
  if (path === "/team/login/start" && method === "POST") return handleLoginStart(request, env, url, deps);
  if (path === "/team/login/verify" && method === "POST") return handleLoginVerify(request, env, url, deps);
  if (path === "/team/logout" && method === "POST") return handleLogout(request, env);

  // --- όλα τα υπόλοιπα απαιτούν έγκυρο session
  const member = await getSession(request, env);
  if (!member) return json(401, { error: "unauthenticated" });
  const rc = { env, deps, member, ctx, origin: url.origin };

  if (path === "/team/me" && method === "GET") {
    return json(200, {
      email: member.email,
      role: member.role,
      workspaceName: member.workspaceName,
      departments: member.departments.map((d) => ({ id: d.id, name: d.name })),
      editorProjectIds: member.editorProjectIds || [],
    });
  }

  if (path === "/team/departments" && method === "GET") {
    const all = await loadWorkspaceDepartments(env, member.workspaceId);
    return json(200, {
      companyWideId: COMPANY_WIDE,
      departments: visibleDepartments(member, all).map((d) => ({
        id: d.id,
        name: d.name,
        ...(member.role === "admin" ? { hidden: !!d.hidden } : {}),
      })),
    });
  }

  // --- έγγραφα (ανάγνωση: όλοι, σύμφωνα με τους κανόνες πρόσβασης)
  if (path === "/team/documents" && method === "GET") return handleListDocuments(env, member);
  if (path === "/team/documents" && method === "POST") return handleSaveDocument(request, rc, null);

  const checkMatch = path.match(DOC_CHECK_RE);
  if (checkMatch && method === "POST") return handleCheckDocument(rc, decodeURIComponent(checkMatch[1]));

  const docMatch = path.match(DOC_PATH_RE);
  if (docMatch) {
    const id = decodeURIComponent(docMatch[1]);
    if (method === "GET") return handleGetDocument(env, member, id);
    if (method === "PUT") return handleSaveDocument(request, rc, id);
    if (method === "DELETE") return handleDeleteDocument(rc, id);
  }

  if (path === "/team/query/stream" && method === "POST") return handleTeamQuery(request, env, member, deps);
  if (path === "/team/feedback" && method === "POST") return handleCreateFeedback(request, rc);

  // --- εισερχόμενα, αντιφάσεις, updates: μόνο editors και admins
  const staffPaths = path === "/team/inbox" || path.startsWith("/team/inbox/") || path.startsWith("/team/contradictions") || path.startsWith("/team/updates");
  if (staffPaths && !isStaff(member)) return json(403, { error: "forbidden" });

  if (path === "/team/inbox" && method === "GET") return handleInbox(env, member);
  if (path === "/team/inbox/questions/dismiss" && method === "POST") return handleDismissQuestion(request, env, member);
  if (path === "/team/inbox/feedback/close" && method === "POST") return handleCloseFeedback(request, rc);

  if (path === "/team/contradictions" && method === "GET") return handleListContradictions(env, member, url);
  const cMatch = path.match(CONTRADICTION_RE);
  if (cMatch && method === "POST") {
    const id = parseInt(cMatch[1], 10);
    return cMatch[2] === "dismiss"
      ? handleDismissContradiction(env, member, id)
      : handleRemindContradiction(env, deps, member, id, url.origin);
  }

  if (path === "/team/updates" && method === "POST") return handleCreateUpdate(request, rc);
  const uMatch = path.match(UPDATE_RE);
  if (uMatch && method === "POST") {
    const id = parseInt(uMatch[1], 10);
    if (uMatch[2] === "propose") return handleProposeMerge(rc, id);
    if (uMatch[2] === "apply") return handleApplyUpdate(request, rc, id);
    return handleRejectUpdate(rc, id);
  }

  // --- διαχείριση: μόνο admin
  if (path.startsWith("/team/admin/")) {
    if (member.role !== "admin") return json(403, { error: "forbidden" });
    if (path === "/team/admin/overview" && method === "GET") return handleAdminOverview(env, member);
    if (path === "/team/admin/departments" && method === "POST") return handleCreateDepartment(request, rc);
    const dMatch = path.match(ADMIN_DEPT_RE);
    if (dMatch && method === "PATCH") return handleUpdateDepartment(request, rc, decodeURIComponent(dMatch[1]));
    if (path === "/team/admin/members" && method === "POST") return handleCreateMember(request, rc);
    if (path === "/team/admin/memberships" && method === "POST") return handleBulkMemberships(request, rc);
    if (path === "/team/admin/members/bulk-status" && method === "POST") return handleBulkStatus(request, rc);
    const mMatch = path.match(ADMIN_MEMBER_RE);
    if (mMatch && method === "PATCH") return handleUpdateMember(request, rc, decodeURIComponent(mMatch[1]));
    if (path === "/team/admin/audit" && method === "GET") return handleAdminAudit(env, member);
    if (path === "/team/admin/documents" && method === "GET") return handleAdminDocuments(env, member);
    const docAdminMatch = path.match(ADMIN_DOC_RE);
    if (docAdminMatch && method === "PATCH") return handleHideDocument(request, rc, decodeURIComponent(docAdminMatch[1]));
    if (path === "/team/admin/rechecks/run" && method === "POST") return handleRunRechecks(rc);
  }

  return json(404, { error: "not_found" });
}

// Ό,τι σφάλμα βάσης προκύψει επιστρέφεται ως καθαρή JSON απάντηση. Αν λείπει πίνακας, σημαίνει ότι δεν έχει εφαρμοστεί
// ακόμα κάποιο migration (π.χ. 0013): 503 migration_required, όχι ακατέργαστο σφάλμα.
export async function handleTeamRequest(request, env, url, deps, ctx) {
  try {
    return await routeTeamRequest(request, env, url, deps, ctx);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/no such table/i.test(msg)) return json(503, { error: "migration_required" });
    return json(500, { error: "server_error" });
  }
}