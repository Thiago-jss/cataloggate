import assert from 'node:assert/strict';
import { completed, fixture, request, submit } from './client.mjs';

for (const [name, totals] of [
  ['northwind', { accepted: 1, rejected: 3 }],
  ['trailforge', { accepted: 1, rejected: 1 }],
]) {
  const result = await submit(await fixture(name));
  assert.equal(result.status, 202);
  const { id, status } = result.body;
  console.log(name + ' → HTTP 202 · ' + status + ' · ' + id);
  await completed(id);
  const report = await request('/imports/' + id + '/report');
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.totals, totals);
  console.log('  ' + totals.accepted + ' aceito(s), ' + totals.rejected + ' rejeitado(s)');
  for (const row of report.body.rejected) {
    console.log(
      '  Linha ' + row.row + ' · ' + row.reasons.join(', ') + ' · ' + JSON.stringify(row.original),
    );
  }
}
