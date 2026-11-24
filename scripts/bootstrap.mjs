import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const names = [
  'POSTGRES_MIGRATION_PASSWORD',
  'POSTGRES_APP_PASSWORD',
  'MONGO_ADMIN_PASSWORD',
  'MONGO_READER_PASSWORD',
  'MONGO_WORKER_PASSWORD',
  'RABBIT_PASSWORD',
  'REDIS_PASSWORD',
];
const lines = names.map((name) => name + '=' + randomBytes(32).toString('hex'));
try {
  await writeFile(new URL('../.env', import.meta.url), lines.join('\n') + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log('Created .env with unique local credentials. No values were printed.');
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
  console.log('.env already exists and was left untouched.');
}
