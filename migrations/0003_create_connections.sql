-- Migration: δημιουργία πίνακα connections
-- Κρατάει τις OAuth συνδέσεις κάθε workspace με κάθε εξωτερικό provider
-- (Google Drive πρώτα, Notion/Slack/κλπ αργότερα ίδια δομή)

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