PRAGMA foreign_keys=ON;

ALTER TABLE sources ADD COLUMN backfill_state TEXT NOT NULL DEFAULT 'idle'
  CHECK(backfill_state IN ('idle','running','paused','completed','failed'));
ALTER TABLE sources ADD COLUMN backfill_window_days INTEGER
  CHECK(backfill_window_days IS NULL OR backfill_window_days BETWEEN 1 AND 3650);
ALTER TABLE sources ADD COLUMN backfill_window_start TEXT;
ALTER TABLE sources ADD COLUMN backfill_run_id TEXT;
ALTER TABLE sources ADD COLUMN backfill_next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN backfill_started_at INTEGER;
ALTER TABLE sources ADD COLUMN backfill_completed_at INTEGER;
ALTER TABLE sources ADD COLUMN backfill_seen_pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN backfill_processed_articles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN backfill_last_error TEXT;

CREATE INDEX sources_backfill_due
  ON sources(backfill_state,backfill_next_at,id)
  WHERE backfill_state='running';

ALTER TABLE sources ADD COLUMN backfill_max_pages INTEGER NOT NULL DEFAULT 100
  CHECK(backfill_max_pages BETWEEN 1 AND 1000);

CREATE TABLE backfill_seen_articles(
  source_id TEXT NOT NULL REFERENCES sources(id),
  run_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id),
  PRIMARY KEY(source_id,run_id,article_id)
);

CREATE TABLE discovery_admissions(
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_no INTEGER NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('discover','backfill')),
  slot INTEGER NOT NULL,
  admitted_at INTEGER NOT NULL,
  PRIMARY KEY(task_id,attempt_no)
);
CREATE INDEX discovery_admissions_budget ON discovery_admissions(lane,slot);

ALTER TABLE tasks ADD COLUMN backfill_retry_from INTEGER NOT NULL DEFAULT 1
  CHECK(backfill_retry_from BETWEEN 1 AND 1000);

ALTER TABLE sources ADD COLUMN backfill_window_end TEXT;
