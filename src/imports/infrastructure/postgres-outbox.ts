import type { Pool } from 'pg';
import type { ImportOutbox } from '../application/dispatch-imports';

export class PostgresOutbox implements ImportOutbox {
  constructor(private readonly pool: Pool) {}

  async unsent(limit: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ import_id: string }>(
      `
      SELECT import_id FROM import_outbox WHERE sent_at IS NULL
      ORDER BY created_at, import_id LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.import_id);
  }

  async markSent(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE import_outbox SET sent_at = now() WHERE import_id = $1 AND sent_at IS NULL',
      [id],
    );
  }
}
