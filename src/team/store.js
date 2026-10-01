// src\team\store.js
// Section W: κοινός κώδικας αποθήκευσης εγγράφων ομάδων (KV + Vectorize). Το έχουν όλα τα
// υπόλοιπα αρχεία του src/team/ (έγγραφα, updates, αντιφάσεις), ώστε να μην εισάγουν το ένα το άλλο.
//
// Τα έγγραφα ζουν στο D1 (πίνακας team_documents), τελείως ξεχωριστά από τα έγγραφα του SMB (KV, πρόθεμα session:).
// Το πρόθεμα team:{workspace}:doc:{id} του KV είναι μόνο για τη μεταφορά των παλιών εγγράφων.
// Το τμήμα ενός εγγράφου γράφεται (α) μέσα στο έγγραφο, (β) ως metadata του KV key (γρήγορη λίστα
// χωρίς ανάγνωση κάθε εγγράφου) και (γ) ως department_id στα metadata κάθε vector (φίλτρο Vectorize).

import { COMPANY_WIDE } from "./access.js";

export const DOC_ID_RE = /^doc-[a-f0-9]{16}$/;
export const docKey = (workspaceId, id) => `team:${workspaceId}:doc:${id}`;
export const docPrefix = (workspaceId) => `team:${workspaceId}:doc:`;

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

// ΕΓΓΡΑΦΑ ΣΤΟ D1 (άμεσα συνεπές). Παλιότερα ζούσαν στο KV, που είναι "τελικά συνεπές" (μια αλλαγή μπορεί να χρειαστεί
// ως ένα λεπτό για να φανεί). Για δικαιώματα πρόσβασης (εμπιστευτικό, διαγραφή, μεταφορά) αυτό ήταν παράθυρο ασφάλειας.
// Το KV χρησιμοποιείται πλέον μόνο για βραχύβια δεδομένα (login tokens, μετρητές, αναπάντητες ερωτήσεις).

const migratedWorkspaces = new Set(); // ανά isolate: ένας οργανισμός ελέγχεται για παλιά έγγραφα μία φορά
export function resetMigrationCache() {
  migratedWorkspaces.clear();
}

function rowToDoc(r) {
  return {
    id: r.id,
    title: r.title,
    fullText: r.full_text,
    departmentId: r.department_id,
    hidden: !!r.hidden,
    status: r.status,
    version: r.version,
    chunkCount: r.chunk_count,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

async function insertDocIfMissing(env, workspaceId, doc) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO team_documents
       (id, workspace_id, title, full_text, department_id, hidden, status, version, chunk_count, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    doc.id, workspaceId, String(doc.title || ""), String(doc.fullText || ""), String(doc.departmentId || ""), doc.hidden ? 1 : 0,
    doc.status || "published", doc.version || 1, doc.chunkCount || 0,
    doc.createdBy === undefined ? null : doc.createdBy, doc.createdAt || now,
    doc.updatedBy === undefined ? null : doc.updatedBy, doc.updatedAt || now
  ).run();
}

// Αντιγράφει τα παλιά έγγραφα του οργανισμού από το KV στο D1 και τα σβήνει από το KV. Ασφαλές να ξανατρέξει.
async function migrateLegacyDocs(env, workspaceId) {
  const prefix = docPrefix(workspaceId);
  const keys = await listAllKeys(env, prefix);
  for (const k of keys) {
    const id = k.name.slice(prefix.length);
    if (!DOC_ID_RE.test(id)) continue;
    const raw = await env.DOCUMENT_REGISTRY.get(k.name);
    if (!raw) continue;
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }
    await insertDocIfMissing(env, workspaceId, { ...doc, id });
    await env.DOCUMENT_REGISTRY.delete(k.name);
  }
}

export async function ensureDocsMigrated(env, workspaceId) {
  if (migratedWorkspaces.has(workspaceId)) return;
  const row = await env.DB.prepare("SELECT docs_migrated_at FROM team_meta WHERE workspace_id = ?").bind(workspaceId).first();
  if (!row || !row.docs_migrated_at) {
    await migrateLegacyDocs(env, workspaceId);
    await env.DB.prepare(
      "INSERT INTO team_meta (workspace_id, docs_migrated_at) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET docs_migrated_at = excluded.docs_migrated_at"
    ).bind(workspaceId, new Date().toISOString()).run();
  }
  migratedWorkspaces.add(workspaceId);
}

// Όλα τα έγγραφα του workspace (χωρίς το κείμενο).
export async function listDocIndex(env, workspaceId) {
  await ensureDocsMigrated(env, workspaceId);
  const res = await env.DB.prepare(
    "SELECT id, title, department_id, updated_at, hidden FROM team_documents WHERE workspace_id = ?"
  ).bind(workspaceId).all();
  return ((res && res.results) || []).map((r) => ({
    id: r.id,
    title: r.title,
    departmentId: r.department_id,
    updatedAt: r.updated_at || null,
    hidden: !!r.hidden,
  }));
}

// Δημιουργία ή ενημέρωση εγγράφου (άμεσα ορατή σε κάθε επόμενο αίτημα).
export async function writeDocRecord(env, workspaceId, doc) {
  await env.DB.prepare(
    `INSERT INTO team_documents
       (id, workspace_id, title, full_text, department_id, hidden, status, version, chunk_count, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, id) DO UPDATE SET
       title = excluded.title, full_text = excluded.full_text, department_id = excluded.department_id, hidden = excluded.hidden,
       status = excluded.status, version = excluded.version, chunk_count = excluded.chunk_count,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(
    doc.id, workspaceId, String(doc.title), String(doc.fullText), String(doc.departmentId), doc.hidden ? 1 : 0,
    doc.status || "published", doc.version || 1, doc.chunkCount || 0,
    doc.createdBy === undefined ? null : doc.createdBy, doc.createdAt,
    doc.updatedBy === undefined ? null : doc.updatedBy, doc.updatedAt
  ).run();
}

export async function deleteDocRecord(env, workspaceId, id) {
  await env.DB.prepare("DELETE FROM team_documents WHERE workspace_id = ? AND id = ?").bind(workspaceId, id).run();
}

export async function readDoc(env, workspaceId, id) {
  if (!DOC_ID_RE.test(id)) return null;
  await ensureDocsMigrated(env, workspaceId);
  const row = await env.DB.prepare("SELECT * FROM team_documents WHERE workspace_id = ? AND id = ?").bind(workspaceId, id).first();
  if (row) return rowToDoc(row);
  // Δίχτυ ασφαλείας: παλιό έγγραφο που το KV δεν είχε επιστρέψει στη λίστα. Μεταφέρεται εδώ.
  const raw = await env.DOCUMENT_REGISTRY.get(docKey(workspaceId, id));
  if (!raw) return null;
  try {
    const doc = { ...JSON.parse(raw), id };
    await insertDocIfMissing(env, workspaceId, doc);
    await env.DOCUMENT_REGISTRY.delete(docKey(workspaceId, id));
    const migrated = await env.DB.prepare("SELECT * FROM team_documents WHERE workspace_id = ? AND id = ?").bind(workspaceId, id).first();
    return migrated ? rowToDoc(migrated) : null;
  } catch {
    return null;
  }
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