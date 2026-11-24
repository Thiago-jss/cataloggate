import { auditCatalog } from '../domain/audit';
import type { AuditWriter, Delivery, WorkStore } from './contracts';

export class ProcessImport {
  constructor(
    private readonly work: WorkStore,
    private readonly audits: AuditWriter,
  ) {}

  async execute(delivery: Delivery): Promise<'completed' | 'skipped'> {
    const run = await this.work.begin(delivery);
    if (!run) return 'skipped';
    try {
      const input: unknown[] = JSON.parse(run.payload);
      const proposed = auditCatalog(run.format, input);
      const stored = await this.audits.storeOnce({
        id: delivery.importId,
        supplier: run.supplier,
        payload: run.payload,
        audit: proposed,
      });
      const finished = await this.work.finish(delivery, run.runId, {
        accepted: stored.audit.accepted.length,
        rejected: stored.audit.rejected.length,
      });
      return finished ? 'completed' : 'skipped';
    } catch (error) {
      await this.work.recordFailure(run.runId);
      throw error;
    }
  }
}
