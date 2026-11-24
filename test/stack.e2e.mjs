import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connect } from 'amqplib';
import { MongoClient } from 'mongodb';
import pg from 'pg';
import { createClient } from 'redis';
import { completed, demoKey, fixture, request, submit, until } from '../scripts/client.mjs';

const queue = 'cataloggate.imports.v1';
const deadQueue = 'cataloggate.imports.dead.v1';
const reportPath = (id) => '/imports/' + id + '/report';

async function broker(t) {
  const link = await connect(process.env.RABBIT_URL);
  t.after(() => link.close());
  return link.createConfirmChannel();
}

async function submitAndWait(input) {
  const accepted = await submit(input);
  assert.equal(accepted.status, 202);
  return completed(accepted.body.id, undefined, demoKey(input.supplier));
}

test('produces reports for both supplier formats and serves a cached report with TTL', async (t) => {
  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', () => undefined);
  await redis.connect();
  t.after(() => redis.close());
  const northwind = await fixture('northwind');
  const northStatus = await submitAndWait(northwind);
  const north = await request(reportPath(northStatus.id));
  assert.equal(north.status, 200);
  assert.deepEqual(north.body.totals, { accepted: 1, rejected: 3 });
  assert.deepEqual(north.body.accepted, [{ row: 1, sku: 'FRAME-42', stock: 4 }]);
  assert.deepEqual(north.body.rejected, [
    { row: 2, reasons: ['INVALID_STOCK'], original: northwind.items[1] },
    { row: 3, reasons: ['DUPLICATE_SKU'], original: northwind.items[2] },
    { row: 4, reasons: ['DUPLICATE_SKU'], original: northwind.items[3] },
  ]);
  const key = 'cataloggate:report:v1:' + northStatus.id;
  const ttl = await redis.ttl(key);
  assert(ttl > 0 && ttl <= 300);
  assert.deepEqual(JSON.parse(await redis.get(key)), north.body);
  assert.deepEqual((await request(reportPath(northStatus.id))).body, north.body);
  const trailforge = await fixture('trailforge');
  const trailStatus = await submitAndWait(trailforge);
  const trail = await request(
    reportPath(trailStatus.id),
    undefined,
    undefined,
    demoKey('trailforge'),
  );
  assert.equal(trail.status, 200);
  assert.deepEqual(trail.body, {
    id: trailStatus.id,
    supplier: 'trailforge',
    totals: { accepted: 1, rejected: 1 },
    accepted: [{ row: 1, sku: 'BELL-11', stock: 15 }],
    rejected: [{ row: 2, reasons: ['INVALID_SKU'], original: trailforge.items[1] }],
  });
});

test('deduplicates concurrent submissions, persists one outbox entry and rejects changed input', async (t) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(() => pool.end());
  const key = randomUUID();
  const input = { supplier: 'northwind', items: [{ sku: 'KIT-1', stock: 3 }] };
  const reordered = { supplier: 'northwind', items: [{ stock: 3, sku: 'KIT-1' }] };
  const replies = await Promise.all(
    Array.from({ length: 12 }, (_, index) => submit(index % 2 ? input : reordered, key)),
  );
  assert(replies.every((response) => response.status === 202));
  const [id] = new Set(replies.map((response) => response.body.id));
  assert(
    replies.every((response) => response.body.id === id && response.location === '/imports/' + id),
  );
  const result = await pool.query(
    `SELECT i.id, o.import_id FROM catalog_imports i
    JOIN import_outbox o ON o.import_id = i.id WHERE i.supplier_code = $1 AND i.idempotency_key = $2`,
    ['northwind', key],
  );
  assert.deepEqual(result.rows, [{ id, import_id: id }]);
  const changed = await submit({ ...input, items: [{ sku: 'KIT-1', stock: 7 }] }, key);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'IDEMPOTENCY_CONFLICT');
  await completed(id);
  const row = await pool.query(
    'SELECT payload IS NULL AS released FROM catalog_imports WHERE id = $1',
    [id],
  );
  assert.deepEqual(row.rows, [{ released: true }]);
});

