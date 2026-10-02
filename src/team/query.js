// src\team\query.js
// Section W: ερωτήσεις υπαλλήλων προς τον βοηθό. ΙΔΙΟ pipeline με το SMB (embedding ->
// semantic search -> Gemini, streaming με εφεδρεία), αλλά με ΑΠΑΡΑΒΙΑΣΤΟ φίλτρο τμήματος.
//
// Το φίλτρο εφαρμόζεται ΔΥΟ φορές (άμυνα σε βάθος):
//   (1) μέσα στο ερώτημα προς το Vectorize (φίλτρο metadata department_id = project ή ομάδα ακροατηρίου, ΠΡΙΝ το topK). Αν η λίστα δεν
//       χωράει σε ένα φίλτρο (όριο 2048 bytes), σπάει σε παρτίδες με παράλληλα ερωτήματα, ενωμένα με βάση το score,
//   (2) ξανά, ΑΥΘΕΝΤΙΚΑ στη βάση ανά έγγραφο (ιδιοκτήτης, ακροατήριο, εμπιστευτικό), ΠΡΙΝ φτιαχτεί το context για το LLM.
// Vector χωρίς department_id ή με έγγραφο που δεν υπάρχει στη βάση απορρίπτεται πάντα (fail closed). Το LLM δεν βλέπει ποτέ
// κείμενο που ο χρήστης δεν δικαιούται -- ό,τι δεν ανακτήθηκε δεν μπορεί να διαρρεύσει.

import { json, loadWorkspaceDepartments } from "./auth.js";
import { COMPANY_WIDE, buildVectorFilters, canReadDocument, memberWalls, scopeMemberToWall } from "./access.js";
import { audienceGroupsForMember, documentAccessInfo, readDoc } from "./store.js";
import { DEFAULT_DAILY_QUESTIONS, consumeQuota } from "./quota.js";

const MAX_QUESTION_CHARS = 1000;
const FALLBACK_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 ημέρες
const NO_MATCH_ANSWER = "Δεν βρέθηκε σχετική διαδικασία στα έγγραφα που έχεις πρόσβαση.";
// Όταν ένα μέλος ανήκει σε τόσα projects και ακροατήρια που ούτε οι παρτίδες φίλτρου δεν αρκούν: ρητό μήνυμα, όχι σιωπηλή αποκοπή.
export const TOO_MANY_PROJECTS_ANSWER = "Ο λογαριασμός σου ανήκει σε πάρα πολλά projects και ο βοηθός δεν μπορεί να ψάξει σε όλα. Ζήτησε από τον admin να μειώσει τα projects σου.";

