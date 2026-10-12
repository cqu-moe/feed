PRAGMA foreign_keys=ON;

ALTER TABLE articles ADD COLUMN next_recheck_at INTEGER NOT NULL DEFAULT 0 CHECK(next_recheck_at>=0);

CREATE INDEX articles_recheck_due
  ON articles(next_recheck_at,id)
  WHERE latest_ready_revision_id IS NOT NULL;

CREATE TABLE archive_recheck_cursor (
  id INTEGER PRIMARY KEY CHECK(id=1),
  due_at INTEGER NOT NULL DEFAULT 0,
  article_id TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL DEFAULT 0
);

INSERT INTO archive_recheck_cursor(id) VALUES (1);
