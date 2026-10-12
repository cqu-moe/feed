import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { sealRssToken } from '../worker/subscription-credentials.mjs';
import {
  applyMigration,
  feedOrigin,
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
