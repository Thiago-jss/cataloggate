import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connect } from 'amqplib';
import { MongoClient } from 'mongodb';
import pg from 'pg';
import { createClient } from 'redis';
import { completed, fixture, request, submit, until } from '../scripts/client.mjs';

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
  return completed(accepted.body.id);
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
  const trail = await request(reportPath(trailStatus.id));
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
