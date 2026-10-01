// Section W (Φέτα 2): αυτόματος έλεγχος αντιφάσεων όταν δημοσιεύεται ή αλλάζει ένα έγγραφο.
//
// Πώς δουλεύει (συντηρητικά, όπως αποφασίστηκε: μόνο ΣΑΦΕΙΣ αντιφάσεις, όπως διαφορετικοί
// αριθμοί, όρια ή προθεσμίες για την ίδια περίπτωση):
//   1. Για τα πρώτα chunks του νέου κειμένου ψάχνουμε στο Vectorize τα πιο όμοια chunks ΟΛΩΝ
//      των τμημάτων (και των κρυφών: η ανίχνευση δεν εξαρτάται από το ποιος δημοσιεύει).
//   2. Για κάθε υποψήφιο έγγραφο, ένα ερώτημα στο LLM με ΑΠΑΙΤΗΣΗ για ακριβείς παραθέσεις.
//   3. Ο ΚΩΔΙΚΑΣ επαληθεύει ότι κάθε παράθεση υπάρχει πράγματι, αυτούσια, στο αντίστοιχο έγγραφο.
//      Ό,τι δεν επαληθεύεται απορρίπτεται, οπότε το LLM δεν μπορεί να "επινοήσει" αντίφαση.
//   4. Αποθήκευση με fingerprint (χωρίς διπλότυπα) και ειδοποίηση των editors που αφορά.
// Το κόστος είναι ένα ερώτημα LLM ανά υποψήφιο έγγραφο, μόνο στο publish (όχι σε κάθε ερώτηση).
//
// Ορατότητα (απόφαση 30 Σεπ 2026): ο editor βλέπει ΚΑΙ τις δύο πλευρές, ακόμα κι αν η μία είναι
// άλλου τμήματος (μόνο ανάγνωση). Αν η άλλη πλευρά είναι σε ΚΡΥΦΟ τμήμα, βλέπει μόνο ότι
// υπάρχει αντίφαση, χωρίς τίτλο ή κείμενο, και ειδοποιείται ο admin.

import { json, loadWorkspaceDepartments, sha256Hex } from "./auth.js";
import { COMPANY_WIDE, canReadDepartment, canWriteDepartment } from "./access.js";
import { departmentName, listDocIndex, normalizeText, readDoc } from "./store.js";
import { SYSTEM_ACTOR, recordAudit } from "./audit.js";

const MAX_QUERY_CHUNKS = 6;
const MAX_CANDIDATE_DOCS = 4;
const MAX_EXCERPTS_PER_DOC = 3;
const MAX_DOC_CHARS = 6000;
const MAX_QUOTE_CHARS = 300;
const MIN_QUOTE_CHARS = 8;
const DEFAULT_MIN_SCORE = 0.7;
const REMIND_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MAX_EMAIL_RECIPIENTS = 6;
export const HIDDEN_TOPIC = "Πιθανή αντίφαση με έγγραφο κρυφού τμήματος";

