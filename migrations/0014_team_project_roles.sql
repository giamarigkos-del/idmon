-- migrations\0014_team_project_roles.sql
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