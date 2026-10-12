import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  notificationInvoke,
  subscriptionCall,
  subscriptionsFixture,
  subscriptionsInvoke,
} from './helpers/subscriptions-fixture.mjs';

const now = Date.parse('2026-10-12T04:00:00.000Z');

test('subscription detail hides new notification content when feed access is revoked', async () => {
  for (const scenario of [
    { name: 'BFF feed.access revoked', revokeBff: true },
    { name: 'Auth RPC access revoked', revokeRpc: true },
  ]) {
    const { mf, login, revokeAccess, setPolicy } = await subscriptionsFixture({ clock: now });
    try {
      const created = await subscriptionsInvoke(mf, 'change', { id: 'access-owner' }, {
        requestId: `access-${scenario.revokeBff ? 'bff' : 'rpc'}`,
        name: '撤权访问订阅',
        sourceIds: ['jwc'],
        emailMode: 'immediate',
      });
      assert.equal(created.status, 200, JSON.stringify(created));
      const subscription = created.body.subscription;
      const cookie = await login('access-owner');
      const otherCookie = await login('access-other');

      assert.equal((await subscriptionCall(mf, `/api/subscriptions/${subscription.id}`)).status, 401);
      assert.equal((await subscriptionCall(mf, `/api/subscriptions/${subscription.id}`, { cookie: otherCookie })).status, 404);

      if (scenario.revokeBff) revokeAccess();
      if (scenario.revokeRpc) {
        await setPolicy('access-owner', { access: false, limit: { kind: 'limited', value: 10 } });
      }

      const eventId = await seedReadyEvent(mf, {
        id: 'aaaaaaaaaaaaaaaaaa990004',
        title: '撤权后新增通知标题',
        firstSeenAt: now + 30_000,
        readyAt: now + 120_000,
      });
      const enqueued = await notificationInvoke(mf, 'enqueueEvent', eventId);
      assert.equal(enqueued.status, 200, JSON.stringify(enqueued));
      const drained = await notificationInvoke(mf, 'replayMatchOutbox', 100);
      assert.equal(drained.status, 200, JSON.stringify(drained));

      const view = await subscriptionCall(mf, `/api/subscriptions/${subscription.id}`, { cookie });
      assert.equal(view.status, 200, JSON.stringify(view));
      assert.deepEqual(view.body.subscription.notificationMatches, [], JSON.stringify(view));
      assert.equal(view.body.subscription.effectiveStatus, 'access_revoked', JSON.stringify(view));
      assert.equal(view.body.subscription.name, '撤权访问订阅');
      assert.deepEqual(view.body.subscription.targetSourceIds, ['jwc']);
      assert.match(view.body.subscription.rssUrl, /^\/rss\?token=/);
    } finally {
      await mf.dispose();
    }
  }
});

async function seedReadyEvent(mf, { id, title, firstSeenAt, readyAt }) {
  const db = await mf.getD1Database('DB', 'feed');
  const manifestHash = createHash('sha256').update(`${id}:manifest`).digest('hex');
  await db.batch([
    db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status)
      VALUES (?,'jwc',?,?,'2026-10-12',?,'archived')`)
      .bind(id, `https://jwc.cqu.edu.cn/info/2026/${id}.htm`, title, firstSeenAt),
    db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
        published_at,published_day,date_precision,source_timezone)
      VALUES (?,'jwc',?,?,'live',NULL,'2026-10-12','day','Asia/Shanghai')`)
      .bind(id, firstSeenAt, firstSeenAt),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,created_at,updated_at)
      VALUES (?,'capture',?,'jwc',?,'{}','succeeded',?,?,?)`)
      .bind(id, `capture:${id}`, id, readyAt, firstSeenAt, readyAt),
    db.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,1,'application/json',?)`)
      .bind(manifestHash, `notifications/${id}/manifest.json`, firstSeenAt),
    db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,capture_task_id,observed_at,state,
        requirement_generation,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,
        title,published_at,source_metadata_json,ready_at)
      VALUES (?,?,1,?,?,'ready',1,1,?,?,?,'baseline',?,?,'{}',?)`)
      .bind(
        id, id, id, firstSeenAt, manifestHash,
        createHash('sha256').update(`${id}:raw`).digest('hex'),
        createHash('sha256').update(`${id}:semantic`).digest('hex'),
        title, '2026-10-12', readyAt,
      ),
    db.prepare(`INSERT INTO content_events(id,revision_id,article_id,kind,observed_at,ready_at,history_only,
        date_state,payload_hash,created_at)
      VALUES (?,?,?,'initial',?,?,0,'verified',?,?)`)
      .bind(
        id, id, id, firstSeenAt, readyAt,
        createHash('sha256').update(`${id}:payload`).digest('hex'), readyAt,
      ),
    db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,
        published_at,published_day,date_precision,source_timezone)
      VALUES (?,'jwc',?,'live',NULL,'2026-10-12','day','Asia/Shanghai')`)
      .bind(id, firstSeenAt),
  ]);
  return id;
}
