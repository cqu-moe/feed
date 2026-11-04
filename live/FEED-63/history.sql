
INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status) VALUES ('fixture-notice','probe-a-old','https://a.feed63.cqu.edu.cn/old-notice','seed','2026-11-01','2026-11-01','complete');
INSERT INTO tasks(id,kind,business_key,source_id,article_id,state,due_at,created_at,updated_at) VALUES
 ('f11111111111111111111111','capture','fixture:archived','probe-a-old','fixture-notice','succeeded',1,1,1),
 ('f22222222222222222222222','discover','fixture:failed','probe-a-old',NULL,'failed',1,1,1),
 ('f33333333333333333333333','backfill','fixture:blocked','probe-a-old',NULL,'blocked',1,1,1);
UPDATE tasks SET last_error='pre-existing-error',attempt_no=3 WHERE business_key IN ('fixture:failed','fixture:blocked');
UPDATE sources SET backfill_state='paused',backfill_run_id='prior-run',backfill_seen_pages=2,backfill_cursor='{"page":2,"nextUrls":["https://a.feed63.cqu.edu.cn/history/3"]}' WHERE id='probe-a-old';
INSERT INTO artifact_objects VALUES ('2032533bc133857661e025d27907b596155faeed5aba0c298eacf5b95d251bc7','sentinel/original',34,'text/plain',1);
INSERT INTO article_revisions(id,article_id,revision_no,capture_task_id,observed_at,state,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,title,source_metadata_json) VALUES ('fixture-rev','fixture-notice',1,'f11111111111111111111111',1,'assembling',1,'2032533bc133857661e025d27907b596155faeed5aba0c298eacf5b95d251bc7','representation','published','baseline','seed','{}');
INSERT INTO revision_requirements(revision_id,slot_key,kind,required,state,object_hash) VALUES ('fixture-rev','body','body',1,'fulfilled','2032533bc133857661e025d27907b596155faeed5aba0c298eacf5b95d251bc7');
UPDATE article_revisions SET state='ready',ready_at=1 WHERE id='fixture-rev';
UPDATE articles SET latest_ready_revision_id='fixture-rev',latest_observed_revision_id='fixture-rev' WHERE id='fixture-notice';
INSERT INTO content_events(id,revision_id,article_id,kind,observed_at,ready_at,payload_hash,created_at) VALUES ('fixture-event','fixture-rev','fixture-notice','initial',1,1,'seed-event',1);