// ------------------------------------------------------------------ ο κριτής (LLM)
function judgePrompt(newDoc, otherTitle, excerpts) {
  return [
    "Είσαι ελεγκτής εσωτερικών διαδικασιών μιας εταιρείας. Σου δίνονται ένα ΝΕΟ ΕΓΓΡΑΦΟ και αποσπάσματα από ένα ΑΛΛΟ ΕΓΓΡΑΦΟ.",
    "Βρες ΜΟΝΟ σαφείς αντιφάσεις: δύο προτάσεις που δεν μπορούν να ισχύουν ταυτόχρονα για την ΙΔΙΑ περίπτωση (π.χ. διαφορετικός αριθμός, όριο, προθεσμία, χρονικό διάστημα, ή ναι/όχι για το ίδιο πράγμα).",
    "ΜΗΝ αναφέρεις: διαφορές σε λεπτομέρεια ή έκταση, πρόσθετες πληροφορίες που δεν αντικρούουν η μία την άλλη, διαφορετικές περιπτώσεις ή προϋποθέσεις, ή διαφορετική διατύπωση του ίδιου νοήματος. Αν αμφιβάλλεις, ΜΗΝ το αναφέρεις.",
    `Κάθε παράθεση (quote) πρέπει να είναι ΑΚΡΙΒΕΣ αντίγραφο μίας πρότασης από το αντίστοιχο κείμενο, μέχρι ${MAX_QUOTE_CHARS} χαρακτήρες, χωρίς αλλαγές.`,
    'Απάντησε ΜΟΝΟ με JSON, χωρίς markdown και χωρίς άλλο κείμενο, ακριβώς σε αυτή τη μορφή: {"contradictions":[{"topic":"σύντομος τίτλος","quoteNew":"...","quoteOther":"..."}]}',
    'Αν δεν υπάρχει καμία σαφής αντίφαση, απάντησε: {"contradictions":[]}',
    "",
    `ΝΕΟ ΕΓΓΡΑΦΟ: «${newDoc.title}»`,
    newDoc.text.slice(0, MAX_DOC_CHARS),
    "",
    `ΑΛΛΟ ΕΓΓΡΑΦΟ: «${otherTitle}» (αποσπάσματα)`,
    excerpts.join("\n...\n"),
  ].join("\n");
}

function parseJudgeOutput(raw) {
  if (typeof raw !== "string") return [];
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = parsed && Array.isArray(parsed.contradictions) ? parsed.contradictions : [];
  return list.filter(
    (c) => c && typeof c.quoteNew === "string" && typeof c.quoteOther === "string"
  ).map((c) => ({
    topic: typeof c.topic === "string" ? c.topic.slice(0, 120) : "",
    quoteNew: c.quoteNew.trim(),
    quoteOther: c.quoteOther.trim(),
  }));
}

// Επαλήθευση: οι παραθέσεις πρέπει να υπάρχουν αυτούσιες στα πραγματικά κείμενα.
function verified(item, newText, otherText) {
  const qn = normalizeText(item.quoteNew);
  const qo = normalizeText(item.quoteOther);
  if (qn.length < MIN_QUOTE_CHARS || qo.length < MIN_QUOTE_CHARS) return false;
  if (item.quoteNew.length > MAX_QUOTE_CHARS || item.quoteOther.length > MAX_QUOTE_CHARS) return false;
  return normalizeText(newText).includes(qn) && normalizeText(otherText).includes(qo);
}

async function judgePair(env, deps, newDoc, other) {
  const raw = await deps.askGeminiOnly(judgePrompt(newDoc, other.title, other.excerpts), env);
  return parseJudgeOutput(raw)
    .filter((item) => verified(item, newDoc.text, other.fullText))
    .slice(0, 3); // το πολύ 3 ανά ζεύγος εγγράφων: κόβει το "θόρυβο"
}

