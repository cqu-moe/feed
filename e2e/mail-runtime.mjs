import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
// External provider only. No product event/message/delivery is inserted.
export function createMailFixture() {
  const bindings = { MAIL_ENABLED: 'true', MAIL_FROM: 'Feed <feed@example.test>',
    RESEND_API_KEY: 're_feed_synthetic_only' };
  const calls = [], clock = [];
  const accepted = new Map();
  let mode = 'accepted', offset = 0, gate, release, rpcSecret;
  const now = () => Date.now() + offset;
  return {
    bindings,
    get offset() { return offset; },
    // A scheduler barrier delays actual native Queue delivery, then forwards the
    // original batch unchanged to the product consumer. It never acknowledges it.
    async queueGate() { if (gate) await gate; return new Response('released'); },
    release() { release?.(); release = null; gate = null; },
    module(productPath, controlSecret, gateMailQueue = true) {
      return `import product from ${JSON.stringify(productPath)};
export * from ${JSON.stringify(productPath)};
const RealDate=Date;let offset=${offset};
globalThis.Date=class extends RealDate{
 constructor(...args){super(...(args.length?args:[RealDate.now()+offset]));}
 static now(){return RealDate.now()+offset;}
};
export default {...product,async fetch(request,env,ctx){
 if(new URL(request.url).pathname==='/__e2e-clock'){
  if(request.headers.get('authorization')!==${JSON.stringify(`Bearer ${controlSecret}`)})return new Response('',{status:403});
  offset=(await request.json()).offset;return Response.json({now:Date.now(),offset});
 }return product.fetch(request,env,ctx);
}${gateMailQueue ? ",async queue(batch,env,ctx){if(batch.messages.some(m=>m.body?.type==='send-mail'))await env.MAIL_E2E_GATE.fetch('https://gate.test/');return product.queue(batch,env,ctx);}" : ''}};`;
    },
    async outbound(request, mf) {
      const url = new URL(request.url);
      if (url.origin !== 'https://api.resend.com' || request.headers.get('authorization') !== `Bearer ${bindings.RESEND_API_KEY}`) return null;
      if (request.method !== 'POST' || url.pathname !== '/emails') throw new Error('Unexpected synthetic mail API');
      const payload = await request.json(), key = request.headers.get('idempotency-key');
      if (!key?.startsWith('feed-mail/') || !payload.to.endsWith('@example.test') || payload.from !== bindings.MAIL_FROM) throw new Error('Refused non-synthetic mail');
      calls.push({ method: 'POST', key, mode, payload, at: now() });
      if (mode === 'rate-limit') return Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': '60' } });
      let item = accepted.get(key);
      if (item && JSON.stringify(item.payload) !== JSON.stringify(payload)) throw new Error('Idempotency key reused with changed payload');
      if (!item) { item = { id: `synthetic-${accepted.size + 1}`, key, payload }; accepted.set(key, item); }
      if (mode === 'lost-response') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{\"id\":'));
        controller.error(new Error('Synthetic connection lost after provider acceptance'));
      } }), { status: 200 });
      return Response.json({ id: item.id });
    },
    async control(input, { mf, db, authDb, controlSecret }) {
      if (input.action === 'mail-mode') {
        if (!['accepted', 'rate-limit', 'lost-response'].includes(input.mode)) throw new Error('Invalid provider mode');
        mode = input.mode; return { mode };
      }
      if (input.action === 'mail-hold') {
        if (input.enabled) { if (gate) throw new Error('Queue already held'); gate = new Promise(done => { release = done; }); }
        else { release?.(); release = null; gate = null; }
        return { held: Boolean(gate) };
      }
      if (input.action === 'mail-clock') {
        if (!Number.isSafeInteger(input.advanceMs) || input.advanceMs < 0 || input.advanceMs > 2 * 86400000) throw new Error('Clock advance out of bounds');
        offset += input.advanceMs;
        // Session expiry, JWT issuance and business deadlines share one timeline.
        // Moving Feed alone makes valid freshly issued Auth tokens look expired.
        const readbacks = await Promise.all(['auth', 'feed'].map(async name => {
          const worker = await mf.getWorker(name);
          const response = await worker.fetch('https://fixture.local/__e2e-clock', { method: 'POST',
            headers: { authorization: `Bearer ${controlSecret}` }, body: JSON.stringify({ offset }) });
          const result = await response.json();
          if (!response.ok || result.offset !== offset) throw new Error(`${name} clock readback failed`);
          return { worker: name, ...result };
        }));
        const result = { offset, readbacks };
        clock.push(result); return result;
      }
      if (input.action === 'mail-recipient') {
        if (input.email && !/^[a-z0-9-]+@example\.test$/.test(input.email)) throw new Error('Synthetic recipient required');
        const before = await authDb.prepare('SELECT email,emailVerified FROM user WHERE id=?').bind(input.userId).first();
        await authDb.prepare('UPDATE user SET email=?,emailVerified=? WHERE id=?').bind(input.email ?? before.email, input.verified === false ? 0 : 1, input.userId).run();
        return authDb.prepare('SELECT email,emailVerified FROM user WHERE id=?').bind(input.userId).first();
      }
      if (input.action === 'mail-rpc-credentials') {
        rpcSecret ??= (await authDb.prepare("SELECT clientSecret FROM oauthClient WHERE clientId='feed-e2e-rpc'").first()).clientSecret;
        await authDb.prepare("UPDATE oauthClient SET clientSecret=? WHERE clientId='feed-e2e-rpc'").bind(input.enabled ? rpcSecret : 'invalid-synthetic-hash').run();
        return { enabled: Boolean(input.enabled) };
      }
      if (input.action === 'mail-duplicate') {
        const row = await db.prepare("SELECT payload_json FROM outbox WHERE id=? AND topic='feed-mail'").bind(input.outboxId).first();
        if (!row) throw new Error('Redelivery requires existing mail outbox');
        await (await mf.getQueueProducer('FEED_MAIL', 'feed')).send(JSON.parse(row.payload_json));
        return { redelivered: input.outboxId };
      }
      if (input.action !== 'mail-state') throw new Error('Unknown mail control');
      const state = { mode, offset, clock: [...clock], held: Boolean(gate), calls: structuredClone(calls), accepted: structuredClone([...accepted.values()]) };
      for (const table of ['mail_messages', 'mail_items', 'mail_digest_windows', 'user_deliveries', 'notification_matches']) state[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
      const bucket = await mf.getR2Bucket('ARCHIVE', 'feed');
      state.snapshots = [];
      for (const row of state.mail_messages) {
        const object = await bucket.get(row.payload_key);
        if (!object) throw new Error('Prepared mail snapshot absent');
        const bytes = await object.arrayBuffer();
        state.snapshots.push({ messageId: row.id, key: row.payload_key, sha256: sha(bytes), payload: JSON.parse(Buffer.from(bytes).toString()) });
      }
      return state;
    },
  };
}
