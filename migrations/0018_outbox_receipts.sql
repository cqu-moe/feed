PRAGMA foreign_keys=ON;

CREATE TABLE outbox_receipts(
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(id),
  topic TEXT NOT NULL CHECK(topic IN ('feed-jobs','feed-events','feed-mail')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK(replay_count>=0),
  last_error TEXT,
  processed_at INTEGER,
  last_replayed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX outbox_receipts_diagnostics ON outbox_receipts(topic,state,updated_at,outbox_id);
