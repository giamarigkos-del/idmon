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
//
// ΑΚΡΟΑΤΗΡΙΟ ΕΓΓΡΑΦΟΥ (2 Οκτ 2026, φέτα 2): κάθε έγγραφο έχει ένα project-ΙΔΙΟΚΤΗΤΗ (εκεί γράφεται και επεξεργάζεται) και, προαιρετικά,
// μια λίστα ΑΛΛΩΝ projects που το διαβάζουν (μέχρι MAX_AUDIENCE_PROJECTS συνολικά, με τον ιδιοκτήτη). Κανόνας (απόφαση "Β"):
// ΟΛΟΙ εκτός από τον admin διαβάζουν ένα έγγραφο ΜΟΝΟ αν είναι μέλη του ιδιοκτήτη ή ενός project του ακροατηρίου. Ένας editor
// ΔΕΝ διαβάζει πια έγγραφα άλλων projects "επειδή είναι editor": το ακροατήριο περιορίζει όλους, ώστε σε ένα BPO οι πελάτες
// να μένουν χωρισμένοι. Το εταιρικό έγγραφο (COMPANY_WIDE) το βλέπουν όλοι. Ένα εμπιστευτικό έγγραφο και ένα έγγραφο κρυφού
// project δεν έχουν ποτέ ακροατήριο: τα διαβάζουν μόνο τα μέλη του ιδιοκτήτη και οι admins.

// Δεσμευμένη τιμή department_id για έγγραφα "όλης της εταιρείας".
export const COMPANY_WIDE = "_all";

export const ROLES = ["admin", "editor", "employee"];

// Ακροατήριο: μέχρι 10 projects ΣΥΝΟΛΙΚΑ (ιδιοκτήτης και άλλα).
export const MAX_AUDIENCE_PROJECTS = 10;

// Το Vectorize δέχεται φίλτρο metadata μέχρι 2048 bytes. Κρατάμε περιθώριο και σπάμε τη λίστα σε παρτίδες (ξεχωριστά ερωτήματα,
// ενωμένα με βάση το score). Πάνω από MAX_FILTER_BATCHES παρτίδες ο βοηθός δεν ψάχνει (αποτυχία κλειστά, με ρητό μήνυμα).
export const MAX_FILTER_BYTES = 1800;
export const MAX_FILTER_BATCHES = 3;

// member: { role, departmentIds: string[], editorProjectIds: string[] }
// workspaceDepartments: [{ id, name, hidden }] -- όλα τα τμήματα του workspace.

// Σύνολο department_id που μπορεί να ΔΙΑΒΑΣΕΙ ως project (δικά του + εταιρικά). null = όλα (admin).
export function readableDepartmentIds(member, workspaceDepartments) {
  if (member.role === "admin") return null;
  return new Set([COMPANY_WIDE, ...(member.departmentIds || [])]);
}

// Σύνολο department_id στα οποία ψάχνει ο ΒΟΗΘΟΣ ΧΩΡΙΣ ακροατήρια εγγράφων. null = όλα (admin).
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

// Σύνολο ids που μπαίνουν στο φίλτρο του Vectorize: τα projects του μέλους (= έγγραφα μόνο του ιδιοκτήτη), τα εταιρικά και οι "ομάδες
// ακροατηρίου" που περιέχουν κάποιο project του. null = όλα (admin).
export function searchGroupIds(member, audienceGroupIds) {
  if (member.role === "admin") return null;
  return new Set([COMPANY_WIDE, ...(member.departmentIds || []), ...(audienceGroupIds || [])]);
}

const utf8Bytes = (s) => new TextEncoder().encode(s).length;
const filterOf = (ids) => ({ department_id: { $in: ids } });

// Φίλτρο metadata για το Vectorize: εφαρμόζεται ΠΡΙΝ το topK. Επιστρέφει { filters, tooMany }.
//   admin: filters = [undefined] (ένα ερώτημα χωρίς φίλτρο).
//   αλλιώς: τα ids σπάνε σε παρτίδες ≤ maxBytes, ένα φίλτρο ανά παρτίδα (κάθε vector έχει ένα μόνο department_id, άρα ανήκει
//   ακριβώς σε μία παρτίδα). Αν χρειάζονται περισσότερες από maxBatches: tooMany = true και ΚΑΝΕΝΑ φίλτρο (αποτυχία κλειστά).
// Vector χωρίς department_id ΔΕΝ ταιριάζει ποτέ σε $in (fail closed).
export function buildVectorFilters(member, audienceGroupIds, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_FILTER_BYTES;
  const maxBatches = opts.maxBatches || MAX_FILTER_BATCHES;
  const ids = searchGroupIds(member, audienceGroupIds);
  if (ids === null) return { filters: [undefined], tooMany: false };
  const sorted = [...ids].sort();
  const base = utf8Bytes(JSON.stringify(filterOf([])));
  const batches = [];
  let cur = [];
  let bytes = base;
  for (const id of sorted) {
    const own = utf8Bytes(JSON.stringify(id));
    if (cur.length && bytes + own + 1 > maxBytes) {
      batches.push(cur);
      cur = [];
      bytes = base;
    }
    bytes += own + (cur.length ? 1 : 0);
    cur.push(id);
  }
  if (cur.length) batches.push(cur);
  if (batches.length > maxBatches) return { filters: [], tooMany: true };
  return { filters: batches.map(filterOf), tooMany: false };
}

// Παλιό φίλτρο (χωρίς ακροατήρια), για συμβατότητα. undefined = χωρίς φίλτρο.
export function vectorFilterFor(member) {
  const ids = searchDepartmentIds(member);
  return ids === null ? undefined : { department_id: { $in: [...ids] } };
}

// Ανάγνωση συγκεκριμένου εγγράφου.
//   admin: όλα. Εταιρικό (_all): όλοι, εκτός αν είναι εμπιστευτικό (αδύνατο μέσω API).
//   Μέλος του ιδιοκτήτη: διαβάζει ΠΑΝΤΑ (και το εμπιστευτικό).
//   Εμπιστευτικό: ΜΟΝΟ τα μέλη του ιδιοκτήτη. Ιδιοκτήτης κρυφό project: ΜΟΝΟ τα μέλη του (το ακροατήριο αγνοείται).
//   Αλλιώς: όποιος είναι μέλος κάποιου project του ακροατηρίου (audienceProjectIds = τα ΑΛΛΑ projects, χωρίς τον ιδιοκτήτη).
// Deny by default: κάθε περίπτωση που δεν ταιριάζει ρητά, απορρίπτεται.
export function canReadDocument(member, workspaceDepartments, departmentId, hidden, audienceProjectIds) {
  if (member.role === "admin") return true;
  if (departmentId === COMPANY_WIDE) return !hidden;
  const own = member.departmentIds || [];
  if (own.includes(departmentId)) return true;
  if (hidden) return false;
  const owner = (workspaceDepartments || []).find((d) => d.id === departmentId);
  if (!owner || owner.hidden) return false;
  return (audienceProjectIds || []).some((p) => own.includes(p));
}