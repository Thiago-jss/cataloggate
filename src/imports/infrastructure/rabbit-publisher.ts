import type { ChannelModel, ConfirmChannel, Message } from 'amqplib';
import type { Delivery } from '../application/contracts';
import type { ImportPublisher } from '../application/dispatch-imports';
import { IMPORT_QUEUE, closeRabbit, declareImportQueues, openRabbit } from './rabbit-link';

type Session = { connection: ChannelModel; channel: ConfirmChannel };

function confirmPublish(channel: ConfirmChannel, delivery: Delivery): Promise<void> {
  const messageId = delivery.importId + ':' + delivery.generation;
  return new Promise<void>((resolve, reject) => {
    let returned = false;
    const onReturn = (message: Message) => {
      if (message.properties.messageId === messageId) returned = true;
    };
    const timer = setTimeout(() => finish(new Error('RabbitMQ confirmation timed out')), 3_000);
    function finish(error?: Error | null): void {
      clearTimeout(timer);
      channel.off('return', onReturn);
      if (error) reject(error);
      else if (returned) reject(new Error('Import message was not routed'));
      else resolve();
    }
    channel.on('return', onReturn);
    try {
      channel.sendToQueue(
        IMPORT_QUEUE,
        Buffer.from(JSON.stringify(delivery)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId,
        },
        finish,
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Publish failed'));
    }
  });
}

export class RabbitPublisher implements ImportPublisher {
  private session?: Session;

  constructor(private readonly url: string) {}

  async publish(delivery: Delivery): Promise<void> {
    try {
      const session = this.session ?? (await this.open());
      await confirmPublish(session.channel, delivery);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await closeRabbit(session.connection);
  }

  private async open(): Promise<Session> {
    const connection = await openRabbit(this.url);
    try {
      const channel = await connection.createConfirmChannel();
      await declareImportQueues(channel);
      const session = { connection, channel };
      this.session = session;
      channel.once('close', () => {
        if (this.session === session) {
          this.session = undefined;
          void closeRabbit(connection);
        }
      });
      return session;
    } catch (error) {
      await closeRabbit(connection);
      throw error;
    }
  }
}
