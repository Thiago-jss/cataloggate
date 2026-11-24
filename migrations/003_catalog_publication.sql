CREATE TABLE catalog_actors (
    id text PRIMARY KEY,
    supplier_code text NOT NULL REFERENCES suppliers(code),
    role text NOT NULL CHECK (role IN ('operator', 'reviewer')),
    key_digest text NOT NULL UNIQUE CHECK (length(key_digest) = 64),
    UNIQUE (id, supplier_code)
);

ALTER TABLE catalog_imports ADD COLUMN submitted_by text;
ALTER TABLE catalog_imports ADD FOREIGN KEY (submitted_by, supplier_code)
    REFERENCES catalog_actors (id, supplier_code);
ALTER TABLE catalog_imports ADD UNIQUE (id, supplier_code);

CREATE TABLE catalog_heads (
    supplier_code text PRIMARY KEY REFERENCES suppliers(code),
    version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);

INSERT INTO catalog_heads (supplier_code) SELECT code FROM suppliers;

CREATE TABLE catalog_inventory (
    supplier_code text NOT NULL REFERENCES catalog_heads(supplier_code),
    sku text NOT NULL,
    stock bigint NOT NULL CHECK (stock BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (supplier_code, sku)
);

CREATE TABLE catalog_releases (
    supplier_code text NOT NULL REFERENCES catalog_heads(supplier_code),
    version integer NOT NULL CHECK (version > 0),
    import_id uuid NOT NULL UNIQUE,
    approved_by text NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
    PRIMARY KEY (supplier_code, version),
    FOREIGN KEY (import_id, supplier_code) REFERENCES catalog_imports (id, supplier_code),
    FOREIGN KEY (approved_by, supplier_code) REFERENCES catalog_actors (id, supplier_code)
);

GRANT SELECT ON catalog_actors TO cataloggate_app;
GRANT SELECT, UPDATE ON catalog_heads TO cataloggate_app;
GRANT SELECT, INSERT, UPDATE ON catalog_inventory TO cataloggate_app;
GRANT SELECT, INSERT ON catalog_releases TO cataloggate_app;
