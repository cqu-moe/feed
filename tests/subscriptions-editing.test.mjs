import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  adminRequest,
  feedOrigin,
  subscriptionCall,
  subscriptionsFixture,
} from './helpers/subscriptions-fixture.mjs';

test('distinct target changes remain valid when the server clock has the same millisecond', async () => {
  const { mf } = await subscriptionsFixture({ clock: 1791800000000 });
  try {
    const invoke = (method, ...args) => subscriptionCall(mf, '/__test/subscriptions', {
      method: 'POST', body: { method, actor: { id: 'same-clock-owner' }, args },
    });
    const created = await invoke('change', {
      requestId: 'same-clock-create', name: '栏目切换', sourceIds: ['jwc'], emailMode: 'off',
    });
    assert.equal(created.status, 200, JSON.stringify(created));
    const id = created.body.subscription.id;
    for (const [index, sourceId] of ['intex', 'jwc', 'intex'].entries()) {
      const edited = await invoke('update', id, {
        requestId: `same-clock-update-${index}`, expectedVersion: index + 1,
        name: '栏目切换', sourceIds: [sourceId], emailMode: 'off', requestedEnabled: true, priority: 0,
      });
      assert.equal(edited.status, 200, JSON.stringify(edited));
      assert.equal(edited.body.subscription.version, index + 2);
      assert.deepEqual(edited.body.subscription.targetSourceIds, [sourceId]);
    }
    const deleted = await invoke('delete', id, { requestId: 'same-clock-delete', expectedVersion: 4 });
    assert.equal(deleted.status, 200, JSON.stringify(deleted));
    assert.deepEqual(deleted.body.subscription.savedSourceIds, ['intex']);
    const replay = await invoke('delete', id, { requestId: 'same-clock-delete', expectedVersion: 4 });
    assert.deepEqual(replay.body.subscription, deleted.body.subscription);
    const restored = await invoke('restore', id, {
      requestId: 'same-clock-restore', expectedVersion: 5, name: '栏目切换',
      sourceIds: deleted.body.subscription.savedSourceIds, emailMode: 'off', requestedEnabled: true, priority: 0,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored));
    assert.deepEqual(restored.body.subscription.targetSourceIds, ['intex']);
  } finally { await mf.dispose(); }
});

