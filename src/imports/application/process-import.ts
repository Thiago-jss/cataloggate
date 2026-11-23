import { auditCatalog } from '../domain/audit';
import type { AuditWriter, WorkStore } from './contracts';

export class ProcessImport {
  constructor(
    private readonly work: WorkStore,
    private readonly audits: AuditWriter,
  ) {}

  async execute(id: string): Promise<void> {
    const item = await this.work.pending(id);
    if (!item) return;
    const input: unknown[] = JSON.parse(item.payload);
    const proposed = auditCatalog(item.format, input);
    const stored = await this.audits.storeOnce({
      id,
      supplier: item.supplier,
      payload: item.payload,
      audit: proposed,
    });
    await this.work.finish(id, {
      accepted: stored.audit.accepted.length,
      rejected: stored.audit.rejected.length,
    });
  }
}
