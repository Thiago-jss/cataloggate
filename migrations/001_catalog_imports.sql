CREATE TABLE suppliers (
    code text PRIMARY KEY,
    name text NOT NULL,
    format text NOT NULL CHECK (format IN ('flat', 'nested'))
);

INSERT INTO suppliers (code, name, format) VALUES
    ('northwind', 'Northwind Cycle Co.', 'flat'),
    ('trailforge', 'Trailforge Supply', 'nested');

CREATE TABLE catalog_imports (
    id uuid PRIMARY KEY,
    supplier_code text NOT NULL REFERENCES suppliers(code),
    idempotency_key text NOT NULL,
    fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
    supplier_format text NOT NULL CHECK (supplier_format IN ('flat', 'nested')),
    payload text,
    item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 500),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    state text NOT NULL DEFAULT 'pending',
    accepted_count integer,
    rejected_count integer,
    UNIQUE (supplier_code, idempotency_key),
    CHECK (
        (state = 'pending' AND finished_at IS NULL AND payload IS NOT NULL
            AND accepted_count IS NULL AND rejected_count IS NULL)
        OR (state = 'completed' AND finished_at IS NOT NULL AND payload IS NULL
            AND accepted_count IS NOT NULL AND rejected_count IS NOT NULL
            AND accepted_count >= 0 AND rejected_count >= 0
            AND accepted_count + rejected_count = item_count)
        OR (state = 'failed' AND finished_at IS NOT NULL AND payload IS NOT NULL
            AND accepted_count IS NULL AND rejected_count IS NULL)
    )
);

CREATE TABLE import_outbox (
    import_id uuid PRIMARY KEY REFERENCES catalog_imports(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);

CREATE INDEX import_outbox_pending_idx ON import_outbox (created_at, import_id) WHERE sent_at IS NULL;
