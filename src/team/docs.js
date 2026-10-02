// src\team\docs.js
// Section W: έγγραφα ομάδων (λίστα, ανάγνωση, δημιουργία/επεξεργασία, διαγραφή), με δικαιώματα ανά ρόλο και
// τμήμα (βλ. access.js). Η αποθήκευση εγγράφου (KV + Vectorize) ζει στο store.js.
//
// Κάθε έγγραφο έχει ένα project-ΙΔΙΟΚΤΗΤΗ (ή COMPANY_WIDE = "_all" για όλη την εταιρεία) και προαιρετικά ΑΚΡΟΑΤΗΡΙΟ: άλλα projects που το
// διαβάζουν (audienceProjectIds, χωρίς τον ιδιοκτήτη, μέχρι MAX_AUDIENCE_PROJECTS συνολικά). Άμεση δημοσίευση.
// Το Vectorize επιτρέπει μία τιμή string ανά metadata πεδίο (βλ. store.js: ομάδα ακροατηρίου).

import { json, loadWorkspaceDepartments } from "./auth.js";
import { COMPANY_WIDE, INTERNAL_WALL, MAX_AUDIENCE_PROJECTS, canReadDocument, canWriteDepartment, scopeMemberToWall, wallOf } from "./access.js";
import {
  DOC_ID_RE, audienceAvailable, deleteDocRecord, departmentName, listDocIndex, pendingUpdateSummary, persistDocument, readDoc,
} from "./store.js";
import { recordAudit } from "./audit.js";
import { afterDocumentSaved, resolveContradictionsForDeletedDoc } from "./contradictions.js";
import { pendingUpdatesForDocument, rejectUpdatesOfDeletedDocument } from "./updates.js";
import { closeFeedbackForDeletedDoc } from "./feedback.js";

const MAX_TITLE_CHARS = 200;