// ------------------------------------------------------------------ παραλήπτες ειδοποιήσεων
async function editorEmails(env, workspaceId, departmentIds) {
  const ids = [...departmentIds].filter((d) => d && d !== COMPANY_WIDE);
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT DISTINCT m.email FROM team_members m JOIN member_departments md ON md.member_id = m.id
      WHERE m.workspace_id = ? AND m.role = 'editor' AND m.status = 'active' AND md.department_id IN (${marks})`
  ).bind(workspaceId, ...ids).all();
  return ((res && res.results) || []).map((r) => r.email);
}

async function adminEmails(env, workspaceId) {
  const res = await env.DB.prepare(
    "SELECT email FROM team_members WHERE workspace_id = ? AND role = 'admin' AND status = 'active'"
  ).bind(workspaceId).all();
  return ((res && res.results) || []).map((r) => r.email);
}

// Ποιοι πρέπει να ενημερωθούν για μια αντίφαση ανάμεσα στα τμήματα deptIds.
// Οι editors των τμημάτων που εμπλέκονται. Οι admins όταν εμπλέκεται κρυφό ή εταιρικό έγγραφο,
// ή όταν κανένα από τα εμπλεκόμενα τμήματα δεν έχει editor (αλλιώς δεν θα το έβλεπε κανείς).
async function recipientsFor(env, workspaceId, deptIds, departments) {
  const depts = new Set(deptIds);
  const emails = new Set(await editorEmails(env, workspaceId, depts));
  const touchesHiddenOrCompany = [...depts].some(
    (d) => d === COMPANY_WIDE || (departments.find((x) => x.id === d) || {}).hidden
  );
  if (touchesHiddenOrCompany || emails.size === 0) {
    for (const e of await adminEmails(env, workspaceId)) emails.add(e);
  }
  return emails;
}

async function notify(env, deps, origin, emails, exceptEmail) {
  const list = [...emails].filter((e) => e !== exceptEmail).slice(0, MAX_EMAIL_RECIPIENTS);
  for (const email of list) {
    await deps.sendEmailViaResend(
      env,
      email,
      "Πιθανή αντίφαση στα έγγραφα",
      // Γενικό κείμενο, ΧΩΡΙΣ τίτλους ή περιεχόμενο: μπορεί να αφορά κρυφό τμήμα.
      `Βρέθηκε μια πιθανή αντίφαση που αφορά έγγραφο του τμήματός σου. Δες τα εισερχόμενα εδώ:\n\n${origin}/team-editor.html`
    );
  }
  return list.length;
}

// ------------------------------------------------------------------ ανίχνευση
// Τρέχει μετά από κάθε αποθήκευση εγγράφου (στο παρασκήνιο, μέσω ctx.waitUntil). Δεν πετάει ποτέ
// σφάλμα προς τα έξω: ένας αποτυχημένος έλεγχος δεν πρέπει να επηρεάσει τη δημοσίευση.
export async function checkContradictions(env, deps, { workspaceId, docId, title, text, vectors, origin, actorEmail }) {
  const result = { created: 0, candidates: 0, failed: 0 };
  try {
    const minScore = parseFloat(env.TEAM_CONTRADICTION_MIN_SCORE) || DEFAULT_MIN_SCORE;

    // 1) υποψήφια έγγραφα, από τα πιο όμοια chunks
    const queries = (vectors || []).slice(0, MAX_QUERY_CHUNKS).map((v) =>
      env.VECTORIZE.query(v.values, { topK: 6, namespace: workspaceId, returnMetadata: "all" }).catch(() => ({ matches: [] }))
    );
    const perChunk = await Promise.all(queries);
    const byDoc = new Map(); // documentId -> { score, texts:Set }
    for (const res of perChunk) {
      for (const m of (res && res.matches) || []) {
        const meta = m.metadata || {};
        if (!meta.documentId || meta.documentId === docId || m.score < minScore) continue;
        const entry = byDoc.get(meta.documentId) || { score: 0, texts: new Map() };
        entry.score = Math.max(entry.score, m.score);
        const clean = String(meta.text || "").replace(/^\[ΠΡΟΣΦΑΤΗ ΕΝΗΜΕΡΩΣΗ[^\]]*\]\s*/, "");
        entry.texts.set(clean, Math.max(entry.texts.get(clean) || 0, m.score));
        byDoc.set(meta.documentId, entry);
      }
    }
    const candidates = [...byDoc.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, MAX_CANDIDATE_DOCS);

    // 2+3) κριτής και επαλήθευση, παράλληλα ανά υποψήφιο έγγραφο
    const jobs = [];
    for (const [otherId, info] of candidates) {
      const other = await readDoc(env, workspaceId, otherId);
      if (!other) continue; // παλιά vectors χωρίς έγγραφο: αγνοούνται
      const excerpts = [...info.texts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_EXCERPTS_PER_DOC).map((e) => e[0]);
      result.candidates++;
      jobs.push(
        judgePair(env, deps, { title, text }, { title: other.title, excerpts, fullText: other.fullText })
          .then((items) => items.map((item) => ({ item, otherId, otherDept: other.departmentId })))
          .catch(() => { result.failed++; return []; })
      );
    }
    const found = (await Promise.all(jobs)).flat();

    // 4) αποθήκευση χωρίς διπλότυπα
    const departments = await loadWorkspaceDepartments(env, workspaceId);
    const me = await readDoc(env, workspaceId, docId);
    const myDept = me ? me.departmentId : COMPANY_WIDE;
    const recipientDepts = new Set();
    let newCount = 0;
    const touchedIds = []; // μόνο όσες βρέθηκαν ή ξανάνοιξαν ΤΩΡΑ (για το notified_at)
    for (const { item, otherId, otherDept } of found) {
      const [lowId, highId] = [docId, otherId].sort();
      const quoteLow = lowId === docId ? item.quoteNew : item.quoteOther;
      const quoteHigh = lowId === docId ? item.quoteOther : item.quoteNew;
      const fingerprint = await sha256Hex(`${lowId}|${highId}|${normalizeText(quoteLow)}|${normalizeText(quoteHigh)}`);
      const existing = await env.DB.prepare(
        "SELECT id, status FROM team_contradictions WHERE workspace_id = ? AND fingerprint = ?"
      ).bind(workspaceId, fingerprint).first();
      if (existing) {
        // Μια αντίφαση που είχε "λυθεί" αλλά εμφανίστηκε ξανά, ανοίγει πάλι. Μια που ο editor
        // χαρακτήρισε "δεν είναι αντίφαση" ΔΕΝ ξανανοίγει ποτέ.
        if (existing.status === "resolved") {
          await env.DB.prepare(
            "UPDATE team_contradictions SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolution = NULL WHERE id = ?"
          ).bind(existing.id).run();
          newCount++;
          touchedIds.push(existing.id);
          recipientDepts.add(myDept); recipientDepts.add(otherDept);
        }
        continue;
      }
      const ins = await env.DB.prepare(
        `INSERT INTO team_contradictions (workspace_id, doc_a, quote_a, doc_b, quote_b, topic, fingerprint, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      ).bind(workspaceId, lowId, quoteLow, highId, quoteHigh, item.topic, fingerprint, new Date().toISOString()).run();
      touchedIds.push(ins.meta.last_row_id);
      newCount++;
      recipientDepts.add(myDept); recipientDepts.add(otherDept);
    }
    result.created = newCount;

    // 5) ειδοποίηση (ένα email ανά παραλήπτη, όχι ανά αντίφαση)
    if (newCount > 0) {
      const emails = await recipientsFor(env, workspaceId, recipientDepts, departments);
      const sent = await notify(env, deps, origin, emails, actorEmail);
      if (sent > 0) {
        const now = new Date().toISOString();
        for (const id of touchedIds) {
          await env.DB.prepare("UPDATE team_contradictions SET notified_at = ? WHERE id = ? AND workspace_id = ?").bind(now, id, workspaceId).run();
        }
      }
    }
    await recordAudit(env, SYSTEM_ACTOR(workspaceId), "contradiction_check", docId, {
      candidates: result.candidates, created: result.created, failed: result.failed,
    });
  } catch (err) {
    result.failed++;
    await recordAudit(env, SYSTEM_ACTOR(workspaceId), "contradiction_check_failed", docId, { message: String((err && err.message) || err).slice(0, 200) });
  }
  return result;
}

