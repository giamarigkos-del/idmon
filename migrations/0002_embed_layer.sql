-- Migration: embed layer (embed_id + domain allow-list)
--
-- Η SQLite ΔΕΝ επιτρέπει να προσθέσεις UNIQUE constraint απευθείας μέσω
-- ALTER TABLE ADD COLUMN, γι' αυτό γίνεται σε 3 βήματα: (1) προσθήκη της
-- στήλης χωρίς constraint, (2) γέμισμα με τυχαία τιμή για ΟΠΟΙΟΝΔΗΠΟΤΕ ήδη
-- υπάρχοντα χρήστη (π.χ. τον δικό σου λογαριασμό), (3) unique index πάνω
-- στη στήλη -- από εδώ και πέρα η βάση η ίδια εγγυάται ότι δεν θα υπάρξουν
-- δύο ίδια embed_id.

ALTER TABLE users ADD COLUMN embed_id TEXT;

-- randomblob(6) -> 12 hex χαρακτήρες, ίδιο μέγεθος/ύφος με τα υπάρχοντα
-- ws-xxxxxxxxxxxx workspace_id (βλ. randomHex(12) στο index.js).
UPDATE users
SET embed_id = 'emb-' || lower(hex(randomblob(6)))
WHERE embed_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_embed_id ON users(embed_id);

-- Domain allow-list table (καινούργιο, δεν αφορά υπάρχοντα δεδομένα).
CREATE TABLE IF NOT EXISTS embed_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_embed_domains_workspace ON embed_domains(workspace_id);