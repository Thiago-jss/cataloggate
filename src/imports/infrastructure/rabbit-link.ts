import { connect, type Channel, type ChannelModel } from 'amqplib';

export const IMPORT_QUEUE = 'cataloggate.imports.v1';
export const DEAD_QUEUE = 'cataloggate.imports.dead.v1';

export async function openRabbit(url: string): Promise<ChannelModel> {
  const connection = await connect(url, { timeout: 2_000 });
  // EventEmitter errors must be observed; close drives reconnection.
  connection.on('error', () => undefined);
  return connection;
}

export async function declareImportQueues(channel: Channel): Promise<void> {
  channel.on('error', () => undefined);
  await channel.assertQueue(DEAD_QUEUE, { durable: true });
  await channel.assertQueue(IMPORT_QUEUE, {
    durable: true,
    deadLetterExchange: '',
    deadLetterRoutingKey: DEAD_QUEUE,
  });
}

export async function closeRabbit(connection: ChannelModel): Promise<void> {
  try {
    await connection.close();
  } catch {
    /* Already disconnected. */
  }
}
