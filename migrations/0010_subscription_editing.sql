PRAGMA foreign_keys=ON;

ALTER TABLE subscriptions ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1 CHECK(config_version>=1);

CREATE TABLE feed_accounts(
  auth_sub TEXT PRIMARY KEY,
  preference_revision INTEGER NOT NULL DEFAULT 0 CHECK(preference_revision>=0),
  active_subscription_count INTEGER NOT NULL DEFAULT 0 CHECK(active_subscription_count>=0),
  reservation_request_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT INTO feed_accounts(auth_sub,active_subscription_count,updated_at)
SELECT owner_sub,COUNT(*),MAX(created_at) FROM subscriptions WHERE deleted_at IS NULL GROUP BY owner_sub;

CREATE TABLE subscription_commands(
  owner_sub TEXT NOT NULL,
  request_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  command_kind TEXT NOT NULL CHECK(command_kind IN ('update','delete','restore','rotate_rss','revoke_rss')),
  command_hash TEXT NOT NULL CHECK(length(command_hash)=64),
  result_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_sub,request_id)
);

CREATE INDEX subscription_commands_by_subscription
  ON subscription_commands(subscription_id,created_at);
