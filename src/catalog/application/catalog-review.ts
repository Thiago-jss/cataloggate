import { requireRole, type Actor } from '../../identity/actor';
import type { AuditReader } from '../../imports/application/contracts';
import { ImportNotFound, InconsistentReport } from '../../imports/application/import-errors';
import type { ReadImport } from '../../imports/application/import-queries';
import type { StockChange, StockLine } from '../domain/inventory-changes';

export type ReviewConflictCode =
  | 'AUDIT_REQUIRED'
  | 'REJECTED_ITEMS'
  | 'STALE_PREVIEW'
  | 'ALREADY_PUBLISHED'
  | 'LEGACY_IMPORT'
  | 'NO_CHANGES'
  | 'SELF_APPROVAL';
export class ReviewConflict extends Error {
  constructor(readonly code: ReviewConflictCode) {
    super(code);
  }
}
export type Preview = {
  importId: string;
  supplier: string;
  baseVersion: number;
  changes: StockChange[];
};
export type Release = {
  importId: string;
  supplier: string;
  version: number;
  approvedBy: string;
  publishedAt: string;
  changes: StockChange[];
};
export type Candidate = { importId: string; supplier: string; lines: StockLine[] };
export interface CatalogStore {
  preview(candidate: Candidate): Promise<Preview>;
  publish(candidate: Candidate, actor: Actor, expectedVersion: number): Promise<Release>;
  readRelease(importId: string, supplier: string): Promise<Release | null>;
}

export class CatalogReview {
  constructor(
    private readonly imports: ReadImport,
    private readonly audits: AuditReader,
    private readonly store: CatalogStore,
  ) {}

  async preview(actor: Actor, importId: string): Promise<Preview> {
    return this.store.preview(await this.candidate(actor, importId));
  }

  async publish(actor: Actor, importId: string, expectedVersion: number): Promise<Release> {
    requireRole(actor, 'reviewer');
    const candidate = await this.candidate(actor, importId);
    return this.store.publish(candidate, actor, expectedVersion);
  }

  async release(actor: Actor, importId: string): Promise<Release> {
    const found = await this.store.readRelease(importId, actor.supplier);
    if (!found) throw new ImportNotFound();
    return found;
  }

  private async candidate(actor: Actor, importId: string): Promise<Candidate> {
    const status = await this.imports.execute(importId, actor.supplier);
    if (status.status !== 'completed' || !status.totals) throw new ReviewConflict('AUDIT_REQUIRED');
    if (status.totals.rejected > 0) throw new ReviewConflict('REJECTED_ITEMS');
    const document = await this.audits.get(importId);
    if (
      !document ||
      document.supplier !== actor.supplier ||
      document.audit.rejected.length !== 0 ||
      document.audit.accepted.length !== status.totals.accepted
    ) {
      throw new InconsistentReport();
    }
    return {
      importId,
      supplier: actor.supplier,
      lines: document.audit.accepted.map(({ sku, stock }) => ({ sku, stock })),
    };
  }
}
