const auditDatabase = db.getSiblingDB('cataloggate');

function provision(user, environmentKey, actions) {
  const pwd = process.env[environmentKey];
  if (!pwd) throw new Error('Missing required MongoDB runtime credential');
  auditDatabase.createRole({
    role: user,
    privileges: [{ resource: { db: 'cataloggate', collection: 'catalog_audits' }, actions }],
    roles: [],
  });
  auditDatabase.createUser({ user, pwd, roles: [{ role: user, db: 'cataloggate' }] });
}

provision('audit_reader', 'MONGO_READER_PASSWORD', ['find']);
provision('audit_worker', 'MONGO_WORKER_PASSWORD', ['find', 'insert', 'update']);
