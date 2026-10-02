-- migrations\0016_team_clients.sql
-- Section W, βήμα 1 των "τοίχων" (2 Οκτ 2026): ΠΡΟΦΙΛ ΧΩΡΟΥ και ΠΕΛΑΤΕΣ (call center με πολλούς πελάτες).
--
-- Δύο είδη ορίων: ο ΤΟΙΧΟΣ (ανάμεσα σε πελάτες, π.χ. Apple και eFood: τίποτα δεν περνά, ούτε από λάθος) και ο ΦΡΑΧΤΗΣ (ανάμεσα
-- στα τμήματα του ίδιου πελάτη: ο διαμοιρασμός είναι φυσιολογικός). Ο χώρος έχει προφίλ: "company" (μία εταιρεία, χωρίς τοίχους,
-- όπως δουλεύει ήδη) ή "multi_client" (call center: κάθε πελάτης είναι τοίχος και τα τμήματά του ζουν μέσα του).
--
-- ΠΑΛΙ ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ (μόνο νέοι πίνακες, κανένα ALTER στα υπάρχοντα): ένα project που δεν έχει γραμμή στο team_project_clients
-- είναι "χωρίς πελάτη", όπως όλα σήμερα. Χωρίς αυτό το migration ο κώδικας δουλεύει όπως πριν (προφίλ company)· μόνο οι ενέργειες
-- πελατών δίνουν 503 clients_unavailable. ΣΕΙΡΑ DEPLOY: πρώτα το migration, μετά ο κώδικας.
--
-- Σημείωση ονομάτων: το departments.name είναι μοναδικό ανά workspace (UNIQUE) και δεν αλλάζει εδώ. Για ένα project πελάτη το name
-- γράφεται ως "<πελάτης> · <τμήμα>" (π.χ. "Apple · Customer Care"), ώστε δύο πελάτες να έχουν και οι δύο "Customer Care" χωρίς
-- σύγκρουση και το όνομα να δείχνει παντού (λίστες, πηγές απαντήσεων, αντιφάσεις) σε ποιον πελάτη ανήκει. Το σκέτο όνομα του τμήματος
-- κρατιέται στο short_name.

CREATE TABLE IF NOT EXISTS team_workspace_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES team_workspaces(id) ON DELETE CASCADE,
  profile TEXT NOT NULL DEFAULT 'company' CHECK (profile IN ('company', 'multi_client')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_clients (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 3 AND 40 AND id NOT GLOB '*[^a-z0-9_-]*'),
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_team_clients_workspace ON team_clients(workspace_id);

-- Σε ποιον πελάτη ανήκει ένα project. Διαγραφή project = διαγραφή της γραμμής. Ένας πελάτης με projects ΔΕΝ διαγράφεται (RESTRICT).
CREATE TABLE IF NOT EXISTS team_project_clients (
  project_id TEXT PRIMARY KEY REFERENCES departments(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES team_clients(id) ON DELETE RESTRICT,
  short_name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_project_clients_client ON team_project_clients(client_id);