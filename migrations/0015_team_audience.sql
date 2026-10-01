-- migrations\0015_team_audience.sql
-- Section W, πακέτο 5 (2 Οκτ 2026), φέτα 2: ΑΚΡΟΑΤΗΡΙΟ ΕΓΓΡΑΦΟΥ (έγγραφο που διαβάζεται από πολλά projects).
--
-- ΠΡΙΝ: ένα έγγραφο ανήκε σε ΕΝΑ project (team_documents.department_id) ή σε όλη την εταιρεία ("_all").
-- ΜΕΤΑ: το department_id μένει ο ΙΔΙΟΚΤΗΤΗΣ (εκεί γράφεται και επεξεργάζεται). Επιπλέον, ένα έγγραφο μπορεί να έχει ΑΚΡΟΑΤΗΡΙΟ:
-- μια λίστα άλλων projects που το διαβάζουν (μέχρι 10 projects συνολικά, με τον ιδιοκτήτη).
--
-- Το Vectorize δέχεται ΜΙΑ τιμή metadata ανά πεδίο, άρα κάθε διαφορετικό σύνολο projects παίρνει ένα id, την "ομάδα ακροατηρίου"
-- (ag-<16 hex>, υπολογίζεται από τα projects), και αυτό γράφεται στο department_id των vectors. Ένα έγγραφο μόνο του ιδιοκτήτη
-- ΔΕΝ έχει γραμμή εδώ και τα vectors του κρατούν το id του project, όπως και πριν: τα υπάρχοντα vectors δεν αλλάζουν.
--
-- Το Vectorize είναι μόνο ΠΡΩΤΟ φίλτρο. Η αυθεντική απόφαση "ποιος διαβάζει ποιο έγγραφο" παίρνεται ΠΑΝΤΑ στη βάση, ανά έγγραφο
-- (deny by default).
--
-- ΠΑΛΙ ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ: μόνο νέοι πίνακες. Ο κώδικας δουλεύει (με το σημερινό μοντέλο, μόνο ο ιδιοκτήτης) και αν το migration
-- δεν έχει εφαρμοστεί ακόμα: μόνο η ΑΛΛΑΓΗ ακροατηρίου δίνει 503 audience_unavailable. ΣΕΙΡΑ DEPLOY: πρώτα το migration, μετά ο κώδικας.

-- Τα σύνολα projects (ομάδες ακροατηρίου). Το id προκύπτει από τα projects, άρα το ίδιο σύνολο δίνει πάντα την ίδια ομάδα.
CREATE TABLE IF NOT EXISTS team_audience_groups (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 19 AND substr(id, 1, 3) = 'ag-' AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_audience_groups_workspace ON team_audience_groups(workspace_id);

-- Ποια projects ανήκουν σε κάθε ομάδα (ο ιδιοκτήτης του εγγράφου περιλαμβάνεται πάντα).
CREATE TABLE IF NOT EXISTS team_audience_group_projects (
  group_id TEXT NOT NULL REFERENCES team_audience_groups(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_team_audience_group_projects_project ON team_audience_group_projects(project_id);

-- Ποιο έγγραφο έχει ποια ομάδα ακροατηρίου. Έγγραφο χωρίς γραμμή εδώ = μόνο ο ιδιοκτήτης. Διαγραφή εγγράφου = διαγραφή γραμμής.
CREATE TABLE IF NOT EXISTS team_document_audience (
  workspace_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES team_audience_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, document_id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES team_documents(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_document_audience_group ON team_document_audience(group_id);