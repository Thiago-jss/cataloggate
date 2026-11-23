import { createHash, randomUUID } from 'node:crypto';
import { type ImportStatus, type IntakeStore } from './contracts';
import { IdempotencyConflict, SupplierNotFound } from './import-errors';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SubmittedItems = Json[];

function canonicalize(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class SubmitImport {
  constructor(private readonly store: IntakeStore) {}

  async execute(
    supplier: string,
    idempotencyKey: string,
    items: SubmittedItems,
  ): Promise<ImportStatus> {
    if (!(await this.store.sourceExists(supplier))) throw new SupplierNotFound();
    const fingerprint = createHash('sha256').update(canonicalize(items)).digest('hex');
    const registered = await this.store.accept({
      id: randomUUID(),
      supplier,
      idempotencyKey,
      fingerprint,
      payload: JSON.stringify(items),
      itemCount: items.length,
    });
    if (registered.fingerprint !== fingerprint) throw new IdempotencyConflict();
    return registered.status;
  }
}