// ------------------------------------------------------------------ GET /team/documents
export async function handleListDocuments(env, member, wallId) {
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const index = await listDocIndex(env, member.workspaceId);
  const pending = await pendingUpdateSummary(env, member.workspaceId);
  // Προαιρετικά: λίστα για έναν μόνο πελάτη (τοίχο), όπως ψάχνει και ο βοηθός. Μόνο στο call center· άγνωστος ή ξένος τοίχος = 403.
  let reader = member;
  if (wallId && member.profile === "multi_client") {
    reader = scopeMemberToWall(member, departments, wallId);
    if (!reader) return json(403, { error: "client_forbidden" });
  }
  const docs = [];
  for (const d of index) {
    if (!canReadDocument(reader, departments, d.departmentId, d.hidden, d.audienceProjectIds)) continue;
    const p = pending.get(d.id);
    const dept = departments.find((x) => x.id === d.departmentId);
    docs.push({
      id: d.id,
      title: d.title,
      departmentId: d.departmentId,
      clientId: dept ? dept.clientId : null,
      departmentName: departmentName(departments, d.departmentId),
      updatedAt: d.updatedAt,
      editable: canWriteDepartment(member, departments, d.departmentId),
      hidden: d.hidden,
      audienceCount: d.audienceProjectIds.length,
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
  if (!canReadDocument(member, departments, doc.departmentId, doc.hidden, doc.audienceProjectIds)) return json(404, { error: "not_found" });
  const pending = await pendingUpdatesForDocument(env, member.workspaceId, id);
  // Ακροατήριο: ο admin βλέπει όλα τα projects. Οι άλλοι βλέπουν ονόματα ΜΟΝΟ για projects όπου είναι μέλη (σε ένα BPO το όνομα ενός
  // project μπορεί να είναι όνομα πελάτη)· για τα υπόλοιπα φαίνεται μόνο το πλήθος.
  const mine = member.role === "admin" ? null : new Set(member.departmentIds || []);
  const visibleAudience = doc.audienceProjectIds.filter((p) => mine === null || mine.has(p));
  return json(200, {
    id,
    title: doc.title,
    fullText: doc.fullText,
    departmentId: doc.departmentId,
    departmentName: departmentName(departments, doc.departmentId),
    version: doc.version,
    updatedAt: doc.updatedAt,
    editable: canWriteDepartment(member, departments, doc.departmentId),
    hidden: !!doc.hidden,
    audience: {
      projects: visibleAudience.map((p) => ({ id: p, name: departmentName(departments, p) })),
      hiddenCount: doc.audienceProjectIds.length - visibleAudience.length,
    },
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
  // audienceProjectIds: τα ΑΛΛΑ projects που διαβάζουν το έγγραφο. Απουσία πεδίου = το ακροατήριο μένει όπως είναι.
  let audienceRequest;
  if (body.audienceProjectIds !== undefined) {
    if (!Array.isArray(body.audienceProjectIds) || body.audienceProjectIds.length > 50 || body.audienceProjectIds.some((p) => typeof p !== "string")) {
      return json(400, { error: "invalid_audience" });
    }
    audienceRequest = [...new Set(body.audienceProjectIds)];
  }
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
    // Ένα εμπιστευτικό έγγραφο δεν μεταφέρεται σε "όλη την εταιρεία" (θα γινόταν ορατό σε όλους μέσω αναζήτησης).
    if (existing.hidden && departmentId === COMPANY_WIDE) return json(409, { error: "hidden_cannot_be_company_wide" });
    // ΤΟΙΧΟΣ (call center): ένα έγγραφο δεν μετακινείται σε project άλλου πελάτη ούτε στα εσωτερικά ή στο "όλη η εταιρεία" (θα περνούσε από τον
    // τοίχο). Αντιγράφεται ως νέο έγγραφο στον προορισμό. Μόνο από "όλη η εταιρεία" προς ένα project (στένεμα) επιτρέπεται.
    if (member.profile === "multi_client" && existing.departmentId !== departmentId && existing.departmentId !== COMPANY_WIDE) {
      const wallOfDep = (id) => (id === COMPANY_WIDE ? "_all" : wallOf(departments, id));
      if (wallOfDep(existing.departmentId) !== wallOfDep(departmentId)) return json(409, { error: "cross_client_move" });
    }
  }

  // ---- ακροατήριο
  let finalExtras; // undefined = αμετάβλητο
  if (audienceRequest !== undefined) {
    if (departmentId === COMPANY_WIDE) {
      if (audienceRequest.length) return json(400, { error: "audience_not_allowed" }); // το εταιρικό το βλέπουν ήδη όλοι
      finalExtras = [];
    } else {
      const known = new Map(departments.map((d) => [d.id, d]));
      if (audienceRequest.some((p) => p === COMPANY_WIDE || !known.has(p))) return json(400, { error: "invalid_audience" });
      // Ο editor βάζει στο ακροατήριο ΜΟΝΟ projects όπου είναι ο ίδιος μέλος (δεν γνωρίζει ούτε τα ονόματα των άλλων).
      const mine = member.role === "admin" ? null : new Set(member.departmentIds || []);
      if (mine && audienceRequest.some((p) => !mine.has(p))) return json(403, { error: "audience_forbidden" });
      // Ό,τι έχει βάλει ο admin και ο editor δεν βλέπει, παραμένει (ο editor δεν μπορεί να το αφαιρέσει ούτε να το δει).
      const preserved = mine && existing ? existing.audienceProjectIds.filter((p) => !mine.has(p)) : [];
      finalExtras = [...new Set([...audienceRequest.filter((p) => p !== departmentId), ...preserved])].sort();
      if (finalExtras.length + 1 > MAX_AUDIENCE_PROJECTS) return json(400, { error: "audience_too_large" });
      const owner = known.get(departmentId);
      // ΤΟΙΧΟΣ: το ακροατήριο μένει μέσα στον ίδιο πελάτη. Ό,τι ζητήθηκε από άλλον τοίχο απορρίπτεται, ρητά (όχι σιωπηλά). Παλιές εγγραφές
      // άλλου τοίχου που μένουν από πριν αφαιρούνται (δεν ίσχυαν ήδη στην ανάγνωση).
      const ownerWall = owner ? owner.clientId || INTERNAL_WALL : undefined;
      if (audienceRequest.some((p) => (known.get(p).clientId || INTERNAL_WALL) !== ownerWall)) return json(400, { error: "audience_cross_client" });
      finalExtras = finalExtras.filter((p) => (known.get(p).clientId || INTERNAL_WALL) === ownerWall);
      // Εμπιστευτικό έγγραφο και έγγραφο κρυφού project δεν έχουν ακροατήριο (θα διέρρεαν σε άλλα projects).
      if (finalExtras.length && ((existing && existing.hidden) || (owner && owner.hidden))) return json(409, { error: "hidden_cannot_have_audience" });
    }
    // Χωρίς το migration 0015 δεν αποθηκεύεται ακροατήριο (ούτε αφαιρείται: δεν υπάρχει).
    const had = !!(existing && existing.audienceProjectIds.length);
    if ((finalExtras.length || had) && !(await audienceAvailable(env))) return json(503, { error: "audience_unavailable" });
  }

  if (existing) {
    // Τα εκκρεμή updates ενός εγγράφου ακολουθούν το τμήμα ΚΑΙ το ακροατήριό του. Για να μη μείνουν vectors με λάθος
    // ομάδα (διαρροή), δεν αλλάζει τμήμα ή ακροατήριο όσο υπάρχουν εκκρεμή updates.
    const audienceChanged = finalExtras !== undefined && JSON.stringify(finalExtras) !== JSON.stringify(existing.audienceProjectIds);
    if (existing.departmentId !== departmentId || audienceChanged) {
      const pending = await pendingUpdatesForDocument(env, member.workspaceId, existingId);
      if (pending.length) return json(409, { error: "has_pending_updates" });
    }
  }

  const id = existingId || `doc-${deps.randomHex(8)}`;
  const saved = await persistDocument(env, deps, member, { id, title, text, departmentId, existing, audienceProjectIds: finalExtras });
  if (!saved.ok) return json(saved.status, { error: saved.error });

  await recordAudit(env, member, existing ? "document_updated" : "document_created", id, {
    title: title.slice(0, 80), departmentId, version: saved.version, audience: saved.doc.audienceProjectIds.length,
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
  await closeFeedbackForDeletedDoc(env, member.workspaceId, id, member.id);
  await resolveContradictionsForDeletedDoc(env, member.workspaceId, id, member.id);
  await deleteDocRecord(env, member.workspaceId, id);
  await recordAudit(env, member, "document_deleted", id, { title: String(doc.title).slice(0, 80) });
  return json(200, { ok: true });
}