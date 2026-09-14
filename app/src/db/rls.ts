import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.js';

/**
 * Row-Level Security — PRODUCT-PLAN.md §4.2
 *
 * The verified failure this defends against: FORCE ROW LEVEL SECURITY does NOT
 * apply to superusers. PGlite connects as `postgres` (superuser, BYPASSRLS=true)
 * and sees every tenant's rows even with the policy in place and FORCE set.
 *
 * Therefore two hard requirements, both enforced here rather than assumed:
 *   1. The application connects as coldpath_app — non-superuser, NOBYPASSRLS,
 *    and NOT the owner of any table.
 *   2. Migrations run as coldpath_migrator, a separate privileged role.
 *
 * Pointing the app at the owner or at postgres disables tenancy isolation with
 * no error, no warning and no failing query. The negative-control test in
 * tests/integration/rls.test.ts exists to catch exactly that regression.
 */

/** Every table carrying tenant_id, derived from the schema rather than a hand-kept list. */
export function tenantScopedTables(): string[] {
  const out: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    if (cfg.columns.some((c) => c.name === 'tenant_id')) out.push(cfg.name);
    else if (cfg.name !== 'tenant') throw new Error(`table ${cfg.name} has no tenant_id — see PRODUCT-PLAN.md §4.1`);
  }
  return out.sort();
}

export const ROLES = {
  migrator: 'coldpath_migrator',
  app: 'coldpath_app',
} as const;

/** Roles and grants. Idempotent so it can run on every migration. */
export function rolesSql(): string {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLES.app}') THEN
    CREATE ROLE ${ROLES.app} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ${ROLES.app};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLES.app};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLES.app};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLES.app};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLES.app};

-- audit_log is append-only. The application cannot edit its own trail.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${ROLES.app};
`.trim();
}

/**
 * ENABLE + FORCE + one policy per tenant-scoped table.
 *
 * The nullif() wrapper: an unset or empty app.tenant_id must degrade to "no
 * rows" (fail closed), never to a cast error. Vanilla Postgres returns NULL
 * from current_setting(..., true) for an unset GUC, but PGlite returns '' —
 * and ''::uuid raises. nullif collapses both to NULL, so the policy is false
 * rather than fatal, identically on every Postgres.
 */
export function policiesSql(): string {
  return tenantScopedTables()
    .map(
      (t) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${t};
CREATE POLICY tenant_isolation ON ${t}
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);`.trim(),
    )
    .join('\n\n');
}

/**
 * Defence in depth behind RLS: even if a policy were dropped, an UPDATE or DELETE
 * on the audit trail raises. Applied to every role including the owner.
 */
export function auditImmutableSql(): string {
  return `
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS audit_no_update ON audit_log;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

DROP TRIGGER IF EXISTS audit_no_delete ON audit_log;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
`.trim();
}

/**
 * audit_log carries the records of FAILED authentication — probes by
 * unauthenticated callers, IdP rejections — which by definition happen before
 * any tenant context exists. Without this policy those inserts are silently
 * dropped by tenant_isolation (NULL tenant matches nothing), and the audit
 * trail loses exactly the entries that matter most in an incident.
 *
 * INSERT-only, NULL-tenant-only. SELECT stays tenant-scoped, and UPDATE/DELETE
 * remain revoked and trigger-blocked, so this widens what can be written by
 * nobody's attacker and narrows what can be hidden by no one.
 */
export function auditAnonymousInsertSql(): string {
  return `
DROP POLICY IF EXISTS audit_anonymous_insert ON audit_log;
CREATE POLICY audit_anonymous_insert ON audit_log
  FOR INSERT
  WITH CHECK (tenant_id IS NULL);`.trim();
}

export function allSecuritySql(): string {
  return [rolesSql(), policiesSql(), auditAnonymousInsertSql(), auditImmutableSql()].join('\n\n');
}
