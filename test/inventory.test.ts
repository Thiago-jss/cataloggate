import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareInventory } from '../src/catalog/domain/inventory-changes';

test('distinguishes zero stock from an absent SKU and does not delete omitted lines', () => {
  assert.deepEqual(
    compareInventory(
      new Map([
        ['A', 0],
        ['B', 2],
        ['OMITTED', 5],
      ]),
      [
        { sku: 'A', stock: 1 },
        { sku: 'B', stock: 2 },
        { sku: 'C', stock: 0 },
      ],
    ),
    [
      { sku: 'A', before: 0, after: 1, kind: 'updated' },
      { sku: 'B', before: 2, after: 2, kind: 'unchanged' },
      { sku: 'C', before: null, after: 0, kind: 'added' },
    ],
  );
});
