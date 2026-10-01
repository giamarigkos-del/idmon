-- migrations\0013_team_documents.sql
-- Section W, πακέτο 3 (1 Οκτ 2026): τα έγγραφα ομάδων μεταφέρονται από το Cloudflare KV στο D1.
--
-- ΓΙΑΤΙ: το KV είναι "τελικά συνεπές": μια αλλαγή (π.χ. σήμανση εμπιστευτικού, διαγραφή, νέο έγγραφο) μπορεί να
-- χρειαστεί ως και ένα λεπτό για να φανεί παντού, και η λίστα εγγράφων κρατούσε τα metadata εκεί. Για ένα προϊόν με
-- δικαιώματα πρόσβασης αυτό είναι παράθυρο ασφάλειας. Το D1 είναι άμεσα συνεπές.
--
-- Τα υπάρχοντα έγγραφα του KV μεταφέρονται ΑΥΤΟΜΑΤΑ και μία φορά ανά οργανισμό, στο πρώτο αίτημα μετά το deploy
-- (και σβήνονται από το KV αφού αντιγραφούν). Το migration είναι ΑΠΑΡΑΙΤΗΤΟ πριν το deploy του νέου κώδικα.
-- ΠΑΛΙ ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ: μόνο νέοι πίνακες.

CREATE TABLE IF NOT EXISTS team_documents (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  full_text TEXT NOT NULL,
  department_id TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  version INTEGER NOT NULL DEFAULT 1,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_team_documents_dept ON team_documents(workspace_id, department_id);

-- Σημαίνει ποιοι οργανισμοί έχουν ήδη μεταφέρει τα παλιά τους έγγραφα από το KV, ώστε η μεταφορά να μην ξαναψάχνει.
CREATE TABLE IF NOT EXISTS team_meta (
  workspace_id TEXT PRIMARY KEY REFERENCES team_workspaces(id) ON DELETE CASCADE,
  docs_migrated_at TEXT
);