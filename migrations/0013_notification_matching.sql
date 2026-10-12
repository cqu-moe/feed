PRAGMA foreign_keys=ON;

CREATE TABLE event_source_corrections(
  id TEXT PRIMARY KEY CHECK(length(id)=24),
  event_id TEXT NOT NULL REFERENCES content_events(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  generation INTEGER NOT NULL CHECK(generation>=1),
  evidence_object_hash TEXT NOT NULL REFERENCES artifact_objects(sha256) CHECK(length(evidence_object_hash)=64),
  corrected_dates_json TEXT NOT NULL CHECK(json_valid(corrected_dates_json)),
  command_hash TEXT NOT NULL UNIQUE CHECK(length(command_hash)=64),
  verified_by TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(event_id,source_id,generation)
);

CREATE INDEX event_source_corrections_current
  ON event_source_corrections(event_id,source_id,generation DESC);

CREATE TABLE notification_matches(
  event_id TEXT NOT NULL REFERENCES content_events(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  target_id TEXT NOT NULL REFERENCES subscription_sources(id),
  owner_sub TEXT NOT NULL,
  eligibility_kind TEXT NOT NULL CHECK(eligibility_kind IN ('new','update','pending','suppressed')),
  reason TEXT NOT NULL,
  matched_at INTEGER NOT NULL,
  PRIMARY KEY(event_id,subscription_id,target_id)
);

CREATE INDEX notification_matches_by_subscription
  ON notification_matches(subscription_id,matched_at DESC,event_id);
CREATE INDEX notification_matches_by_owner
  ON notification_matches(owner_sub,event_id);

CREATE TABLE user_deliveries(
  id TEXT PRIMARY KEY CHECK(length(id)=24),
  owner_sub TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES content_events(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','sent','accepted','delivered','submission_unknown','suppressed','cancelled')),
  delivery_kind TEXT NOT NULL CHECK(delivery_kind IN ('immediate','daily_digest')),
  available_at INTEGER NOT NULL,
  claimed_message_id TEXT,
  suppression_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_sub,event_id)
);

CREATE INDEX user_deliveries_pending
  ON user_deliveries(state,available_at,owner_sub);