test('an owner can edit subscription settings and targets with version guards and stable replay', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture();
  try {
    await setPolicy('editor', { access: true, limit: { kind: 'limited', value: 2 } });
    const cookie = await login('editor');
    const created = await subscriptionCall(mf, '/api/subscriptions', {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: {
        requestId: 'create-for-editing',
        name: '原始订阅',
        siteIds: [],
        sourceIds: ['jwc'],
        emailMode: 'daily_digest',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const subscriptionId = created.body.subscription.id;
    const initialEffectiveFrom = Date.parse(
      created.body.subscription.targets.find(target => target.sourceId === 'jwc').effectiveFrom,
    );

    await delay(5);
    const command = {
      requestId: 'edit-subscription-once',
      expectedVersion: 1,
      name: '编辑后的订阅',
      sourceIds: ['intex'],
      emailMode: 'off',
      requestedEnabled: false,
      priority: 20,
    };
    const edited = await subscriptionCall(mf, `/api/subscriptions/${subscriptionId}`, {
      cookie,
      method: 'PATCH',
      origin: feedOrigin,
      body: command,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.equal(edited.body.changed, true);
    assert.equal(edited.body.subscription.version, 2);
    assert.equal(edited.body.subscription.name, command.name);
    assert.deepEqual(edited.body.subscription.targetSourceIds, ['intex']);
    assert.equal(edited.body.subscription.emailMode, command.emailMode);
    assert.equal(edited.body.subscription.requestedEnabled, false);
    assert.equal(edited.body.subscription.priority, command.priority);

    const replay = await subscriptionCall(mf, `/api/subscriptions/${subscriptionId}`, {
      cookie,
      method: 'PATCH',
      origin: feedOrigin,
      body: command,
    });
    assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.equal(replay.body.changed, false);
    assert.equal(replay.body.subscription.version, 2);
    assert.deepEqual(replay.body.subscription.targetSourceIds, ['intex']);

    const stale = await subscriptionCall(mf, `/api/subscriptions/${subscriptionId}`, {
      cookie,
      method: 'PATCH',
      origin: feedOrigin,
      body: { ...command, requestId: 'edit-from-stale-version', name: '过期编辑' },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale));

    await delay(5);
    const restored = await subscriptionCall(mf, `/api/subscriptions/${subscriptionId}`, {
      cookie,
      method: 'PATCH',
      origin: feedOrigin,
      body: {
        requestId: 're-add-jwc',
        expectedVersion: 2,
        name: command.name,
        sourceIds: ['jwc'],
        emailMode: 'daily_digest',
        requestedEnabled: true,
        priority: 0,
      },
    });
    assert.equal(restored.status, 200, JSON.stringify(restored));
    assert.deepEqual(restored.body.subscription.targetSourceIds, ['jwc']);
    const restoredEffectiveFrom = Date.parse(
      restored.body.subscription.targets.find(target => target.sourceId === 'jwc').effectiveFrom,
    );
    assert.ok(restoredEffectiveFrom > initialEffectiveFrom);
  } finally {
    await mf.dispose();
  }
});

test('concurrent target edits share one version transition and only the winner writes targets', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture();
  try {
    await setPolicy('race-editor', { access: true, limit: { kind: 'unlimited' } });
    const cookie = await login('race-editor');
    const created = await subscriptionCall(mf, '/api/subscriptions', {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: {
        requestId: 'create-target-race',
        name: '目标竞争',
        siteIds: [],
        sourceIds: ['jwc'],
        emailMode: 'daily_digest',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.body.subscription.id;
    const commands = ['intex', 'civil'].map((sourceId, index) => ({
      requestId: `target-race-${index}`,
      expectedVersion: 1,
      name: `目标竞争 ${index}`,
      sourceIds: [sourceId],
      emailMode: 'daily_digest',
      requestedEnabled: true,
      priority: 10,
    }));
    const results = await Promise.all(commands.map(command => subscriptionCall(mf, `/api/subscriptions/${id}`, {
      cookie,
      method: 'PATCH',
      origin: feedOrigin,
      body: command,
    })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const winner = results.find(result => result.status === 200);
    const loser = results.find(result => result.status === 409);
    assert.equal(winner.body.subscription.version, 2);
    assert.ok(['intex', 'civil'].includes(winner.body.subscription.targetSourceIds[0]));
    assert.equal(loser.body.error, '订阅已被其他操作修改，请刷新后重试');
    const listed = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    assert.equal(listed.status, 200, JSON.stringify(listed));
    const persisted = listed.body.subscriptions.find(subscription => subscription.id === id);
    assert.deepEqual(persisted.targetSourceIds, winner.body.subscription.targetSourceIds);
  } finally {
    await mf.dispose();
  }
});

test('editing may retain an existing target after an administrator disables it', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture();
  try {
    await setPolicy('disabled-target-editor', { access: true, limit: { kind: 'unlimited' } });
    const cookie = await login('disabled-target-editor');
    const created = await subscriptionCall(mf, '/api/subscriptions', {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: {
        requestId: 'create-with-two-targets',
        name: '含停用栏目',
        siteIds: [],
        sourceIds: ['jwc', 'intex'],
        emailMode: 'daily_digest',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.body.subscription.id;
    const disabled = await adminRequest(mf, '/internal/sources/jwc', { enabled: false }, { method: 'PATCH' });
    assert.equal(disabled.status, 200, JSON.stringify(disabled));

    const edited = await subscriptionCall(mf, `/api/subscriptions/${id}`, {
      cookie,
      method: 'PATCH',
      origin: feedOrigin,
      body: {
        requestId: 'edit-with-disabled-existing-target',
        expectedVersion: 1,
        name: '保留停用栏目',
        sourceIds: ['jwc', 'intex'],
        emailMode: 'off',
        requestedEnabled: false,
        priority: 30,
      },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.deepEqual(edited.body.subscription.targetSourceIds, ['intex', 'jwc']);
    assert.equal(edited.body.subscription.emailMode, 'off');
    assert.equal(edited.body.subscription.requestedEnabled, false);
  } finally {
    await mf.dispose();
  }
});

test('finite quota preserves configuration while priority selects the running set and email verification only pauses email', async () => {
  const { mf, login, setPolicy, setRecipient, setPolicyService } = await subscriptionsFixture();
  try {
    await setPolicy('runtime-user', { access: true, limit: { kind: 'unlimited' } });
    const cookie = await login('runtime-user');
    const subscriptions = [];
    for (const index of [0, 1, 2]) {
      const created = await subscriptionCall(mf, '/api/subscriptions', {
        cookie,
        method: 'POST',
        origin: feedOrigin,
        body: {
          requestId: `runtime-subscription-${index}`,
          name: `运行订阅 ${index}`,
          siteIds: [],
          sourceIds: ['jwc'],
          emailMode: 'daily_digest',
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      subscriptions.push(created.body.subscription);
      await delay(5);
    }
    await setPolicy('runtime-user', { access: true, limit: { kind: 'limited', value: 2 } });

    const initial = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    assert.equal(initial.status, 200, JSON.stringify(initial));
    assert.deepEqual(initial.body.subscriptions.map(subscription => subscription.effectiveStatus), [
      'active',
      'active',
      'quota_exceeded',
    ]);

    const reprioritized = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[2].id}`, {
      cookie,
      method: 'PATCH',
      origin: feedOrigin,
      body: {
        requestId: 'runtime-reprioritize-third',
        expectedVersion: 1,
        name: subscriptions[2].name,
        sourceIds: ['jwc'],
        emailMode: 'daily_digest',
        requestedEnabled: true,
        priority: 0,
      },
    });
    assert.equal(reprioritized.status, 200, JSON.stringify(reprioritized));
    const reordered = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    const byId = new Map(reordered.body.subscriptions.map(subscription => [subscription.id, subscription]));
    assert.equal(byId.get(subscriptions[0].id).effectiveStatus, 'active');
    assert.equal(byId.get(subscriptions[1].id).effectiveStatus, 'quota_exceeded');
    assert.equal(byId.get(subscriptions[2].id).effectiveStatus, 'active');

    const paused = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[1].id}`, {
      cookie,
      method: 'PATCH',
      origin: feedOrigin,
      body: {
        requestId: 'runtime-pause-second',
        expectedVersion: 1,
        name: subscriptions[1].name,
        sourceIds: ['jwc'],
        emailMode: 'daily_digest',
        requestedEnabled: false,
        priority: 100,
      },
    });
    assert.equal(paused.status, 200, JSON.stringify(paused));
    await setPolicy('runtime-user', { access: true, limit: { kind: 'limited', value: 3 } });
    const recovered = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    const recoveredById = new Map(recovered.body.subscriptions.map(subscription => [subscription.id, subscription]));
    assert.equal(recoveredById.get(subscriptions[0].id).effectiveStatus, 'active');
    assert.equal(recoveredById.get(subscriptions[1].id).effectiveStatus, 'paused');
    assert.equal(recoveredById.get(subscriptions[2].id).effectiveStatus, 'active');

    await setRecipient('runtime-user', { status: 'unverified' });
    const unverified = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    assert.equal(unverified.status, 200, JSON.stringify(unverified));
    assert.equal(unverified.body.subscriptions[0].emailStatus, 'email_unverified');
    assert.equal(unverified.body.subscriptions[0].rssStatus, 'active');

    await setPolicyService({ outage: true, policyCalls: 0 });
    const outage = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    assert.equal(outage.status, 200, JSON.stringify(outage));
    assert.equal(outage.body.subscriptions.length, 3);
    assert.equal(outage.body.subscriptions[0].effectiveStatus, 'auth_unavailable');
  } finally {
    await mf.dispose();
  }
});

test('an owner can delete and later restore a subscription with a fresh quota check, target interval, and RSS credential', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture();
  try {
    await setPolicy('delete-restore-user', { access: true, limit: { kind: 'limited', value: 1 } });
    const cookie = await login('delete-restore-user');
    const created = await subscriptionCall(mf, '/api/subscriptions', {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: {
        requestId: 'create-before-delete',
        name: '待删除订阅',
        siteIds: [],
        sourceIds: ['jwc'],
        emailMode: 'daily_digest',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.body.subscription.id;
    const originalRssUrl = created.body.subscription.rssUrl;
    const originalEffectiveFrom = Date.parse(
      created.body.subscription.targets.find(target => target.sourceId === 'jwc').effectiveFrom,
    );
    await delay(5);

    const deleteCommand = { requestId: 'delete-subscription-once', expectedVersion: 1 };
    const deleted = await subscriptionCall(mf, `/api/subscriptions/${id}`, {
      cookie,
      method: 'DELETE',
      origin: feedOrigin,
      body: deleteCommand,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted));
    assert.equal(deleted.body.changed, true);
    assert.equal(deleted.body.subscription.version, 2);
    assert.equal(deleted.body.subscription.effectiveStatus, 'deleted');
    assert.equal(deleted.body.subscription.rssUrl, null);
    assert.deepEqual(deleted.body.subscription.savedSourceIds, ['jwc']);

    const replayDelete = await subscriptionCall(mf, `/api/subscriptions/${id}`, {
      cookie,
      method: 'DELETE',
      origin: feedOrigin,
      body: deleteCommand,
    });
    assert.equal(replayDelete.status, 200, JSON.stringify(replayDelete));
    assert.equal(replayDelete.body.changed, false);
    assert.deepEqual(replayDelete.body.subscription, deleted.body.subscription);
    const listed = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    assert.equal(listed.body.usage, 0);
    assert.equal(listed.body.subscriptions.length, 1);
    assert.equal(listed.body.subscriptions[0].effectiveStatus, 'deleted');

    const staleDelete = await subscriptionCall(mf, `/api/subscriptions/${id}`, {
      cookie,
      method: 'DELETE',
      origin: feedOrigin,
      body: { requestId: 'delete-from-stale-version', expectedVersion: 1 },
    });
    assert.equal(staleDelete.status, 409, JSON.stringify(staleDelete));

    await setPolicy('delete-restore-user', { access: true, limit: { kind: 'limited', value: 0 } });
    const deniedRestore = await subscriptionCall(mf, `/api/subscriptions/${id}/restore`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: {
        requestId: 'restore-subscription-once',
        expectedVersion: 2,
        name: '恢复后的订阅',
        sourceIds: ['jwc'],
        emailMode: 'off',
        requestedEnabled: true,
        priority: 0,
      },
    });
    assert.equal(deniedRestore.status, 403, JSON.stringify(deniedRestore));

    await setPolicy('delete-restore-user', { access: true, limit: { kind: 'limited', value: 1 } });
    const restoreCommand = {
      requestId: 'restore-subscription-once',
      expectedVersion: 2,
      name: '恢复后的订阅',
      sourceIds: ['jwc'],
      emailMode: 'daily_digest',
      requestedEnabled: true,
      priority: 0,
    };
    const occupying = await subscriptionCall(mf, '/api/subscriptions', {
      cookie, method: 'POST', origin: feedOrigin,
      body: { requestId: 'occupy-restoration-quota', name: '占用唯一额度', sourceIds: ['intex'] },
    });
    assert.equal(occupying.status, 201, JSON.stringify(occupying));
    for (let retry = 0; retry < 2; retry++) {
      const full = await subscriptionCall(mf, `/api/subscriptions/${id}/restore`, {
        cookie, method: 'POST', origin: feedOrigin, body: restoreCommand,
      });
      assert.equal(full.status, 403, JSON.stringify(full));
    }
    const afterDenied = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    assert.equal(afterDenied.body.usage, 1);
    const stillDeleted = afterDenied.body.subscriptions.find(item => item.id === id);
    assert.equal(stillDeleted.version, 2);
    assert.equal(stillDeleted.effectiveStatus, 'deleted');
    assert.equal(stillDeleted.rssUrl, null);
    const freed = await subscriptionCall(mf, `/api/subscriptions/${occupying.body.subscription.id}`, {
      cookie, method: 'DELETE', origin: feedOrigin,
      body: { requestId: 'free-restoration-quota', expectedVersion: 1 },
    });
    assert.equal(freed.status, 200, JSON.stringify(freed));
    const restored = await subscriptionCall(mf, `/api/subscriptions/${id}/restore`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: restoreCommand,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored));
    assert.equal(restored.body.changed, true);
    assert.equal(restored.body.subscription.version, 3);
    assert.equal(restored.body.subscription.deletedAt, null);
    assert.equal(restored.body.subscription.effectiveStatus, 'active');
    assert.deepEqual(restored.body.subscription.targetSourceIds, ['jwc']);
    assert.notEqual(restored.body.subscription.rssUrl, originalRssUrl);
    const restoredEffectiveFrom = Date.parse(
      restored.body.subscription.targets.find(target => target.sourceId === 'jwc').effectiveFrom,
    );
    assert.ok(restoredEffectiveFrom > originalEffectiveFrom);

    const replayRestore = await subscriptionCall(mf, `/api/subscriptions/${id}/restore`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: restoreCommand,
    });
    assert.equal(replayRestore.status, 200, JSON.stringify(replayRestore));
    assert.equal(replayRestore.body.changed, false);
    assert.equal((await subscriptionCall(mf, '/api/subscriptions', { cookie })).body.usage, 1);
  } finally {
    await mf.dispose();
  }
});

test('concurrent restores share the creation quota and leave only one configuration active', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture();
  try {
    await setPolicy('restore-race-user', { access: true, limit: { kind: 'unlimited' } });
    const cookie = await login('restore-race-user');
    const subscriptions = [];
    for (const index of [0, 1]) {
      const created = await subscriptionCall(mf, '/api/subscriptions', {
        cookie,
        method: 'POST',
        origin: feedOrigin,
        body: {
          requestId: `restore-race-create-${index}`,
          name: `恢复竞争 ${index}`,
          siteIds: [],
          sourceIds: ['jwc'],
          emailMode: 'daily_digest',
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      subscriptions.push(created.body.subscription);
      const deleted = await subscriptionCall(mf, `/api/subscriptions/${created.body.subscription.id}`, {
        cookie,
        method: 'DELETE',
        origin: feedOrigin,
        body: { requestId: `restore-race-delete-${index}`, expectedVersion: 1 },
      });
      assert.equal(deleted.status, 200, JSON.stringify(deleted));
    }

    await setPolicy('restore-race-user', { access: true, limit: { kind: 'limited', value: 1 } });
    const restoreCommand = index => ({
      requestId: `restore-race-restore-${index}`,
      expectedVersion: 2,
      name: subscriptions[index].name,
      sourceIds: ['jwc'],
      emailMode: 'daily_digest',
      requestedEnabled: true,
      priority: 10,
    });
    const results = await Promise.all(subscriptions.map((subscription, index) => subscriptionCall(
      mf,
      `/api/subscriptions/${subscription.id}/restore`,
      {
        cookie,
        method: 'POST',
        origin: feedOrigin,
        body: restoreCommand(index),
      },
    )));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 403]);
    const winnerIndex = results.findIndex(result => result.status === 200);
    const loserIndex = results.findIndex(result => result.status === 403);
    const listed = await subscriptionCall(mf, '/api/subscriptions', { cookie });
    assert.equal(listed.body.usage, 1);
    assert.equal(listed.body.subscriptions.filter(subscription => subscription.deletedAt === null).length, 1);
    assert.equal(listed.body.subscriptions.filter(subscription => subscription.deletedAt !== null).length, 1);

    const freed = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[winnerIndex].id}`, {
      cookie,
      method: 'DELETE',
      origin: feedOrigin,
      body: { requestId: 'restore-race-free-quota', expectedVersion: 3 },
    });
    assert.equal(freed.status, 200, JSON.stringify(freed));
    const retriedLoser = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[loserIndex].id}/restore`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: restoreCommand(loserIndex),
    });
    assert.equal(retriedLoser.status, 200, JSON.stringify(retriedLoser));
    assert.equal(retriedLoser.body.changed, true);
  } finally {
    await mf.dispose();
  }
});

test('an owner can independently rotate and revoke an RSS credential without changing quota usage', async () => {
  const { mf, db, login, setPolicy } = await subscriptionsFixture();
  try {
    await setPolicy('rss-manager', { access: true, limit: { kind: 'limited', value: 1 } });
    const cookie = await login('rss-manager');
    const otherCookie = await login('rss-other-owner');
    const created = await subscriptionCall(mf, '/api/subscriptions', {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: {
        requestId: 'create-before-rss-commands',
        name: 'RSS 管理',
        siteIds: [],
        sourceIds: ['jwc'],
        emailMode: 'daily_digest',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.body.subscription.id;
    const originalUrl = created.body.subscription.rssUrl;
    await delay(5);

    const rotateCommand = { requestId: 'rotate-rss-once', expectedVersion: 1 };
    const rotated = await subscriptionCall(mf, `/api/subscriptions/${id}/rss/rotate`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: rotateCommand,
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated));
    assert.equal(rotated.body.changed, true);
    assert.equal(rotated.body.subscription.version, 2);
    assert.equal(rotated.body.subscription.rssStatus, 'active');
    assert.notEqual(rotated.body.subscription.rssUrl, originalUrl);

    const replayRotate = await subscriptionCall(mf, `/api/subscriptions/${id}/rss/rotate`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: rotateCommand,
    });
    assert.equal(replayRotate.status, 200, JSON.stringify(replayRotate));
    assert.equal(replayRotate.body.changed, false);
    assert.equal(replayRotate.body.subscription.rssUrl, rotated.body.subscription.rssUrl);

    const staleRotate = await subscriptionCall(mf, `/api/subscriptions/${id}/rss/rotate`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: { requestId: 'rotate-rss-from-stale-version', expectedVersion: 1 },
    });
    assert.equal(staleRotate.status, 409, JSON.stringify(staleRotate));

    const otherOwner = await subscriptionCall(mf, `/api/subscriptions/${id}/rss/rotate`, {
      cookie: otherCookie,
      method: 'POST',
      origin: feedOrigin,
      body: { requestId: 'rotate-other-owner', expectedVersion: 2 },
    });
    assert.equal(otherOwner.status, 404, JSON.stringify(otherOwner));
    const otherList = await subscriptionCall(mf, '/api/subscriptions', { cookie: otherCookie });
    assert.equal(JSON.stringify(otherList.body).includes(rotated.body.subscription.rssUrl), false);

    await setPolicy('rss-manager', { access: false, limit: { kind: 'limited', value: 0 } });
    const revoked = await subscriptionCall(mf, `/api/subscriptions/${id}/rss/revoke`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: { requestId: 'revoke-rss-once', expectedVersion: 2 },
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked));
    assert.equal(revoked.body.changed, true);
    assert.equal(revoked.body.subscription.version, 3);
    assert.equal(revoked.body.subscription.rssUrl, null);
    assert.equal(revoked.body.subscription.rssStatus, 'rss_revoked');
    assert.equal(revoked.body.subscription.effectiveStatus, 'access_revoked');
    assert.equal((await subscriptionCall(mf, '/api/subscriptions', { cookie })).body.usage, 1);

    const rotatedAfterRevoke = await subscriptionCall(mf, `/api/subscriptions/${id}/rss/rotate`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: { requestId: 'rotate-after-revoke', expectedVersion: 3 },
    });
    assert.equal(rotatedAfterRevoke.status, 200, JSON.stringify(rotatedAfterRevoke));
       assert.notEqual(rotatedAfterRevoke.body.subscription.rssUrl, rotated.body.subscription.rssUrl);

    const commands = [0, 1].map(index => ({
      requestId: `concurrent-rotate-${index}`,
      expectedVersion: 4,
    }));
    const races = await Promise.all(commands.map(command => subscriptionCall(mf, `/api/subscriptions/${id}/rss/rotate`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: command,
    })));
    assert.deepEqual(races.map(result => result.status).sort(), [200, 409]);
    const winner = races.find(result => result.status === 200);
    assert.equal(winner.body.subscription.version, 5);
    const currentToken = new URL(winner.body.subscription.rssUrl, feedOrigin).searchParams.get('token');
    const credential = await db.prepare(
      'SELECT rss_token_hash AS hash,rss_token_generation AS generation FROM subscriptions WHERE id=?',
    ).bind(id).first();
    assert.equal(credential.generation, 4);
    assert.equal(credential.hash, createHash('sha256').update(currentToken).digest('hex'));
    assert.notEqual(credential.hash, createHash('sha256').update(new URL(originalUrl, feedOrigin).searchParams.get('token')).digest('hex'));
  } finally {
    await mf.dispose();
  }
});

test('update commands are owner and subscription scoped without leaking targets across subscriptions', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture();
  try {
    await setPolicy('owner-a', { access: true, limit: { kind: 'unlimited' } });
    await setPolicy('owner-b', { access: true, limit: { kind: 'unlimited' } });
    const cookieA = await login('owner-a');
    const cookieB = await login('owner-b');
    const subscriptions = [];
    for (const [index, sourceId] of ['jwc', 'intex'].entries()) {
      const created = await subscriptionCall(mf, '/api/subscriptions', {
        cookie: cookieA,
        method: 'POST',
        origin: feedOrigin,
        body: {
          requestId: `isolation-create-${index}`,
          name: `隔离订阅 ${index}`,
          siteIds: [],
          sourceIds: [sourceId],
          emailMode: 'daily_digest',
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      subscriptions.push(created.body.subscription);
    }

    const firstCommand = {
      requestId: 'same-owner-command',
      expectedVersion: 1,
      name: '第一条已编辑',
      sourceIds: ['civil'],
      emailMode: 'off',
      requestedEnabled: false,
      priority: 20,
    };
    const first = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[0].id}`, {
      cookie: cookieA,
      method: 'PATCH',
      origin: feedOrigin,
      body: firstCommand,
    });
    assert.equal(first.status, 200, JSON.stringify(first));

    const reusedId = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[1].id}`, {
      cookie: cookieA,
      method: 'PATCH',
      origin: feedOrigin,
      body: { ...firstCommand, name: '第二条不应编辑' },
    });
    assert.equal(reusedId.status, 409, JSON.stringify(reusedId));

    const crossOwner = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[1].id}`, {
      cookie: cookieB,
      method: 'PATCH',
      origin: feedOrigin,
      body: { ...firstCommand, requestId: 'cross-owner-command', name: '跨用户不应编辑' },
    });
    assert.equal(crossOwner.status, 404, JSON.stringify(crossOwner));

    const second = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[1].id}`, {
      cookie: cookieA,
      method: 'PATCH',
      origin: feedOrigin,
      body: {
        requestId: 'second-subscription-command',
        expectedVersion: 1,
        name: '第二条已编辑',
        sourceIds: ['intex', 'civil'],
        emailMode: 'immediate',
        requestedEnabled: true,
        priority: 10,
      },
    });
    assert.equal(second.status, 200, JSON.stringify(second));
    assert.deepEqual(second.body.subscription.targetSourceIds, ['civil', 'intex']);
    const listB = await subscriptionCall(mf, '/api/subscriptions', { cookie: cookieB });
    assert.deepEqual(listB.body.subscriptions, []);
    const listA = await subscriptionCall(mf, '/api/subscriptions', { cookie: cookieA });
    const persistedFirst = listA.body.subscriptions.find(subscription => subscription.id === subscriptions[0].id);
    assert.deepEqual(persistedFirst.targetSourceIds, ['civil']);
    assert.equal(persistedFirst.name, firstCommand.name);
  } finally {
    await mf.dispose();
  }
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
