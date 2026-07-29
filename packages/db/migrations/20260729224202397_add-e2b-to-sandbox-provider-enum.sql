-- Up Migration

ALTER TYPE agentica.sandbox_provider ADD VALUE IF NOT EXISTS 'e2b';

-- Down Migration

-- ALTER TYPE agentica.sandbox_provider REMOVE VALUE 'e2b';