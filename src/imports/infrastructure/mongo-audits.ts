import { MongoServerError, type Collection, type Db } from 'mongodb';
import type { AuditReader, AuditWriter, StoredAudit } from '../application/contracts';

type AuditDocument = Omit<StoredAudit, 'id'> & { _id: string };

export class MongoAudits implements AuditReader, AuditWriter {
  private readonly documents: Collection<AuditDocument>;

  constructor(db: Db) {
    this.documents = db.collection('catalog_audits');
  }

  async get(id: string): Promise<StoredAudit | null> {
    const found = await this.documents.findOne({ _id: id });
    if (!found) return null;
    const { _id, ...data } = found;
    return { id: _id, ...data };
  }

  async storeOnce({ id, ...document }: StoredAudit): Promise<StoredAudit> {
    try {
      await this.documents.updateOne({ _id: id }, { $setOnInsert: document }, { upsert: true });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    }
    const persisted = await this.get(id);
    if (!persisted) throw new Error('Expected a persisted audit');
    return persisted;
  }
}
