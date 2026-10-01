// src\team\feedback.js
// Section W: αναφορές υπαλλήλων ("η απάντηση ήταν λάθος / ξεπερασμένη") προς τον editor του τμήματος.
// Κλείνουν τον κύκλο ποιότητας: ο υπάλληλος που βλέπει μια λάθος απάντηση το δηλώνει με ένα κλικ και ο editor το βλέπει
// στα Εισερχόμενα, ομαδοποιημένο ανά έγγραφο. ΔΕΝ αποθηκεύεται ταυτότητα του υπαλλήλου (όπως και στις αναπάντητες ερωτήσεις).
// Οι αναφορές εμφανίζονται μόνο σε editors του τμήματος του εγγράφου και στους admins.

import { json, loadWorkspaceDepartments } from "./auth.js";
import { canReadDocument, canWriteDepartment } from "./access.js";
import { DOC_ID_RE, departmentName, listDocIndex, readDoc } from "./store.js";
import { DEFAULT_DAILY_FEEDBACK, consumeQuota } from "./quota.js";
import { recordAudit } from "./audit.js";

const KINDS = ["wrong", "outdated", "unclear"];
const MAX_NOTE_CHARS = 300;
const MAX_QUESTION_CHARS = 300;

// POST /team/feedback  (κάθε μέλος, για έγγραφο που μπορεί να διαβάσει)
export async function handleCreateFeedback(request, rc) {
  const { env, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  if (!DOC_ID_RE.test(documentId)) return json(404, { error: "not_found" });
  if (!KINDS.includes(body.kind)) return json(400, { error: "invalid_kind" });
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (note.length > MAX_NOTE_CHARS || question.length > MAX_QUESTION_CHARS) return json(400, { error: "too_long" });

  const doc = await readDoc(env, member.workspaceId, documentId);
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  // Ίδια απάντηση με το "δεν υπάρχει": δεν αποκαλύπτεται ότι ένα έγγραφο υπάρχει αν δεν το βλέπεις.
  if (!doc || !canReadDocument(member, departments, doc.departmentId, doc.hidden)) return json(404, { error: "not_found" });

  const limit = parseInt(env.TEAM_DAILY_FEEDBACK_LIMIT, 10) || DEFAULT_DAILY_FEEDBACK;
  const quota = await consumeQuota(env, member.id, "feedback", limit);
  if (!quota.ok) return json(429, { error: "daily_limit" });

  try {
    await env.DB.prepare(
      "INSERT INTO team_feedback (workspace_id, document_id, kind, question, note, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)"
    ).bind(member.workspaceId, documentId, body.kind, question || null, note || null, new Date().toISOString()).run();
  } catch {
    return json(503, { error: "feedback_unavailable" });
  }
  return json(201, { ok: true });
}

// Ανοιχτές αναφορές, ομαδοποιημένες ανά (έγγραφο, είδος), για τα έγγραφα που μπορεί να διορθώσει το μέλος.
export async function listFeedbackFor(env, member) {
  let rows;
  try {
    const res = await env.DB.prepare(
      "SELECT document_id, kind, question, note, created_at FROM team_feedback WHERE workspace_id = ? AND status = 'open' ORDER BY id DESC LIMIT 500"
    ).bind(member.workspaceId).all();
    rows = (res && res.results) || [];
  } catch {
    return []; // ο πίνακας δεν υπάρχει ακόμα
  }
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const docIndex = new Map((await listDocIndex(env, member.workspaceId)).map((d) => [d.id, d]));
  const groups = new Map();
  for (const r of rows) {
    const entry = docIndex.get(r.document_id);
    if (!entry || !canWriteDepartment(member, departments, entry.departmentId)) continue;
    const key = `${r.document_id}|${r.kind}`;
    const g = groups.get(key) || {
      documentId: r.document_id, documentTitle: entry.title, departmentName: departmentName(departments, entry.departmentId),
      kind: r.kind, count: 0, latestAt: r.created_at, notes: [], questions: [],
    };
    g.count++;
    if (r.note && g.notes.length < 3) g.notes.push(r.note);
    if (r.question && g.questions.length < 2 && !g.questions.includes(r.question)) g.questions.push(r.question);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt));
}

// POST /team/inbox/feedback/close  {documentId, kind}
export async function handleCloseFeedback(request, rc) {
  const { env, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!DOC_ID_RE.test(String(body.documentId || "")) || !KINDS.includes(body.kind)) return json(400, { error: "invalid_request" });
  const doc = await readDoc(env, member.workspaceId, body.documentId);
  if (!doc) return json(404, { error: "not_found" });
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  if (!canWriteDepartment(member, departments, doc.departmentId)) return json(403, { error: "forbidden" });
  try {
    await env.DB.prepare(
      "UPDATE team_feedback SET status = 'closed', closed_at = ?, closed_by = ? WHERE workspace_id = ? AND document_id = ? AND kind = ? AND status = 'open'"
    ).bind(new Date().toISOString(), member.id, member.workspaceId, body.documentId, body.kind).run();
  } catch {
    return json(503, { error: "feedback_unavailable" });
  }
  await recordAudit(env, member, "feedback_closed", body.documentId, { kind: body.kind });
  return json(200, { ok: true });
}

// Όταν διαγράφεται ένα έγγραφο, οι αναφορές του κλείνουν.
export async function closeFeedbackForDeletedDoc(env, workspaceId, documentId, resolverId) {
  try {
    await env.DB.prepare(
      "UPDATE team_feedback SET status = 'closed', closed_at = ?, closed_by = ? WHERE workspace_id = ? AND document_id = ? AND status = 'open'"
    ).bind(new Date().toISOString(), resolverId === undefined ? null : resolverId, workspaceId, documentId).run();
  } catch {
    /* ο πίνακας δεν υπάρχει ακόμα */
  }
}