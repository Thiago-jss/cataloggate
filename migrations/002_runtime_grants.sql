GRANT USAGE ON SCHEMA public TO cataloggate_app;
GRANT SELECT ON suppliers TO cataloggate_app;
GRANT SELECT, INSERT, UPDATE ON catalog_imports, import_outbox TO cataloggate_app;