// Όταν αλλάζει ένα έγγραφο, οι ανοιχτές αντιφάσεις του, των οποίων η πρόταση δεν υπάρχει πια στο
// κείμενο, θεωρούνται λυμένες. Είναι καθαρά ντετερμινιστικό (χωρίς LLM) και άμεσο.
export async function resolveStaleContradictions(env, workspaceId, docId, newText, resolverId) {
  const rows = await env.DB.prepare(
    "SELECT id, doc_a, quote_a, doc_b, quote_b FROM team_contradictions WHERE workspace_id = ? AND status = 'open' AND (doc_a = ? OR doc_b = ?)"
  ).bind(workspaceId, docId, docId).all();
  const now = new Date().toISOString();
  const text = normalizeText(newText);
  let resolved = 0;
  for (const r of (rows && rows.results) || []) {
    const quote = r.doc_a === docId ? r.quote_a : r.quote_b;
    if (!text.includes(normalizeText(quote))) {
      await env.DB.prepare(
        "UPDATE team_contradictions SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = 'edited' WHERE id = ?"
      ).bind(now, resolverId === undefined ? null : resolverId, r.id).run();
      resolved++;
    }
  }
  return resolved;
}

export async function resolveContradictionsForDeletedDoc(env, workspaceId, docId, resolverId) {
  await env.DB.prepare(
    "UPDATE team_contradictions SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = 'deleted' WHERE workspace_id = ? AND status = 'open' AND (doc_a = ? OR doc_b = ?)"
  ).bind(new Date().toISOString(), resolverId === undefined ? null : resolverId, workspaceId, docId, docId).run();
}

