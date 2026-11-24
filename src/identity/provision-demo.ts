import type { PoolClient } from 'pg';
import { keyDigest } from './postgres-actors';

const demoActors = [
  {
    id: 'northwind-operator',
    supplier: 'northwind',
    role: 'operator',
    variable: 'NORTHWIND_OPERATOR_KEY',
  },
  {
    id: 'northwind-reviewer',
    supplier: 'northwind',
    role: 'reviewer',
    variable: 'NORTHWIND_REVIEWER_KEY',
  },
  {
    id: 'trailforge-operator',
    supplier: 'trailforge',
    role: 'operator',
    variable: 'TRAILFORGE_OPERATOR_KEY',
  },
  {
    id: 'trailforge-reviewer',
    supplier: 'trailforge',
    role: 'reviewer',
    variable: 'TRAILFORGE_REVIEWER_KEY',
  },
] as const;

export async function provisionDemoActors(client: PoolClient): Promise<void> {
  const keys = demoActors.map(({ variable }) => process.env[variable]);
  if (keys.every((value) => value === undefined)) return;
  if (
    keys.some((value) => !value || !/^[0-9a-f]{64}$/.test(value)) ||
    new Set(keys).size !== demoActors.length
  ) {
    throw new Error('Demo actor keys must all be supplied, distinct and valid');
  }
  for (const { id, supplier, role, variable } of demoActors) {
    const key = process.env[variable];
    if (!key) throw new Error('Missing demo key');
    await client.query(
      `INSERT INTO catalog_actors (id, supplier_code, role, key_digest)
      VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET key_digest = EXCLUDED.key_digest`,
      [id, supplier, role, keyDigest(key)],
    );
  }
}
