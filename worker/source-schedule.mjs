// A plan can extend only the check that became due before its own hourly scan.
// Use the immutable payload start: Workflow backoff may move tasks.due_at.
// Old cycles and failed launches must stay visible.
export function scheduledDiscoveryAtSql(source='s'){
  const hour="json_extract(planned.payload_json,'$.scheduledHour')";
  const start="json_extract(planned.payload_json,'$.scheduledStartAt')";
  const due=`CASE WHEN ${source}.last_run_at IS NULL
    THEN COALESCE(NULLIF(json_extract(planned.payload_json,'$.previousDue'),0),${hour})
    ELSE CAST(ROUND((julianday(${source}.last_run_at)-2440587.5)*86400000) AS INTEGER)+${source}.refresh_interval_sec*1000 END`;
  return `(SELECT MIN(${start}) FROM tasks planned
    JOIN outbox launch ON launch.topic='feed-jobs' AND launch.dedupe_key='start:'||planned.id||':a1'
    WHERE planned.source_id=${source}.id AND planned.kind='discover' AND planned.attempt_no=1
      AND planned.state IN ('queued','starting','running') AND planned.last_error IS NULL
      AND launch.last_error IS NULL
      AND ${source}.enabled=1 AND ${source}.validation_state='verified'
      AND (${source}.error IS NULL OR TRIM(${source}.error)='')
      AND EXISTS(SELECT 1 FROM sites enabled_site WHERE enabled_site.id=${source}.site_id AND enabled_site.enabled=1)
      AND json_extract(planned.payload_json,'$.source.configVersion')=${source}.config_version
      AND json_extract(planned.payload_json,'$.source.siteId')=${source}.site_id
      AND json_extract(planned.payload_json,'$.page')=1
      AND json_type(planned.payload_json,'$.scheduledHour')='integer' AND ${hour}%3600000=0
      AND json_type(planned.payload_json,'$.scheduledStartAt')='integer'
      AND ${start} BETWEEN ${hour} AND ${hour}+3599000
      AND (${due})>${hour}-3600000 AND (${due})<=${hour})`;
}
