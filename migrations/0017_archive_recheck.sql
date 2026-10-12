PRAGMA foreign_keys=ON;

ALTER TABLE articles ADD COLUMN next_recheck_at INTEGER NOT NULL DEFAULT 0 CHECK(next_recheck_at>=0);

CREATE INDEX articles_recheck_due
  ON articles(next_recheck_at,id)
  WHERE latest_ready_revision_id IS NOT NULL;
