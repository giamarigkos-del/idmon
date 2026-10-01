// src\team\quota.js
// Section W: ημερήσια όρια χρήσης ανά μέλος (UTC ημέρα). Μετράει ΜΟΝΟ πόσες φορές, ποτέ τι ρώτησε κάποιος.
// Στόχος: έλεγχος κόστους LLM και προστασία από κατάχρηση. Αν ο πίνακας δεν υπάρχει ακόμα (το migration 0012 δεν έχει
// εφαρμοστεί) ή η βάση αποτύχει, το όριο ΔΕΝ εφαρμόζεται (fail open): ένα όριο που χαλά το προϊόν είναι χειρότερο από το
// να λείπει προσωρινά.

export const DEFAULT_DAILY_QUESTIONS = 100;
export const DEFAULT_DAILY_FEEDBACK = 30;

export const todayUtc = () => new Date().toISOString().slice(0, 10);

export async function consumeQuota(env, memberId, kind, limit) {
  try {
    const row = await env.DB.prepare(
      `INSERT INTO team_usage (member_id, day, kind, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(member_id, day, kind) DO UPDATE SET count = count + 1 RETURNING count`
    ).bind(memberId, todayUtc(), kind).first();
    const count = row ? row.count : 1;
    return { ok: count <= limit, count, limit };
  } catch {
    return { ok: true, count: 0, limit };
  }
}

export async function purgeOldUsage(env, keepDays = 7) {
  try {
    const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM team_usage WHERE day < ?").bind(cutoff).run();
  } catch {
    /* ο πίνακας μπορεί να μην υπάρχει ακόμα */
  }
}