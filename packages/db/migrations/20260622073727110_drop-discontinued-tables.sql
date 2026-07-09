-- Up Migration
--
-- Centralize on agentica.ts (85 tables) as the single source of truth. These 8
-- tables are discontinued: absent from prod, zero code references, and not
-- modeled in agentica.ts. Their only foreign keys are internal to this set
-- (executions -> triggers, vault_item_grants -> vault_items), so nothing kept
-- depends on them. Dropping aligns dev + a fresh baseline build to prod, which
-- is exactly what agentica.ts already models.

DROP TABLE IF EXISTS agentica.executions CASCADE;
DROP TABLE IF EXISTS agentica.triggers CASCADE;
DROP TABLE IF EXISTS agentica.vault_item_grants CASCADE;
DROP TABLE IF EXISTS agentica.vault_items CASCADE;
DROP TABLE IF EXISTS agentica.api_schema_migrations CASCADE;
DROP TABLE IF EXISTS agentica.channel_identity_map CASCADE;
DROP TABLE IF EXISTS agentica.credit_balance CASCADE;
DROP TABLE IF EXISTS agentica.woa_posts CASCADE;

-- Enum types now exclusive to the dropped tables (execution_status is shared
-- with a kept table, so it stays).
DROP TYPE IF EXISTS agentica.session_mode;
DROP TYPE IF EXISTS agentica.vault_item_kind;
DROP TYPE IF EXISTS agentica.woa_post_type;

-- Down Migration
-- Forward-only: these tables are discontinued and intentionally not recreatable.
