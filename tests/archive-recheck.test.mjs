import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adminRequest,
  feedJobsInvoke,
  subscriptionsFixture,
  subscriptionsInvoke,
} from './helpers/subscriptions-fixture.mjs';
import { seedReadyEvent } from './helpers/notification-event.mjs';

const start = Date.parse('2026-10-12T08:00:00.000Z');

test('bounded recheck admission schedules ready articles by configured age tiers and deduplicates replay', async () => {
  const { mf, db } = await subscriptionsFixture({
    recheckMigration: true,
    recheckVars: {
      RECHECK_RECENT_AFTER_SEC: '1728000',
      RECHECK_RECENT_INTERVAL_SEC: '3600',
      RECHECK_OLD_INTERVAL_SEC: '86400',
    },
  });
  try {
    const now = Date.now();
    const recent = await seedReadyEvent(mf, {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      sourceId: 'jwc',
      firstSeenAt: now - 3_600_000,
      observedAt: now - 3_600_000,
      readyAt: now - 3_600_000,
      publishedAt: new Date(now - 3_600_000).toISOString(),
      datePrecision: 'minute',
      title: '近期归档通知',
    });
    const old = await seedReadyEvent(mf, {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      sourceId: 'jwc',
      firstSeenAt: now - 40 * 86_400_000,
      observedAt: now - 3_600_000,
      readyAt: now - 40 * 86_400_000,
      publishedAt: new Date(now - 40 * 86_400_000).toISOString(),
      datePrecision: 'minute',
      title: '旧归档通知',
    });
    await db.batch([
      db.prepare(`UPDATE articles SET next_recheck_at=0,latest_ready_revision_id=?,latest_observed_revision_id=?
        WHERE id=?`).bind(recent, recent, recent),
      db.prepare(`UPDATE articles SET next_recheck_at=0,latest_ready_revision_id=?,latest_observed_revision_id=?
        WHERE id=?`).bind(old, old, old),
    ]);

    const scheduled = await adminRequest(mf, '/internal/rechecks', { limit: 10 });
    if (scheduled.status !== 202) {
      const errors = await (await mf.dispatchFetch('https://feed.test/__test/errors')).text();
      assert.fail(`${JSON.stringify(scheduled.body)}\nworker errors: ${errors}`);
    }
    assert.equal(scheduled.status, 202, JSON.stringify(scheduled.body));
    assert.equal(scheduled.body.scheduled.length, 2);
    const intervals = await db.prepare(`SELECT
        CASE WHEN id=? THEN next_recheck_at-? ELSE 0 END AS recent,
        CASE WHEN id=? THEN next_recheck_at-? ELSE 0 END AS old
      FROM articles WHERE id IN (?,?)`).bind(recent, now, old, now, recent, old).all();
    assert.equal(intervals.results.length, 2);
    const byArticle = new Map(intervals.results.map(row => [row.recent ? 'recent' : 'old', row]));
    assert.equal(Math.round(byArticle.get('recent').recent / 1000), 3600);
    assert.equal(Math.round(byArticle.get('old').old / 1000), 86400);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE kind='recheck'`).first()).n, 2);
    assert.deepEqual((await db.prepare(`SELECT state FROM outbox WHERE topic='feed-jobs'`).all()).results,
      [{ state: 'queued' }, { state: 'queued' }]);

    await db.prepare('UPDATE articles SET next_recheck_at=0 WHERE id IN (?,?)').bind(recent, old).run();
    const replay = await adminRequest(mf, '/internal/rechecks', { limit: 10 });
    assert.equal(replay.status, 202);
    assert.deepEqual(replay.body.scheduled, []);
    assert.equal(replay.body.duplicate, true);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE kind='recheck'`).first()).n, 2);

    const status = await adminRequest(mf, '/internal/rechecks', undefined, { method: 'GET' });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.due, 0);
    assert.equal(status.body.readyArticles, 2);
    assert.equal(status.body.scheduledTasks, 2);
  } finally {
    await mf.dispose();
  }
});

