-- Section W (30 Σεπ 2026): "Idmon για ομάδες" -- εσωτερικό portal γνώσης για εταιρείες.
--
-- ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ: μόνο νέοι πίνακες, κανένα ALTER/DROP/UPDATE σε υπάρχοντα. Ο πίνακας
-- users (SMB πελάτες, Paddle) δεν αγγίζεται. Λόγος: users.workspace_id είναι UNIQUE, δηλαδή
-- ένας χρήστης = ένα workspace, οπότε υπάλληλοι μιας εταιρείας δεν χωράνε εκεί. Οι ομάδες
-- έχουν δική τους ταυτότητα (team_members) και δικά τους sessions (team_sessions).
--
-- team_workspaces.id είναι το ΙΔΙΟ αναγνωριστικό που χρησιμοποιούν ήδη το KV
-- (session:{workspace}:doc:...) και το Vectorize (namespace), άρα ο υπάρχων κώδικας
-- ανάκτησης δουλεύει χωρίς αλλαγή ως προς τα namespaces.
-- status: 'pilot' (δοκιμαστικό, χωρίς χρέωση), 'active', 'paused'. Οι ομάδες ΔΕΝ περνούν από
-- Paddle -- πληρώνει η εταιρεία (τιμολόγιο/συμβόλαιο, όχι συνδρομή ανά χρήστη).
CREATE TABLE IF NOT EXISTS team_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pilot' CHECK (status IN ('pilot', 'active', 'paused')),
  created_at TEXT NOT NULL
);

-- Ποιο email domain ανήκει σε ποια εταιρεία (για ανίχνευση από το email στο login, SSO
-- αργότερα). Ένα domain ανήκει σε ένα μόνο workspace.
CREATE TABLE IF NOT EXISTS team_domains (
  domain TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_domains_workspace ON team_domains(workspace_id);

-- Μέλη: admin, editor ή employee. email πάντα με πεζά (το εξασφαλίζει ο κώδικας) και
-- UNIQUE σε όλο τον πίνακα: αρχικά ένας άνθρωπος ανήκει σε ΕΝΑΝ οργανισμό (απλό login).
-- status 'disabled' = αποχώρησε/απενεργοποιήθηκε από τον admin (αποκλείεται στο login).
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'employee')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_members_workspace ON team_members(workspace_id);

-- Τμήματα. Το id πηγαίνει αυτούσιο στα metadata των vectors στο Vectorize (φίλτρο
-- department_id), άρα: μόνο λατινικά πεζά, αριθμοί, _ και -, μέχρι 40 χαρακτήρες (το
-- Vectorize ευρετηριάζει μόνο τα πρώτα 64 bytes ενός string, και κάθε ελληνικός χαρακτήρας
-- είναι 2 bytes). Το '_all' είναι δεσμευμένο για "όλη η εταιρεία" και δεν επιτρέπεται εδώ.
-- hidden = 1: το τμήμα είναι κρυφό για τους editors (το βλέπει μόνο ο admin).
-- ΣΗΜΕΙΩΣΗ: ότι ένα τμήμα ανήκει στο ίδιο workspace με τα μέλη του το ελέγχει ο κώδικας
-- (και τα tests), όχι η βάση.
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 40 AND id NOT GLOB '*[^a-z0-9_-]*' AND id <> '_all'),
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_departments_workspace ON departments(workspace_id);

-- Many-to-many από την αρχή: ένας υπάλληλος μπορεί να ανήκει σε περισσότερα από ένα τμήματα.
CREATE TABLE IF NOT EXISTS member_departments (
  member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (member_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_member_departments_department ON member_departments(department_id);

-- Sessions ομάδων: ξεχωριστά από τα sessions των SMB (πίνακας sessions), ώστε καμία αλλαγή
-- εδώ να μην επηρεάζει τη σύνδεση των υπαρχόντων πελατών. Σύντομη διάρκεια (ορίζεται από
-- τον κώδικα) ώστε να κόβεται σύντομα η πρόσβαση όταν κάποιος αποχωρεί.
CREATE TABLE IF NOT EXISTS team_sessions (
  token TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_sessions_member ON team_sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_team_sessions_expires_at ON team_sessions(expires_at);
