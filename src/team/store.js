// src\team\store.js
// Section W: κοινός κώδικας αποθήκευσης εγγράφων ομάδων (KV + Vectorize). Το έχουν όλα τα
// υπόλοιπα αρχεία του src/team/ (έγγραφα, updates, αντιφάσεις), ώστε να μην εισάγουν το ένα το άλλο.
//
// Τα έγγραφα ζουν στο D1 (πίνακας team_documents), τελείως ξεχωριστά από τα έγγραφα του SMB (KV, πρόθεμα session:).
// Το πρόθεμα team:{workspace}:doc:{id} του KV είναι μόνο για τη μεταφορά των παλιών εγγράφων.
// Το τμήμα ενός εγγράφου γράφεται (α) μέσα στο έγγραφο, (β) ως metadata του KV key (γρήγορη λίστα
// χωρίς ανάγνωση κάθε εγγράφου) και (γ) ως department_id στα metadata κάθε vector (φίλτρο Vectorize).

import { COMPANY_WIDE } from "./access.js";
import { sha256Hex } from "./auth.js";

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
    audienceGroupId: null,
    audienceProjectIds: [],
  };
}

// ---------------------------------------------------------------- ακροατήριο εγγράφου (migration 0015)
// Ένα έγγραφο έχει ΙΔΙΟΚΤΗΤΗ (department_id) και, προαιρετικά, ΑΛΛΑ projects που το διαβάζουν (audienceProjectIds, χωρίς τον ιδιοκτήτη).
// audienceGroupId: το id που γράφεται στο department_id των vectors (id του project αν δεν υπάρχει ακροατήριο, αλλιώς "ag-<16 hex>").
const isNoTable = (err) => /no such table/i.test(String((err && err.message) || err));

// Το id των vectors ενός εγγράφου. Μόνο ιδιοκτήτης: το id του project (όπως πάντα). Αλλιώς "ag-" + 16 hex από το σύνολο των projects.
export async function audienceGroupId(workspaceId, ownerId, extraProjectIds) {
  const all = [...new Set([ownerId, ...(extraProjectIds || [])])].sort();
  if (all.length <= 1) return ownerId;
  return "ag-" + (await sha256Hex(`${workspaceId}|${all.join(",")}`)).slice(0, 16);
}

// Υπάρχει ο πίνακας ακροατηρίου (migration 0015); Άλλο σφάλμα βάσης ξαναπετιέται (fail closed).
export async function audienceAvailable(env) {
  try {
    await env.DB.prepare("SELECT 1 AS x FROM team_document_audience LIMIT 1").first();
    return true;
  } catch (err) {
    if (isNoTable(err)) return false;
    throw err;
  }
}

// Map(documentId -> { groupId, projectIds }) όπου projectIds = ΟΛΑ τα projects της ομάδας (και ο ιδιοκτήτης). docIds === null: όλα.
// Αν λείπει το migration: κενός χάρτης (ισχύει το μοντέλο "μόνο ο ιδιοκτήτης").
async function readAudienceMap(env, workspaceId, docIds) {
  const map = new Map();
  try {
    const base = "SELECT da.document_id, da.group_id, gp.project_id FROM team_document_audience da JOIN team_audience_group_projects gp ON gp.group_id = da.group_id WHERE da.workspace_id = ?";
    const stmt = docIds === null
      ? env.DB.prepare(base).bind(workspaceId)
      : env.DB.prepare(base + " AND da.document_id IN (SELECT value FROM json_each(?))").bind(workspaceId, JSON.stringify(docIds));
    const res = await stmt.all();
    for (const r of (res && res.results) || []) {
      const e = map.get(r.document_id) || { groupId: r.group_id, projectIds: [] };
      e.projectIds.push(r.project_id);
      map.set(r.document_id, e);
    }
  } catch (err) {
    if (!isNoTable(err)) throw err;
  }
  return map;
}

function attachAudience(doc, entry) {
  doc.audienceGroupId = entry ? entry.groupId : null;
  doc.audienceProjectIds = entry ? entry.projectIds.filter((p) => p !== doc.departmentId).sort() : [];
  return doc;
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
  const audience = await readAudienceMap(env, workspaceId, null);
  return ((res && res.results) || []).map((r) =>
    attachAudience({
      id: r.id,
      title: r.title,
      departmentId: r.department_id,
      updatedAt: r.updated_at || null,
      hidden: !!r.hidden,
    }, audience.get(r.id))
  );
}

// Η εντολή εγγραφής του εγγράφου (δεν εκτελείται εδώ), ώστε να μπορεί να μπει σε batch μαζί με το ακροατήριο.
function docStatement(env, workspaceId, doc) {
  return env.DB.prepare(
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
  );
}

