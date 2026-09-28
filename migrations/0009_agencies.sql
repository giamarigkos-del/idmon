-- Section V (28 Σεπ 2026): agency/reseller μοντέλο (Μοντέλο Β, δικό μας, όχι τρίτο εργαλείο).
--
-- agencies: ένας developer/agency = μία γραμμή. agency_code είναι ό,τι δίνει ο developer
-- στους δικούς του πελάτες (χειροκίνητα, στη φόρμα εγγραφής -- ΟΧΙ μέσω cookie/link, ώστε
-- να μην χάνεται ποτέ attribution σε cross-device σενάρια, βλ. συζήτηση 28 Σεπ 2026).
-- current_tier ΔΕΝ αποθηκεύεται σαν πηγή αλήθειας -- ξαναϋπολογίζεται ζωντανά
-- (computeAgencyTier() στο src/index.js) σε κάθε webhook event που αφορά workspace με
-- agency_id. Η στήλη εδώ είναι μόνο cache για να μην ξαναμετράμε σε κάθε read, ενημερώνεται
-- ρητά κάθε φορά που τρέχει το recompute.
CREATE TABLE IF NOT EXISTS agencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  agency_code TEXT UNIQUE NOT NULL,
  current_tier INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agencies_code ON agencies(agency_code);

-- users.agency_id: ποιος developer "κατέχει" (διαχειρίζεται) αυτό το workspace, αν κανένας.
-- NULL = απευθείας πελάτης λιανικής, όπως όλοι μέχρι τώρα.
-- Grandfathering (απόφαση 28 Σεπ 2026): η τιμή χρέωσης ενός workspace ΔΕΝ αλλάζει
-- αναδρομικά όταν αλλάζει το tier του agency -- η νέα τιμή ισχύει μόνο για νέα workspaces
-- που προστίθενται μετά την αλλαγή. Το πεδίο που "κλειδώνει" αυτή την τιμή είναι το ήδη
-- υπάρχον users.paddle_subscription_id/price_id, όχι κάτι νέο εδώ.
ALTER TABLE users ADD COLUMN agency_id TEXT REFERENCES agencies(id);

CREATE INDEX IF NOT EXISTS idx_users_agency ON users(agency_id);