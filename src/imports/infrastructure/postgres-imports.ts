import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../../platform/transaction';
import type {
  AuditTotals,
  Delivery,
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
  generation: number;
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
    generation: row.generation,
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
    INSERT INTO catalog_imports (id, supplier_code, idempotency_key, fingerprint, supplier_format, payload, item_count, submitted_by)
    SELECT $1, code, $3, $4, format, $5, $6, $7 FROM suppliers WHERE code = $2
    ON CONFLICT (supplier_code, idempotency_key) DO NOTHING
    RETURNING *`,
    [
      input.id,
      input.supplier,
      input.idempotencyKey,
      input.fingerprint,
      input.payload,
      input.itemCount,
      input.submittedBy,
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

  async find(id: string, supplier: string): Promise<ImportStatus | null> {
    const { rows } = await this.pool.query<Row>(
      `
      SELECT id, supplier_code, state, generation, item_count, submitted_at, finished_at, accepted_count, rejected_count
      FROM catalog_imports WHERE id = $1 AND supplier_code = $2`,
      [id, supplier],
    );
    return rows[0] ? toStatus(rows[0]) : null;
  }

  begin({ importId, generation }: Delivery): Promise<WorkItem | null> {
    return inTransaction(this.pool, async (client) => {
      const { rows } = await client.query<Omit<WorkItem, 'runId'>>(
        `SELECT supplier_code AS supplier, supplier_format AS format, payload
        FROM catalog_imports WHERE id = $1 AND generation = $2 AND state = 'pending' FOR UPDATE`,
        [importId, generation],
      );
      const work = rows[0];
      if (!work) return null;
      const runId = randomUUID();
      await client.query(
        'INSERT INTO import_attempts (id, import_id, generation) VALUES ($1, $2, $3)',
        [runId, importId, generation],
      );
      return { ...work, runId };
    });
  }

  finish({ importId, generation }: Delivery, runId: string, totals: AuditTotals): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE catalog_imports SET state = 'completed', finished_at = now(), payload = NULL,
        accepted_count = $3, rejected_count = $4 WHERE id = $1 AND generation = $2 AND state = 'pending'`,
        [importId, generation, totals.accepted, totals.rejected],
      );
      const completed = updated.rowCount === 1;
      await client.query(
        `UPDATE import_attempts SET outcome = $2, finished_at = clock_timestamp()
        WHERE id = $1 AND outcome = 'running'`,
        [runId, completed ? 'succeeded' : 'superseded'],
      );
      if (completed) await supersedeRunning(client, importId, generation);
      return completed;
    });
  }

  async recordFailure(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE import_attempts SET outcome = 'technical_failure', finished_at = clock_timestamp()
      WHERE id = $1 AND outcome = 'running'`,
      [runId],
    );
  }

  fail({ importId, generation }: Delivery): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE catalog_imports SET state = 'failed', finished_at = now()
        WHERE id = $1 AND generation = $2 AND state = 'pending'`,
        [importId, generation],
      );
      if (rowCount === 1) await supersedeRunning(client, importId, generation);
      return rowCount === 1;
    });
  }
}

async function supersedeRunning(
  client: PoolClient,
  importId: string,
  generation: number,
): Promise<void> {
  await client.query(
    `UPDATE import_attempts SET outcome = 'superseded', finished_at = clock_timestamp()
    WHERE import_id = $1 AND generation = $2 AND outcome = 'running'`,
    [importId, generation],
  );
}
