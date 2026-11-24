import type { AuditReader, AuditReport, ImportStatus, ReportCache, StatusStore } from './contracts';
import { ImportNotFound, InconsistentReport, ReportNotAvailable } from './import-errors';

export class ReadImport {
  constructor(private readonly statusStore: StatusStore) {}

  async execute(id: string, supplier: string): Promise<ImportStatus> {
    const found = await this.statusStore.find(id, supplier);
    if (!found) throw new ImportNotFound();
    return found;
  }
}

export class ReadReport {
  constructor(
    private readonly imports: ReadImport,
    private readonly audits: AuditReader,
    private readonly cache: ReportCache,
  ) {}

  async execute(id: string, supplier: string): Promise<AuditReport> {
    const found = await this.imports.execute(id, supplier);
    if (found.status !== 'completed' || !found.totals) throw new ReportNotAvailable();
    const cached = await this.cache.get(id);
    if (cached) return cached;
    const document = await this.audits.get(id);
    if (!document || document.supplier !== supplier) throw new InconsistentReport();
    const input: unknown[] = JSON.parse(document.payload);
    const report = {
      id,
      supplier: found.supplier,
      totals: found.totals,
      accepted: document.audit.accepted,
      rejected: document.audit.rejected.map((row) => ({ ...row, original: input[row.row - 1] })),
    };
    await this.cache.set(report);
    return report;
  }
}
