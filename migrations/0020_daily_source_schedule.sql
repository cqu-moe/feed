-- Existing columns become daily. The first post-migration day is staggered by
-- stable site order; disabled columns stay disabled and retain their metadata.
WITH ranked_sites AS (
  SELECT id,ROW_NUMBER() OVER(ORDER BY id)-1 AS site_order,COUNT(*) OVER() AS site_count
  FROM sites
), next_day AS (
  SELECT (unixepoch()/86400+1)*86400000 AS start_ms
)
UPDATE sources
SET refresh_interval_sec=86400,
    next_discovery_at=(
      SELECT start_ms+site_order*86400000/site_count
      FROM ranked_sites,next_day
      WHERE ranked_sites.id=sources.site_id
    )
WHERE site_id IN (SELECT id FROM sites);
