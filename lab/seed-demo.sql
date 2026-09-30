-- Δοκιμαστικά δεδομένα για το lab (idmon-lab). Τρέχει ΜΟΝΟ στη βάση του lab, ποτέ στο production.
-- Ασφαλές να ξανατρέξει (INSERT OR IGNORE): δεν δημιουργεί διπλότυπα.
--
-- Τα emails είναι aliases του Gmail σου (giamarigkos+ρόλος@gmail.com): φτάνουν όλα στο ίδιο
-- inbox, αλλά για το σύστημα είναι διαφορετικοί άνθρωποι. Έτσι δοκιμάζεις κάθε ρόλο.
--
--   admin    -> βλέπει και γράφει τα πάντα (και το κρυφό τμήμα HR)
--   editor   -> Customer Care: γράφει στο δικό του τμήμα, διαβάζει τα άλλα (όχι το κρυφό)
--   agent    -> υπάλληλος Customer Care: βλέπει μόνο Customer Care + εταιρικά
--   finance  -> υπάλληλος Finance: βλέπει μόνο Finance + εταιρικά

INSERT OR IGNORE INTO team_workspaces (id, name, status, created_at)
VALUES ('team-demo', 'Εταιρεία Demo', 'pilot', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO departments (id, workspace_id, name, hidden, created_at) VALUES
  ('cc',  'team-demo', 'Customer Care', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('fin', 'team-demo', 'Finance',       0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('hr',  'team-demo', 'HR',            1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO team_members (workspace_id, email, role, status, created_at) VALUES
  ('team-demo', 'giamarigkos+admin@gmail.com',   'admin',    'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('team-demo', 'giamarigkos+editor@gmail.com',  'editor',   'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('team-demo', 'giamarigkos+agent@gmail.com',   'employee', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('team-demo', 'giamarigkos+finance@gmail.com', 'employee', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO member_departments (member_id, department_id)
  SELECT id, 'cc' FROM team_members
   WHERE email IN ('giamarigkos+editor@gmail.com', 'giamarigkos+agent@gmail.com');

INSERT OR IGNORE INTO member_departments (member_id, department_id)
  SELECT id, 'fin' FROM team_members WHERE email = 'giamarigkos+finance@gmail.com';
