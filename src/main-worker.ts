import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConsoleLogger } from '@nestjs/common';
import { ImportsModule } from './imports/imports.module';
import { loadDataEnvironment } from './platform/environment';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    ImportsModule.worker(loadDataEnvironment()),
    { abortOnError: false, logger: new ConsoleLogger({ json: true }) },
  );
  app.enableShutdownHooks();
}

void bootstrap().catch((error: unknown) => {
  console.error('Worker startup failed:', error instanceof Error ? error.name : 'Unknown error');
  process.exitCode = 1;
});
