import { pgTable, text, timestamp, uuid, jsonb, boolean, integer, date, index, pgEnum, integer as int } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';
import { account, site } from './account.js';

export const sourceKind = pgEnum('source_kind', [
  'rmp', 'edgar', 'news', 'web', 'job', 'enforcement', 'tariff', 'rto', 'sustainability',
  'crm', 'enrichment', 'capture', 'document', 'internal',
]);

export const confidenceEnum = pgEnum('confidence', ['gap', 'medium', 'high']);

/**
 * Provenance is non-nullable. A record without a source is rejected, not stored
 * with blanks — G0. raw holds the original payload so a parser change can be
 * replayed without re-fetching.
 */
export const source = pgTable('source', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => account.id, { onDelete: 'cascade' }),
  kind: sourceKind('kind').notNull(),
  title: text('title').notNull(),
  url: text('url'),
  publisher: text('publisher'),
  publishedOn: date('published_on'),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull().defaultNow(),
  confidence: integer('confidence').notNull().default(1),
  /** CC BY-SA for RMP data — the attribution duty is enforced by the type, not by memory. */
  licence: text('licence').notNull(),
  attribution: text('attribution'),
  dataThrough: date('data_through'),
  raw: jsonb('raw'),
}, (t) => [index('ix_source_account').on(t.accountId), index('ix_source_kind').on(t.tenantId, t.kind)]);

/**
 * An atomic, sourced claim. The unit of the confidence model.
 *
 * citationRange is what makes claim-level traceability (backlog F3) possible:
 * without it, provenance is document-level and "every number traces to a source"
 * is a claim rather than a feature. Adding it later would mean regenerating every
 * deliverable, so it is here from the first migration.
 */
export const fact = pgTable('fact', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => account.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  predicate: text('predicate').notNull(),
  value: text('value').notNull(),
  asOf: date('as_of'),
  sourceId: uuid('source_id').notNull().references(() => source.id),
  confidence: integer('confidence').notNull().default(1),
  citationStart: int('citation_start'),
  citationEnd: int('citation_end'),
  usedInDeliverable: boolean('used_in_deliverable').notNull().default(false),
}, (t) => [index('ix_fact_account').on(t.accountId), index('ix_fact_source').on(t.sourceId)]);

export const signalType = pgEnum('signal_type', [
  'compliance', 'leadership', 'capex', 'expansion', 'restructuring', 'power',
  'regulatory', 'sustainability', 'intent', 'financial', 'technology', 'driver',
]);

export const impactEnum = pgEnum('impact', ['critical', 'high', 'medium', 'low', 'context']);

/**
 * whyItMatters is the commercial translation. A signal without it is stored but
 * never surfaced — it is the difference between intelligence and a news feed.
 */
export const signal = pgTable('signal', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => account.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').references(() => site.id, { onDelete: 'set null' }),
  type: signalType('type').notNull(),
  occurredOn: date('occurred_on').notNull(),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  impact: impactEnum('impact').notNull(),
  whyItMatters: text('why_it_matters'),
  sourceIds: jsonb('source_ids').notNull().default([]),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ix_signal_account').on(t.accountId), index('ix_signal_date').on(t.occurredOn)]);

/**
 * 0 real-time energy optimisation · 1 precision cold product storage
 * 2 grid volatility response · 3 shore power network expansion
 *
 * isWeakFit lets the engine say "do not lead with this pillar". Manufacturing a
 * reason to sell all four is a failure, not a feature.
 */
export const pain = pgTable('pain', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => account.id, { onDelete: 'cascade' }),
  pillar: integer('pillar').notNull(),
  title: text('title').notNull(),
  evidence: text('evidence').notNull(),
  ndustrialAngle: text('ndustrial_angle').notNull(),
  severity: integer('severity').notNull(),
  isWeakFit: boolean('is_weak_fit').notNull().default(false),
  isStrategic: boolean('is_strategic').notNull().default(false),
  supportingFactIds: jsonb('supporting_fact_ids').notNull().default([]),
}, (t) => [index('ix_pain_account').on(t.accountId)]);

export const roleInDeal = pgEnum('role_in_deal', [
  'economic_buyer', 'economic_buyer_domain', 'financial_validator', 'technical_champion',
  'technical_evaluator', 'influencer', 'end_user', 'supporting',
]);

/**
 * A decision-unit entry. is_gap=true is a real state, not an absence: the engine
 * could not resolve this role and says so, with a reason and a resolution path.
 * 5 of 17 people rows in the prototype corpus are gaps. That is the product working.
 */
export const person = pgTable('person', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => account.id, { onDelete: 'cascade' }),
  name: text('name'),
  title: text('title'),
  roleInDeal: roleInDeal('role_in_deal').notNull(),
  confidence: integer('confidence').notNull().default(1),
  isGap: boolean('is_gap').notNull().default(false),
  gapReason: text('gap_reason'),
  resolutionPath: text('resolution_path'),
  angle: text('angle'),
  provenance: text('provenance'),
  asOf: date('as_of'),
  email: text('email'),
  phone: text('phone'),
  linkedinUrl: text('linkedin_url'),
  verifiedAt: date('verified_at'),
}, (t) => [index('ix_person_account').on(t.accountId), index('ix_person_gap').on(t.tenantId, t.isGap)]);

export type Signal = typeof signal.$inferSelect;
export type Person = typeof person.$inferSelect;
export type Fact = typeof fact.$inferSelect;
