// Section W (30 Σεπ 2026): κανόνες πρόσβασης των ομάδων ("Idmon για ομάδες").
//
// ΚΑΘΑΡΕΣ συναρτήσεις: καμία βάση, KV ή δίκτυο εδώ, ώστε να δοκιμάζονται εύκολα και να
// φαίνονται όλοι οι κανόνες σε ένα σημείο. Ο έλεγχος πρόσβασης γίνεται ΠΑΝΤΑ σε κώδικα
// του backend, πριν το LLM δει οτιδήποτε -- ποτέ μέσα στο prompt.
//
// Ρόλοι (απόφαση 30 Σεπ 2026):
//   employee: ρωτά τον βοηθό και διαβάζει έγγραφα του τμήματός του + τα εταιρικά.
//   editor:   ίδια ανάγνωση με τον employee, ΣΥΝ ανάγνωση εγγράφων άλλων τμημάτων
//             (εκτός από τα κρυφά). Επεξεργάζεται ΜΟΝΟ έγγραφα του δικού του τμήματος.
//   admin:    διαβάζει και επεξεργάζεται τα πάντα, συμπεριλαμβανομένων των εταιρικών.
// Ο βοηθός (αναζήτηση) του editor ψάχνει μόνο στα δικά του τμήματα + τα εταιρικά,
// όπως ο employee. Το "διαβάζω άλλα τμήματα" ισχύει μόνο για τη βιβλιοθήκη εγγράφων.

// Δεσμευμένη τιμή department_id για έγγραφα "όλης της εταιρείας".
export const COMPANY_WIDE = "_all";

export const ROLES = ["admin", "editor", "employee"];

// member: { role, departmentIds: string[] }
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
  if (member.role === "editor") {
    return (
      departmentId !== COMPANY_WIDE &&
      exists &&
      (member.departmentIds || []).includes(departmentId)
    );
  }
  return false;
}

// Φίλτρο metadata για το Vectorize: εφαρμόζεται ΠΡΙΝ το topK. undefined = χωρίς φίλτρο.
// Vector χωρίς department_id ΔΕΝ ταιριάζει ποτέ σε $in (fail closed).
export function vectorFilterFor(member) {
  const ids = searchDepartmentIds(member);
  return ids === null ? undefined : { department_id: { $in: [...ids] } };
}
