export type StockLine = { sku: string; stock: number };
export type StockChange = {
  sku: string;
  before: number | null;
  after: number;
  kind: 'added' | 'updated' | 'unchanged';
};

export function compareInventory(
  current: ReadonlyMap<string, number>,
  proposed: readonly StockLine[],
): StockChange[] {
  return proposed.map(({ sku, stock }) => {
    const before = current.get(sku) ?? null;
    return {
      sku,
      before,
      after: stock,
      kind: before === null ? 'added' : before === stock ? 'unchanged' : 'updated',
    };
  });
}
