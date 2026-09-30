-- Section W, Φέτες 2-4 (30 Σεπ 2026): εισερχόμενα editor (αντιφάσεις, updates) και audit log.
--
-- ΠΑΛΙ ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ: μόνο νέοι πίνακες. Δεν αγγίζει users/sessions ή οτιδήποτε του SMB.
-- Τα έγγραφα ζουν στο KV, γι' αυτό εδώ κρατάμε μόνο αναφορές (document id) και όχι το κείμενό τους.

-- Αντιφάσεις που βρέθηκαν αυτόματα όταν δημοσιεύεται ή αλλάζει ένα έγγραφο.
-- doc_a/doc_b: ταξινομημένα (doc_a < doc_b) ώστε το ίδιο ζευγάρι να έχει πάντα το ίδιο
-- fingerprint, άρα να μη δημιουργείται διπλότυπο όταν ξανατρέχει ο έλεγχος.
-- quote_a/quote_b: οι ακριβείς προτάσεις που συγκρούονται (επαληθεύονται στον κώδικα ότι
-- υπάρχουν πράγματι στα κείμενα, ώστε το LLM να μην "επινοεί" αντιφάσεις).
-- Το τμήμα κάθε εγγράφου ΔΕΝ αποθηκεύεται εδώ: διαβάζεται ζωντανά από το έγγραφο, οπότε
-- μια μεταφορά εγγράφου σε άλλο τμήμα δεν αφήνει ξεπερασμένα δεδομένα.
-- status: open (χρειάζεται δουλειά), resolved (λύθηκε: το κείμενο άλλαξε ή το έγγραφο
-- διαγράφηκε), dismissed (ο editor είπε "δεν είναι αντίφαση", δεν ξαναδημιουργείται).
CREATE TABLE IF NOT EXISTS team_contradictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  doc_a TEXT NOT NULL,
  quote_a TEXT NOT NULL,
  doc_b TEXT NOT NULL,
  quote_b TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL,
  notified_at TEXT,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  resolution TEXT,
  UNIQUE (workspace_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_team_contradictions_status ON team_contradictions(workspace_id, status);

-- Updates (συμπληρώματα) πάνω σε ένα βασικό έγγραφο, που περιμένουν ενσωμάτωση.
-- Μέχρι να ενσωματωθούν είναι ήδη αναζητήσιμα (ξεχωριστά vectors με τη σήμανση
-- "πρόσφατη ενημέρωση") και φαίνονται στους υπαλλήλους. Η ενσωμάτωση γίνεται ΠΑΝΤΑ με έγκριση
-- editor: το proposed_text είναι μόνο πρόταση του συστήματος, δεν εφαρμόζεται μόνο του.
CREATE TABLE IF NOT EXISTS team_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
  proposed_text TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  resolved_by INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_team_updates_status ON team_updates(workspace_id, status, document_id);

-- Ιστορικό ενεργειών, ορατό μόνο στον admin. actor_email κρατιέται αυτούσιο ώστε το ιστορικό
-- να παραμένει κατανοητό ακόμα κι όταν διαγραφεί ένα μέλος. Δεν καταγράφονται ποτέ ερωτήσεις
-- υπαλλήλων προς τον βοηθό (μόνο διαχειριστικές ενέργειες), ώστε να μην γίνει εργαλείο
-- παρακολούθησης προσωπικού.
CREATE TABLE IF NOT EXISTS team_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_audit_log_workspace ON team_audit_log(workspace_id, created_at);
