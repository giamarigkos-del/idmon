-- migrations\0012_team_extras.sql
-- Section W, πακέτο 2 (1 Οκτ 2026): αυτόματος επανέλεγχος αντιφάσεων, ημερήσια όρια χρήσης, αναφορές υπαλλήλων.
-- ΠΑΛΙ ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ: μόνο νέοι πίνακες. Ο κώδικας δουλεύει (χωρίς τα νέα χαρακτηριστικά) και αν το
-- migration δεν έχει εφαρμοστεί ακόμα: κάθε χρήση των πινάκων αυτών προστατεύεται και δεν χαλά ποτέ τις υπάρχουσες λειτουργίες.

-- Επανέλεγχος αντιφάσεων λίγα λεπτά μετά από κάθε αποθήκευση εγγράφου. Το Vectorize χρειάζεται λίγο χρόνο μέχρι να
-- "δει" ένα νέο έγγραφο, οπότε ο άμεσος έλεγχος μπορεί να μη βρει υποψήφια. Το origin κρατιέται για τον σύνδεσμο στα
-- emails ειδοποίησης (ο επανέλεγχος τρέχει από cron, χωρίς request).
CREATE TABLE IF NOT EXISTS team_rechecks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  due_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_team_rechecks_due ON team_rechecks(done_at, due_at);

-- Μετρητές χρήσης ανά μέλος και ημέρα (UTC), για ημερήσιο όριο ερωτήσεων και αναφορών (έλεγχος κόστους και κατάχρησης).
-- Μετρούν ΜΟΝΟ πόσες φορές, ποτέ τι ρώτησε κάποιος.
CREATE TABLE IF NOT EXISTS team_usage (
  member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, day, kind)
);

-- Αναφορές υπαλλήλων προς τον editor ("η απάντηση ήταν λάθος / ξεπερασμένη"). ΔΕΝ αποθηκεύεται ταυτότητα του υπαλλήλου,
-- μόνο το έγγραφο, το είδος, προαιρετική σημείωση και η ερώτηση (όπως και στις αναπάντητες ερωτήσεις).
CREATE TABLE IF NOT EXISTS team_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wrong', 'outdated', 'unclear')),
  question TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by INTEGER REFERENCES team_members(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_team_feedback_open ON team_feedback(workspace_id, status, document_id);