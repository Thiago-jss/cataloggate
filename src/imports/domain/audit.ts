export type SupplierFormat = 'flat' | 'nested';
export type RejectionCode = 'INVALID_SKU' | 'INVALID_STOCK' | 'DUPLICATE_SKU';
export type AcceptedRow = { row: number; sku: string; stock: number };
export type RejectedRow = { row: number; reasons: RejectionCode[] };
export type Audit = { accepted: AcceptedRow[]; rejected: RejectedRow[] };

function fieldsOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const extractors: Record<SupplierFormat, (item: Record<string, unknown>) => [unknown, unknown]> = {
  flat: (item) => [item.sku, item.stock],
  nested: (item) => [fieldsOf(item.product).code, fieldsOf(item.inventory).available],
};

function normalizeSku(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sku = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(sku) ? sku.toUpperCase() : null;
}

function normalizeStock(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function auditCatalog(format: SupplierFormat, items: readonly unknown[]): Audit {
  const extract = extractors[format];
  const skuCounts = new Map<string, number>();
  const candidates = items.map((item, index) => {
    const [rawSku, rawStock] = extract(fieldsOf(item));
    const sku = normalizeSku(rawSku);
    if (sku !== null) skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
    return { row: index + 1, sku, stock: normalizeStock(rawStock) };
  });

  const audit: Audit = { accepted: [], rejected: [] };
  for (const { row, sku, stock } of candidates) {
    const reasons: RejectionCode[] = [];
    if (sku === null) reasons.push('INVALID_SKU');
    if (stock === null) reasons.push('INVALID_STOCK');
    if (sku !== null && (skuCounts.get(sku) ?? 0) > 1) reasons.push('DUPLICATE_SKU');
    if (sku !== null && stock !== null && reasons.length === 0) {
      audit.accepted.push({ row, sku, stock });
    } else {
      audit.rejected.push({ row, reasons });
    }
  }
  return audit;
}
