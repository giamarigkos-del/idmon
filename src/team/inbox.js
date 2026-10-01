// src\team\inbox.js
// Section W: εισερχόμενα του editor: (1) αντιφάσεις, (2) updates προς ενσωμάτωση, (3) αναπάντητες
// ερωτήσεις. Οι αναπάντητες ερωτήσεις καταγράφονται από τον βοηθό ΧΩΡΙΣ ταυτότητα υπαλλήλου, μόνο
// με τα τμήματα του ερωτώντος, ώστε ο editor κάθε τμήματος να βλέπει τις δικές του.
// (Σημείωση GDPR: σε τμήμα με έναν μόνο υπάλληλο η ερώτηση προδίδει ποιος τη ρώτησε.)

import { json, sha256Hex } from "./auth.js";
import { listUpdatesForInbox } from "./updates.js";
import { listContradictionsFor } from "./contradictions.js";
import { listFeedbackFor } from "./feedback.js";
import { listAllKvKeys, normalizeText } from "./store.js";
import { recordAudit } from "./audit.js";

const QUESTION_DISMISS_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_QUESTION_KEYS = 2000;

export const fallbackPrefix = (workspaceId) => `team:${workspaceId}:fallback:`;
const dismissKey = (workspaceId, hash) => `team:${workspaceId}:qdismiss:${hash}`;

function normalizeQuestion(q) {
  return normalizeText(q).replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

export async function questionHash(question) {
  return (await sha256Hex(normalizeQuestion(question))).slice(0, 16);
}

async function listQuestionsFor(env, member) {
  const keys = (await listAllKvKeys(env, fallbackPrefix(member.workspaceId))).slice(0, MAX_QUESTION_KEYS);
  // editor: μόνο ερωτήσεις υπαλλήλων των projects όπου είναι ΡΗΤΑ editor (όχι όσων είναι απλό μέλος).
  const own = new Set(member.editorProjectIds || []);
  const groups = new Map(); // hash -> { question, count, lastAt }
  for (const k of keys) {
    const meta = k.metadata || {};
    if (typeof meta.q !== "string" || !meta.q) continue;
    const depts = Array.isArray(meta.d) ? meta.d : [];
    // admin: όλα. editor: μόνο ερωτήσεις υπαλλήλων των projects όπου είναι editor.
    if (member.role !== "admin" && !depts.some((d) => own.has(d))) continue;
    const hash = await questionHash(meta.q);
    const g = groups.get(hash) || { hash, question: meta.q, count: 0, lastAt: "" };
    g.count++;
    if (String(meta.at || "") >= g.lastAt) { g.lastAt = String(meta.at || ""); g.question = meta.q; }
    groups.set(hash, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (await env.DOCUMENT_REGISTRY.get(dismissKey(member.workspaceId, g.hash))) continue;
    out.push(g);
  }
  return out.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, 50);
}

export async function handleInbox(env, member) {
  const [contradictions, updates, questions, feedback] = await Promise.all([
    listContradictionsFor(env, member, "open"),
    listUpdatesForInbox(env, member),
    listQuestionsFor(env, member),
    listFeedbackFor(env, member),
  ]);
  return json(200, {
    counts: { contradictions: contradictions.length, updates: updates.length, questions: questions.length, feedback: feedback.length },
    contradictions,
    updates,
    questions,
    feedback,
  });
}

export async function handleDismissQuestion(request, env, member) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const hash = body && typeof body.hash === "string" ? body.hash : "";
  if (!/^[a-f0-9]{16}$/.test(hash)) return json(400, { error: "invalid_hash" });
  await env.DOCUMENT_REGISTRY.put(dismissKey(member.workspaceId, hash), "1", { expirationTtl: QUESTION_DISMISS_TTL_SECONDS });
  await recordAudit(env, member, "question_dismissed", hash, null);
  return json(200, { ok: true });
}