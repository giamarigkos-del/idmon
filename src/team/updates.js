// Section W (Φέτα 3): updates (συμπληρώματα) πάνω σε βασικό έγγραφο, με ενσωμάτωση ΠΑΝΤΑ με έγκριση.
//
// Το πρόβλημα που λύνει: τα updates γράφονται συχνά σε ξεχωριστή καρτέλα "εκτός ροής" και
// κανείς δεν ξέρει αν ισχύουν ή αν έχουν ενσωματωθεί. Εδώ:
//   * ένα update δένεται με το βασικό έγγραφο και ΑΜΕΣΩΣ γίνεται αναζητήσιμο (ξεχωριστά vectors με
//     τη σήμανση "πρόσφατη ενημέρωση" και την ΙΔΙΑ ομάδα ακροατηρίου με το έγγραφο), ώστε ο βοηθός να το
//     χρησιμοποιεί και να υπερισχύει του παλιού κειμένου σε περίπτωση διαφοράς,
//   * οι υπάλληλοι το βλέπουν στο "Τι άλλαξε πρόσφατα" και μέσα στο έγγραφο,
//   * το σύστημα ΠΡΟΤΕΙΝΕΙ ξαναγραμμένο κείμενο, αλλά ο editor το βλέπει, το διορθώνει αν θέλει και το
//     εγκρίνει. Τίποτα δεν εφαρμόζεται μόνο του (απόφαση 30 Σεπ 2026).

import { json, loadWorkspaceDepartments } from "./auth.js";
import { canWriteDepartment } from "./access.js";
import { DOC_ID_RE, UPDATE_PREFIX, deleteUpdateVectors, departmentName, listDocIndex, normalizeText, persistDocument, readDoc } from "./store.js";
import { recordAudit } from "./audit.js";
import { afterDocumentSaved } from "./contradictions.js";

const MAX_UPDATE_CHARS = 4000;
const MAX_PROPOSAL_RATIO = 3; // η πρόταση δεν πρέπει να είναι υπερβολικά μεγαλύτερη ή μικρότερη από το αρχικό

function mergePrompt(baseTitle, baseText, updateText) {
  return [
    "Σου δίνεται το κείμενο ενός εσωτερικού εγγράφου μιας εταιρείας και μια ΕΝΗΜΕΡΩΣΗ που πρέπει να ενσωματωθεί σε αυτό.",
    "Ξαναγράψε ολόκληρο το κείμενο του εγγράφου ενσωματώνοντας την ενημέρωση.",
    "Κανόνες: κράτα ΑΚΡΙΒΩΣ όπως είναι ό,τι δεν επηρεάζεται. Άλλαξε ή πρόσθεσε ΜΟΝΟ ό,τι προκύπτει από την ενημέρωση. Μην προσθέσεις τίποτα άλλο και μην σβήσεις άσχετα. Κράτα τη γλώσσα, το ύφος και τη μορφή (παραγράφους, λίστες). Το κείμενο του εγγράφου είναι σε Markdown: κράτα ΑΚΡΙΒΩΣ τη σύνταξή του (τίτλοι με #, λίστες, πίνακες, **έντονα**, *πλάγια*, [συνδέσμους](διεύθυνση), εικόνες ![περιγραφή](διεύθυνση)) και μην προσθέσεις HTML.",
    "Επίστρεψε ΜΟΝΟ το νέο πλήρες κείμενο του εγγράφου, χωρίς σχόλια, χωρίς εισαγωγή και χωρίς markdown code fences.",
    "",
    `ΕΓΓΡΑΦΟ: «${baseTitle}»`,
    baseText,
    "",
    "ΕΝΗΜΕΡΩΣΗ:",
    updateText,
  ].join("\n");
}

