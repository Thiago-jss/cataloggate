import { requireRole, type Actor } from '../../identity/actor';
import { ImportNotFound } from './import-errors';

export class RetryConflict extends Error {
  constructor(readonly code: 'RETRY_NOT_AVAILABLE' | 'STALE_GENERATION' | 'RETRY_LIMIT') {
    super(code);
  }
}
export type RetryReceipt = { importId: string; generation: number; status: 'pending' };
export type Attempt = {
  generation: number;
  id: string;
  outcome: 'running' | 'succeeded' | 'technical_failure' | 'superseded';
  startedAt: Date;
  finishedAt: Date | null;
};
export type RetryEntry = { generation: number; requestedBy: string; requestedAt: Date };
export type ImportHistory = { attempts: Attempt[]; retries: RetryEntry[] };
export type SupplierMetrics = {
  pendingImports: number;
  failedImports: number;
  completedImports: number;
  outboxBacklog: number;
  processingAttempts: number;
  failedAttempts: number;
  meanCompletionMs: number | null;
};
export interface OperationsStore {
  retry(importId: string, actor: Actor, expectedGeneration: number): Promise<RetryReceipt>;
  history(importId: string, supplier: string): Promise<ImportHistory | null>;
  metrics(supplier: string): Promise<SupplierMetrics>;
}

export class ImportOperations {
  constructor(private readonly store: OperationsStore) {}

  async retry(actor: Actor, importId: string, expectedGeneration: number): Promise<RetryReceipt> {
    requireRole(actor, 'reviewer');
    return this.store.retry(importId, actor, expectedGeneration);
  }

  async history(actor: Actor, importId: string): Promise<ImportHistory> {
    requireRole(actor, 'reviewer');
    const history = await this.store.history(importId, actor.supplier);
    if (!history) throw new ImportNotFound();
    return history;
  }

  async metrics(actor: Actor): Promise<SupplierMetrics> {
    requireRole(actor, 'reviewer');
    return this.store.metrics(actor.supplier);
  }
}
