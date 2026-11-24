import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { provisionDemoActors } from '../identity/provision-demo';
import { openPostgres } from './clients';
import { loadDatabaseUrl } from './environment';

async function migrate(): Promise<void> {
  const directory = resolve('migrations');
  const files = (await readdir(directory))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  if (files.length === 0) throw new Error('No CatalogGate migrations found');
  const pool = openPostgres(loadDatabaseUrl());
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(837019231)');
      await client.query(`CREATE TABLE IF NOT EXISTS cataloggate_migrations (
        filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const file of files) {
        const found = await client.query(
          'SELECT 1 FROM cataloggate_migrations WHERE filename = $1',
          [file],
        );
        if (found.rowCount) continue;
        await client.query(await readFile(resolve(directory, file), 'utf8'));
        await client.query('INSERT INTO cataloggate_migrations (filename) VALUES ($1)', [file]);
        console.log(`Applied migration: ${file}`);
      }
      await provisionDemoActors(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void migrate().catch((error: unknown) => {
  console.error('Migration failed:', error instanceof Error ? error.name : 'Unknown error');
  process.exitCode = 1;
});
