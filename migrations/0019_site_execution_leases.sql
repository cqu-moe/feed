PRAGMA foreign_keys=ON;

CREATE TABLE site_execution_leases(
  site_id TEXT PRIMARY KEY REFERENCES sites(id),
  owner_task_id TEXT REFERENCES tasks(id),
  owner_attempt_no INTEGER,
  acquired_at INTEGER CHECK(acquired_at IS NULL OR acquired_at >= 0),
  lease_until INTEGER NOT NULL DEFAULT 0 CHECK(lease_until >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  CHECK((owner_task_id IS NULL AND owner_attempt_no IS NULL AND acquired_at IS NULL)
    OR (owner_task_id IS NOT NULL AND owner_attempt_no IS NOT NULL AND acquired_at IS NOT NULL))
);

