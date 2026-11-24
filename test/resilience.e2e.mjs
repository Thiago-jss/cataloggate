import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { completed, demoKey, fixture, request, submit, until } from '../scripts/client.mjs';

const project = process.env.CATALOGGATE_TEST_PROJECT;
assert(
  ['cataloggate-qa', 'cataloggate-ci'].includes(project),
  'Use a dedicated CatalogGate QA or CI Compose project',
);
const run = promisify(execFile);
const compose = (...args) =>
  run('docker', ['compose', '-p', project, ...args], { timeout: 60_000 });
const { stdout } = await compose('port', 'api', '3000');
const address = stdout.trim();
assert(/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(address), 'Expected a loopback-only test endpoint');
const base = 'http://' + address;

test('accepts a batch during an actual broker outage and processes it after RabbitMQ restarts', async () => {
  await compose('stop', 'rabbitmq');
  let id;
  try {
    const accepted = await submit(await fixture('northwind'), undefined, base);
    assert.equal(accepted.status, 202);
    id = accepted.body.id;
    assert.equal(accepted.body.status, 'pending');
    await delay(900);
    assert.equal((await request('/imports/' + id, undefined, base)).body.status, 'pending');
    const unavailable = await request('/imports/' + id + '/report', undefined, base);
    assert.equal(unavailable.status, 409);
    assert.equal(unavailable.body.code, 'REPORT_NOT_AVAILABLE');
  } finally {
    await compose('start', 'rabbitmq');
  }
  const result = await completed(id, base);
  assert.deepEqual(result.totals, { accepted: 1, rejected: 3 });
});

test('reads the same report from durable storage with Redis offline', async () => {
  const accepted = await submit(await fixture('trailforge'), undefined, base);
  assert.equal(accepted.status, 202);
  const token = demoKey('trailforge');
  await completed(accepted.body.id, base, token);
  const path = '/imports/' + accepted.body.id + '/report';
  const before = await request(path, undefined, base, token);
  assert.equal(before.status, 200);
  await compose('stop', 'redis');
  try {
    const fallback = await request(path, undefined, base, token);
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body, before.body);
  } finally {
    await compose('start', 'redis');
  }
});

test('retains work across worker interruption and reprocesses a real technical failure exactly once per generation', async () => {
  const reviewer = demoKey('northwind', 'reviewer');
  const getStatus = (id) => request('/imports/' + id, undefined, base);
  const history = (id, token = reviewer) =>
    request('/imports/' + id + '/attempts', undefined, base, token);
  const metrics = () => request('/ops/metrics', undefined, base, reviewer);
  const retry = (id, expectedGeneration, token = reviewer) =>
    request(
      '/imports/' + id + '/retry',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedGeneration }),
      },
      base,
      token,
    );

  const before = await metrics();
  assert.equal(before.status, 200);
  let waiting;
  await compose('stop', 'worker');
  try {
    waiting = await submit(await fixture('northwind'), undefined, base);
    assert.equal(waiting.status, 202);
    assert.equal((await getStatus(waiting.body.id)).body.status, 'pending');
    assert((await metrics()).body.pendingImports > before.body.pendingImports);
  } finally {
    await compose('start', 'worker');
  }
  await completed(waiting.body.id, base);
  assert.equal((await retry(waiting.body.id, 1)).body.code, 'RETRY_NOT_AVAILABLE');

  const sku = 'RECOVERY-' + randomUUID().toUpperCase();
  let id;
  await compose('stop', 'mongo');
  try {
    const submitted = await submit(
      { supplier: 'northwind', items: [{ sku, stock: 7 }] },
      undefined,
      base,
    );
    assert.equal(submitted.status, 202);
    id = submitted.body.id;
    const failed = await until(async () => {
      const status = await getStatus(id);
      assert.equal(status.status, 200);
      return status.body.status === 'failed' ? status.body : null;
    }, 'terminal failure while MongoDB is offline');
    assert.equal(failed.generation, 1);
    assert.deepEqual(
      (await history(id)).body.attempts.map(({ generation, outcome }) => [generation, outcome]),
      [
        [1, 'technical_failure'],
        [1, 'technical_failure'],
        [1, 'technical_failure'],
      ],
    );
    assert((await metrics()).body.failedAttempts >= before.body.failedAttempts + 3);
    assert.equal((await retry(id, 1, demoKey())).status, 403);
    assert.equal((await retry(id, 1, demoKey('trailforge', 'reviewer'))).status, 404);
    assert.equal((await history(id, demoKey('trailforge', 'reviewer'))).status, 404);
  } finally {
    await compose('start', 'mongo');
    await compose('up', '-d', '--no-deps', '--wait', 'mongo');
  }
  const retries = await Promise.all([retry(id, 1), retry(id, 1)]);
  assert.deepEqual(retries.map(({ status }) => status).sort(), [202, 409]);
  assert.equal(retries.find(({ status }) => status === 409).body.code, 'STALE_GENERATION');
  const done = await completed(id, base);
  assert.equal(done.generation, 2);
  assert.deepEqual(done.totals, { accepted: 1, rejected: 0 });
  const log = await history(id);
  assert.deepEqual(
    log.body.attempts.map(({ generation, outcome }) => [generation, outcome]),
    [
      [2, 'succeeded'],
      [1, 'technical_failure'],
      [1, 'technical_failure'],
      [1, 'technical_failure'],
    ],
  );
  assert.deepEqual(
    log.body.retries.map(({ generation, requestedBy }) => [generation, requestedBy]),
    [[2, 'northwind-reviewer']],
  );
  const preview = await request('/imports/' + id + '/preview', undefined, base, reviewer);
  const publication = () =>
    request(
      '/imports/' + id + '/publish',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: preview.body.baseVersion }),
      },
      base,
      reviewer,
    );
  const publications = await Promise.all([publication(), publication()]);
  assert.deepEqual(publications.map(({ status }) => status).sort(), [201, 409]);
  assert.equal(publications.find(({ status }) => status === 201).body.changes[0].sku, sku);
});
