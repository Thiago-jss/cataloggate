import {
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Delivery, WorkStore } from '../application/contracts';
import type { ProcessImport } from '../application/process-import';
import { IMPORT_QUEUE, closeRabbit, declareImportQueues, openRabbit } from './rabbit-link';

const messageSchema = z.strictObject({
  importId: z.uuid(),
  generation: z.int().min(1).max(6).optional(),
});
const ATTEMPTS_PER_DELIVERY = 3;

function decode(message: ConsumeMessage): Delivery | null {
  if (message.content.length > 256) return null;
  try {
    const result = messageSchema.safeParse(JSON.parse(message.content.toString('utf8')));
    if (!result.success) return null;
    const { importId, generation } = result.data;
    const expectedId = generation === undefined ? importId : importId + ':' + generation;
    return message.properties.messageId === expectedId
      ? { importId: importId.toLowerCase(), generation: generation ?? 1 }
      : null;
  } catch {
    return null;
  }
}

export class RabbitWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('ImportWorker');
  private readonly stop = new AbortController();
  private connection?: ChannelModel;
  private active = new Set<Promise<void>>();
  private running?: Promise<void>;

  constructor(
    private readonly url: string,
    private readonly process: ProcessImport,
    private readonly work: WorkStore,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.listen();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    if (this.connection) await closeRabbit(this.connection);
    await this.running;
    await Promise.all(this.active);
  }

  private async listen(): Promise<void> {
    while (!this.stop.signal.aborted) {
      let connection: ChannelModel | undefined;
      try {
        connection = await openRabbit(this.url);
        this.connection = connection;
        if (this.stop.signal.aborted) break;
        const channel = await connection.createChannel();
        const closed = new Promise<void>((resolve) => {
          channel.once('close', resolve);
        });
        await declareImportQueues(channel);
        await channel.prefetch(1);
        await channel.consume(
          IMPORT_QUEUE,
          (message) => {
            if (message === null) {
              const link = this.connection;
              if (link) void closeRabbit(link);
              return;
            }
            const task = this.handle(channel, message);
            this.active.add(task);
            void task.finally(() => {
              this.active.delete(task);
            });
          },
          { noAck: false },
        );
        this.logger.log('Consuming catalog imports');
        await closed;
      } catch {
        if (!this.stop.signal.aborted)
          this.logger.warn('Worker broker connection unavailable; reconnecting');
      } finally {
        if (connection) await closeRabbit(connection);
        this.connection = undefined;
      }
      await delay(1_000, undefined, { signal: this.stop.signal }).catch(() => undefined);
    }
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    try {
      const delivery = decode(message);
      if (!delivery) {
        channel.nack(message, false, false);
        return;
      }
      const { importId, generation } = delivery;
      for (let attempt = 1; attempt <= ATTEMPTS_PER_DELIVERY; attempt += 1) {
        if (this.stop.signal.aborted) return;
        try {
          const outcome = await this.process.execute(delivery);
          if (outcome === 'completed')
            this.logger.log({ event: 'import_completed', importId, generation, attempt });
        } catch {
          this.logger.warn({ event: 'import_attempt_failed', importId, generation, attempt });
          if (attempt < ATTEMPTS_PER_DELIVERY) await delay(250 * attempt);
          continue;
        }
        channel.ack(message);
        return;
      }
      if (this.stop.signal.aborted) return;
      try {
        if (await this.work.fail(delivery)) {
          this.logger.warn({ event: 'processing_attempts_exhausted', importId, generation });
          channel.nack(message, false, false);
        } else {
          channel.ack(message);
        }
      } catch {
        // The terminal state was not acknowledged by PostgreSQL. Keep the job recoverable.
        await delay(1_000);
        channel.nack(message, false, true);
      }
    } catch {
      // Consumer connection closed; the broker owns redelivery of unacknowledged messages.
    }
  }
}
