import {
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { CatalogReview } from '../catalog/application/catalog-review';
import { ReviewsController } from '../catalog/http/reviews-controller';
import { PostgresCatalog } from '../catalog/infrastructure/postgres-catalog';
import { ActorGuard } from '../identity/actor-guard';
import { PostgresActors } from '../identity/postgres-actors';
import { openMongo, openPostgres } from '../platform/clients';
import type { loadApiEnvironment, loadDataEnvironment } from '../platform/environment';
import { DispatchImports } from './application/dispatch-imports';
import { ImportOperations } from './application/import-operations';
import { OperationsController } from './http/operations-controller';
import { PostgresOperations } from './infrastructure/postgres-operations';
import { ReadImport, ReadReport } from './application/import-queries';
import { ProcessImport } from './application/process-import';
import { SubmitImport } from './application/submit-import';
import { HealthController, ImportsController } from './http/imports-controller';
import { MongoAudits } from './infrastructure/mongo-audits';
import { OutboxRunner } from './infrastructure/outbox-runner';
import { PostgresImports } from './infrastructure/postgres-imports';
import { PostgresOutbox } from './infrastructure/postgres-outbox';
import { RabbitPublisher } from './infrastructure/rabbit-publisher';
import { RabbitWorker } from './infrastructure/rabbit-worker';
import { RedisReportCache } from './infrastructure/redis-report-cache';

type DataEnvironment = ReturnType<typeof loadDataEnvironment>;
type ApiEnvironment = ReturnType<typeof loadApiEnvironment>;

class DatabaseClients implements OnApplicationShutdown {
  readonly postgres;
  readonly mongo;

  constructor(env: DataEnvironment) {
    this.postgres = openPostgres(env.DATABASE_URL);
    this.mongo = openMongo(env.MONGO_URL);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.postgres.end(), this.mongo.close()]);
  }
}

function stores(env: DataEnvironment): Provider[] {
  return [
    { provide: DatabaseClients, useFactory: () => new DatabaseClients(env) },
    {
      provide: PostgresImports,
      inject: [DatabaseClients],
      useFactory: (db: DatabaseClients) => new PostgresImports(db.postgres),
    },
    {
      provide: MongoAudits,
      inject: [DatabaseClients],
      useFactory: (db: DatabaseClients) => new MongoAudits(db.mongo.db(env.MONGO_DB)),
    },
  ];
}

@Module({})
export class ImportsModule {
  static api(env: ApiEnvironment): DynamicModule {
    return {
      module: ImportsModule,
      controllers: [ImportsController, ReviewsController, OperationsController, HealthController],
      providers: [
        ...stores(env),
        ActorGuard,
        {
          provide: ImportOperations,
          inject: [DatabaseClients],
          useFactory: (db: DatabaseClients) =>
            new ImportOperations(new PostgresOperations(db.postgres)),
        },
        {
          provide: PostgresActors,
          inject: [DatabaseClients],
          useFactory: (db: DatabaseClients) => new PostgresActors(db.postgres),
        },
        {
          provide: CatalogReview,
          inject: [ReadImport, MongoAudits, DatabaseClients],
          useFactory: (imports: ReadImport, audits: MongoAudits, db: DatabaseClients) =>
            new CatalogReview(imports, audits, new PostgresCatalog(db.postgres)),
        },
        {
          provide: SubmitImport,
          inject: [PostgresImports],
          useFactory: (db: PostgresImports) => new SubmitImport(db),
        },
        {
          provide: ReadImport,
          inject: [PostgresImports],
          useFactory: (db: PostgresImports) => new ReadImport(db),
        },
        { provide: RedisReportCache, useFactory: () => new RedisReportCache(env.REDIS_URL) },
        {
          provide: ReadReport,
          inject: [ReadImport, MongoAudits, RedisReportCache],
          useFactory: (status: ReadImport, mongo: MongoAudits, cache: RedisReportCache) =>
            new ReadReport(status, mongo, cache),
        },
        { provide: RabbitPublisher, useFactory: () => new RabbitPublisher(env.RABBIT_URL) },
        {
          provide: OutboxRunner,
          inject: [DatabaseClients, RabbitPublisher],
          useFactory: (db: DatabaseClients, rabbit: RabbitPublisher) =>
            new OutboxRunner(new DispatchImports(new PostgresOutbox(db.postgres), rabbit), rabbit),
        },
      ],
    };
  }

  static worker(env: DataEnvironment): DynamicModule {
    return {
      module: ImportsModule,
      providers: [
        ...stores(env),
        {
          provide: RabbitWorker,
          inject: [PostgresImports, MongoAudits],
          useFactory: (db: PostgresImports, mongo: MongoAudits) =>
            new RabbitWorker(env.RABBIT_URL, new ProcessImport(db, mongo), db),
        },
      ],
    };
  }
}
