import type { ReportCache, AuditReport } from '../application/contracts';
import { createClient } from 'redis';
import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

const KEY_PREFIX = 'cataloggate:report:v1:';
const TTL_SECONDS = 300;

export class RedisReportCache
  implements ReportCache, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly client: ReturnType<typeof createClient>;
  private readonly logger = new Logger('ReportCache');
  private unavailable = false;

  constructor(url: string) {
    this.client = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 750 } });
    this.client.on('error', () => {
      if (!this.unavailable) this.logger.warn('Redis unavailable; reports will bypass cache');
      this.unavailable = true;
    });
    this.client.on('ready', () => {
      this.unavailable = false;
    });
  }

  onApplicationBootstrap(): void {
    void this.client.connect().catch(() => undefined);
  }

  onApplicationShutdown(): void {
    if (this.client.isOpen) this.client.destroy();
  }

  async get(id: string): Promise<AuditReport | null> {
    if (!this.client.isReady) return null;
    try {
      const raw = await this.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(200) })
        .get(KEY_PREFIX + id);
      return raw === null ? null : (JSON.parse(raw) as AuditReport);
    } catch {
      return null;
    }
  }

  async set(report: AuditReport): Promise<void> {
    if (!this.client.isReady) return;
    try {
      await this.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(200) })
        .set(KEY_PREFIX + report.id, JSON.stringify(report), { EX: TTL_SECONDS });
    } catch {
      /* The authoritative report is already persisted. */
    }
  }
}
