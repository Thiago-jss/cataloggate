import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Actor, ActorDirectory } from './actor';

export function keyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class PostgresActors implements ActorDirectory {
  constructor(private readonly pool: Pool) {}

  async authenticate(key: string): Promise<Actor | null> {
    const { rows } = await this.pool.query<Actor>(
      'SELECT id, supplier_code AS supplier, role FROM catalog_actors WHERE key_digest = $1',
      [keyDigest(key)],
    );
    return rows[0] ?? null;
  }
}
