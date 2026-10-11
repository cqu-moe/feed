PRAGMA foreign_keys=ON;
CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,last_run_at TEXT,error TEXT);
CREATE TABLE articles(
 id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),url TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,published_at TEXT NOT NULL,discovered_at TEXT NOT NULL,captured_at TEXT,
 status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,
 body_text TEXT NOT NULL DEFAULT '',excerpt TEXT NOT NULL DEFAULT '',prefix TEXT,content_hash TEXT,
 attachment_count INTEGER NOT NULL DEFAULT 0,snapshot_key TEXT,screenshot_key TEXT
);
CREATE INDEX articles_date ON articles(published_at DESC,id);
CREATE INDEX articles_source_date ON articles(source_id,published_at DESC);
CREATE TABLE attachments(
 id TEXT PRIMARY KEY,article_id TEXT NOT NULL REFERENCES articles(id),name TEXT NOT NULL,
 original_url TEXT NOT NULL,filename TEXT,object_key TEXT,bytes INTEGER NOT NULL DEFAULT 0,
 content_type TEXT,sha256 TEXT,status TEXT NOT NULL,error TEXT,role TEXT,
 UNIQUE(article_id,original_url)
);
CREATE VIRTUAL TABLE article_search USING fts5(id UNINDEXED,title,body_text,tokenize='trigram');
CREATE TRIGGER article_insert AFTER INSERT ON articles BEGIN
 INSERT INTO article_search(id,title,body_text) VALUES (new.id,new.title,new.body_text);
END;
CREATE TRIGGER article_update AFTER UPDATE OF title,body_text ON articles BEGIN
 DELETE FROM article_search WHERE id=old.id;
 INSERT INTO article_search(id,title,body_text) VALUES (new.id,new.title,new.body_text);
END;
CREATE TRIGGER article_delete AFTER DELETE ON articles BEGIN DELETE FROM article_search WHERE id=old.id; END;
CREATE TABLE runs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,error TEXT,discovered INTEGER DEFAULT 0,captured INTEGER DEFAULT 0);
CREATE TABLE usage(day TEXT NOT NULL,kind TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,kind));
CREATE TABLE ocr_slots(run_id TEXT NOT NULL,slot INTEGER NOT NULL,result TEXT,created_at TEXT NOT NULL,PRIMARY KEY(run_id,slot));
CREATE TABLE sessions(id_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,access_token TEXT NOT NULL,refresh_token TEXT,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE oauth_states(state_hash TEXT PRIMARY KEY,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL);
