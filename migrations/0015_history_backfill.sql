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
