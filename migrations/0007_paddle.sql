-- Migration 0007: στήλες Paddle στον πίνακα users.
--
-- Το Paddle (merchant of record) κρατάει τα δικά του IDs για κάθε πελάτη και
-- κάθε συνδρομή. Τα αποθηκεύουμε εδώ ώστε ένα webhook που φτάνει μόνο με
-- IDs του Paddle να μπορεί να ταιριάξει με τον σωστό λογαριασμό Idmon, και
-- ώστε να μπορούμε αργότερα να ακυρώσουμε/αλλάξουμε πλάνο.
--
-- Όλες οι στήλες είναι NULL για τους υπάρχοντες λογαριασμούς (Free, ή
-- Basic/Pro που δόθηκαν χειροκίνητα), άρα η migration δεν αλλάζει τίποτα
-- για αυτούς.
--
-- paddle_event_at: ώρα (ISO 8601, όπως την στέλνει το Paddle) του τελευταίου
-- webhook που επεξεργαστήκαμε. Το Paddle μπορεί να στείλει γεγονότα με λάθος
-- σειρά, οπότε αγνοούμε ό,τι είναι παλαιότερο από αυτό που ήδη ξέρουμε.
--
-- Κάθε ADD COLUMN γίνεται ξεχωριστά (περιορισμός της SQLite). Το UNIQUE
-- μπαίνει με ξεχωριστό index, όχι μέσα στη στήλη.

ALTER TABLE users ADD COLUMN paddle_customer_id TEXT;
ALTER TABLE users ADD COLUMN paddle_subscription_id TEXT;
ALTER TABLE users ADD COLUMN paddle_status TEXT;
ALTER TABLE users ADD COLUMN paddle_event_at TEXT;

-- Ένας πελάτης μπορεί να αλλάξει συνδρομή, οπότε το customer_id ΔΕΝ είναι
-- μοναδικό. Απλό index, μόνο για γρήγορη αναζήτηση.
CREATE INDEX IF NOT EXISTS idx_users_paddle_customer
  ON users (paddle_customer_id);

-- Μία συνδρομή ανήκει σε έναν μόνο λογαριασμό. Οι NULL δεν συγκρούονται
-- μεταξύ τους στην SQLite, άρα οι λογαριασμοί χωρίς συνδρομή δεν πειράζουν.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_paddle_subscription
  ON users (paddle_subscription_id);