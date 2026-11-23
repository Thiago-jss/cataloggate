export interface ImportOutbox {
  unsent(limit: number): Promise<string[]>;
  markSent(id: string): Promise<void>;
}

export interface ImportPublisher {
  publish(id: string): Promise<void>;
}

export class DispatchImports {
  constructor(
    private readonly outbox: ImportOutbox,
    private readonly publisher: ImportPublisher,
  ) {}

  async execute(): Promise<void> {
    for (const id of await this.outbox.unsent(10)) {
      await this.publisher.publish(id);
      await this.outbox.markSent(id);
    }
  }
}
