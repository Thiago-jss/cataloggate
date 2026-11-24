import type { Pool } from 'pg';
import type { Delivery } from '../application/contracts';
import type { ImportOutbox } from '../application/dispatch-imports';

export class PostgresOutbox implements ImportOutbox {
  constructor(private readonly pool: Pool) {}

  async unsent(limit: number): Promise<Delivery[]> {
    const { rows } = await this.pool.query<Delivery>(
      `SELECT import_id AS "importId", generation
      FROM import_outbox WHERE sent_at IS NULL ORDER BY created_at, import_id, generation LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async markSent({ importId, generation }: Delivery): Promise<void> {
    await this.pool.query(
      `UPDATE import_outbox SET sent_at = now()
      WHERE import_id = $1 AND generation = $2 AND sent_at IS NULL`,
      [importId, generation],
    );
  }
}
