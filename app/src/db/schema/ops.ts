import { pgTable, text, timestamp, uuid, jsonb, integer, numeric, index, pgEnum } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';
import { account } from './account.js';
import { appUser } from './identity.js';

export const gateId = pgEnum('gate_id', [
  'G0','G1','G2','G3','G4','G5','G6','G7','G8','G9',
  'C1','C2','C3','C4','C5','C6','C7','C8','C9',
  'R1','R2','R3','R4','R5','R6','R7','R8','R9','R10',
  'L1','L2','L3','L4','L5','L6','L7','L8','L9','L10','L11','L12',
  'S1','S2','S3','S4','S5','S6','S7','S8',
]);

export const ingestPath = pgEnum('ingest_path', ['crm', 'reports', 'capture', 'salesintel', 'spec', 'research']);
export const severityEnum = pgEnum('severity', ['blocking', 'waiting', 'info']);

/**
 * The unified review queue. Every gate that refuses, defers or conflicts writes
 * here. Nothing is silently overwritten, merged or dropped — this table is how
 * the system keeps that promise, and it is surfaced on the Command dashboard as
 * well as the Ingest overview so a refusal is never only visible on a screen
 * nobody opened.
 */
export const reviewItem = pgTable('review_item', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  gate: gateId('gate').notNull(),
  path: ingestPath('path').notNull(),
  severity: severityEnum('severity').notNull(),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  accountId: uuid('account_id').references(() => account.id, { onDelete: 'cascade' }),
  evidence: jsonb('evidence'),
  resolvedBy: uuid('resolved_by').references(() => appUser.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ix_review_open').on(t.tenantId, t.severity, t.resolvedAt),
  index('ix_review_gate').on(t.gate),
]);

export const costOperation = pgEnum('cost_operation', [
  'research', 'refresh', 'deliverable', 'enrichment', 'news', 'registry', 'filings', 'web', 'infra',
]);

export const llmProvider = pgEnum('llm_provider', ['anthropic', 'openai', 'azure_openai', 'none']);

/**
 * Metered at the LLM boundary, not estimated afterwards. Every provider call
 * writes exactly one row. The Usage & Cost screen reads this table.
 */
export const costEvent = pgTable('cost_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  operation: costOperation('operation').notNull(),
  accountId: uuid('account_id').references(() => account.id, { onDelete: 'set null' }),
  units: integer('units').notNull().default(1),
  unitCost: numeric('unit_cost', { precision: 12, scale: 6 }).notNull().default('0'),
  cost: numeric('cost', { precision: 12, scale: 6 }).notNull().default('0'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  provider: llmProvider('provider').notNull().default('none'),
  model: text('model'),
  note: text('note'),
}, (t) => [index('ix_cost_tenant_at').on(t.tenantId, t.at), index('ix_cost_operation').on(t.operation)]);

export type ReviewItem = typeof reviewItem.$inferSelect;
export type CostEvent = typeof costEvent.$inferSelect;
