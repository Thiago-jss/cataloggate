import {
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import type { DispatchImports } from '../application/dispatch-imports';
import type { RabbitPublisher } from './rabbit-publisher';

export class OutboxRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('ImportOutbox');
  private readonly stop = new AbortController();
  private running?: Promise<void>;

  constructor(
    private readonly dispatch: DispatchImports,
    private readonly rabbit: RabbitPublisher,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.loop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.running;
    await this.rabbit.close();
  }

  private async loop(): Promise<void> {
    let failing = false;
    while (!this.stop.signal.aborted) {
      try {
        await this.dispatch.execute();
        if (failing) this.logger.log('Outbox dispatch recovered');
        failing = false;
      } catch {
        if (!failing) this.logger.warn('Outbox dispatch unavailable; pending imports are retained');
        failing = true;
      }
      await delay(failing ? 1_000 : 250, undefined, { signal: this.stop.signal }).catch(
        () => undefined,
      );
    }
  }
}
