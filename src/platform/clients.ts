import { Logger } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';

export function openPostgres(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
    max: 10,
  });
  const logger = new Logger('Postgres');
  pool.on('error', () => logger.warn('Idle database connection closed unexpectedly'));
  return pool;
}

export function openMongo(url: string): MongoClient {
  return new MongoClient(url, {
    serverSelectionTimeoutMS: 2_000,
    socketTimeoutMS: 5_000,
    writeConcern: { w: 'majority', j: true },
  });
}