function cleanProposal(raw) {
  return String(raw || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
}

// Το LLM προσθέτει συχνά τον τίτλο του εγγράφου σαν πρώτη γραμμή. Αφαιρείται, εκτός αν το ίδιο το έγγραφο
// ξεκινά ήδη με τη γραμμή του τίτλου (τότε είναι νόμιμο περιεχόμενο).
function stripLeadingTitle(proposed, title, original) {
  const nl = proposed.indexOf("\n");
  if (nl < 0) return proposed;
  const clean = (s) => normalizeText(String(s).replace(/[«»"'“”#*_]/g, ""));
  if (clean(proposed.slice(0, nl)) !== clean(title)) return proposed;
  if (clean(String(original).split("\n")[0]) === clean(title)) return proposed;
  return proposed.slice(nl + 1).replace(/^\s+/, "");
}

async function loadPendingUpdate(env, member, id) {
  const row = await env.DB.prepare("SELECT * FROM team_updates WHERE id = ? AND workspace_id = ?")
    .bind(id, member.workspaceId).first();
  if (!row || row.status !== "pending") return { error: "not_found" };
  const doc = await readDoc(env, member.workspaceId, row.document_id);
  if (!doc) return { error: "not_found" };
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  if (!canWriteDepartment(member, departments, doc.departmentId)) return { error: "forbidden" };
  return { row, doc, departments };
}

// ------------------------------------------------------------- POST /team/updates
export async function handleCreateUpdate(request, rc) {
  const { env, deps, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!DOC_ID_RE.test(documentId)) return json(404, { error: "not_found" });
  if (!text || text.length > MAX_UPDATE_CHARS) return json(400, { error: "invalid_text" });

  const doc = await readDoc(env, member.workspaceId, documentId);
  if (!doc) return json(404, { error: "not_found" });
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  if (!canWriteDepartment(member, departments, doc.departmentId)) return json(403, { error: "forbidden" });

  // Πρώτα τα embeddings: αν αποτύχουν, δεν δημιουργείται τίποτα.
  const chunks = deps.chunkText(text);
  const embeddings = [];
  try {
    for (const chunk of chunks) embeddings.push(await deps.getEmbedding(chunk, env.GEMINI_API_KEY));
  } catch {
    return json(503, { error: "ai_unavailable" });
  }

  const now = new Date().toISOString();
  const ins = await env.DB.prepare(
    "INSERT INTO team_updates (workspace_id, document_id, text, status, chunk_count, created_by, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)"
  ).bind(member.workspaceId, documentId, text, chunks.length, member.id, now).run();
  const updateId = ins.meta.last_row_id;

  await env.VECTORIZE.upsert(
    chunks.map((chunk, i) => ({
      id: `upd-${updateId}-chunk-${i}`,
      values: embeddings[i],
      namespace: member.workspaceId,
      metadata: {
        documentId,
        chunkIndex: i,
        text: UPDATE_PREFIX + chunk,
        // Ίδια ομάδα με τα vectors του εγγράφου (ιδιοκτήτης ή ομάδα ακροατηρίου): ο βοηθός το βρίσκει όσοι διαβάζουν το έγγραφο.
        department_id: doc.audienceGroupId || doc.departmentId,
        kind: "update",
        updateId,
      },
    }))
  );
  await recordAudit(env, member, "update_created", documentId, { updateId });
  return json(201, { id: updateId });
}

// ------------------------------------------------- POST /team/updates/{id}/propose
export async function handleProposeMerge(rc, id) {
  const { env, deps, member } = rc;
  const found = await loadPendingUpdate(env, member, id);
  if (found.error === "forbidden") return json(403, { error: "forbidden" });
  if (found.error) return json(404, { error: "not_found" });
  const { row, doc } = found;

  let proposed;
  try {
    proposed = stripLeadingTitle(cleanProposal(await deps.askGeminiOnly(mergePrompt(doc.title, doc.fullText, row.text), env)), doc.title, doc.fullText);
  } catch {
    return json(503, { error: "ai_unavailable" });
  }
  const minLen = Math.floor(doc.fullText.length / MAX_PROPOSAL_RATIO);
  const maxLen = (doc.fullText.length + row.text.length) * MAX_PROPOSAL_RATIO;
  if (!proposed || proposed.length < minLen || proposed.length > maxLen) {
    return json(502, { error: "bad_proposal" });
  }
  await env.DB.prepare("UPDATE team_updates SET proposed_text = ? WHERE id = ?").bind(proposed, id).run();
  await recordAudit(env, member, "update_proposal_generated", doc.id, { updateId: id });
  return json(200, { baseText: doc.fullText, proposedText: proposed });
}

// -------------------------------------------------- POST /team/updates/{id}/apply
// Ο editor στέλνει το τελικό κείμενο που ΕΓΚΡΙΝΕΙ (την πρόταση ή τη δική του διόρθωση).
// Χωρίς ρητό κείμενο δεν εφαρμόζεται τίποτα.
export async function handleApplyUpdate(request, rc, id) {
  const { env, deps, member } = rc;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json(400, { error: "text_required" });
  if (text.split(/\s+/).length > deps.MAX_UPLOAD_WORDS) return json(400, { error: "text_too_long" });

  const found = await loadPendingUpdate(env, member, id);
  if (found.error === "forbidden") return json(403, { error: "forbidden" });
  if (found.error) return json(404, { error: "not_found" });
  const { row, doc } = found;

  const saved = await persistDocument(env, deps, member, {
    id: doc.id, title: doc.title, text, departmentId: doc.departmentId, existing: doc,
  });
  if (!saved.ok) return json(saved.status, { error: saved.error });

  await env.DB.prepare(
    "UPDATE team_updates SET status = 'applied', resolved_by = ?, resolved_at = ? WHERE id = ?"
  ).bind(member.id, new Date().toISOString(), id).run();
  await deleteUpdateVectors(env, id, row.chunk_count);
  await recordAudit(env, member, "update_applied", doc.id, { updateId: id, version: saved.version });

  await afterDocumentSaved(rc, { docId: doc.id, title: doc.title, text, vectors: saved.vectors });
  return json(200, { ok: true, version: saved.version });
}

// -------------------------------------------------- POST /team/updates/{id}/reject
export async function handleRejectUpdate(rc, id) {
  const { env, member } = rc;
  const found = await loadPendingUpdate(env, member, id);
  if (found.error === "forbidden") return json(403, { error: "forbidden" });
  if (found.error) return json(404, { error: "not_found" });
  await env.DB.prepare(
    "UPDATE team_updates SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ?"
  ).bind(member.id, new Date().toISOString(), id).run();
  await deleteUpdateVectors(env, id, found.row.chunk_count);
  await recordAudit(env, member, "update_rejected", found.doc.id, { updateId: id });
  return json(200, { ok: true });
}

// ------------------------------------------ χρήση από άλλα αρχεία (διαγραφή εγγράφου, λίστες)
export async function pendingUpdatesForDocument(env, workspaceId, documentId) {
  const res = await env.DB.prepare(
    "SELECT id, text, created_at, chunk_count FROM team_updates WHERE workspace_id = ? AND document_id = ? AND status = 'pending' ORDER BY id"
  ).bind(workspaceId, documentId).all();
  return (res && res.results) || [];
}

// Όταν διαγράφεται ένα έγγραφο, τα εκκρεμή updates του απορρίπτονται μαζί με τα vectors τους.
export async function rejectUpdatesOfDeletedDocument(env, workspaceId, documentId, resolverId) {
  const pending = await pendingUpdatesForDocument(env, workspaceId, documentId);
  for (const u of pending) {
    await deleteUpdateVectors(env, u.id, u.chunk_count);
    await env.DB.prepare("UPDATE team_updates SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ?")
      .bind(resolverId === undefined ? null : resolverId, new Date().toISOString(), u.id).run();
  }
}

// Εκκρεμή updates που μπορεί να ενσωματώσει το μέλος (για τα εισερχόμενα).
export async function listUpdatesForInbox(env, member) {
  const res = await env.DB.prepare(
    "SELECT id, document_id, text, proposed_text, created_at FROM team_updates WHERE workspace_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 100"
  ).bind(member.workspaceId).all();
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const docIndex = new Map((await listDocIndex(env, member.workspaceId)).map((d) => [d.id, d]));
  const out = [];
  for (const r of (res && res.results) || []) {
    const entry = docIndex.get(r.document_id);
    if (!entry || !canWriteDepartment(member, departments, entry.departmentId)) continue;
    out.push({
      id: r.id,
      documentId: r.document_id,
      documentTitle: entry.title,
      departmentName: departmentName(departments, entry.departmentId),
      text: r.text,
      createdAt: r.created_at,
      hasProposal: !!r.proposed_text,
    });
  }
  return out;
}