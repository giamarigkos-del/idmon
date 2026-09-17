-- Migration: password_iterations στήλη (audit finding, Σεπτέμβριος 2026)
--
-- Το PBKDF2_ITERATIONS στο index.js ανέβηκε από 100.000 σε 600.000
-- (τρέχον OWASP recommendation για PBKDF2-SHA256). Δεν μπορούμε απλά να
-- αλλάξουμε τον αριθμό και να αφήσουμε τους υπάρχοντες hashes ως έχουν --
-- το ίδιο password με διαφορετικό αριθμό iterations βγάζει διαφορετικό
-- hash, θα έσπαγε το login για κάθε υπάρχοντα λογαριασμό.
--
-- DEFAULT 100000 εδώ σκόπιμα -- ό,τι λογαριασμός υπάρχει ήδη έγινε hash με
-- το παλιό νούμερο, αυτό πρέπει να συνεχίσει να ισχύει γι' αυτόν μέχρι να
-- κάνει reset password (οπότε παίρνει αυτόματα το νέο, υψηλότερο νούμερο,
-- βλ. handleResetPassword). Νέοι λογαριασμοί (handleSignup) γράφουν ρητά
-- 600000 σε αυτή τη στήλη, δεν βασίζονται στο DEFAULT.

ALTER TABLE users ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 100000;