import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { completed, demoKey, fixture, request, submit } from '../scripts/client.mjs';

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
