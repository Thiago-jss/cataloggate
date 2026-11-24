import type { Pool } from 'pg';
import type { Actor } from '../../identity/actor';
import { inTransaction } from '../../platform/transaction';
import { ImportNotFound } from '../application/import-errors';
import {
  RetryConflict,
  type Attempt,
  type ImportHistory,
  type OperationsStore,
  type RetryEntry,
  type RetryReceipt,
  type SupplierMetrics,
} from '../application/import-operations';

const MAX_GENERATION = 6;

export class PostgresOperations implements OperationsStore {
  constructor(private readonly pool: Pool) {}

  retry(importId: string, actor: Actor, expectedGeneration: number): Promise<RetryReceipt> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<{ state: string; generation: number }>(
        `SELECT state, generation
        FROM catalog_imports WHERE id = $1 AND supplier_code = $2 FOR UPDATE`,
        [importId, actor.supplier],
      );
      const current = result.rows[0];
      if (!current) throw new ImportNotFound();
      if (current.generation !== expectedGeneration) throw new RetryConflict('STALE_GENERATION');
      if (current.state !== 'failed') throw new RetryConflict('RETRY_NOT_AVAILABLE');
      if (current.generation >= MAX_GENERATION) throw new RetryConflict('RETRY_LIMIT');
      const generation = current.generation + 1;
      await client.query(
        `UPDATE catalog_imports SET state = 'pending', finished_at = NULL, generation = $2 WHERE id = $1`,
        [importId, generation],
      );
      await client.query('INSERT INTO import_outbox (import_id, generation) VALUES ($1, $2)', [
        importId,
        generation,
      ]);
      await client.query(
        `INSERT INTO import_retries (import_id, generation, supplier_code, requested_by)
        VALUES ($1, $2, $3, $4)`,
        [importId, generation, actor.supplier, actor.id],
      );
      return { importId, generation, status: 'pending' };
    });
  }

  history(importId: string, supplier: string): Promise<ImportHistory | null> {
    return inTransaction(
      this.pool,
      async (client) => {
        const owner = await client.query(
          'SELECT 1 FROM catalog_imports WHERE id = $1 AND supplier_code = $2',
          [importId, supplier],
        );
        if (!owner.rowCount) return null;
        const attempts = await client.query<Attempt>(
          `SELECT generation, id, outcome, started_at AS "startedAt", finished_at AS "finishedAt"
        FROM import_attempts WHERE import_id = $1 ORDER BY started_at DESC, id DESC LIMIT 50`,
          [importId],
        );
        const retries = await client.query<RetryEntry>(
          `SELECT generation, requested_by AS "requestedBy", requested_at AS "requestedAt"
        FROM import_retries WHERE import_id = $1 ORDER BY generation DESC`,
          [importId],
        );
        return { attempts: attempts.rows, retries: retries.rows };
      },
      true,
    );
  }

  async metrics(supplier: string): Promise<SupplierMetrics> {
    const { rows } = await this.pool.query<SupplierMetrics>(
      `SELECT
      (SELECT count(*)::int FROM catalog_imports WHERE supplier_code = $1 AND state = 'pending') AS "pendingImports",
      (SELECT count(*)::int FROM catalog_imports WHERE supplier_code = $1 AND state = 'failed') AS "failedImports",
      (SELECT count(*)::int FROM catalog_imports WHERE supplier_code = $1 AND state = 'completed') AS "completedImports",
      (SELECT count(*)::int FROM import_outbox o JOIN catalog_imports i ON i.id = o.import_id
        WHERE i.supplier_code = $1 AND o.sent_at IS NULL) AS "outboxBacklog",
      (SELECT count(*)::int FROM import_attempts a JOIN catalog_imports i ON i.id = a.import_id
        WHERE i.supplier_code = $1) AS "processingAttempts",
      (SELECT count(*)::int FROM import_attempts a JOIN catalog_imports i ON i.id = a.import_id
        WHERE i.supplier_code = $1 AND a.outcome = 'technical_failure') AS "failedAttempts",
      (SELECT round(avg(extract(epoch FROM (finished_at - submitted_at))) * 1000)::float8
        FROM catalog_imports WHERE supplier_code = $1 AND state = 'completed') AS "meanCompletionMs"`,
      [supplier],
    );
    const result = rows[0];
    if (!result) throw new Error('Metrics unavailable');
    return result;
  }
}
