PRAGMA foreign_keys=ON;

CREATE TABLE sites(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE sources ADD COLUMN site_id TEXT REFERENCES sites(id);
ALTER TABLE sources ADD COLUMN list_url TEXT;
ALTER TABLE sources ADD COLUMN adapter_key TEXT NOT NULL DEFAULT 'cqu-generic';
ALTER TABLE sources ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}' CHECK(config_json='{}' OR json_valid(config_json));
ALTER TABLE sources ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1 CHECK(config_version>=1);
ALTER TABLE sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
ALTER TABLE sources ADD COLUMN refresh_interval_sec INTEGER NOT NULL DEFAULT 86400 CHECK(refresh_interval_sec BETWEEN 1800 AND 604800);
ALTER TABLE sources ADD COLUMN next_discovery_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN baseline_cutoff_at TEXT;
ALTER TABLE sources ADD COLUMN backfill_cursor TEXT;
ALTER TABLE sources ADD COLUMN validation_state TEXT NOT NULL DEFAULT 'verified' CHECK(validation_state IN ('draft','verified','failed'));
ALTER TABLE sources ADD COLUMN validation_json TEXT CHECK(validation_json IS NULL OR json_valid(validation_json));
ALTER TABLE sources ADD COLUMN validated_at INTEGER;
ALTER TABLE sources ADD COLUMN validation_task_id TEXT REFERENCES tasks(id);
ALTER TABLE sources ADD COLUMN source_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE sources ADD COLUMN created_at INTEGER;
ALTER TABLE sources ADD COLUMN updated_at INTEGER;

INSERT INTO sites(id,name,origin,created_at,updated_at) VALUES
  ('7fd03676e5751e9b6dd95ecb','教务处','https://jwc.cqu.edu.cn',0,0),
  ('1922681dab068aba5ab31dd8','国际处','https://intex.cqu.edu.cn',0,0),
  ('9527c4fa93c87021fea169ff','土木学院','https://civil.cqu.edu.cn',0,0),
  ('40b5b99980d313a8206ab67c','学工部','https://xgb.cqu.edu.cn',0,0),
  ('9076295fe7a44c01dabe3c33','新闻网','https://news.cqu.edu.cn',0,0);

UPDATE sources SET site_id=CASE id
  WHEN 'jwc' THEN '7fd03676e5751e9b6dd95ecb'
  WHEN 'intex' THEN '1922681dab068aba5ab31dd8'
  WHEN 'civil' THEN '9527c4fa93c87021fea169ff'
  WHEN 'xgb' THEN '40b5b99980d313a8206ab67c'
  WHEN 'news' THEN '9076295fe7a44c01dabe3c33'
  ELSE NULL
END;

UPDATE sources SET
  list_url=CASE id
    WHEN 'jwc' THEN 'https://jwc.cqu.edu.cn/index/tzgg.htm'
    WHEN 'intex' THEN 'https://intex.cqu.edu.cn/index/tzgg.htm'
    WHEN 'civil' THEN 'https://civil.cqu.edu.cn/xzwb/tzgg.htm'
    WHEN 'xgb' THEN 'https://xgb.cqu.edu.cn/list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1024'
    WHEN 'news' THEN 'https://news.cqu.edu.cn/tzggjb.htm'
    ELSE url
  END,
  config_json=CASE id
    WHEN 'jwc' THEN '{"articlePattern":"^/info/\\d+/\\d+\\.htm$","listUrls":["https://jwc.cqu.edu.cn/index/tzgg.htm","https://jwc.cqu.edu.cn/index/tzgg/xjgl.htm"]}'
    WHEN 'news' THEN '{"articlePattern":"^/info/1008/\\d+\\.htm$","listUrls":["https://news.cqu.edu.cn/tzggjb.htm"]}'
    ELSE '{"articlePattern":"^/info/\\d+/\\d+\\.htm$"}'
  END,
  validation_state=CASE WHEN id IN ('jwc','intex','civil','xgb','news') THEN 'verified' ELSE 'draft' END,
  next_discovery_at=0;

UPDATE sources SET created_at=0,updated_at=0 WHERE created_at IS NULL OR updated_at IS NULL;

CREATE TABLE article_sources(
  article_id TEXT NOT NULL REFERENCES articles(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  discovery_class TEXT NOT NULL CHECK(discovery_class IN ('live','backfill','migrated')),
  published_at TEXT,
  published_day TEXT,
  date_precision TEXT NOT NULL CHECK(date_precision IN ('unknown','day','minute')),
  source_timezone TEXT NOT NULL,
  PRIMARY KEY(article_id,source_id)
);
CREATE INDEX article_sources_source ON article_sources(source_id,article_id);

INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
SELECT id,source_id,
  CAST(strftime('%s',discovered_at) AS INTEGER)*1000,
  CAST(strftime('%s',discovered_at) AS INTEGER)*1000,
  'migrated',NULL,published_at,'day','Asia/Shanghai'
FROM articles;

CREATE INDEX sources_due ON sources(enabled,next_discovery_at,id);
