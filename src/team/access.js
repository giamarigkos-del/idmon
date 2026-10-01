// src\team\access.js
// Section W (30 Σεπ 2026): κανόνες πρόσβασης των ομάδων ("Idmon για ομάδες").
//
// ΚΑΘΑΡΕΣ συναρτήσεις: καμία βάση, KV ή δίκτυο εδώ, ώστε να δοκιμάζονται εύκολα και να
// φαίνονται όλοι οι κανόνες σε ένα σημείο. Ο έλεγχος πρόσβασης γίνεται ΠΑΝΤΑ σε κώδικα
// του backend, πριν το LLM δει οτιδήποτε -- ποτέ μέσα στο prompt.
//
// Ρόλοι (απόφαση 30 Σεπ 2026, ρόλος ανά project από 1 Οκτ 2026):
//   admin:    ρόλος ΟΡΓΑΝΙΣΜΟΥ. Διαβάζει και επεξεργάζεται τα πάντα, συμπεριλαμβανομένων των εταιρικών.
//   Όλοι οι άλλοι είναι μέλη του οργανισμού και έχουν ρόλο ΑΝΑ PROJECT (τμήμα):
//   μέλος:    ρωτά τον βοηθό και διαβάζει έγγραφα του project του + τα εταιρικά.
//   editor:   (σε ένα συγκεκριμένο project) επεξεργάζεται ΜΟΝΟ έγγραφα ΑΥΤΟΥ του project.
//             Σε άλλα projects όπου είναι απλό μέλος δεν γράφει. member.editorProjectIds = τα projects όπου είναι editor.
//   Το member.role είναι ΠΑΡΑΓΩΓΟ: "admin", ή "editor" αν είναι editor σε τουλάχιστον ένα project, αλλιώς "employee".
//   Ένας "editor" (παραγόμενος) διαβάζει επιπλέον έγγραφα άλλων τμημάτων (εκτός από τα κρυφά), μόνο για ανάγνωση.
// Ο βοηθός (αναζήτηση) του editor ψάχνει μόνο στα δικά του τμήματα + τα εταιρικά,
// όπως ο employee. Το "διαβάζω άλλα τμήματα" ισχύει μόνο για τη βιβλιοθήκη εγγράφων.

// Δεσμευμένη τιμή department_id για έγγραφα "όλης της εταιρείας".
export const COMPANY_WIDE = "_all";

export const ROLES = ["admin", "editor", "employee"];

// member: { role, departmentIds: string[], editorProjectIds: string[] }
// workspaceDepartments: [{ id, name, hidden }] -- όλα τα τμήματα του workspace.

// Σύνολο department_id που μπορεί να ΔΙΑΒΑΣΕΙ (βιβλιοθήκη εγγράφων). null = όλα (admin).
export function readableDepartmentIds(member, workspaceDepartments) {
  if (member.role === "admin") return null;
  const ids = new Set([COMPANY_WIDE, ...(member.departmentIds || [])]);
  if (member.role === "editor") {
    for (const d of workspaceDepartments || []) {
      if (!d.hidden) ids.add(d.id);
    }
  }
  return ids;
}

// Σύνολο department_id στα οποία ψάχνει ο ΒΟΗΘΟΣ. null = όλα (admin).
export function searchDepartmentIds(member) {
  if (member.role === "admin") return null;
  return new Set([COMPANY_WIDE, ...(member.departmentIds || [])]);
}

export function canReadDepartment(member, workspaceDepartments, departmentId) {
  const ids = readableDepartmentIds(member, workspaceDepartments);
  return ids === null ? true : ids.has(departmentId);
}

// Μπορεί να ΓΡΑΨΕΙ (δημιουργία/επεξεργασία/διαγραφή) έγγραφο σε αυτό το τμήμα;
export function canWriteDepartment(member, workspaceDepartments, departmentId) {
  const exists = (workspaceDepartments || []).some((d) => d.id === departmentId);
  if (member.role === "admin") return departmentId === COMPANY_WIDE || exists;
  // Μη-admin: μόνο σε project όπου είναι ΚΑΙ μέλος ΚΑΙ editor (deny by default).
  return (
    departmentId !== COMPANY_WIDE &&
    exists &&
    (member.departmentIds || []).includes(departmentId) &&
    (member.editorProjectIds || []).includes(departmentId)
  );
}

// Ο ρόλος του μέλους σε ένα project: "admin" | "editor" | "member" | null (δεν είναι μέλος).
export function projectRoleOf(member, projectId) {
  if (member.role === "admin") return "admin";
  if (!(member.departmentIds || []).includes(projectId)) return null;
  return (member.editorProjectIds || []).includes(projectId) ? "editor" : "member";
}

// Φίλτρο metadata για το Vectorize: εφαρμόζεται ΠΡΙΝ το topK. undefined = χωρίς φίλτρο.
// Vector χωρίς department_id ΔΕΝ ταιριάζει ποτέ σε $in (fail closed).
export function vectorFilterFor(member) {
  const ids = searchDepartmentIds(member);
  return ids === null ? undefined : { department_id: { $in: [...ids] } };
}

// Ανάγνωση συγκεκριμένου εγγράφου. Ένα "εμπιστευτικό" έγγραφο (σήμανση από τον admin) το διαβάζουν μόνο ο admin και τα
// μέλη του ΙΔΙΟΥ τμήματος, ακόμα κι αν το τμήμα είναι κανονικά ορατό σε άλλους editors. Εταιρικά έγγραφα (_all) δεν
// μπορούν να γίνουν εμπιστευτικά (θα διέρρεαν μέσω της αναζήτησης), γι' αυτό το API δεν το επιτρέπει.
export function canReadDocument(member, workspaceDepartments, departmentId, hidden) {
  if (!canReadDepartment(member, workspaceDepartments, departmentId)) return false;
  if (!hidden) return true;
  return member.role === "admin" || (departmentId !== COMPANY_WIDE && (member.departmentIds || []).includes(departmentId));
}