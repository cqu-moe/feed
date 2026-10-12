PRAGMA foreign_keys=ON;

INSERT OR IGNORE INTO sources(id,site_id,name,url,list_url,config_json,validation_state,created_at,updated_at) VALUES
  ('jwc','7fd03676e5751e9b6dd95ecb','教务处','https://jwc.cqu.edu.cn/','https://jwc.cqu.edu.cn/index/tzgg.htm','{"articlePattern":"^/info/\\d+/\\d+\\.htm$","listUrls":["https://jwc.cqu.edu.cn/index/tzgg.htm","https://jwc.cqu.edu.cn/index/tzgg/xjgl.htm"]}','verified',0,0),
  ('intex','1922681dab068aba5ab31dd8','国际处','https://intex.cqu.edu.cn/','https://intex.cqu.edu.cn/index/tzgg.htm','{"articlePattern":"^/info/\\d+/\\d+\\.htm$","listUrls":["https://intex.cqu.edu.cn/index/tzgg.htm"]}','verified',0,0),
  ('civil','9527c4fa93c87021fea169ff','土木学院','https://civil.cqu.edu.cn/','https://civil.cqu.edu.cn/xzwb/tzgg.htm','{"articlePattern":"^/info/\\d+/\\d+\\.htm$","listUrls":["https://civil.cqu.edu.cn/xzwb/tzgg.htm"]}','verified',0,0),
  ('xgb','40b5b99980d313a8206ab67c','学工部','https://xgb.cqu.edu.cn/','https://xgb.cqu.edu.cn/list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1024','{"articlePattern":"^/info/\\d+/\\d+\\.htm$","listUrls":["https://xgb.cqu.edu.cn/list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1024"]}','verified',0,0),
  ('news','9076295fe7a44c01dabe3c33','新闻网','https://news.cqu.edu.cn/','https://news.cqu.edu.cn/tzggjb.htm','{"articlePattern":"^/info/1008/\\d+\\.htm$","listUrls":["https://news.cqu.edu.cn/tzggjb.htm"]}','verified',0,0);

CREATE TABLE subscriptions(
  id TEXT PRIMARY KEY CHECK(length(id)=24),
  owner_sub TEXT NOT NULL,
  name TEXT NOT NULL,
  requested_enabled INTEGER NOT NULL CHECK(requested_enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 100 CHECK(priority>=0),
  email_mode TEXT NOT NULL CHECK(email_mode IN ('off','immediate','daily_digest')),
  activated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  rss_token_hash TEXT NOT NULL UNIQUE CHECK(length(rss_token_hash)=64),
  rss_token_ciphertext TEXT NOT NULL,
  rss_token_generation INTEGER NOT NULL DEFAULT 1 CHECK(rss_token_generation>0),
  rss_revoked_at INTEGER
);

CREATE INDEX subscriptions_running
  ON subscriptions(owner_sub,deleted_at,priority,created_at,id);

CREATE TABLE subscription_sources(
  id TEXT PRIMARY KEY CHECK(length(id)=24),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  effective_from INTEGER NOT NULL,
  removed_at INTEGER
);

CREATE INDEX subscription_sources_by_source
  ON subscription_sources(source_id,removed_at,subscription_id);

CREATE UNIQUE INDEX subscription_sources_active
  ON subscription_sources(subscription_id,source_id) WHERE removed_at IS NULL;

CREATE TABLE subscription_requests(
  owner_sub TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK(length(command_hash)=64),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_sub,request_id)
);
