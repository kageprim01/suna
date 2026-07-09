-- Up Migration
--
-- Rename the `kortix` schema to `agentica`, matching the Drizzle schema
-- definition (pgSchema('agentica')) and the API codebase (now references
-- agentica.* exclusively).
--
-- Idempotent via ALTER SCHEMA IF EXISTS — a no-op on fresh databases built
-- from the updated baseline (which already uses agentica).

ALTER SCHEMA IF EXISTS kortix RENAME TO agentica;

-- Down Migration
-- Forward-only: rolling back a schema rename would break every object within it.
