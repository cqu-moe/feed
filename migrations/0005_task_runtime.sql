PRAGMA foreign_keys=ON;

CREATE TABLE tasks(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('discover','capture','ocr','match-event','backfill','recheck','migration')),
  business_key TEXT NOT NULL UNIQUE,
  source_id TEXT REFERENCES sources(id),
  article_id TEXT REFERENCES articles(id),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  state TEXT NOT NULL CHECK(state IN ('queued','starting','running','succeeded','deferred','blocked','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  due_at INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL DEFAULT 1 CHECK(attempt_no BETWEEN 1 AND 1000),
  checkpoint_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_due ON tasks(state,due_at,priority,id);
CREATE INDEX tasks_article ON tasks(article_id,created_at);

CREATE TABLE task_attempts(
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_no INTEGER NOT NULL,
  workflow_instance_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('starting','running','succeeded','failed','deferred','blocked','cancelled')),
  started_at INTEGER,
  handed_off_at INTEGER,
  ended_at INTEGER,
  result_json TEXT,
  error_code TEXT,
  PRIMARY KEY(task_id,attempt_no)
);
CREATE TABLE outbox(
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL CHECK(topic IN ('feed-jobs','feed-events','feed-mail')),
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  available_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(topic,dedupe_key)
);
CREATE INDEX outbox_due ON outbox(state,available_at,id);
ALTER TABLE articles ADD COLUMN capture_fence INTEGER NOT NULL DEFAULT 0;
