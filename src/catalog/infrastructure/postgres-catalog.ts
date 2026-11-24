import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../identity/actor';
import { ImportNotFound } from '../../imports/application/import-errors';
import { inTransaction } from '../../platform/transaction';
import {
  ReviewConflict,
  type Candidate,
  type CatalogStore,
  type Preview,
  type Release,
} from '../application/catalog-review';
import { compareInventory, type StockChange } from '../domain/inventory-changes';

type ReleaseRow = {
  import_id: string;
  supplier_code: string;
  version: number;
  approved_by: string;
  published_at: Date;
  changes: StockChange[];
};

function toRelease(row: ReleaseRow): Release {
  return {
    importId: row.import_id,
    supplier: row.supplier_code,
    version: row.version,
    approvedBy: row.approved_by,
    publishedAt: row.published_at.toISOString(),
    changes: row.changes,
  };
}

async function currentVersion(
  client: PoolClient,
  supplier: string,
  lock: boolean,
): Promise<number> {
  const sql = 'SELECT version FROM catalog_heads WHERE supplier_code = $1';
  const { rows } = await client.query<{ version: number }>(lock ? sql + ' FOR UPDATE' : sql, [
    supplier,
  ]);
  if (!rows[0]) throw new Error('Catalog head missing');
  return rows[0].version;
}

async function changesFor(
  client: PoolClient,
  { supplier, lines }: Candidate,
): Promise<StockChange[]> {
  const { rows } = await client.query<{ sku: string; stock: string }>(
    'SELECT sku, stock FROM catalog_inventory WHERE supplier_code = $1 AND sku = ANY($2::text[])',
    [supplier, lines.map(({ sku }) => sku)],
  );
  return compareInventory(new Map(rows.map(({ sku, stock }) => [sku, Number(stock)])), lines);
}

export class PostgresCatalog implements CatalogStore {
  constructor(private readonly pool: Pool) {}

  preview(candidate: Candidate): Promise<Preview> {
    return inTransaction(
      this.pool,
      async (client) => {
        const baseVersion = await currentVersion(client, candidate.supplier, false);
        const changes = await changesFor(client, candidate);
        return { importId: candidate.importId, supplier: candidate.supplier, baseVersion, changes };
      },
      true,
    );
  }

  async readRelease(importId: string, supplier: string): Promise<Release | null> {
    const { rows } = await this.pool.query<ReleaseRow>(
      'SELECT * FROM catalog_releases WHERE import_id = $1 AND supplier_code = $2',
      [importId, supplier],
    );
    return rows[0] ? toRelease(rows[0]) : null;
  }

  publish(candidate: Candidate, actor: Actor, expectedVersion: number): Promise<Release> {
    const { importId, supplier } = candidate;
    return inTransaction(this.pool, async (client) => {
      const version = await currentVersion(client, supplier, true);
      const imported = await client.query<{
        submitted_by: string | null;
        state: string;
        rejected_count: number | null;
      }>(
        'SELECT submitted_by, state, rejected_count FROM catalog_imports WHERE id = $1 AND supplier_code = $2',
        [importId, supplier],
      );
      const row = imported.rows[0];
      if (!row) throw new ImportNotFound();
      if (row.state !== 'completed') throw new ReviewConflict('AUDIT_REQUIRED');
      if (row.rejected_count !== 0) throw new ReviewConflict('REJECTED_ITEMS');
      if (!row.submitted_by) throw new ReviewConflict('LEGACY_IMPORT');
      if (row.submitted_by === actor.id) throw new ReviewConflict('SELF_APPROVAL');
      const previous = await client.query('SELECT 1 FROM catalog_releases WHERE import_id = $1', [
        importId,
      ]);
      if (previous.rowCount) throw new ReviewConflict('ALREADY_PUBLISHED');
      if (version !== expectedVersion) throw new ReviewConflict('STALE_PREVIEW');
      const changes = await changesFor(client, candidate);
      const changed = changes.filter(({ kind }) => kind !== 'unchanged');
      if (!changed.length) throw new ReviewConflict('NO_CHANGES');
      await client.query(
        `INSERT INTO catalog_inventory (supplier_code, sku, stock)
        SELECT $1, sku, stock FROM unnest($2::text[], $3::bigint[]) AS patch(sku, stock)
        ON CONFLICT (supplier_code, sku) DO UPDATE SET stock = EXCLUDED.stock`,
        [supplier, changed.map(({ sku }) => sku), changed.map(({ after }) => after)],
      );
      const release = await client.query<ReleaseRow>(
        `INSERT INTO catalog_releases
        (supplier_code, version, import_id, approved_by, changes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [supplier, version + 1, importId, actor.id, JSON.stringify(changes)],
      );
      await client.query('UPDATE catalog_heads SET version = $2 WHERE supplier_code = $1', [
        supplier,
        version + 1,
      ]);
      if (!release.rows[0]) throw new Error('Release was not persisted');
      return toRelease(release.rows[0]);
    });
  }
}
