// src\team\store.js
// Section W: κοινός κώδικας αποθήκευσης εγγράφων ομάδων (KV + Vectorize). Το έχουν όλα τα
// υπόλοιπα αρχεία του src/team/ (έγγραφα, updates, αντιφάσεις), ώστε να μην εισάγουν το ένα το άλλο.
//
// Αποθήκευση στο KV με ΔΙΚΟ ΤΟΥΣ πρόθεμα (team:{workspace}:doc:{id}), ξεχωριστό από το
// session:{workspace}:doc:{id} των SMB, ώστε κανένα SMB endpoint να μην μπορεί ποτέ να τα φτάσει.
// Το τμήμα ενός εγγράφου γράφεται (α) μέσα στο έγγραφο, (β) ως metadata του KV key (γρήγορη λίστα
// χωρίς ανάγνωση κάθε εγγράφου) και (γ) ως department_id στα metadata κάθε vector (φίλτρο Vectorize).

import { COMPANY_WIDE } from "./access.js";

export const DOC_ID_RE = /^doc-[a-f0-9]{16}$/;
export const docKey = (workspaceId, id) => `team:${workspaceId}:doc:${id}`;
export const docPrefix = (workspaceId) => `team:${workspaceId}:doc:`;
const KV_META_TITLE_CHARS = 120; // το metadata ενός KV key έχει όριο 1024 bytes

export const UPDATE_PREFIX = "[ΠΡΟΣΦΑΤΗ ΕΝΗΜΕΡΩΣΗ, υπερισχύει του βασικού κειμένου σε περίπτωση διαφοράς] ";

export function departmentName(departments, departmentId) {
  if (departmentId === COMPANY_WIDE) return "Όλη η εταιρεία";
  const d = (departments || []).find((x) => x.id === departmentId);
  return d ? d.name : departmentId;
}

// Ίδια κανονικοποίηση παντού για σύγκριση προτάσεων (κενά, πεζά/κεφαλαία).
export function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.DOCUMENT_REGISTRY.list({ prefix, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

// Όλα τα έγγραφα του workspace, από τα metadata των KV keys (χωρίς να διαβαστεί κάθε έγγραφο).
export async function listDocIndex(env, workspaceId) {
  const prefix = docPrefix(workspaceId);
  const keys = await listAllKeys(env, prefix);
  return keys.map((k) => {
    const meta = k.metadata || {};
    return {
      id: k.name.slice(prefix.length),
      title: meta.title || "",
      departmentId: meta.departmentId,
      updatedAt: meta.updatedAt || null,
      hidden: !!meta.hidden,
    };
  });
}

// Γράφει την εγγραφή ενός εγγράφου και τα metadata του KV key (τίτλος, τμήμα, ημερομηνία, εμπιστευτικό).
export async function writeDocRecord(env, workspaceId, doc) {
  const meta = { title: String(doc.title).slice(0, KV_META_TITLE_CHARS), departmentId: doc.departmentId, updatedAt: doc.updatedAt };
  if (doc.hidden) meta.hidden = true;
  await env.DOCUMENT_REGISTRY.put(docKey(workspaceId, doc.id), JSON.stringify(doc), { metadata: meta });
}

export async function readDoc(env, workspaceId, id) {
  if (!DOC_ID_RE.test(id)) return null;
  const raw = await env.DOCUMENT_REGISTRY.get(docKey(workspaceId, id));
  return raw ? JSON.parse(raw) : null;
}

export async function listAllKvKeys(env, prefix) {
  return listAllKeys(env, prefix);
}

// Εγγραφή εγγράφου: chunks -> embeddings -> vectors (με department_id) -> KV. Πρώτα ΟΛΑ τα
// embeddings και μετά οποιαδήποτε αλλαγή: αν αποτύχει ο πάροχος AI, το υπάρχον έγγραφο μένει όπως ήταν.
export async function persistDocument(env, deps, member, { id, title, text, departmentId, existing }) {
  const workspaceId = member.workspaceId;
  const chunks = deps.chunkText(text);
  const vectors = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const values = await deps.getEmbedding(chunks[i], env.GEMINI_API_KEY);
      vectors.push({
        id: `${id}-chunk-${i}`,
        values,
        namespace: workspaceId,
        metadata: { documentId: id, chunkIndex: i, text: chunks[i], department_id: departmentId },
      });
    }
  } catch {
    return { ok: false, status: 503, error: "ai_unavailable" };
  }

  await env.VECTORIZE.upsert(vectors);
  // Διαγραφή μόνο των "περισσευούμενων" παλιών chunks (το νέο κείμενο μπορεί να είναι μικρότερο).
  if (existing && (existing.chunkCount || 0) > chunks.length) {
    const stale = [];
    for (let i = chunks.length; i < existing.chunkCount; i++) stale.push(`${id}-chunk-${i}`);
    if (stale.length) await env.VECTORIZE.deleteByIds(stale);
  }

  const now = new Date().toISOString();
  const textChanged = !existing || existing.fullText !== text;
  const doc = {
    id,
    title,
    hidden: existing ? !!existing.hidden : false,
    fullText: text,
    departmentId,
    status: "published",
    version: existing ? (existing.version || 1) + (textChanged ? 1 : 0) : 1,
    chunkCount: chunks.length,
    createdBy: existing ? existing.createdBy : member.id,
    createdAt: existing ? existing.createdAt : now,
    updatedBy: member.id,
    updatedAt: now,
  };
  await writeDocRecord(env, workspaceId, doc);
  return { ok: true, id, version: doc.version, chunkCount: chunks.length, vectors, doc, textChanged };
}

// Διαγραφή των vectors ενός update.
export async function deleteUpdateVectors(env, updateId, chunkCount) {
  const ids = [];
  for (let i = 0; i < (chunkCount || 0); i++) ids.push(`upd-${updateId}-chunk-${i}`);
  if (ids.length) await env.VECTORIZE.deleteByIds(ids);
}

// Εκκρεμή updates ανά έγγραφο: Map(documentId -> { count, latestAt }).
export async function pendingUpdateSummary(env, workspaceId) {
  const res = await env.DB.prepare(
    "SELECT document_id, COUNT(*) AS c, MAX(created_at) AS latest FROM team_updates WHERE workspace_id = ? AND status = 'pending' GROUP BY document_id"
  ).bind(workspaceId).all();
  const map = new Map();
  for (const r of (res && res.results) || []) map.set(r.document_id, { count: r.c, latestAt: r.latest });
  return map;
}