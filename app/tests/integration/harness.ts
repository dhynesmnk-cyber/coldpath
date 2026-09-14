import { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { migratePglite } from '../../src/db/migrate.js';
import type * as schema from '../../src/db/schema/index.js';
import { account, tenant } from '../../src/db/schema/index.js';

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';

export interface Harness {
  db: PgliteDatabase<typeof schema>;
  raw: PGlite;
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
