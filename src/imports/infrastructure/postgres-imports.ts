import type { Pool, PoolClient } from 'pg';
import type {
  AuditTotals,
  ImportStatus,
  IntakeStore,
  NewImport,
  StatusStore,
  WorkItem,
  WorkStore,
} from '../application/contracts';

type Row = {
  id: string;
  supplier_code: string;
  fingerprint: string;
  state: ImportStatus['status'];
  item_count: number;
  submitted_at: Date;
  finished_at: Date | null;
  accepted_count: number | null;
  rejected_count: number | null;
};

function toStatus(row: Row): ImportStatus {
  return {
    id: row.id,
    supplier: row.supplier_code,
    status: row.state,
    itemCount: row.item_count,
    submittedAt: row.submitted_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    totals:
      row.accepted_count === null || row.rejected_count === null
        ? null
        : { accepted: row.accepted_count, rejected: row.rejected_count },
  };
}

async function writeImport(client: PoolClient, input: NewImport): Promise<Row> {
  const inserted = await client.query<Row>(
    `
    INSERT INTO catalog_imports (id, supplier_code, idempotency_key, fingerprint, supplier_format, payload, item_count)
    SELECT $1, code, $3, $4, format, $5, $6 FROM suppliers WHERE code = $2
    ON CONFLICT (supplier_code, idempotency_key) DO NOTHING
    RETURNING *`,
    [
      input.id,
      input.supplier,
      input.idempotencyKey,
      input.fingerprint,
      input.payload,
      input.itemCount,
    ],
  );
  const created = inserted.rows[0];
  if (created) {
    await client.query('INSERT INTO import_outbox (import_id) VALUES ($1)', [created.id]);
    return created;
  }
  // This must be a new statement: the concurrent winner might not have been
  // visible to the INSERT snapshot even though its unique index entry won.
  const existing = await client.query<Row>(
    `
    SELECT * FROM catalog_imports WHERE supplier_code = $1 AND idempotency_key = $2`,
    [input.supplier, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('Expected a registered import');
  return row;
}

export class PostgresImports implements IntakeStore, WorkStore, StatusStore {
  constructor(private readonly pool: Pool) {}

  async sourceExists(code: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM suppliers WHERE code = $1', [code]);
    return rowCount === 1;
  }

  async accept(input: NewImport): Promise<{ status: ImportStatus; fingerprint: string }> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const row = await writeImport(client, input);
      await client.query('COMMIT');
      return { status: toStatus(row), fingerprint: row.fingerprint };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async find(id: string): Promise<ImportStatus | null> {
    const { rows } = await this.pool.query<Row>(
      `
      SELECT id, supplier_code, state, item_count, submitted_at, finished_at, accepted_count, rejected_count
      FROM catalog_imports WHERE id = $1`,
      [id],
    );
    return rows[0] ? toStatus(rows[0]) : null;
  }

  async pending(id: string): Promise<WorkItem | null> {
    const { rows } = await this.pool.query<WorkItem>(
      `
      SELECT id, supplier_code AS supplier, supplier_format AS format, payload
      FROM catalog_imports WHERE id = $1 AND state = 'pending'`,
      [id],
    );
    return rows[0] ?? null;
  }

  async finish(id: string, totals: AuditTotals): Promise<void> {
    await this.pool.query(
      `
      UPDATE catalog_imports SET state = 'completed', finished_at = now(), payload = NULL,
        accepted_count = $2, rejected_count = $3 WHERE id = $1 AND state = 'pending'`,
      [id, totals.accepted, totals.rejected],
    );
  }

  async fail(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE catalog_imports SET state = 'failed', finished_at = now()
      WHERE id = $1 AND state = 'pending'`,
      [id],
    );
    return rowCount === 1;
  }
}