// Δημιουργία ή ενημέρωση εγγράφου (άμεσα ορατή σε κάθε επόμενο αίτημα).
export async function writeDocRecord(env, workspaceId, doc) {
  await docStatement(env, workspaceId, doc).run();
}

// Όλα ή τίποτα όταν υπάρχει batch (πραγματικό D1). Χωρίς batch (ψεύτικο D1 των τεστ) διαδοχικά.
async function runBatch(env, statements) {
  if (typeof env.DB.batch === "function") {
    await env.DB.batch(statements);
    return;
  }
  for (const s of statements) await s.run();
}

// Εγγραφή εγγράφου ΚΑΙ ακροατηρίου σε ένα βήμα. audience = { groupId, projectIds } (projectIds με τον ιδιοκτήτη) ή null = μόνο ιδιοκτήτης.
// hadAudience: το έγγραφο είχε ακροατήριο πριν (άρα η γραμμή του πρέπει να σβηστεί). Χωρίς ακροατήριο και χωρίς προηγούμενο,
// ο πίνακας δεν αγγίζεται καθόλου (δουλεύει και πριν το migration 0015).
export async function writeDocWithAudience(env, workspaceId, doc, audience, hadAudience) {
  const statements = [docStatement(env, workspaceId, doc)];
  if (audience) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO team_audience_groups (id, workspace_id, created_at) VALUES (?, ?, ?)")
        .bind(audience.groupId, workspaceId, doc.updatedAt)
    );
    for (const p of audience.projectIds) {
      statements.push(
        env.DB.prepare("INSERT OR IGNORE INTO team_audience_group_projects (group_id, project_id) VALUES (?, ?)").bind(audience.groupId, p)
      );
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO team_document_audience (workspace_id, document_id, group_id) VALUES (?, ?, ?) ON CONFLICT(workspace_id, document_id) DO UPDATE SET group_id = excluded.group_id"
      ).bind(workspaceId, doc.id, audience.groupId)
    );
  } else if (hadAudience) {
    statements.push(env.DB.prepare("DELETE FROM team_document_audience WHERE workspace_id = ? AND document_id = ?").bind(workspaceId, doc.id));
  }
  await runBatch(env, statements);
}

export async function deleteDocRecord(env, workspaceId, id) {
  await env.DB.prepare("DELETE FROM team_documents WHERE workspace_id = ? AND id = ?").bind(workspaceId, id).run();
}

