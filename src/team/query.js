// Section W: ερωτήσεις υπαλλήλων προς τον βοηθό. ΙΔΙΟ pipeline με το SMB (embedding ->
// semantic search -> Gemini, streaming με εφεδρεία), αλλά με ΑΠΑΡΑΒΙΑΣΤΟ φίλτρο τμήματος.
//
// Το φίλτρο εφαρμόζεται ΔΥΟ φορές (άμυνα σε βάθος):
//   (1) μέσα στο ερώτημα προς το Vectorize (φίλτρο metadata department_id, ΠΡΙΝ το topK),
//   (2) ξανά στον κώδικα, πάνω στα αποτελέσματα, ΠΡΙΝ φτιαχτεί το context για το LLM.
// Vector χωρίς department_id απορρίπτεται πάντα (fail closed). Το LLM δεν βλέπει ποτέ
// κείμενο που ο χρήστης δεν δικαιούται -- ό,τι δεν ανακτήθηκε δεν μπορεί να διαρρεύσει.

import { json, loadWorkspaceDepartments } from "./auth.js";
import { COMPANY_WIDE, searchDepartmentIds, vectorFilterFor } from "./access.js";
import { docKey } from "./store.js";

const MAX_QUESTION_CHARS = 1000;
const FALLBACK_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 ημέρες
const NO_MATCH_ANSWER = "Δεν βρέθηκε σχετική διαδικασία στα έγγραφα που έχεις πρόσβαση.";

function isFallbackAnswer(answer) {
  const a = answer.toLowerCase();
  return (
    a.includes("δεν γνωρίζω") ||
    a.includes("δε γνωρίζω") ||
    a.includes("don't know") ||
    a.includes("do not know")
  );
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
  const allowed = searchDepartmentIds(member); // null = όλα (admin)
  const filter = vectorFilterFor(member); // undefined = χωρίς φίλτρο (admin)
  const workspaceId = member.workspaceId;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const found = await deps.retrieveMatches(env, workspaceId, question, history, filter);
        let matches = (found && found.matches) || [];
        // (2) δεύτερος έλεγχος στον κώδικα, fail closed
        if (allowed !== null) {
          matches = matches.filter(
            (m) => m.metadata && typeof m.metadata.department_id === "string" && allowed.has(m.metadata.department_id)
          );
        }

        if (matches.length === 0) {
          controller.enqueue(deps.encodeSSE({ type: "chunk", text: NO_MATCH_ANSWER }));
          await logUnanswered(env, deps, member, question);
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
          const raw = await env.DOCUMENT_REGISTRY.get(docKey(workspaceId, top.metadata.documentId));
          const doc = raw ? JSON.parse(raw) : {};
          const deptId = top.metadata.department_id;
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
          await logUnanswered(env, deps, member, question);
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
