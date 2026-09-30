// Section W: έγγραφα ομάδων (λίστα, ανάγνωση, δημιουργία/επεξεργασία, διαγραφή), με δικαιώματα ανά ρόλο και
// τμήμα (βλ. access.js). Η αποθήκευση εγγράφου (KV + Vectorize) ζει στο store.js.
//
// Πρώτη φάση: ένα τμήμα ανά έγγραφο (ή COMPANY_WIDE = "_all" για όλη την εταιρεία), άμεση δημοσίευση.
// Το Vectorize επιτρέπει μία τιμή string ανά metadata πεδίο.

import { json, loadWorkspaceDepartments } from "./auth.js";
import { canReadDepartment, canWriteDepartment } from "./access.js";
import {
  DOC_ID_RE, departmentName, docKey, listDocIndex, pendingUpdateSummary, persistDocument, readDoc,
} from "./store.js";
import { recordAudit } from "./audit.js";
import { afterDocumentSaved, resolveContradictionsForDeletedDoc } from "./contradictions.js";
import { pendingUpdatesForDocument, rejectUpdatesOfDeletedDocument } from "./updates.js";

const MAX_TITLE_CHARS = 200;

// ------------------------------------------------------------------ GET /team/documents
export async function handleListDocuments(env, member) {
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const index = await listDocIndex(env, member.workspaceId);
  const pending = await pendingUpdateSummary(env, member.workspaceId);
  const docs = [];
  for (const d of index) {
    if (!canReadDepartment(member, departments, d.departmentId)) continue;
    const p = pending.get(d.id);
    docs.push({
      id: d.id,
      title: d.title,
      departmentId: d.departmentId,
      departmentName: departmentName(departments, d.departmentId),
      updatedAt: d.updatedAt,
      editable: canWriteDepartment(member, departments, d.departmentId),
      pendingUpdates: p ? { count: p.count, latestAt: p.latestAt } : null,
    });
  }
  docs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return json(200, { documents: docs });
}

// ------------------------------------------------------- GET /team/documents/{id}
export async function handleGetDocument(env, member, id) {
  const doc = await readDoc(env, member.workspaceId, id);
  if (!doc) return json(404, { error: "not_found" });
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  // Ίδια απάντηση με το "δεν υπάρχει": δεν αποκαλύπτουμε ότι ένα έγγραφο υπάρχει αν δεν το βλέπεις.
  if (!canReadDepartment(member, departments, doc.departmentId)) return json(404, { error: "not_found" });
  const pending = await pendingUpdatesForDocument(env, member.workspaceId, id);
  return json(200, {
    id,
    title: doc.title,
    fullText: doc.fullText,
    departmentId: doc.departmentId,
    departmentName: departmentName(departments, doc.departmentId),
    version: doc.version,
    updatedAt: doc.updatedAt,
    editable: canWriteDepartment(member, departments, doc.departmentId),
    pendingUpdates: pending.map((u) => ({ id: u.id, text: u.text, createdAt: u.created_at })),
  });
}

// ------------------------------------- POST /team/documents  και  PUT /team/documents/{id}
export async function handleSaveDocument(request, rc, existingId) {
  const { env, deps, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const departmentId = typeof body.departmentId === "string" ? body.departmentId : "";
  if (!title || title.length > MAX_TITLE_CHARS) return json(400, { error: "invalid_title" });
  if (!text) return json(400, { error: "text_required" });
  if (text.split(/\s+/).length > deps.MAX_UPLOAD_WORDS) return json(400, { error: "text_too_long" });

  const departments = await loadWorkspaceDepartments(env, member.workspaceId);

  // Πρέπει να έχεις δικαίωμα εγγραφής ΚΑΙ στο τμήμα-προορισμό. Έτσι ένας editor δεν
  // μπορεί ούτε να δημιουργήσει έγγραφο σε ξένο τμήμα ούτε να "μεταφέρει" δικό του εκεί.
  if (!canWriteDepartment(member, departments, departmentId)) return json(403, { error: "forbidden" });

  let existing = null;
  if (existingId) {
    if (!DOC_ID_RE.test(existingId)) return json(404, { error: "not_found" });
    existing = await readDoc(env, member.workspaceId, existingId);
    if (!existing) return json(404, { error: "not_found" });
    // Και το ΥΠΑΡΧΟΝ τμήμα του εγγράφου πρέπει να είναι εγγράψιμο για τον χρήστη.
    if (!canWriteDepartment(member, departments, existing.departmentId)) return json(403, { error: "forbidden" });
    // Τα εκκρεμή updates ενός εγγράφου ακολουθούν το τμήμα του. Για να μη μείνουν vectors με λάθος
    // τμήμα (διαρροή), δεν αλλάζει τμήμα όσο υπάρχουν εκκρεμή updates.
    if (existing.departmentId !== departmentId) {
      const pending = await pendingUpdatesForDocument(env, member.workspaceId, existingId);
      if (pending.length) return json(409, { error: "has_pending_updates" });
    }
  }

  const id = existingId || `doc-${deps.randomHex(8)}`;
  const saved = await persistDocument(env, deps, member, { id, title, text, departmentId, existing });
  if (!saved.ok) return json(saved.status, { error: saved.error });

  await recordAudit(env, member, existing ? "document_updated" : "document_created", id, {
    title: title.slice(0, 80), departmentId, version: saved.version,
  });
  await afterDocumentSaved(rc, { docId: id, title, text, vectors: saved.vectors });

  return json(existing ? 200 : 201, {
    id, version: saved.version, chunkCount: saved.chunkCount, contradictionCheck: "started",
  });
}

// ------------------------------------------------------ DELETE /team/documents/{id}
export async function handleDeleteDocument(rc, id) {
  const { env, member } = rc;
  const doc = await readDoc(env, member.workspaceId, id);
  if (!doc) return json(404, { error: "not_found" });
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  if (!canWriteDepartment(member, departments, doc.departmentId)) return json(403, { error: "forbidden" });

  const ids = [];
  for (let i = 0; i < (doc.chunkCount || 0); i++) ids.push(`${id}-chunk-${i}`);
  if (ids.length) await env.VECTORIZE.deleteByIds(ids);
  await rejectUpdatesOfDeletedDocument(env, member.workspaceId, id, member.id);
  await resolveContradictionsForDeletedDoc(env, member.workspaceId, id, member.id);
  await env.DOCUMENT_REGISTRY.delete(docKey(member.workspaceId, id));
  await recordAudit(env, member, "document_deleted", id, { title: String(doc.title).slice(0, 80) });
  return json(200, { ok: true });
}

