import { pgTable, text, timestamp, uuid, jsonb, boolean, integer, numeric, index, unique, pgEnum } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';
import { appUser } from './identity.js';

export const verticalEnum = pgEnum('vertical', [
  'cold_storage_logistics', 'manufacturing_food_production', 'retail_food_service', 'other',
]);

export const accountStatus = pgEnum('account_status', [
  'identified', 'scored', 'researching', 'in_review', 'published', 'working', 'excluded',
]);

export const priorityEnum = pgEnum('priority', ['P0', 'P1', 'P2', 'P3']);

export const account = pgTable('account', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  canonicalName: text('canonical_name').notNull(),
  vertical: verticalEnum('vertical').notNull().default('cold_storage_logistics'),
  ticker: text('ticker'),
  hq: text('hq'),
  website: text('website'),
  /**
   * The single most consequential boolean in the system. A true value here means
   * gate C5 suppresses this account from every outbound list. Getting it wrong
   * in the false direction emails a flagship customer; in the true direction it
   * silently deletes a prospect. See INGESTION-GATES.md §1 (the VersaCold defect).
   */
  isCustomer: boolean('is_customer').notNull().default(false),
  crmId: text('crm_id'),
  ownerId: uuid('owner_id').references(() => appUser.id),
  repId: uuid('rep_id').references(() => appUser.id),
  priority: priorityEnum('priority'),
  status: accountStatus('status').notNull().default('identified'),
  icpScore: integer('icp_score'),
  icpComponents: jsonb('icp_components'),
  researchState: jsonb('research_state'),
  researchedAt: timestamp('researched_at', { withTimezone: true }),
  refreshDueAt: timestamp('refresh_due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uq_account_canonical').on(t.tenantId, t.canonicalName),
  index('ix_account_tenant_status').on(t.tenantId, t.status),
  index('ix_account_owner').on(t.ownerId),
]);

/**
 * Every reported name that resolved to this account. This is the audit trail for
 * entity resolution — 51 of 114 real accounts (45%) had more than one.
 */
export const resolvedBy = pgEnum('resolved_by', ['rule', 'fuzzy', 'human', 'model']);

export const accountAlias = pgTable('account_alias', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => account.id, { onDelete: 'cascade' }),
  reportedName: text('reported_name').notNull(),
  source: text('source'),
  confidence: integer('confidence').notNull().default(1),
  resolvedBy: resolvedBy('resolved_by').notNull(),
  matchScore: numeric('match_score', { precision: 4, scale: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uq_alias').on(t.tenantId, t.accountId, t.reportedName),
  index('ix_alias_name').on(t.reportedName),
]);

export const rtoEnum = pgEnum('rto', [
  'PJM', 'MISO', 'SPP', 'ERCOT', 'NYISO', 'ISO-NE', 'CAISO', 'WECC', 'SERC',
  'TVA', 'Duke', 'NW', 'SWPP', 'Other',
]);

/**
 * validated=false means the numeric validation gate rejected a field (see
 * INGESTION-GATES.md §7.2). The record is retained and surfaced in the review
 * queue, never dropped — the 89,000,000 lb marine terminal is the reference case.
 */
export const site = pgTable('site', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => account.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  city: text('city'),
  state: text('state'),
  rto: rtoEnum('rto'),
  naics: text('naics'),
  ammoniaLb: integer('ammonia_lb').notNull().default(0),
  programLevel: integer('program_level'),
  accidents: integer('accidents').notNull().default(0),
  recentAccidents: integer('recent_accidents').notNull().default(0),
  submissions: integer('submissions').notNull().default(0),
  rmpId: text('rmp_id'),
  lat: numeric('lat', { precision: 10, scale: 6 }),
  lon: numeric('lon', { precision: 10, scale: 6 }),
  url: text('url'),
  validated: boolean('validated').notNull().default(true),
  validationNote: text('validation_note'),
  raw: jsonb('raw'),
}, (t) => [
  index('ix_site_account').on(t.accountId),
  index('ix_site_tenant_rto').on(t.tenantId, t.rto),
  index('ix_site_unvalidated').on(t.tenantId, t.validated),
]);

export type Account = typeof account.$inferSelect;
export type Site = typeof site.$inferSelect;
