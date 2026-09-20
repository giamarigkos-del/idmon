-- Migration 0008: idempotent Paddle customer/subscription mirror.
--
-- last_event_at is the Paddle event time used to reject stale deliveries.
-- These rows are durable live billing state and must not be deleted as test cleanup.
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

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer
  ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON subscriptions(status);
