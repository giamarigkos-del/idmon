// Section W: ιστορικό ενεργειών (μόνο διαχειριστικές ενέργειες, ορατό μόνο στον admin).
// ΔΕΝ καταγράφονται ερωτήσεις υπαλλήλων προς τον βοηθό ούτε αναγνώσεις εγγράφων: το ιστορικό
// απαντά "ποιος άλλαξε τι", όχι "τι ρώτησε ο καθένας". Αποτυχία καταγραφής δεν μπλοκάρει ποτέ
// την ίδια την ενέργεια.

const MAX_DETAIL_CHARS = 1000;
export const AUDIT_RETENTION_DAYS = 365;

// member: { workspaceId, id, email }. Για ενέργειες του συστήματος: { workspaceId, id: null, email: "system" }.
export async function recordAudit(env, member, action, target, detail) {
  try {
    await env.DB.prepare(
      "INSERT INTO team_audit_log (workspace_id, member_id, actor_email, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      member.workspaceId,
      member.id === undefined ? null : member.id,
      member.email,
      action,
      target === undefined || target === null ? null : String(target).slice(0, 200),
      detail === undefined || detail === null ? null : JSON.stringify(detail).slice(0, MAX_DETAIL_CHARS),
      new Date().toISOString()
    ).run();
  } catch {
    // ποτέ δεν αποτυγχάνει η πραγματική ενέργεια εξαιτίας του ιστορικού
  }
}

export const SYSTEM_ACTOR = (workspaceId) => ({ workspaceId, id: null, email: "system" });
