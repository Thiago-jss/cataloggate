import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { completed, demoKey, fixture, request, submit } from './client.mjs';

for (const [name, totals] of [
  ['northwind', { accepted: 1, rejected: 3 }],
  ['trailforge', { accepted: 1, rejected: 1 }],
]) {
  const result = await submit(await fixture(name));
  assert.equal(result.status, 202);
  const { id, status } = result.body;
  console.log(name + ' → HTTP 202 · ' + status + ' · ' + id);
  await completed(id, undefined, demoKey(name));
  const report = await request('/imports/' + id + '/report', undefined, undefined, demoKey(name));
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.totals, totals);
  console.log('  ' + totals.accepted + ' aceito(s), ' + totals.rejected + ' rejeitado(s)');
  for (const row of report.body.rejected) {
    console.log(
      '  Linha ' + row.row + ' · ' + row.reasons.join(', ') + ' · ' + JSON.stringify(row.original),
    );
  }
}

const sku = 'DEMO-' + randomUUID().toUpperCase();
const clean = await submit({ supplier: 'northwind', items: [{ sku, stock: 5 }] });
assert.equal(clean.status, 202);
const { id: candidateId } = clean.body;
await completed(candidateId);
const review = await request('/imports/' + candidateId + '/preview');
assert.equal(review.status, 200);
assert.deepEqual(review.body.changes, [{ sku, before: null, after: 5, kind: 'added' }]);
const publish = (token) =>
  request(
    '/imports/' + candidateId + '/publish',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: review.body.baseVersion }),
    },
    undefined,
    token,
  );
assert.equal((await publish(demoKey())).status, 403);
const release = await publish(demoKey('northwind', 'reviewer'));
assert.equal(release.status, 201);
assert.deepEqual((await request('/imports/' + candidateId + '/release')).body, release.body);
console.log(
  'Catálogo: ' +
    sku +
    ' adicionado; versão ' +
    release.body.version +
    ' aprovada por ' +
    release.body.approvedBy,
);
