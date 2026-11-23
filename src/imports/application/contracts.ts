import type { Audit, SupplierFormat } from '../domain/audit';

export type AuditTotals = { accepted: number; rejected: number };
export type ImportStatus = {
  id: string;
  supplier: string;
  status: 'pending' | 'completed' | 'failed';
  itemCount: number;
  submittedAt: string;
  finishedAt: string | null;
  totals: AuditTotals | null;
};
export type NewImport = {
  id: string;
  supplier: string;
  idempotencyKey: string;
  fingerprint: string;
  payload: string;
  itemCount: number;
};
export type WorkItem = { id: string; supplier: string; format: SupplierFormat; payload: string };
export type StoredAudit = { id: string; supplier: string; payload: string; audit: Audit };
export type AuditReport = { id: string; supplier: string; totals: AuditTotals } & Pick<
  Audit,
  'accepted'
> & {
    rejected: (Audit['rejected'][number] & { original: unknown })[];
  };

export interface IntakeStore {
  sourceExists(code: string): Promise<boolean>;
  accept(input: NewImport): Promise<{ status: ImportStatus; fingerprint: string }>;
}

export interface WorkStore {
  pending(id: string): Promise<WorkItem | null>;
  finish(id: string, totals: AuditTotals): Promise<void>;
  fail(id: string): Promise<boolean>;
}

export interface StatusStore {
  find(id: string): Promise<ImportStatus | null>;
}

export interface AuditWriter {
  storeOnce(document: StoredAudit): Promise<StoredAudit>;
}

export interface AuditReader {
  get(id: string): Promise<StoredAudit | null>;
}

export interface ReportCache {
  get(id: string): Promise<AuditReport | null>;
  set(report: AuditReport): Promise<void>;
}