test('a controlled source recheck produces immutable versions, RSS updates, and one immediate update email', async () => {
  const submissions = [];
  const { mf, db, login, mail, mailClock, replayMail } = await subscriptionsFixture({
    clock: start,
    mailHarness: { async fetch(request) {
      submissions.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
      return Response.json({ id: `99999999-9999-4999-8999-${String(submissions.length).padStart(12, '0')}` });
    } },
    recheckMigration: true,
    recheckHarness: true,
    recheckVars: {
      RECHECK_RECENT_AFTER_SEC: '1728000',
      RECHECK_RECENT_INTERVAL_SEC: '3600',
      RECHECK_OLD_INTERVAL_SEC: '86400',
    },
  });
  try {
    const articleId = '123456789012345678901234';
    await seedReadyEvent(mf, {
      id: articleId,
      sourceId: 'jwc',
      firstSeenAt: start - 86_400_000,
      observedAt: start - 86_400_000,
      readyAt: start - 86_400_000,
      publishedAt: new Date(start - 86_400_000).toISOString(),
      datePrecision: 'minute',
      title: '旧文更新基线',
    });
    await db.prepare(`UPDATE articles SET next_recheck_at=0,next_revision_no=2,latest_ready_revision_id=?,latest_observed_revision_id=? WHERE id=?`)
      .bind(articleId, articleId, articleId).run();
    const subscription = await subscriptionsInvoke(mf, 'change', { id: 'recheck-reader' }, {
      requestId: 'recheck-immediate-subscription', name: '复查更新', sourceIds: ['jwc'], emailMode: 'immediate',
    });
    assert.equal(subscription.status, 200, JSON.stringify(subscription.body));

    const scheduled = await adminRequest(mf, '/internal/rechecks', { limit: 1 });
    if (scheduled.status !== 202) {
      const errors = await (await mf.dispatchFetch('https://feed.test/__test/errors')).text();
      assert.fail(`${JSON.stringify(scheduled.body)}\nworker errors: ${errors}`);
    }
    assert.equal(scheduled.status, 202, JSON.stringify(scheduled.body));
    const taskId = scheduled.body.scheduled[0];
    assert.match(taskId, /^[a-f0-9]{24}$/);
    const captured = await moduleInvoke(mf, '/__test/recheck-capture', { taskId });
    if (captured.status !== 200) assert.fail(await captured.text());
    const changed = await captured.json();
    if (changed.outcome !== 'new') assert.fail(JSON.stringify(changed));
    assert.equal(changed.outcome, 'new');
    assert.equal(changed.revisionState, 'assembling');
    assert.equal((await sourceCalls(mf)).length, 1);
    for (let round = 0; round < 3; round++) {
      const rows = await db.prepare(`SELECT id,payload_json FROM outbox WHERE topic='feed-events' AND state='queued' ORDER BY created_at,id`).all();
      if (!rows.results.length) break;
      const replay = await feedJobsInvoke(mf, ...rows.results.map(row => JSON.parse(row.payload_json)));
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body.messages.map(message => message.acked), rows.results.map(() => true));
      await db.prepare(`UPDATE outbox SET state='sent' WHERE id IN (${rows.results.map(() => '?').join(',')})`)
        .bind(...rows.results.map(row => row.id)).run();
    }
    assert.equal((await db.prepare(`SELECT state FROM article_revisions WHERE id=?`).bind(changed.revisionId).first()).state, 'ready');

    const cookie = await login('recheck-reader');
    const history = await mf.dispatchFetch(`https://feed.test/api/articles/${articleId}/revisions`, { headers: { Cookie: cookie } });
    assert.equal(history.status, 200, await history.clone().text());
    const revisions = (await history.json()).revisions;
    assert.deepEqual(revisions.map(revision => revision.changeKind), ['substantive', 'baseline']);
    const changedAttachment = await mf.dispatchFetch(`https://feed.test/api/articles/${articleId}/revisions/${changed.revisionId}/files/attachment-1.pdf`, { headers: { Cookie: cookie } });
    assert.equal(changedAttachment.status, 200);
    assert.equal(await changedAttachment.text(), '%PDF-1.7\nchanged');

    await mailClock(Date.now());
    const firstPrepare = await mail('preparePending');
    if (firstPrepare.prepared !== 1) {
      const evidence = await db.prepare(`SELECT
          (SELECT json_group_array(json_object('kind',kind,'historyOnly',history_only,'observedAt',observed_at)) FROM content_events WHERE article_id=?) AS events,
          (SELECT json_group_array(json_object('kind',eligibility_kind,'reason',reason)) FROM notification_matches WHERE event_id IN (SELECT id FROM content_events WHERE article_id=?)) AS matches,
          (SELECT json_group_array(json_object('state',state,'kind',delivery_kind,'reason',suppression_reason)) FROM user_deliveries WHERE event_id IN (SELECT id FROM content_events WHERE article_id=?)) AS deliveries,
          (SELECT json_group_array(json_object('emailMode',email_mode,'activatedAt',activated_at)) FROM subscriptions WHERE owner_sub='recheck-reader') AS subscriptions`).bind(articleId, articleId, articleId).first();
      assert.fail(`${JSON.stringify(firstPrepare)}\n${JSON.stringify(evidence)}`);
    }
    await replayMail();
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].body.subject, '内容更新：复查通知');
    assert.match(submissions[0].body.text, new RegExp(`/articles/${articleId}\\?revision=${changed.revisionId}`));

    const rss = await mf.dispatchFetch('https://feed.test' + subscription.body.subscription.rssUrl);
    assert.equal(rss.status, 200, await rss.clone().text());
    const xml = await rss.text();
    assert.deepEqual(itemTitles(xml).sort(), ['复查通知', '旧文更新基线']);
    assert.equal(new Set(itemGuids(xml)).size, 2);
    assert.equal(items(xml).filter(item => item.includes('<category>更新</category>')).length, 1);

    await db.prepare('UPDATE articles SET next_recheck_at=? WHERE id=?').bind(Date.now() - 2000, articleId).run();
    const revertedSchedule = await adminRequest(mf, '/internal/rechecks', { limit: 1 });
    const revertedTaskId = revertedSchedule.body.scheduled[0];
    await moduleInvoke(mf, '/__test/recheck-source', { mode: 'reverted' });
    const revertedCapture = await moduleInvoke(mf, '/__test/recheck-capture', { taskId: revertedTaskId });
    const reverted = await revertedCapture.json();
    for (let round = 0; round < 3; round++) {
      const rows = await db.prepare(`SELECT id,payload_json FROM outbox WHERE topic='feed-events' AND state='queued' ORDER BY created_at,id`).all();
      if (!rows.results.length) break;
      await feedJobsInvoke(mf, ...rows.results.map(row => JSON.parse(row.payload_json)));
      await db.prepare(`UPDATE outbox SET state='sent' WHERE id IN (${rows.results.map(() => '?').join(',')})`)
        .bind(...rows.results.map(row => row.id)).run();
    }
    const timeline = await (await mf.dispatchFetch(`https://feed.test/api/articles/${articleId}/revisions`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(timeline.revisions.map(revision => revision.changeKind), ['substantive', 'substantive', 'baseline']);
    const originalAttachment = await mf.dispatchFetch(`https://feed.test/api/articles/${articleId}/revisions/${reverted.revisionId}/files/attachment-1.pdf`, { headers: { Cookie: cookie } });
    assert.equal(await originalAttachment.text(), '%PDF-1.7\noriginal');
    assert.equal((await db.prepare('SELECT latest_ready_revision_id AS id FROM articles WHERE id=?').bind(articleId).first()).id, reverted.revisionId);

    await mailClock(Date.now());
    assert.equal((await mail('preparePending')).prepared, 1);
    await replayMail();
    assert.equal(submissions.length, 2);
    assert.deepEqual([...new Set(submissions.map(message => message.key))].length, 2);
    const revertedRss = await mf.dispatchFetch('https://feed.test' + subscription.body.subscription.rssUrl);
    const revertedXml = await revertedRss.text();
    assert.equal(itemTitles(revertedXml).length, 3);
    assert.equal(new Set(itemGuids(revertedXml)).size, 3);

    await db.prepare('UPDATE articles SET next_recheck_at=? WHERE id=?').bind(Date.now() - 1000, articleId).run();
    const failureSchedule = await adminRequest(mf, '/internal/rechecks', { limit: 1 });
    await moduleInvoke(mf, '/__test/recheck-source', { mode: 'unavailable' });
    const failure = await moduleInvoke(mf, '/__test/recheck-capture', { taskId: failureSchedule.body.scheduled[0] });
    assert.equal(failure.status, 200);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM article_revisions WHERE article_id=?').bind(articleId).first()).n, 3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM content_events WHERE article_id=?').bind(articleId).first()).n, 3);
    const failedTask = await db.prepare('SELECT state,last_error AS lastError FROM tasks WHERE id=?')
      .bind(failureSchedule.body.scheduled[0]).first();
    assert.deepEqual({ state: failedTask.state, error: failedTask.lastError },
      { state: 'failed', error: 'source unavailable' });
    const afterFailure = await mf.dispatchFetch('https://feed.test' + subscription.body.subscription.rssUrl);
    assert.deepEqual(itemTitles(await afterFailure.text()).sort(), ['复查通知', '复查通知', '旧文更新基线']);
  } finally {
    await mf.dispose();
  }
});

async function moduleInvoke(mf, path, body) {
  return mf.dispatchFetch('https://feed.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sourceCalls(mf) {
  return (await (await moduleInvoke(mf, '/__test/recheck-source', {})).json()).calls;
}

function items(xml) {
  return [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].map(match => match[0]);
}

function itemTitles(xml) {
  return items(xml).map(item => /<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? '');
}

function itemGuids(xml) {
  return items(xml).map(item => /<guid[^>]*>([\s\S]*?)<\/guid>/.exec(item)?.[1] ?? '');
}