// Ένωση των αποτελεσμάτων των παρτίδων: ταξινόμηση με βάση το score και κόψιμο στο μέγεθος που θα είχε ένα μόνο ερώτημα.
// Το topK του retrieveMatches δεν είναι γνωστό εδώ. Αν κάποια παρτίδα επέστρεψε "γεμάτη", αυτό είναι το μέγεθος. Αλλιώς (λίγα έγγραφα σε κάθε
// παρτίδα) κρατάμε τουλάχιστον MIN_MERGED_MATCHES, ώστε να μη χαθούν σχετικά αποτελέσματα από διαφορετικές παρτίδες.
const MIN_MERGED_MATCHES = 4; // = TOP_K του retrieveMatches στο src/index.js (4)
function mergeMatches(results) {
  const lists = results.map((r) => (r && r.matches) || []);
  if (lists.length === 1) return lists[0];
  const limit = Math.max(MIN_MERGED_MATCHES, ...lists.map((l) => l.length));
  const seen = new Set();
  const out = [];
  for (const m of lists.flat().sort((a, b) => b.score - a.score)) {
    const meta = m.metadata || {};
    const key = m.id || `${meta.documentId}|${meta.chunkIndex}|${meta.updateId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out.slice(0, limit);
}

function isFallbackAnswer(answer) {
  const a = answer.toLowerCase();
  return (
    a.includes("δεν γνωρίζω") ||
    a.includes("δε γνωρίζω") ||
    a.includes("don't know") ||
    a.includes("do not know")
  );
}

// Το Vectorize σβήνει τα vectors με καθυστέρηση. Ένα update που ενσωματώθηκε ή απορρίφθηκε μπορεί λοιπόν να
// εμφανίζεται ακόμα στην αναζήτηση για λίγα λεπτά. Πριν φτάσει στον βοηθό, κάθε κομμάτι update ελέγχεται στη
// βάση ότι είναι ΑΚΟΜΑ εκκρεμές. Fail closed: αν δεν μπορεί να ελεγχθεί, το κομμάτι update παραλείπεται.
async function dropInactiveUpdates(env, workspaceId, matches) {
  const isUpdate = (m) => m.metadata && m.metadata.kind === "update";
  if (!matches.some(isUpdate)) return matches;
  const ids = [...new Set(matches.filter(isUpdate).map((m) => Number(m.metadata.updateId)).filter(Number.isInteger))];
  let active = new Set();
  try {
    if (ids.length) {
      const marks = ids.map(() => "?").join(",");
      const res = await env.DB.prepare(
        `SELECT id FROM team_updates WHERE workspace_id = ? AND status = 'pending' AND id IN (${marks})`
      ).bind(workspaceId, ...ids).all();
      active = new Set(((res && res.results) || []).map((r) => r.id));
    }
  } catch {
    active = new Set();
  }
  return matches.filter((m) => !isUpdate(m) || active.has(Number(m.metadata.updateId)));
}

// Καταγραφή αναπάντητης ερώτησης: ΧΩΡΙΣ ταυτότητα υπαλλήλου (απόφαση GDPR, 29-30 Σεπ 2026: μόνο το
// κείμενο, η ώρα και τα ΤΜΗΜΑΤΑ του ερωτώντος, ώστε ο editor κάθε τμήματος να βλέπει τις δικές του
// αναπάντητες ερωτήσεις χωρίς να γίνεται εργαλείο παρακολούθησης). Τα στοιχεία μπαίνουν και στα
// metadata του KV key, ώστε τα εισερχόμενα να τα διαβάζουν χωρίς να ανοίγουν κάθε εγγραφή.
async function logUnanswered(env, deps, member, question) {
  const key = `team:${member.workspaceId}:fallback:${Date.now()}-${deps.randomHex(4)}`;
  const at = new Date().toISOString();
  await env.DOCUMENT_REGISTRY.put(
    key,
    JSON.stringify({ question: question.slice(0, 500), at, departmentIds: member.departmentIds }),
    { expirationTtl: FALLBACK_TTL_SECONDS, metadata: { q: question.slice(0, 200), d: member.departmentIds, at } }
  );
}

export async function handleTeamQuery(request, env, member, deps) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return json(400, { error: "question_required" });
  if (question.length > MAX_QUESTION_CHARS) return json(400, { error: "question_too_long" });
  const history = deps.sanitizeHistory(body.history);

  const departments = await loadWorkspaceDepartments(env, member.workspaceId);

  // ΤΟΙΧΟΙ (call center): ο βοηθός ψάχνει σε ΕΝΑΝ πελάτη τη φορά, ώστε ένας πράκτορας που δουλεύει για δύο πελάτες να μην παίρνει ποτέ
  // ανάμεικτη απάντηση. Αν το μέλος ανήκει σε περισσότερους από έναν τοίχους, ο πελάτης (clientId) είναι υποχρεωτικός: αλλιώς 400, ΠΡΙΝ
  // καταναλωθεί ερώτηση του ημερήσιου ορίου και πριν ψάξουμε οτιδήποτε. Ο admin χωρίς clientId ψάχνει παντού, όπως πάντα.
  // `actor` = το μέλος όπως περιορίστηκε στον τοίχο: ΜΟΝΟ αυτό χρησιμοποιείται για φίλτρο, ακροατήρια και έλεγχο ανάγνωσης.
  let actor = member;
  if (member.profile === "multi_client") {
    const wanted = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
    if (wanted) {
      actor = scopeMemberToWall(member, departments, wanted);
      if (!actor) return json(403, { error: "client_forbidden" });
    } else if (member.role !== "admin") {
      const walls = memberWalls(member, departments);
      if (walls.length > 1) return json(400, { error: "client_required", clients: walls });
    }
  }

  // Ημερήσιο όριο ερωτήσεων ανά μέλος (έλεγχος κόστους LLM). Fail open αν ο μετρητής δεν είναι διαθέσιμος.
  const dailyLimit = parseInt(env.TEAM_DAILY_QUESTION_LIMIT, 10) || DEFAULT_DAILY_QUESTIONS;
  const quota = await consumeQuota(env, member.id, "question", dailyLimit);
  if (!quota.ok) return json(429, { error: "daily_limit", limit: dailyLimit });

  const isAdmin = actor.role === "admin";
  // Οι ομάδες ακροατηρίου που αφορούν το μέλος (άδειο αν λείπει το migration 0015) και το φίλτρο σε παρτίδες.
  const groupIds = isAdmin ? [] : await audienceGroupsForMember(env, actor);
  const { filters, tooMany } = buildVectorFilters(actor, groupIds); // admin: ένα ερώτημα χωρίς φίλτρο
  const workspaceId = member.workspaceId;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (tooMany) {
          // Δεν ψάχνουμε καθόλου (fail closed) και ΔΕΝ το καταγράφουμε ως αναπάντητη ερώτηση: δεν φταίει το περιεχόμενο.
          controller.enqueue(deps.encodeSSE({ type: "chunk", text: TOO_MANY_PROJECTS_ANSWER }));
          controller.enqueue(deps.encodeSSE({ type: "done", isFallback: true, primarySource: null, relatedSections: [] }));
          controller.close();
          return;
        }
        const found = await Promise.all(filters.map((f) => deps.retrieveMatches(env, workspaceId, question, history, f)));
        let matches = mergeMatches(found);
        // (2) δεύτερος έλεγχος, ΑΥΘΕΝΤΙΚΑ στη βάση ανά έγγραφο, fail closed
        if (!isAdmin) {
          matches = matches.filter((m) => m.metadata && typeof m.metadata.department_id === "string" && typeof m.metadata.documentId === "string");
          const info = await documentAccessInfo(env, workspaceId, matches.map((m) => m.metadata.documentId));
          matches = matches.filter((m) => {
            const d = info.get(m.metadata.documentId);
            return !!d && canReadDocument(actor, departments, d.departmentId, d.hidden, d.audienceProjectIds);
          });
        }

        matches = await dropInactiveUpdates(env, workspaceId, matches);

        if (matches.length === 0) {
          controller.enqueue(deps.encodeSSE({ type: "chunk", text: NO_MATCH_ANSWER }));
          await logUnanswered(env, deps, actor, question);
          controller.enqueue(deps.encodeSSE({ type: "done", isFallback: true, primarySource: null, relatedSections: [] }));
          controller.close();
          return;
        }

        const context = matches.map((m) => m.metadata.text).join("\n\n---\n\n");

        let fullAnswer = "";
        try {
          for await (const piece of deps.streamGeminiChunks(context, question, env, history)) {
            if (!piece) continue;
            fullAnswer += piece;
            controller.enqueue(deps.encodeSSE({ type: "chunk", text: piece }));
          }
        } catch {
          // ό,τι στάλθηκε ήδη μένει, όπως στο SMB
        }
        if (!fullAnswer) {
          fullAnswer = await deps.askGemini(context, question, env, history);
          controller.enqueue(deps.encodeSSE({ type: "chunk", text: fullAnswer }));
        }

        const isFallback = isFallbackAnswer(fullAnswer);
        const top = [...matches].sort((a, b) => b.score - a.score)[0];

        let primarySource = null;
        if (!isFallback) {
          const doc = (await readDoc(env, workspaceId, top.metadata.documentId)) || {};
          // Το department_id των vectors είναι πλέον id ΟΜΑΔΑΣ ακροατηρίου. Ο ιδιοκτήτης του εγγράφου έρχεται από τη βάση.
          const deptId = doc.departmentId || top.metadata.department_id;
          const dept = departments.find((d) => d.id === deptId);
          primarySource = {
            documentId: top.metadata.documentId,
            title: doc.title || null,
            departmentId: deptId,
            departmentName: deptId === COMPANY_WIDE ? "Όλη η εταιρεία" : dept ? dept.name : deptId,
            chunkIndex: top.metadata.chunkIndex,
            isUpdate: top.metadata.kind === "update",
            score: top.score,
            text: top.metadata.text,
          };
        } else {
          await logUnanswered(env, deps, actor, question);
        }

        controller.enqueue(deps.encodeSSE({ type: "done", isFallback, primarySource, relatedSections: [] }));
        controller.close();
      } catch {
        try {
          controller.enqueue(deps.encodeSSE({ type: "error", message: "Κάτι πήγε στραβά." }));
        } catch {
          // το stream μπορεί να έχει ήδη κλείσει
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}