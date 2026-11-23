import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditCatalog } from '../src/imports/domain/audit';

test('normalizes both supplier formats into the same catalog shape', () => {
  const flat = auditCatalog('flat', [{ sku: ' bike-42 ', stock: 3, color: 'blue' }]);
  const nested = auditCatalog('nested', [
    { product: { code: 'BIKE-42' }, inventory: { available: 3 } },
  ]);
  const expected = { accepted: [{ row: 1, sku: 'BIKE-42', stock: 3 }], rejected: [] };
  assert.deepEqual(flat, expected);
  assert.deepEqual(nested, expected);
});

test('rejects every row of a duplicate SKU, even if another rule already rejects it', () => {
  assert.deepEqual(
    auditCatalog('flat', [
      { sku: 'A', stock: -1 },
      { sku: ' a ', stock: 2 },
      { sku: '', stock: '8' },
      { sku: 'B', stock: 0 },
      null,
    ]),
    {
      accepted: [{ row: 4, sku: 'B', stock: 0 }],
      rejected: [
        { row: 1, reasons: ['INVALID_STOCK', 'DUPLICATE_SKU'] },
        { row: 2, reasons: ['DUPLICATE_SKU'] },
        { row: 3, reasons: ['INVALID_SKU', 'INVALID_STOCK'] },
        { row: 5, reasons: ['INVALID_SKU', 'INVALID_STOCK'] },
      ],
    },
  );
});

test('rejects coercion, fractions, and unsafe stock quantities', () => {
  const quantities = ['2', 1.2, Number.MAX_SAFE_INTEGER + 1, null];
  const result = auditCatalog(
    'flat',
    quantities.map((stock, i) => ({ sku: `SKU-${i}`, stock })),
  );
  assert.deepEqual(result, {
    accepted: [],
    rejected: quantities.map((_, i) => ({ row: i + 1, reasons: ['INVALID_STOCK'] })),
  });
});
