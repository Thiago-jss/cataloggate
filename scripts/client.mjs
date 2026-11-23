import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const base = process.env.CATALOGGATE_URL ?? 'http://127.0.0.1:3180';

export async function request(path, init, url = base) {
  const response = await fetch(new URL(path, url), { ...init, signal: AbortSignal.timeout(5_000) });
  return {
    status: response.status,
    body: await response.json(),
    location: response.headers.get('location'),
  };
}

export function submit(body, key = randomUUID(), url = base) {
  return request(
    '/imports',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    },
    url,
  );
}

export async function until(probe, description, timeout = 25_000) {
  const deadline = performance.now() + timeout;
  do {
    const result = await probe();
    if (result) return result;
    await delay(150);
  } while (performance.now() < deadline);
  throw new Error('Timed out: ' + description);
}

export function completed(id, url = base) {
  return until(async () => {
    const { status, body } = await request('/imports/' + id, undefined, url);
    if (status !== 200 || body.status === 'failed')
      throw new Error('Import did not complete: ' + JSON.stringify(body));
    return body.status === 'completed' ? body : null;
  }, 'completion of import ' + id);
}

export async function fixture(name) {
  const data = await readFile(new URL('../fixtures/' + name + '.json', import.meta.url), 'utf8');
  return JSON.parse(data);
}
