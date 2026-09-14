import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema/index.js';
import { ROLES } from './rls.js';

/**
 * Driver-agnostic Drizzle type. Both PgliteDatabase (dev/test) and
 * PostgresJsDatabase (production) are assignable to it, so services can be
 * written once and run against either without a cast.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TenantContext {
  readonly tenantId: string;
  /** The role the transaction runs as. Never the table owner, never a superuser. */
  readonly role: typeof ROLES.app;
}

// PGlite construction lives in src/db/migrate.ts (migratePglite), which is the
// only sanctioned way to get a database in dev and test: it applies migrations,
// installs RLS and verifies the policies before returning. A bare constructor
// helper would invite tests that silently run as the superuser.

/**
 * Runs fn inside a transaction scoped to one tenant and one non-superuser role.
 *
 * This is the only sanctioned way to read or write tenant data. The two SET LOCAL
 * statements are what make a forgotten WHERE tenant_id clause return zero rows
 * instead of another company's customer list.
 */
export async function withTenant<T>(
  db: Db,
  ctx: TenantContext,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE ${raw(ctx.role)}`);
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * SET LOCAL ROLE does not accept a bound parameter, so the identifier has to be
 * inlined. It comes from a const union of two literal role names and never from
 * user input — but validate anyway, because this is the one place in the codebase
 * where interpolation touches SQL.
 */
function raw(identifier: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`refusing to interpolate unsafe SQL identifier: ${identifier}`);
  }
  return sql.raw(identifier);
}

export function tenantCtx(tenantId: string): TenantContext {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error(`invalid tenant id: ${tenantId}`);
  }
  return { tenantId, role: ROLES.app };
}
