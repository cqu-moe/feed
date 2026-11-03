-- Replace 0020's fixed site slots with last successful check + refresh interval.
UPDATE sources
SET next_discovery_at=CAST(strftime('%s',last_run_at) AS INTEGER)*1000+refresh_interval_sec*1000
WHERE enabled=1 AND validation_state='verified'
  AND site_id IN (SELECT id FROM sites WHERE enabled=1)
  AND strftime('%s',last_run_at) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.source_id=sources.id AND t.kind='discover'
    AND t.state IN ('queued','starting','running','deferred'));
