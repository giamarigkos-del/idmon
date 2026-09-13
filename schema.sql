-- Section H: λογαριασμοί πελατών + sessions.
--
-- users: ένας λογαριασμός ανά email. Το workspace_id είναι το ίδιο workspace
-- που ήδη χρησιμοποιεί ΟΛΟΣ ο υπόλοιπος κώδικας (KV, Vectorize namespace,
-- κλπ) -- τα accounts απλά δίνουν έναν σωστό, ασφαλή τρόπο να το αποκτήσεις,
-- δεν αλλάζουν πώς χρησιμοποιείται παρακάτω.
--
-- embed_id: ΞΕΧΩΡΙΣΤΟ από το workspace_id. Το workspace_id είναι εσωτερικό
-- και ΔΕΝ πρέπει ποτέ να εμφανίζεται σε δημόσιο κώδικα. Το embed_id είναι
-- φτιαγμένο ρητά για να είναι δημόσιο -- μπαίνει μέσα στο <script> tag που
-- θα βλέπει ο καθένας αν κάνει view-source στο site του πελάτη. Ο Worker
-- το μεταφράζει εσωτερικά σε workspace_id.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  workspace_id TEXT UNIQUE NOT NULL,
  embed_id TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

-- sessions: το token είναι το μόνο πράγμα που κρατάει ο browser. ΠΟΤΕ δεν
-- ξαναδημιουργείται/μαντεύεται από τον client -- υπάρχει ΜΟΝΟ αν το server
-- το δημιούργησε ρητά σε ένα login. Το logout είναι απλά DELETE αυτής της
-- γραμμής, οπότε γίνεται αμέσως άκυρο.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Section I: embed layer -- domain allow-list ανά workspace.
--
-- Ένας πελάτης μπορεί να έχει παραπάνω από ένα domain (π.χ. με και χωρίς
-- www.), γι' αυτό ξεχωριστό table αντί για ένα πεδίο στο users. Χωρίς ΚΑΝΕΝΑ
-- domain καταχωρημένο, το section "Embed στο site σου" στο editor δεν
-- εμφανίζει καν το script tag -- το domain είναι υποχρεωτικό πριν
-- εκτεθεί οτιδήποτε δημόσια.
CREATE TABLE IF NOT EXISTS embed_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_embed_domains_workspace ON embed_domains(workspace_id);