import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConsoleLogger } from '@nestjs/common';
import { json } from 'express';
import { ApiErrors } from './imports/http/api-errors';
import { ImportsModule } from './imports/imports.module';
import { loadApiEnvironment } from './platform/environment';

async function bootstrap(): Promise<void> {
  const env = loadApiEnvironment();
  const app = await NestFactory.create(ImportsModule.api(env), {
    bodyParser: false,
    abortOnError: false,
    logger: new ConsoleLogger({ json: true }),
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use(json({ limit: '128kb', inflate: false }));
  app.useGlobalFilters(new ApiErrors());
  app.enableShutdownHooks();
  try {
    await app.listen(env.PORT, env.HOST);
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  console.error('API startup failed:', error instanceof Error ? error.name : 'Unknown error');
  process.exitCode = 1;
});
