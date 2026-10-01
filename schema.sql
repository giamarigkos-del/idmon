-- schema.sql
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
  agency_id TEXT REFERENCES agencies(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_agency ON users(agency_id);
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
-- (Notion/Slack/κλπ, με την ίδια δομή -- ο αρχικός Google Drive connector
-- που χρησιμοποίησε πρώτος αυτόν τον πίνακα αφαιρέθηκε 26 Σεπ 2026, βλ. git
-- history). Τα access_token/refresh_token πρέπει να αποθηκεύονται
-- κρυπτογραφημένα (AES-GCM), ποτέ σε απλό κείμενο -- ο βοηθητικός κώδικας
-- γι' αυτό αφαιρέθηκε μαζί με τον Drive connector, θα χρειαστεί να
-- ξαναγραφτεί για τον επόμενο provider που θα χρησιμοποιήσει τον πίνακα.
-- Προστέθηκε με τη migration 0003.
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

-- Section V: agency/reseller μοντέλο (δικό μας, Μοντέλο Β -- βλ. migration 0009 για πλήρες
-- σκεπτικό). agency_id σε κάθε workspace = ποιος developer το διαχειρίζεται, NULL αν κανένας.
-- current_tier είναι cache, ξαναϋπολογίζεται ζωντανά σε κάθε σχετικό webhook event.
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

-- Section W, πακέτο 4 (1 Οκτ 2026), φέτα 1: ΡΟΛΟΣ ΑΝΑ PROJECT.
--
-- ΠΡΙΝ: ένας ρόλος ανά άνθρωπο. Ένας editor ήταν editor σε ΟΛΑ του τα τμήματα.
-- ΜΕΤΑ: ο οργανισμός έχει δύο επίπεδα: (1) ρόλος οργανισμού (admin ή μέλος) και (2) ρόλος ανά project (μέλος ή editor).
-- Ένας team leader στο project Α μπορεί λοιπόν να είναι απλός πράκτορας στο Β (πρότυπο Guru, Slack, Zendesk).
--
-- Η συμμετοχή σε project παραμένει στο member_departments. Εδώ κρατιέται ΜΟΝΟ ποιοι είναι editors σε ποιο project.
-- Όποιος δεν έχει εγγραφή εδώ είναι απλό μέλος στο project (deny by default: κανένα δικαίωμα εγγραφής χωρίς ρητή ανάθεση).
--
-- ΠΑΛΙ ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ και ασφαλές να ξανατρέξει. Το backfill διατηρεί ΑΚΡΙΒΩΣ τα σημερινά δικαιώματα:
-- κάθε υπάρχων editor γίνεται editor σε όλα τα τμήματά του.

CREATE TABLE IF NOT EXISTS team_project_editors (
  member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_team_project_editors_project ON team_project_editors(project_id);

INSERT OR IGNORE INTO team_project_editors (member_id, project_id, created_at)
  SELECT md.member_id, md.department_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM member_departments md
    JOIN team_members m ON m.id = md.member_id
   WHERE m.role = 'editor';

--
-- ΠΡΙΝ: ένα έγγραφο ανήκε σε ΕΝΑ project (team_documents.department_id) ή σε όλη την εταιρεία ("_all").
-- ΜΕΤΑ: το department_id μένει ο ΙΔΙΟΚΤΗΤΗΣ (εκεί γράφεται και επεξεργάζεται). Επιπλέον, ένα έγγραφο μπορεί να έχει ΑΚΡΟΑΤΗΡΙΟ:
-- μια λίστα άλλων projects που το διαβάζουν (μέχρι 10 projects συνολικά, με τον ιδιοκτήτη).
--
-- Το Vectorize δέχεται ΜΙΑ τιμή metadata ανά πεδίο, άρα κάθε διαφορετικό σύνολο projects παίρνει ένα id, την "ομάδα ακροατηρίου"
-- (ag-<16 hex>, υπολογίζεται από τα projects), και αυτό γράφεται στο department_id των vectors. Ένα έγγραφο μόνο του ιδιοκτήτη
-- ΔΕΝ έχει γραμμή εδώ και τα vectors του κρατούν το id του project, όπως και πριν: τα υπάρχοντα vectors δεν αλλάζουν.
--
-- Το Vectorize είναι μόνο ΠΡΩΤΟ φίλτρο. Η αυθεντική απόφαση "ποιος διαβάζει ποιο έγγραφο" παίρνεται ΠΑΝΤΑ στη βάση, ανά έγγραφο
-- (deny by default).
--
-- ΠΑΛΙ ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ: μόνο νέοι πίνακες. Ο κώδικας δουλεύει (με το σημερινό μοντέλο, μόνο ο ιδιοκτήτης) και αν το migration
-- δεν έχει εφαρμοστεί ακόμα: μόνο η ΑΛΛΑΓΗ ακροατηρίου δίνει 503 audience_unavailable. ΣΕΙΡΑ DEPLOY: πρώτα το migration, μετά ο κώδικας.

-- Τα σύνολα projects (ομάδες ακροατηρίου). Το id προκύπτει από τα projects, άρα το ίδιο σύνολο δίνει πάντα την ίδια ομάδα.
CREATE TABLE IF NOT EXISTS team_audience_groups (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 19 AND substr(id, 1, 3) = 'ag-' AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_audience_groups_workspace ON team_audience_groups(workspace_id);

-- Ποια projects ανήκουν σε κάθε ομάδα (ο ιδιοκτήτης του εγγράφου περιλαμβάνεται πάντα).
CREATE TABLE IF NOT EXISTS team_audience_group_projects (
  group_id TEXT NOT NULL REFERENCES team_audience_groups(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_team_audience_group_projects_project ON team_audience_group_projects(project_id);

-- Ποιο έγγραφο έχει ποια ομάδα ακροατηρίου. Έγγραφο χωρίς γραμμή εδώ = μόνο ο ιδιοκτήτης. Διαγραφή εγγράφου = διαγραφή γραμμής.
CREATE TABLE IF NOT EXISTS team_document_audience (
  workspace_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES team_audience_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, document_id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES team_documents(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_document_audience_group ON team_document_audience(group_id);