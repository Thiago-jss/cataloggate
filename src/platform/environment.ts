import { z } from 'zod';

const dataEnvironment = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  MONGO_URL: z.url({ protocol: /^mongodb$/ }),
  MONGO_DB: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,48}$/)
    .default('cataloggate'),
  RABBIT_URL: z.url({ protocol: /^amqps?$/ }),
});

export function loadDataEnvironment() {
  return dataEnvironment.parse(process.env);
}

export function loadApiEnvironment() {
  return dataEnvironment
    .extend({
      REDIS_URL: z.url({ protocol: /^rediss?$/ }),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      HOST: z.string().default('127.0.0.1'),
    })
    .parse(process.env);
}

export function loadDatabaseUrl(): string {
  return dataEnvironment.pick({ DATABASE_URL: true }).parse(process.env).DATABASE_URL;
}
