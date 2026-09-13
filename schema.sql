-- Section H: λογαριασμοί πελατών + sessions.
--
-- users: ένας λογαριασμός ανά email. Το workspace_id είναι το ίδιο workspace
-- που ήδη χρησιμοποιεί ΟΛΟΣ ο υπόλοιπος κώδικας (KV, Vectorize namespace,
-- κλπ) -- τα accounts απλά δίνουν έναν σωστό, ασφαλή τρόπο να το αποκτήσεις,
-- δεν αλλάζουν πώς χρησιμοποιείται παρακάτω.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  workspace_id TEXT UNIQUE NOT NULL,
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