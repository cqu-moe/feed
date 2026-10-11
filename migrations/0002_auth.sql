PRAGMA foreign_keys=ON;

-- These prototype tables were never used by a deployed feed release.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS oauth_states;

CREATE TABLE feed_login(
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE feed_session(
  token_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  refresh_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX feed_login_expiry ON feed_login(expires_at);
CREATE INDEX feed_session_expiry ON feed_session(expires_at);
