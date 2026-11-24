import type { Delivery } from './contracts';

export interface ImportOutbox {
  unsent(limit: number): Promise<Delivery[]>;
  markSent(delivery: Delivery): Promise<void>;
}

export interface ImportPublisher {
  publish(delivery: Delivery): Promise<void>;
}

export class DispatchImports {
  constructor(
    private readonly outbox: ImportOutbox,
    private readonly publisher: ImportPublisher,
  ) {}

  async execute(): Promise<void> {
    for (const delivery of await this.outbox.unsent(10)) {
      await this.publisher.publish(delivery);
      await this.outbox.markSent(delivery);
    }
  }
}
