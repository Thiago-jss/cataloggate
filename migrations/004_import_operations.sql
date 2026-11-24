ALTER TABLE catalog_imports ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 6);
ALTER TABLE import_outbox ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 6);
ALTER TABLE import_outbox DROP CONSTRAINT import_outbox_pkey;
ALTER TABLE import_outbox ADD PRIMARY KEY (import_id, generation);

CREATE TABLE import_attempts (
    id uuid PRIMARY KEY,
    import_id uuid NOT NULL,
    generation integer NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    outcome text NOT NULL DEFAULT 'running',
    CHECK ((outcome = 'running' AND finished_at IS NULL) OR
           (outcome IN ('succeeded', 'technical_failure', 'superseded') AND finished_at IS NOT NULL)),
    FOREIGN KEY (import_id, generation) REFERENCES import_outbox (import_id, generation)
);

CREATE INDEX import_attempts_history_idx ON import_attempts (import_id, started_at DESC, id DESC);

CREATE TABLE import_retries (
    import_id uuid NOT NULL,
    generation integer NOT NULL CHECK (generation BETWEEN 2 AND 6),
    supplier_code text NOT NULL,
    requested_by text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (import_id, generation),
    FOREIGN KEY (import_id, generation) REFERENCES import_outbox (import_id, generation),
    FOREIGN KEY (import_id, supplier_code) REFERENCES catalog_imports (id, supplier_code),
    FOREIGN KEY (requested_by, supplier_code) REFERENCES catalog_actors (id, supplier_code)
);

GRANT SELECT, INSERT, UPDATE ON import_attempts TO cataloggate_app;
GRANT SELECT, INSERT ON import_retries TO cataloggate_app;
