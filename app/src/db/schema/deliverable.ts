import { pgTable, primaryKey, text, timestamp, uuid, jsonb, integer, index, unique, pgEnum, bigint } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';
import { account } from './account.js';
import { appUser } from './identity.js';
import { fact } from './research.js';

export const deliverableType = pgEnum('deliverable_type', [
  'brief', 'exec', 'outbound', 'discovery', 'battle', 'business',
  'campaign', 'letter', 'social', 'site_portfolio',
]);

export const deliverableStatus = pgEnum('deliverable_status', [
  'draft', 'in_review', 'published', 'superseded', 'blocked', 'stale',
]);

/**
 * minConfidence is enforced at generation time, not advisory. A deliverable type
 * declares the floor it needs per field class; generation fails loudly rather
 * than shipping something weaker (gate L8, INGESTION-GATES.md §7.6).
 */
export const deliverable = pgTable('deliverable', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => account.id, { onDelete: 'cascade' }),
  type: deliverableType('type').notNull(),
  version: integer('version').notNull().default(1),
  status: deliverableStatus('status').notNull().default('draft'),
  body: jsonb('body').notNull(),
  rendered: text('rendered'),
  minConfidence: integer('min_confidence').notNull().default(2),
  /** Why generation was refused. A refusal is a success state and is recorded. */
  blockedReason: text('blocked_reason'),
  authorId: uuid('author_id').references(() => appUser.id),
  approvedBy: uuid('approved_by').references(() => appUser.id),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  /** Corrections create a new row referencing the old one; nothing is edited in place. */
  supersedesId: uuid('supersedes_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uq_deliverable_version').on(t.tenantId, t.accountId, t.type, t.version),
  index('ix_deliverable_account').on(t.accountId),
  index('ix_deliverable_status').on(t.tenantId, t.status),
]);

/**
 * The fact -> deliverable join. One query answers "which artefacts are now stale?"
 * which is what makes version diff (D2) and the dependency graph (K6) cheap.
 */
export const deliverableFact = pgTable('deliverable_fact', {
  deliverableId: uuid('deliverable_id').notNull().references(() => deliverable.id, { onDelete: 'cascade' }),
  factId: uuid('fact_id').notNull().references(() => fact.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.deliverableId, t.factId] }),
  index('ix_df_fact').on(t.factId),
]);

export const correctionKind = pgEnum('correction_kind', ['wrong', 'stale', 'missing', 'tone', 'other']);

/** Rep feedback is a first-class object. It drops the affected fact to confidence 1. */
export const correction = pgTable('correction', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  deliverableId: uuid('deliverable_id').notNull().references(() => deliverable.id, { onDelete: 'cascade' }),
  factId: uuid('fact_id').references(() => fact.id, { onDelete: 'set null' }),
  personId: uuid('person_id'),
  raisedBy: uuid('raised_by').notNull().references(() => appUser.id),
  kind: correctionKind('kind').notNull(),
  note: text('note'),
  resolved: jsonb('resolved').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ix_correction_deliverable').on(t.deliverableId)]);

export const captureMethod = pgEnum('capture_method', ['manual_paste', 'csv_export', 'api']);

/**
 * Gate L2: captured_by is written server-side from the validated session. It is
 * not a request parameter and there is no API that accepts it as input. With a
 * shared rep code this is the only thing that keeps captures attributable.
 *
 * rawText is retained verbatim forever so a parser improvement can re-extract
 * every historical capture, and so any field can be audited against what was
 * actually pasted.
 */
export const capture = pgTable('capture', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => account.id, { onDelete: 'set null' }),
  personId: uuid('person_id'),
  capturedBy: uuid('captured_by').notNull().references(() => appUser.id),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  sourceUrl: text('source_url'),
  sourceKind: text('source_kind').notNull().default('linkedin_sales_navigator'),
  captureMethod: captureMethod('capture_method').notNull().default('manual_paste'),
  rawText: text('raw_text').notNull(),
  extracted: jsonb('extracted').notNull().default({}),
  /** L7 — hard ceiling. No code path may write 3 here for a capture. */
  confidence: integer('confidence').notNull().default(2),
  corroboratedBy: uuid('corroborated_by').references(() => fact.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('ix_capture_account').on(t.accountId), index('ix_capture_by').on(t.capturedBy)]);

export const documentClass = pgEnum('document_class', [
  'prior_research', 'activity_record', 'mixed', 'unclassifiable', 'rejected',
]);

/**
 * R2 classification result. `unclassifiable` is a real state routed to a human
 * sorting queue — the engine does not guess. `rejected` means R1 refused it
 * (e.g. a scanned PDF with no text layer); the document is retained with a reason.
 */
export const document = pgTable('document', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => account.id, { onDelete: 'set null' }),
  filename: text('filename').notNull(),
  mime: text('mime'),
  bytes: bigint('bytes', { mode: 'number' }),
  extractedText: text('extracted_text'),
  classification: documentClass('classification').notNull(),
  classificationMargin: integer('classification_margin'),
  researchMarkers: integer('research_markers').notNull().default(0),
  activityMarkers: integer('activity_markers').notNull().default(0),
  author: text('author'),
  docDate: text('doc_date'),
  ageDays: integer('age_days'),
  /** R5 — internal documents cap at confidence 2 regardless of how authoritative they read. */
  confidenceCap: integer('confidence_cap').notNull().default(2),
  rejectionReason: text('rejection_reason'),
  indexedForSuppression: jsonb('indexed_for_suppression').notNull().default([]),
  uploadedBy: uuid('uploaded_by').references(() => appUser.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ix_document_classification').on(t.tenantId, t.classification)]);

export type Deliverable = typeof deliverable.$inferSelect;
