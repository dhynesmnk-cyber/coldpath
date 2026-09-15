import { PGlite } from '@electric-sql/pglite';
import type { Db } from '../../src/db/client.js';
import { migratePglite } from '../../src/db/migrate.js';
import { account, tenant } from '../../src/db/schema/index.js';

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';

/**
 * The minimum raw-SQL surface the checks need: pg_roles and pg_policies lookups
 * that Drizzle's typed builder does not model. PGlite exposes exactly this;
 * pg-harness.ts provides the same shape over postgres.js, so one set of
 * assertions runs against both engines.
 */
export interface RawQuery {
  // T appears once by design: this mirrors PGlite's own query<T>() signature so
  // the checks can call it identically on either engine, and the parameter is
  // what lets a call site name its row shape.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<T>(sql: string): Promise<{ rows: T[] }>;
}

/**
 * Engine-agnostic on purpose. `db` is the driver-agnostic Drizzle type rather
 * than PgliteDatabase so that rls.checks.ts and auth.checks.ts can run
 * unchanged against real Postgres — see pg-harness.ts and
 * scripts/verify-postgres.ts. The assertions must not know which engine they
 * are on, or they stop being evidence about production.
 */
export interface Harness {
  db: Db;
  raw: RawQuery;
  tenantAId: string;
  tenantBId: string;
  tables: number;
  securedTables: string[];
  close(): Promise<void>;
}

/**
 * Builds a fully migrated PGlite instance with two tenants and three accounts
 * (two in tenant A, one in tenant B). Seeding runs as the superuser, which is
 * correct: the application role must not own tables and must not bypass RLS.
 */
export async function setupHarness(): Promise<Harness> {
  const raw = new PGlite();
  const migrated = await migratePglite(raw);

  const [a] = await migrated.db.insert(tenant).values({ id: TENANT_A, name: 'Ndustrial', slug: 'ndustrial' }).returning();
  const [b] = await migrated.db.insert(tenant).values({ id: TENANT_B, name: 'Competitor Co', slug: 'competitor' }).returning();
  if (!a || !b) throw new Error('tenant seeding failed');

  await migrated.db.insert(account).values([
    { tenantId: a.id, canonicalName: 'Americold Realty Trust', isCustomer: true, icpScore: 97 },
    { tenantId: a.id, canonicalName: 'Sysco Corporation', isCustomer: false, icpScore: 94 },
    { tenantId: b.id, canonicalName: 'Tenant B Secret Customer', isCustomer: true, icpScore: 99 },
  ]);

  return {
    db: migrated.db,
    raw,
    tenantAId: a.id,
    tenantBId: b.id,
    tables: migrated.tables,
    securedTables: migrated.securedTables,
    close: () => raw.close(),
  };
}
