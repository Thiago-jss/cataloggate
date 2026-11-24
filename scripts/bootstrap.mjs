import { randomBytes } from 'node:crypto';
import { lstat, open, writeFile } from 'node:fs/promises';

const names = [
  'POSTGRES_MIGRATION_PASSWORD',
  'POSTGRES_APP_PASSWORD',
  'MONGO_ADMIN_PASSWORD',
  'MONGO_READER_PASSWORD',
  'MONGO_WORKER_PASSWORD',
  'RABBIT_PASSWORD',
  'REDIS_PASSWORD',
  'NORTHWIND_OPERATOR_KEY',
  'NORTHWIND_REVIEWER_KEY',
  'TRAILFORGE_OPERATOR_KEY',
  'TRAILFORGE_REVIEWER_KEY',
];
const file = new URL('../.env', import.meta.url);
const line = (name) => name + '=' + randomBytes(32).toString('hex');
const lines = names.map(line);
try {
  await writeFile(file, lines.join('\n') + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log('Created .env with unique local credentials. No values were printed.');
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
  if (!process.argv.includes('--extend')) {
    console.log('.env already exists and was left untouched.');
  } else {
    const metadata = await lstat(file);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error('Expected a private regular .env file', { cause: error });
    const handle = await open(file, 'a+');
    try {
      const current = await handle.readFile('utf8');
      const missing = names.filter(
        (name) => !new RegExp('^\\s*' + name + '\\s*=', 'm').test(current),
      );
      if (missing.length) await handle.appendFile('\n' + missing.map(line).join('\n') + '\n');
      console.log('Added missing entries: ' + missing.length + '. Existing values were preserved.');
    } finally {
      await handle.close();
    }
  }
}
