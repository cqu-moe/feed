PRAGMA foreign_keys=ON;

ALTER TABLE articles ADD COLUMN latest_observed_revision_id TEXT REFERENCES article_revisions(id);
ALTER TABLE articles ADD COLUMN latest_ready_revision_id TEXT REFERENCES article_revisions(id);
ALTER TABLE articles ADD COLUMN next_revision_no INTEGER NOT NULL DEFAULT 1 CHECK(next_revision_no>0);

CREATE TABLE artifact_objects(
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  r2_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK(byte_size>=0),
  media_type TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);
CREATE TABLE derived_outputs(
  id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL REFERENCES artifact_objects(sha256),
  processor TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  options_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL REFERENCES artifact_objects(sha256),
  completed_at INTEGER NOT NULL,
  UNIQUE(input_hash,processor,processor_version,options_hash)
);
CREATE TABLE article_revisions(
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id),
  revision_no INTEGER NOT NULL CHECK(revision_no>0),
  previous_revision_id TEXT REFERENCES article_revisions(id),
  capture_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  observed_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('assembling','ready','blocked')),
  requirement_generation INTEGER NOT NULL DEFAULT 1,
  requirement_count INTEGER NOT NULL CHECK(requirement_count>0),
  manifest_object_hash TEXT NOT NULL REFERENCES artifact_objects(sha256),
  raw_fingerprint TEXT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  fingerprint_version TEXT NOT NULL DEFAULT 'body-files-v1',
  change_kind TEXT NOT NULL CHECK(change_kind IN ('baseline','substantive','presentation_only','unclassified')),
  title TEXT NOT NULL,
  published_at TEXT,
  source_metadata_json TEXT NOT NULL CHECK(json_valid(source_metadata_json)),
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(diagnostics_json)),
  ready_at INTEGER,
  UNIQUE(article_id,revision_no),
  CHECK((state='ready' AND ready_at IS NOT NULL) OR (state<>'ready' AND ready_at IS NULL))
);
CREATE INDEX revisions_history ON article_revisions(article_id,revision_no DESC);
CREATE TABLE revision_requirements(
  revision_id TEXT NOT NULL REFERENCES article_revisions(id),
  slot_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('body','snapshot','attachment','body_pdf','body_ocr','screenshot')),
  original_url TEXT,
  filename TEXT,
  name TEXT,
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('pending','fulfilled','failed')),
  object_hash TEXT REFERENCES artifact_objects(sha256),
  input_hash TEXT REFERENCES artifact_objects(sha256),
  derived_output_id TEXT REFERENCES derived_outputs(id),
  fetched_at INTEGER,
  error_code TEXT,
  PRIMARY KEY(revision_id,slot_key),
  CHECK(state<>'fulfilled' OR object_hash IS NOT NULL OR derived_output_id IS NOT NULL)
);
CREATE INDEX requirements_pending ON revision_requirements(revision_id,required,state);
CREATE TABLE capture_observations(
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  article_id TEXT NOT NULL REFERENCES articles(id),
  revision_id TEXT NOT NULL REFERENCES article_revisions(id),
  observed_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('new','unchanged'))
);
CREATE TABLE article_read_models(
  article_id TEXT PRIMARY KEY REFERENCES articles(id),
  revision_id TEXT NOT NULL REFERENCES article_revisions(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  readable_text TEXT NOT NULL,
  extraction_generation INTEGER NOT NULL DEFAULT 1
);
CREATE TRIGGER preserve_ready_revisions BEFORE UPDATE ON article_revisions WHEN OLD.state='ready'
BEGIN SELECT RAISE(ABORT,'ready_revision_is_immutable'); END;
CREATE TRIGGER preserve_all_revisions BEFORE DELETE ON article_revisions
BEGIN SELECT RAISE(ABORT,'revision_retention_required'); END;
CREATE TRIGGER preserve_original_requirements BEFORE UPDATE ON revision_requirements
WHEN EXISTS(SELECT 1 FROM article_revisions WHERE id=OLD.revision_id AND state='ready')
 OR OLD.revision_id IS NOT NEW.revision_id OR OLD.slot_key IS NOT NEW.slot_key
 OR OLD.kind IS NOT NEW.kind OR OLD.required IS NOT NEW.required
 OR OLD.original_url IS NOT NEW.original_url OR OLD.filename IS NOT NEW.filename
 OR OLD.name IS NOT NEW.name OR OLD.input_hash IS NOT NEW.input_hash
 OR (OLD.object_hash IS NOT NULL AND OLD.object_hash IS NOT NEW.object_hash)
BEGIN SELECT RAISE(ABORT,'revision_requirement_is_immutable'); END;
CREATE TRIGGER preserve_requirement_inventory BEFORE DELETE ON revision_requirements
BEGIN SELECT RAISE(ABORT,'revision_requirement_retention_required'); END;
CREATE TRIGGER preserve_ready_inventory BEFORE INSERT ON revision_requirements
WHEN EXISTS(SELECT 1 FROM article_revisions WHERE id=NEW.revision_id AND state='ready')
BEGIN SELECT RAISE(ABORT,'ready_requirement_inventory_is_immutable'); END;
CREATE TRIGGER preserve_artifact_objects BEFORE UPDATE ON artifact_objects
BEGIN SELECT RAISE(ABORT,'artifact_object_is_immutable'); END;
CREATE TRIGGER preserve_derived_outputs BEFORE UPDATE ON derived_outputs
BEGIN SELECT RAISE(ABORT,'derived_output_is_immutable'); END;
CREATE VIRTUAL TABLE article_read_search USING fts5(id UNINDEXED,title,readable_text,tokenize='trigram');
CREATE TRIGGER read_model_insert AFTER INSERT ON article_read_models BEGIN
  INSERT INTO article_read_search(id,title,readable_text) VALUES(new.article_id,new.title,new.readable_text);
END;
CREATE TRIGGER read_model_update AFTER UPDATE ON article_read_models BEGIN
  DELETE FROM article_read_search WHERE id=old.article_id;
  INSERT INTO article_read_search(id,title,readable_text) VALUES(new.article_id,new.title,new.readable_text);
END;
CREATE TRIGGER read_model_delete AFTER DELETE ON article_read_models BEGIN
  DELETE FROM article_read_search WHERE id=old.article_id;
END;
