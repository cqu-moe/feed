import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { sealRssToken } from '../worker/subscription-credentials.mjs';
import {
  applyMigration,
  feedOrigin,
  staticSiteId,
  subscriptionCall,
  subscriptionsFixture,
} from './helpers/subscriptions-fixture.mjs';

test('0010 migrates existing owner subscriptions into versions and the active quota count', async () => {
  const { mf, db, login, setPolicy } = await subscriptionsFixture({ editingMigration: false });
  try {
    const token = 'a'.repeat(43);
    const row = {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      ownerSub: 'legacy-owner',
      rssTokenGeneration: 1,
    };
    const ciphertext = await sealRssToken(
      { FEED_SESSION_ENCRYPTION_KEY: 'test-session-encryption-key' },
      row,
      token,
    );
    await db.prepare(`INSERT INTO subscriptions(id,owner_sub,name,requested_enabled,priority,email_mode,
      activated_at,created_at,rss_token_hash,rss_token_ciphertext,rss_token_generation)
      VALUES (?,?,?,1,7,'off',123,123,?,?,1)`)
      .bind(row.id, row.ownerSub, '迁移前订阅', createHash('sha256').update(token).digest('hex'), ciphertext)
      .run();
    await db.prepare(`INSERT INTO subscription_sources(id,subscription_id,source_id,effective_from)
      VALUES ('bbbbbbbbbbbbbbbbbbbbbbbb',?,'jwc',124)`)
      .bind(row.id)
      .run();

    await applyMigration(db, await readFile('migrations/0010_subscription_editing.sql', 'utf8'));
    await setPolicy(row.ownerSub, { access: true, limit: { kind: 'limited', value: 1 } });
    const cookie = await login(row.ownerSub);
    const listed = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    assert.equal(listed.status, 200, JSON.stringify(listed));
    assert.equal(listed.body.usage, 1);
    assert.equal(listed.body.subscriptions[0].version, 1);
    assert.equal(listed.body.subscriptions[0].rssUrl, `/rss?token=${token}`);

    const create = () => subscriptionCall(mf, '/api/subscriptions', {
      cookie, method: 'POST', origin: feedOrigin,
      body: { requestId: 'create-after-migration', name: '迁移后新建', sourceIds: ['jwc'] },
    });
    assert.equal((await create()).status, 403);

    const deleted = await subscriptionCall(mf, `/api/subscriptions/${row.id}`, {
      cookie,
      method: 'DELETE',
      origin: feedOrigin,
      body: { requestId: 'legacy-delete-command', expectedVersion: 1 },
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted));
    assert.equal((await create()).status, 201);
    assert.equal((await subscriptionCall(mf, '/api/subscriptions', { cookie })).body.usage, 1);
  } finally {
    await mf.dispose();
  }
});

test('0020 migrates existing sources to staggered daily schedules', async () => {
  const { mf, db } = await subscriptionsFixture();
  try {
    await db.batch([
      db.prepare(`INSERT INTO sources(id,site_id,name,url,list_url,config_json,config_version,enabled,
        refresh_interval_sec,next_discovery_at,validation_state,source_timezone,created_at,updated_at)
        VALUES ('a','7fd03676e5751e9b6dd95ecb','A','https://jwc.cqu.edu.cn/a/','https://jwc.cqu.edu.cn/a/list.htm','{}',7,1,3600,0,'verified','Asia/Shanghai',11,12)`),
      db.prepare(`INSERT INTO sources(id,site_id,name,url,list_url,config_json,config_version,enabled,
        refresh_interval_sec,next_discovery_at,validation_state,validation_json,source_timezone,created_at,updated_at)
        VALUES ('b','9076295fe7a44c01dabe3c33','B','https://news.cqu.edu.cn/b/','https://news.cqu.edu.cn/b/list.htm','{}',3,0,86400,1,'draft','{}','UTC',13,14)`),
    ]);
    await db.batch([
      db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
        VALUES ('t1','discover','pre-migration-succeeded','a','{}','succeeded',1,1,1,1)`),
      db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
        VALUES ('t2','capture','pre-migration-failed','b','{}','failed',2,1,2,2)`),
      db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
        VALUES ('t3','recheck','pre-migration-cancelled','a','{}','cancelled',3,1,3,3)`),
    ]);
    const beforeMigration = Object.fromEntries((await db.prepare(`SELECT id,enabled,config_json,config_version,
      validation_state,validation_json,source_timezone,created_at,updated_at FROM sources`).all()).results
      .map(row => {
        const { id, enabled, config_json, config_version, validation_state, validation_json, source_timezone, created_at, updated_at } = row;
        return [id, { enabled, config_json, config_version, validation_state, validation_json, source_timezone, created_at, updated_at }];
      }));
    const beforeTasks = (await db.prepare('SELECT * FROM tasks ORDER BY id').all()).results;
    await applyMigration(db, await readFile('migrations/0020_daily_source_schedule.sql', 'utf8'));

    const rows = await db.prepare(`SELECT id,site_id,enabled,refresh_interval_sec,next_discovery_at,
      config_json,config_version,validation_state,validation_json,source_timezone,created_at,updated_at
      FROM sources ORDER BY id`).all();
    const byId = Object.fromEntries(rows.results.map(row => [row.id, row]));
    const base = Math.min(...rows.results.map(row => row.next_discovery_at));
    assert.deepEqual(rows.results.map(row => [row.id, row.site_id, row.refresh_interval_sec, row.next_discovery_at - base]), [
      ['a', staticSiteId, 86400, 34560000],
      ['b', '9076295fe7a44c01dabe3c33', 86400, 51840000],
      ['civil', '9527c4fa93c87021fea169ff', 86400, 69120000],
      ['intex', '1922681dab068aba5ab31dd8', 86400, 0],
      ['jwc', staticSiteId, 86400, 34560000],
      ['news', '9076295fe7a44c01dabe3c33', 86400, 51840000],
      ['xgb', '40b5b99980d313a8206ab67c', 86400, 17280000],
    ]);
    const preserved = Object.fromEntries(rows.results.map(row => {
      const { enabled, config_json, config_version, validation_state, validation_json, source_timezone, created_at, updated_at } = row;
      return [row.id, { enabled, config_json, config_version, validation_state, validation_json, source_timezone, created_at, updated_at }];
    }));
    assert.deepEqual(preserved.a, {
      enabled: 1, config_json: '{}', config_version: 7, validation_state: 'verified',
      validation_json: null, source_timezone: 'Asia/Shanghai', created_at: 11, updated_at: 12,
    });
    assert.deepEqual(preserved.b, {
      enabled: 0, config_json: '{}', config_version: 3, validation_state: 'draft',
      validation_json: '{}', source_timezone: 'UTC', created_at: 13, updated_at: 14,
    });
    assert.deepEqual(preserved.intex, beforeMigration.intex);
    assert.deepEqual((await db.prepare('SELECT * FROM tasks ORDER BY id').all()).results, beforeTasks);
  } finally {
    await mf.dispose();
  }
});
