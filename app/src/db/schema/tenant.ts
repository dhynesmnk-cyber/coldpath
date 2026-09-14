import { pgTable, text, timestamp, uuid, jsonb, boolean } from 'drizzle-orm/pg-core';

/**
 * The tenancy root. Every other table carries tenant_id and is protected by a
 * Row-Level Security policy keyed to current_setting('app.tenant_id').
 *
 * See PRODUCT-PLAN.md §4.2 for why this is RLS rather than a WHERE clause:
 * a forgotten filter must degrade to "no rows", never to another tenant's data.
 */
export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Per-tenant configuration: ICP weights, connector enablement, LLM provider. */
  config: jsonb('config').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenant.$inferSelect;
export type NewTenant = typeof tenant.$inferInsert;
