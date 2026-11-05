-- D1 owns visibility. Mutations only increment a small per-notice generation;
-- no trigger calls Bailian or changes the archive/notification lifecycle.
CREATE TABLE bailian_notices (
  article_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1,
  projected INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, error TEXT, blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bailian_dirty ON bailian_notices(next_at,article_id) WHERE projected<>generation AND blocked=0;
CREATE TABLE bailian_files (
  id TEXT PRIMARY KEY, article_id TEXT NOT NULL, generation INTEGER NOT NULL,
  slot TEXT NOT NULL, revision_id TEXT, filename TEXT, label TEXT NOT NULL,
  fingerprint TEXT NOT NULL, evidence_key TEXT, text_key TEXT, tags TEXT NOT NULL DEFAULT '[]',
  file_id TEXT UNIQUE, job_id TEXT, state TEXT NOT NULL, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
  UNIQUE(article_id,generation,slot)
);
CREATE INDEX bailian_article_files ON bailian_files(article_id,generation);
CREATE INDEX bailian_file_work ON bailian_files(next_at,state) WHERE blocked=0;
CREATE TABLE bailian_control (
  id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0,
  backfill TEXT NOT NULL DEFAULT 'paused', cursor TEXT NOT NULL DEFAULT '',
  cooldown_until INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO bailian_control(id) VALUES(1);

CREATE TRIGGER bailian_new_article AFTER INSERT ON articles
WHEN NEW.status='complete'
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(NEW.id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_article_change AFTER UPDATE OF latest_ready_revision_id,latest_observed_revision_id,status,title,published_at,source_id,body_text,ocr_result_key,prefix,snapshot_key ON articles
WHEN NEW.latest_ready_revision_id IS NOT OLD.latest_ready_revision_id OR NEW.latest_observed_revision_id IS NOT OLD.latest_observed_revision_id OR NEW.status IS NOT OLD.status OR NEW.title IS NOT OLD.title OR NEW.published_at IS NOT OLD.published_at OR NEW.source_id IS NOT OLD.source_id OR NEW.body_text IS NOT OLD.body_text OR NEW.ocr_result_key IS NOT OLD.ocr_result_key OR NEW.prefix IS NOT OLD.prefix OR NEW.snapshot_key IS NOT OLD.snapshot_key
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(NEW.id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_article_delete AFTER DELETE ON articles
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(OLD.id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_read_insert AFTER INSERT ON article_read_models
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(NEW.article_id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_read_delete AFTER DELETE ON article_read_models
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(OLD.article_id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_read_update AFTER UPDATE OF title,revision_id,extraction_generation,readable_text ON article_read_models
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(NEW.article_id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_membership_insert AFTER INSERT ON article_sources
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(NEW.article_id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_membership_delete AFTER DELETE ON article_sources
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(OLD.article_id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_attachment_insert AFTER INSERT ON attachments
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(NEW.article_id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_attachment_delete AFTER DELETE ON attachments
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(OLD.article_id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_attachment_update AFTER UPDATE OF status,object_key,filename,name,role ON attachments
BEGIN
  INSERT INTO bailian_notices(article_id) VALUES(NEW.article_id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

CREATE TRIGGER bailian_site_membership AFTER UPDATE OF site_id ON sources
WHEN NEW.site_id IS NOT OLD.site_id
BEGIN
  INSERT INTO bailian_notices(article_id) SELECT a.id FROM articles a WHERE a.source_id=NEW.id OR EXISTS(SELECT 1 FROM article_sources x WHERE x.article_id=a.id AND x.source_id=NEW.id)
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,attempts=0,next_at=0,error=NULL,blocked=0;
END;

-- An existing OCR result can arrive after the PDF was first indexed.
CREATE INDEX bailian_attachment_hash ON attachments(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX bailian_requirement_hash ON revision_requirements(object_hash) WHERE object_hash IS NOT NULL;
CREATE INDEX bailian_ocr_hash ON pdf_ocr_jobs(source_hash,model,status);
CREATE TRIGGER bailian_ocr_complete AFTER UPDATE OF result_key,status ON pdf_ocr_jobs WHEN NEW.status='complete' AND (NEW.result_key IS NOT OLD.result_key OR NEW.status IS NOT OLD.status)
BEGIN
  INSERT INTO bailian_notices(article_id) SELECT a.id FROM attachments t JOIN articles a ON a.id=t.article_id WHERE t.sha256=NEW.source_hash AND a.latest_observed_revision_id IS NULL
    UNION SELECT a.id FROM revision_requirements q JOIN articles a ON a.latest_ready_revision_id=q.revision_id WHERE q.object_hash=NEW.source_hash
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,next_at=0,attempts=0,error=NULL,blocked=0;
END;
CREATE TRIGGER bailian_derived AFTER INSERT ON derived_outputs
BEGIN
  INSERT INTO bailian_notices(article_id) SELECT a.id FROM attachments t JOIN articles a ON a.id=t.article_id WHERE t.sha256=NEW.input_hash AND a.latest_observed_revision_id IS NULL
    UNION SELECT a.id FROM revision_requirements q JOIN articles a ON a.latest_ready_revision_id=q.revision_id WHERE q.object_hash=NEW.input_hash
  ON CONFLICT(article_id) DO UPDATE SET generation=generation+1,priority=1,next_at=0,attempts=0,error=NULL,blocked=0;
END;
