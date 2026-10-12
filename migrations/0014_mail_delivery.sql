CREATE TABLE mail_messages(
  id TEXT PRIMARY KEY CHECK(length(id)=24),
  owner_sub TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('immediate','daily_digest')),
  state TEXT NOT NULL CHECK(state IN ('prepared','submitting','deferred','submission_unknown','accepted','delivered','bounced','complained','cancelled','rejected')),
  payload_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  recipient_hash TEXT NOT NULL CHECK(length(recipient_hash)=64),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_id TEXT UNIQUE,
  submitted_at INTEGER,
  accepted_at INTEGER,
  delivered_at INTEGER,
  bounced_at INTEGER,
  complained_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mail_due ON mail_messages(state,next_attempt_at,lease_until);
CREATE TABLE mail_items(
  message_id TEXT NOT NULL REFERENCES mail_messages(id),
  delivery_id TEXT NOT NULL REFERENCES user_deliveries(id),
  event_id TEXT NOT NULL REFERENCES content_events(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(message_id,delivery_id),
  UNIQUE(message_id,ordinal)
);
CREATE TABLE mail_webhook_receipts(
  id TEXT PRIMARY KEY,
  payload_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processed','ignored')),
  message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX mail_receipts_pending ON mail_webhook_receipts(state,received_at);
CREATE TABLE mail_suppressions(
  recipient_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK(reason IN ('bounced','complained')),
  provider_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