test('processes repeated RabbitMQ deliveries without replacing the audit or completion time', async (t) => {
  const mongo = new MongoClient(process.env.MONGO_URL);
  await mongo.connect();
  t.after(() => mongo.close());
  const audits = mongo.db(process.env.MONGO_DB).collection('catalog_audits');
  const before = await submitAndWait(await fixture('northwind'));
  const document = await audits.findOne({ _id: before.id });
  assert(document);
  const channel = await broker(t);
  const content = Buffer.from(JSON.stringify({ importId: before.id }));
  for (let i = 0; i < 2; i += 1)
    channel.sendToQueue(queue, content, { messageId: before.id, persistent: true });
  await channel.waitForConfirms();
  // One consumer with prefetch=1 must finish the two earlier deliveries before this barrier.
  await submitAndWait(await fixture('trailforge'));
  assert.deepEqual((await request('/imports/' + before.id)).body, before);
  assert.deepEqual(await audits.findOne({ _id: before.id }), document);
  assert.equal(await audits.countDocuments({ _id: before.id }), 1);
});

test('dead-letters a malformed internal message without preventing subsequent imports', async (t) => {
  const channel = await broker(t);
  const before = await channel.checkQueue(deadQueue);
  channel.sendToQueue(queue, Buffer.from('{}'), { persistent: true });
  await channel.waitForConfirms();
  await until(
    async () => (await channel.checkQueue(deadQueue)).messageCount > before.messageCount,
    'dead-letter routing',
  );
  await submitAndWait(await fixture('trailforge'));
});

test('returns documented errors and rejects oversized bodies', async () => {
  assert.equal(
    (await submit({ supplier: 'unknown-supplier', items: [{}] })).body.code,
    'SUPPLIER_NOT_FOUND',
  );
  assert.equal((await submit(await fixture('northwind'), 'invalid')).status, 400);
  assert.equal((await submit({ supplier: 'northwind', items: [] })).status, 400);
  assert.equal((await request('/imports/' + randomUUID())).body.code, 'IMPORT_NOT_FOUND');
  assert.equal((await request('/imports/not-an-id')).status, 400);
  const oversized = await submit({ supplier: 'northwind', items: ['a'.repeat(132_000)] });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'PAYLOAD_TOO_LARGE');
  const malformed = await request('/imports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"items":[synthetic-untrusted-input]}',
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'BAD_REQUEST');
  assert(!JSON.stringify(malformed.body).includes('synthetic-untrusted-input'));
});

test('runtime clients cannot read migration metadata, write through the Mongo reader, or use Redis anonymously', async (t) => {
  const postgres = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const mongo = new MongoClient(process.env.MONGO_URL);
  const redisUrl = new URL(process.env.REDIS_URL);
  redisUrl.password = '';
  const redis = createClient({ url: redisUrl.toString(), socket: { reconnectStrategy: false } });
  redis.on('error', () => undefined);
  t.after(async () => {
    if (redis.isOpen) redis.destroy();
    await Promise.all([postgres.end(), mongo.close()]);
  });
  await assert.rejects(postgres.query('SELECT 1 FROM cataloggate_migrations'), { code: '42501' });
  const audits = mongo.db(process.env.MONGO_DB).collection('catalog_audits');
  await assert.rejects(
    audits.updateOne({ _id: randomUUID() }, { $set: { supplier: 'northwind' } }),
    { code: 13 },
  );
  await redis.connect();
  await assert.rejects(redis.ping(), /NOAUTH/);
});

async function approval(id, expectedVersion, token = demoKey('northwind', 'reviewer')) {
  return request(
    '/imports/' + id + '/publish',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion }),
    },
    undefined,
    token,
  );
}

async function preview(id) {
  return request('/imports/' + id + '/preview');
}