export async function readDoc(env, workspaceId, id) {
  if (!DOC_ID_RE.test(id)) return null;
  await ensureDocsMigrated(env, workspaceId);
  const row = await env.DB.prepare("SELECT * FROM team_documents WHERE workspace_id = ? AND id = ?").bind(workspaceId, id).first();
  if (row) return attachAudience(rowToDoc(row), (await readAudienceMap(env, workspaceId, [id])).get(id));
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

// Εγγραφή εγγράφου: chunks -> embeddings -> vectors (με department_id = ομάδα ακροατηρίου) -> D1. Πρώτα ΟΛΑ τα
// embeddings και μετά οποιαδήποτε αλλαγή: αν αποτύχει ο πάροχος AI, το υπάρχον έγγραφο μένει όπως ήταν.
// audienceProjectIds: undefined = το ακροατήριο μένει όπως ήταν. Πίνακας = τα ΑΛΛΑ projects που διαβάζουν το έγγραφο (χωρίς τον ιδιοκτήτη).
// Εμπιστευτικό ή εταιρικό έγγραφο δεν έχει ποτέ ακροατήριο. Τα vectors γράφονται πριν τη βάση: η βάση είναι η αυθεντική πηγή, άρα
// ένα vector με "λάθος" ομάδα μπορεί να χαθεί από την αναζήτηση, ποτέ όμως να διαρρεύσει (ο δεύτερος έλεγχος γίνεται στη βάση).
export async function persistDocument(env, deps, member, { id, title, text, departmentId, existing, audienceProjectIds }) {
  const workspaceId = member.workspaceId;
  const hidden = existing ? !!existing.hidden : false;
  let extras = audienceProjectIds === undefined ? (existing ? existing.audienceProjectIds || [] : []) : audienceProjectIds;
  extras = hidden || departmentId === COMPANY_WIDE ? [] : [...new Set(extras)].filter((p) => p !== departmentId).sort();
  const groupId = await audienceGroupId(workspaceId, departmentId, extras);

  const chunks = deps.chunkText(text);
  const vectors = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const values = await deps.getEmbedding(chunks[i], env.GEMINI_API_KEY);
      vectors.push({
        id: `${id}-chunk-${i}`,
        values,
        namespace: workspaceId,
        metadata: { documentId: id, chunkIndex: i, text: chunks[i], department_id: groupId },
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
    hidden,
    fullText: text,
    departmentId,
    status: "published",
    version: existing ? (existing.version || 1) + (textChanged ? 1 : 0) : 1,
    chunkCount: chunks.length,
    createdBy: existing ? existing.createdBy : member.id,
    createdAt: existing ? existing.createdAt : now,
    updatedBy: member.id,
    updatedAt: now,
    audienceGroupId: extras.length ? groupId : null,
    audienceProjectIds: extras,
  };
  await writeDocWithAudience(
    env, workspaceId, doc,
    extras.length ? { groupId, projectIds: [departmentId, ...extras] } : null,
    !!(existing && existing.audienceGroupId)
  );
  return { ok: true, id, version: doc.version, chunkCount: chunks.length, vectors, doc, textChanged, groupId };
}

// ---------------------------------------------------------------- αναζήτηση: ποιες ομάδες ακροατηρίου αφορούν ένα μέλος
// Οι ομάδες που περιέχουν κάποιο project του μέλους ΚΑΙ χρησιμοποιούνται από τουλάχιστον ένα έγγραφο (ώστε το φίλτρο να μένει μικρό).
// Το json_each αποφεύγει το όριο των 100 παραμέτρων του D1. Αν λείπει το migration: καμία ομάδα.
export async function audienceGroupsForMember(env, member) {
  const own = member.departmentIds || [];
  if (!own.length) return [];
  try {
    const res = await env.DB.prepare(
      `SELECT DISTINCT da.group_id FROM team_document_audience da
         JOIN team_audience_group_projects gp ON gp.group_id = da.group_id
        WHERE da.workspace_id = ? AND gp.project_id IN (SELECT value FROM json_each(?))`
    ).bind(member.workspaceId, JSON.stringify(own)).all();
    return ((res && res.results) || []).map((r) => r.group_id);
  } catch (err) {
    if (isNoTable(err)) return [];
    throw err;
  }
}

// Η αυθεντική πληροφορία πρόσβασης για έγγραφα, από τη βάση: Map(documentId -> { departmentId, hidden, audienceProjectIds }).
// Έγγραφο που δεν υπάρχει στη βάση ΔΕΝ μπαίνει στον χάρτη (ο καλών το απορρίπτει: deny by default).
export async function documentAccessInfo(env, workspaceId, docIds) {
  const unique = [...new Set(docIds)];
  const out = new Map();
  if (!unique.length) return out;
  await ensureDocsMigrated(env, workspaceId);
  const rows = await env.DB.prepare(
    "SELECT id, department_id, hidden FROM team_documents WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))"
  ).bind(workspaceId, JSON.stringify(unique)).all();
  for (const r of (rows && rows.results) || []) out.set(r.id, { departmentId: r.department_id, hidden: !!r.hidden, audienceProjectIds: [] });
  const audience = await readAudienceMap(env, workspaceId, unique);
  for (const [docId, entry] of audience) {
    const info = out.get(docId);
    if (info) info.audienceProjectIds = entry.projectIds.filter((p) => p !== info.departmentId).sort();
  }
  return out;
}

// ---------------------------------------------------------------- επαναφορά ακροατηρίου σε "μόνο ιδιοκτήτης"
// Όταν ένα έγγραφο γίνεται εμπιστευτικό ή ένα project γίνεται κρυφό. ΠΡΩΤΑ η βάση (ισχύει αμέσως), ΜΕΤΑ τα vectors (best effort:
// αν αποτύχουν, μένουν με παλιά ομάδα και η αναζήτηση τα χάνει, αλλά ο έλεγχος στη βάση τα αποκλείει, άρα δεν υπάρχει διαρροή).
export async function resetDocumentAudience(env, workspaceId, doc, pendingUpdates) {
  if (!doc.audienceGroupId) return { changed: false, vectorsOk: true };
  await env.DB.prepare("DELETE FROM team_document_audience WHERE workspace_id = ? AND document_id = ?").bind(workspaceId, doc.id).run();
  const ids = [];
  for (let i = 0; i < (doc.chunkCount || 0); i++) ids.push(`${doc.id}-chunk-${i}`);
  for (const u of pendingUpdates || []) for (let i = 0; i < (u.chunk_count || 0); i++) ids.push(`upd-${u.id}-chunk-${i}`);
  return { changed: true, vectorsOk: await rewriteVectorGroup(env, ids, doc.departmentId) };
}

async function rewriteVectorGroup(env, ids, groupId) {
  try {
    if (!ids.length || typeof env.VECTORIZE.getByIds !== "function") return false;
    const found = (await env.VECTORIZE.getByIds(ids)) || [];
    const next = found.map((v) => ({ id: v.id, values: v.values, namespace: v.namespace, metadata: { ...(v.metadata || {}), department_id: groupId } }));
    if (next.length) await env.VECTORIZE.upsert(next);
    return next.length === ids.length;
  } catch {
    return false;
  }
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