PRAGMA foreign_keys=ON;

CREATE TABLE archive_migration_runs(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','blocked','failed')),
  batch_size INTEGER NOT NULL CHECK(batch_size BETWEEN 1 AND 100),
  last_article_id TEXT,
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)),
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE archive_migration_articles(
  run_id TEXT NOT NULL REFERENCES archive_migration_runs(id),
  article_id TEXT NOT NULL REFERENCES articles(id),
  revision_id TEXT REFERENCES article_revisions(id),
  task_id TEXT REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN ('imported','ready','blocked','failed','excluded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  comparison_json TEXT NOT NULL CHECK(json_valid(comparison_json)),
  differences_json TEXT NOT NULL CHECK(json_valid(differences_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,article_id),
  UNIQUE(article_id)
);

CREATE INDEX archive_migration_pending ON archive_migration_articles(run_id,state,article_id);
CREATE INDEX archive_migration_revision ON archive_migration_articles(revision_id);
