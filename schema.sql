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
--
-- plan: Section Q -- free/basic/pro, ελέγχει τα πραγματικά όρια μηνυμάτων/
-- εγγράφων (βλ. PLAN_LIMITS στο src/index.js). Default 'basic' εδώ είναι
-- ασφαλές fallback για γραμμές χωρίς ρητή τιμή· το handleSignup εισάγει
-- πάντα ρητά plan='free' για νέες εγγραφές.
--
-- paddle_*: τα IDs και η κατάσταση της συνδρομής στο Paddle (merchant of
-- record). Όλα NULL για λογαριασμούς χωρίς πληρωμένη συνδρομή. Το
-- paddle_event_at κρατάει την ώρα (ISO 8601) του τελευταίου webhook που
-- επεξεργαστήκαμε, ώστε ένα παλιό γεγονός που φτάνει καθυστερημένα να
-- αγνοείται αντί να γυρίζει το plan πίσω. Το paddle_subscription_id είναι
-- μοναδικό, το paddle_customer_id όχι (ένας πελάτης μπορεί να αλλάξει
-- συνδρομή). Προστέθηκαν με τη migration 0007.
--
-- ΣΗΜΕΙΩΣΗ συντήρησης: αυτό το αρχείο είναι το πλήρες, τρέχον schema για
-- φρέσκο τοπικό setup (π.χ. νέο wrangler dev D1). Η production D1 φτάνει
-- στο ίδιο σημείο μέσω των migrations/*.sql, ένα-ένα, με σειρά. Κάθε φορά
-- που προστίθεται νέα migration, το ίδιο σχήμα πρέπει να αντικατοπτρίζεται
-- και ΕΔΩ -- τα δύο αρχεία συντηρούνται χειροκίνητα παράλληλα, κανένα
-- αυτόματο sync. Σημειώθηκε σε πλήρες audit, Σεπτέμβριος 2026.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  workspace_id TEXT UNIQUE NOT NULL,
  embed_id TEXT UNIQUE NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'basic',
  paddle_customer_id TEXT,
  paddle_subscription_id TEXT,
  paddle_status TEXT,
  paddle_event_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_paddle_customer ON users(paddle_customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_paddle_subscription ON users(paddle_subscription_id);

-- Durable Paddle state mirrored from verified webhook events. These rows are
-- live billing state, not disposable test data.
CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_at TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  price_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  scheduled_change_action TEXT,
  scheduled_change_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

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

-- connections: οι OAuth συνδέσεις κάθε workspace με κάθε εξωτερικό provider
-- (Google Drive πρώτα, Notion/Slack/κλπ αργότερα με την ίδια δομή). Τα
-- access_token/refresh_token αποθηκεύονται κρυπτογραφημένα (AES-GCM, βλ.
-- src/crypto-helpers.js), ποτέ σε απλό κείμενο. Προστέθηκε με τη migration
-- 0003.
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  connected_by_email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Ένα workspace μπορεί να έχει μόνο μία ενεργή σύνδεση ανά provider
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_workspace_provider
  ON connections (workspace_id, provider);