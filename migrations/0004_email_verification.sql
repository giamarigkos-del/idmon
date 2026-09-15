-- Migration: email verification στο signup (should-fix-soon #2 του release
-- checklist)
--
-- email_verified: 0 = μη επιβεβαιωμένο (προεπιλογή για ΝΕΟΥΣ λογαριασμούς
-- από εδώ και πέρα), 1 = επιβεβαιωμένο. "Soft" verification -- ΔΕΝ μπλοκάρει
-- login/χρήση, απλά δείχνει ένα banner στο editor μέχρι να επιβεβαιωθεί.
--
-- Υπάρχοντες λογαριασμοί (πριν αυτό το migration) θεωρούνται ήδη
-- επιβεβαιωμένοι -- δεν έχει νόημα να τους δείξουμε ξαφνικά "unverified"
-- για κάτι που ήδη χρησιμοποιούσαν κανονικά πριν υπάρξει καν αυτό το
-- feature.

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

UPDATE users SET email_verified = 1;