test('authenticates roles and denies cross-supplier reads even when the report is cached', async () => {
  const id = (await submitAndWait(await fixture('northwind'))).id;
  assert.equal((await request('/imports/' + id, undefined, undefined, null)).status, 401);
  assert.equal((await request('/imports/' + id, undefined, undefined, 'f'.repeat(64))).status, 401);
  assert.equal((await request(reportPath(id))).status, 200);
  const other = demoKey('trailforge', 'reviewer');
  assert.equal((await request('/imports/' + id, undefined, undefined, other)).status, 404);
  assert.equal((await request(reportPath(id), undefined, undefined, other)).status, 404);
  assert.equal((await approval(id, 0, other)).status, 404);
  assert.equal((await approval(id, 0, demoKey())).status, 403);
  assert.equal((await approval(id, 0)).body.code, 'REJECTED_ITEMS');
  assert.equal(
    (
      await submit(
        await fixture('northwind'),
        undefined,
        undefined,
        demoKey('northwind', 'reviewer'),
      )
    ).status,
    403,
  );
  assert.equal(
    (await submit(await fixture('trailforge'), undefined, undefined, demoKey())).status,
    404,
  );
});

test('publishes a reviewed diff atomically, prevents duplicate and stale releases, and preserves history', async (t) => {
  const pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(() => pgPool.end());
  const sku = 'SKU-' + randomUUID().toUpperCase();
  const queueBatch = (stock) => submitAndWait({ supplier: 'northwind', items: [{ sku, stock }] });
  const [first, second] = await Promise.all([queueBatch(10), queueBatch(20)]);
  const [previewA, previewB] = await Promise.all([preview(first.id), preview(second.id)]);
  assert.equal(previewA.status, 200);
  assert.equal(previewB.status, 200);
  const version = previewA.body.baseVersion;
  assert.equal(previewB.body.baseVersion, version);
  assert.deepEqual(previewA.body.changes, [{ sku, before: null, after: 10, kind: 'added' }]);

  const concurrent = await Promise.all([
    approval(first.id, version),
    approval(first.id, version),
    approval(second.id, version),
  ]);
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [201, 409, 409]);
  const winner = concurrent.find((item) => item.status === 201).body;
  assert.equal(winner.version, version + 1);
  assert.equal(winner.approvedBy, 'northwind-reviewer');
  const loser = winner.importId === first.id ? second.id : first.id;
  assert.equal((await approval(winner.importId, version)).body.code, 'ALREADY_PUBLISHED');
  assert.equal((await approval(loser, version)).body.code, 'STALE_PREVIEW');
  const nextPreview = await preview(loser);
  assert.equal(nextPreview.body.baseVersion, version + 1);
  assert.equal(nextPreview.body.changes[0].before, winner.changes[0].after);
  assert.equal(nextPreview.body.changes[0].kind, 'updated');
  const published = await approval(loser, nextPreview.body.baseVersion);
  assert.equal(published.status, 201);
  assert.equal(published.body.version, version + 2);
  assert.deepEqual((await request('/imports/' + winner.importId + '/release')).body, winner);
  assert.equal(
    (
      await request(
        '/imports/' + winner.importId + '/release',
        undefined,
        undefined,
        demoKey('trailforge'),
      )
    ).status,
    404,
  );
  const stored = await pgPool.query(
    'SELECT stock FROM catalog_inventory WHERE supplier_code = $1 AND sku = $2',
    ['northwind', sku],
  );
  assert.equal(Number(stored.rows[0].stock), published.body.changes[0].after);
  const releases = await pgPool.query(
    'SELECT version FROM catalog_releases WHERE import_id = ANY($1::uuid[]) ORDER BY version',
    [[first.id, second.id]],
  );
  assert.deepEqual(
    releases.rows.map((row) => row.version),
    [version + 1, version + 2],
  );
  const noChange = await queueBatch(published.body.changes[0].after);
  assert.equal((await approval(noChange.id, version + 2)).body.code, 'NO_CHANGES');
});
