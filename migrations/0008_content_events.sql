PRAGMA foreign_keys=ON;

ALTER TABLE revision_requirements ADD COLUMN processor TEXT;
ALTER TABLE revision_requirements ADD COLUMN processor_version TEXT;
ALTER TABLE revision_requirements ADD COLUMN options_hash TEXT;
ALTER TABLE article_read_models ADD COLUMN ocr_result_hash TEXT REFERENCES artifact_objects(sha256);
ALTER TABLE article_read_models ADD COLUMN ocr_model TEXT;
ALTER TABLE article_read_models ADD COLUMN ocr_updated_at TEXT;

CREATE TABLE content_events(
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL UNIQUE REFERENCES article_revisions(id),
  article_id TEXT NOT NULL REFERENCES articles(id),
  kind TEXT NOT NULL CHECK(kind IN ('initial','update')),
  observed_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  history_only INTEGER NOT NULL DEFAULT 0 CHECK(history_only IN (0,1)),
  date_state TEXT NOT NULL DEFAULT 'verified' CHECK(date_state IN ('verified','date_unknown')),
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX content_events_ready ON content_events(ready_at,id);
CREATE INDEX content_events_article ON content_events(article_id,ready_at,id);

CREATE TABLE event_sources(
  event_id TEXT NOT NULL REFERENCES content_events(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  article_source_first_seen_at INTEGER NOT NULL,
  discovery_class TEXT NOT NULL CHECK(discovery_class IN ('live','backfill','migrated')),
  published_at TEXT,
  published_day TEXT,
  date_precision TEXT NOT NULL CHECK(date_precision IN ('unknown','day','minute')),
  source_timezone TEXT NOT NULL,
  PRIMARY KEY(event_id,source_id)
);
CREATE INDEX event_sources_source ON event_sources(source_id,event_id);

CREATE TRIGGER preserve_content_events BEFORE UPDATE ON content_events
BEGIN SELECT RAISE(ABORT,'content_event_is_immutable'); END;
CREATE TRIGGER preserve_content_events_delete BEFORE DELETE ON content_events
BEGIN SELECT RAISE(ABORT,'content_event_retention_required'); END;
CREATE TRIGGER preserve_event_sources_delete BEFORE DELETE ON event_sources
BEGIN SELECT RAISE(ABORT,'event_source_retention_required'); END;

CREATE TRIGGER preserve_event_sources BEFORE UPDATE ON event_sources
BEGIN SELECT RAISE(ABORT,'event_source_is_immutable'); END;

CREATE TRIGGER preserve_requirement_processing BEFORE UPDATE ON revision_requirements
WHEN OLD.processor IS NOT NEW.processor
 OR OLD.processor_version IS NOT NEW.processor_version
 OR OLD.options_hash IS NOT NEW.options_hash
BEGIN SELECT RAISE(ABORT,'revision_requirement_processing_is_immutable'); END;
