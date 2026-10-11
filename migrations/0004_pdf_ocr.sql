CREATE TABLE pdf_ocr_jobs(
 id TEXT PRIMARY KEY,
 article_id TEXT NOT NULL REFERENCES articles(id),
 attachment_id TEXT NOT NULL REFERENCES attachments(id),
 source_hash TEXT NOT NULL,
 source_key TEXT NOT NULL,
 filename TEXT NOT NULL,
 model TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0,
 total_pages INTEGER NOT NULL DEFAULT 0,
 ocr_pages INTEGER NOT NULL DEFAULT 0,
 result_key TEXT,
 estimated_usd REAL NOT NULL DEFAULT 0,
 publish_requested INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX pdf_ocr_article ON pdf_ocr_jobs(article_id,updated_at);
CREATE TABLE pdf_ocr_usage(
 period TEXT PRIMARY KEY,
 reserved_pages INTEGER NOT NULL DEFAULT 0,
 processed_pages INTEGER NOT NULL DEFAULT 0,
 estimated_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE pdf_ocr_budget(
 id INTEGER PRIMARY KEY CHECK(id=1),
 day TEXT NOT NULL,
 month TEXT NOT NULL,
 day_pages INTEGER NOT NULL DEFAULT 0,
 month_pages INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pdf_ocr_calls(
 id TEXT PRIMARY KEY,
 lease_until INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 result_key TEXT,
 error TEXT
);
ALTER TABLE articles ADD COLUMN ocr_result_key TEXT;
ALTER TABLE articles ADD COLUMN ocr_model TEXT;
ALTER TABLE articles ADD COLUMN ocr_updated_at TEXT;