// ------------------------------------------------------------------ ορατότητα
// Επιστρέφει την εικόνα μιας αντίφασης όπως τη βλέπει το συγκεκριμένο μέλος, ή null αν δεν
// τον αφορά. Ο editor ΑΦΟΡΑΤΑΙ όταν τουλάχιστον μία πλευρά είναι έγγραφο που μπορεί να επεξεργαστεί.
function viewFor(member, departments, docIndex, row) {
  const sides = [];
  for (const [docId, quote] of [[row.doc_a, row.quote_a], [row.doc_b, row.quote_b]]) {
    const entry = docIndex.get(docId);
    if (!entry) return null; // το έγγραφο δεν υπάρχει πια
    const readable = canReadDepartment(member, departments, entry.departmentId);
    const editable = canWriteDepartment(member, departments, entry.departmentId);
    sides.push({ docId, quote, entry, readable, editable });
  }
  const involved = member.role === "admin" || sides.some((s) => s.editable);
  if (!involved) return null;
  // Ο τίτλος φτιάχνεται από το LLM συνοψίζοντας ΚΑΙ τα δύο κείμενα, άρα μπορεί να αποκαλύπτει το θέμα
  // ενός κρυφού εγγράφου. Όταν μια πλευρά δεν είναι αναγνώσιμη για το μέλος, βλέπει γενικό τίτλο.
  const anyHidden = sides.some((s) => !s.readable);
  return {
    id: row.id,
    topic: anyHidden ? HIDDEN_TOPIC : row.topic,
    status: row.status,
    createdAt: row.created_at,
    notifiedAt: row.notified_at || null,
    resolution: row.resolution || null,
    sides: sides.map((s) =>
      s.readable
        ? {
            hidden: false,
            documentId: s.docId,
            title: s.entry.title,
            departmentName: departmentName(departments, s.entry.departmentId),
            quote: s.quote,
            editable: s.editable,
          }
        // Κρυφό τμήμα: μόνο το γεγονός ότι υπάρχει, τίποτα άλλο.
        : { hidden: true, editable: false }
    ),
  };
}

export async function listContradictionsFor(env, member, status) {
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const docIndex = new Map((await listDocIndex(env, member.workspaceId)).map((d) => [d.id, d]));
  const where = status === "all" ? "" : " AND status = ?";
  const stmt = env.DB.prepare(
    `SELECT * FROM team_contradictions WHERE workspace_id = ?${where} ORDER BY id DESC LIMIT 200`
  );
  const res = await (status === "all" ? stmt.bind(member.workspaceId) : stmt.bind(member.workspaceId, status || "open")).all();
  const out = [];
  for (const row of (res && res.results) || []) {
    const v = viewFor(member, departments, docIndex, row);
    if (v) out.push(v);
  }
  return out;
}

async function loadVisible(env, member, id) {
  const row = await env.DB.prepare("SELECT * FROM team_contradictions WHERE id = ? AND workspace_id = ?")
    .bind(id, member.workspaceId).first();
  if (!row) return null;
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const docIndex = new Map((await listDocIndex(env, member.workspaceId)).map((d) => [d.id, d]));
  const view = viewFor(member, departments, docIndex, row);
  return view ? { row, view, departments, docIndex } : null;
}

// ------------------------------------------------------------------ endpoints
export async function handleListContradictions(env, member, url) {
  const status = url.searchParams.get("status") || "open";
  if (!["open", "resolved", "dismissed", "all"].includes(status)) return json(400, { error: "invalid_status" });
  return json(200, { contradictions: await listContradictionsFor(env, member, status) });
}

export async function handleDismissContradiction(env, member, id) {
  const found = await loadVisible(env, member, id);
  if (!found) return json(404, { error: "not_found" });
  if (found.row.status !== "open") return json(409, { error: "not_open" });
  await env.DB.prepare(
    "UPDATE team_contradictions SET status = 'dismissed', resolved_at = ?, resolved_by = ?, resolution = 'dismissed' WHERE id = ?"
  ).bind(new Date().toISOString(), member.id, id).run();
  await recordAudit(env, member, "contradiction_dismissed", String(id), { topic: found.row.topic });
  return json(200, { ok: true });
}

// Υπενθύμιση προς το άλλο τμήμα (ή τον admin, αν η άλλη πλευρά είναι κρυφή ή εταιρική).
export async function handleRemindContradiction(env, deps, member, id, origin) {
  const found = await loadVisible(env, member, id);
  if (!found) return json(404, { error: "not_found" });
  if (found.row.status !== "open") return json(409, { error: "not_open" });
  if (found.row.notified_at && Date.now() - new Date(found.row.notified_at).getTime() < REMIND_COOLDOWN_MS) {
    return json(429, { error: "cooldown" });
  }
  const otherDepts = new Set();
  for (const docId of [found.row.doc_a, found.row.doc_b]) {
    const entry = found.docIndex.get(docId);
    if (entry && !canWriteDepartment(member, found.departments, entry.departmentId)) otherDepts.add(entry.departmentId);
  }
  const emails = await recipientsFor(env, member.workspaceId, otherDepts, found.departments);
  await notify(env, deps, origin, emails, member.email);
  await env.DB.prepare("UPDATE team_contradictions SET notified_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id).run();
  await recordAudit(env, member, "contradiction_reminder", String(id), null);
  return json(200, { ok: true });
}

// ------------------------------------------------------------------ μετά από αποθήκευση εγγράφου
// rc = { env, deps, member, ctx, origin }. Οι ήδη ανοιχτές αντιφάσεις που έπαψαν να ισχύουν κλείνουν
// αμέσως, και ο έλεγχος για νέες τρέχει στο παρασκήνιο (ctx.waitUntil) ώστε ο editor να μην περιμένει.
export async function afterDocumentSaved(rc, { docId, title, text, vectors }) {
  const { env, deps, member, ctx, origin } = rc;
  await resolveStaleContradictions(env, member.workspaceId, docId, text, member.id);
  const job = checkContradictions(env, deps, {
    workspaceId: member.workspaceId, docId, title, text, vectors, origin, actorEmail: member.email,
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
  else await job;
}

// Χειροκίνητος έλεγχος ενός εγγράφου, σύγχρονος: επιστρέφει πόσες νέες αντιφάσεις βρέθηκαν.
export async function handleCheckDocument(rc, id) {
  const { env, deps, member, origin } = rc;
  const doc = await readDoc(env, member.workspaceId, id);
  if (!doc) return json(404, { error: "not_found" });
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  if (!canWriteDepartment(member, departments, doc.departmentId)) return json(403, { error: "forbidden" });
  const vectors = [];
  try {
    for (const chunk of deps.chunkText(doc.fullText).slice(0, MAX_QUERY_CHUNKS)) {
      vectors.push({ values: await deps.getEmbedding(chunk, env.GEMINI_API_KEY) });
    }
  } catch {
    return json(503, { error: "ai_unavailable" });
  }
  const result = await checkContradictions(env, deps, {
    workspaceId: member.workspaceId, docId: id, title: doc.title, text: doc.fullText, vectors, origin, actorEmail: member.email,
  });
  // Οι ήδη γνωστές αντιφάσεις δεν μετρούν ως "νέες". Επιστρέφουμε και πόσες ανοιχτές υπάρχουν, ώστε το μήνυμα
  // να μη δείχνει "0" όταν απλώς βρέθηκαν ξανά οι ίδιες.
  const openRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM team_contradictions WHERE workspace_id = ? AND status = 'open' AND (doc_a = ? OR doc_b = ?)"
  ).bind(member.workspaceId, id, id).first();
  return json(200, { ...result, open: openRow ? openRow.c : 0 });
}