import { pgTable, text, timestamp, uuid, jsonb, boolean, inet, index, pgEnum, unique } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';

export const roleEnum = pgEnum('role', ['admin', 'marketing', 'sales_lead', 'rep', 'viewer']);

/** AUTH-SPEC.md §5 — idp_subject is the stable key, never the email address. */
export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  idpSubject: text('idp_subject').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  initials: text('initials'),
  isActive: boolean('is_active').notNull().default(true),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uq_app_user_idp').on(t.tenantId, t.idpSubject),
  unique('uq_app_user_email').on(t.tenantId, t.email),
  index('ix_app_user_tenant').on(t.tenantId),
]);

/** Roles are granted, not inherent. scope=null means global; else an account id. */
export const roleGrant = pgTable('role_grant', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  role: roleEnum('role').notNull(),
  scope: uuid('scope'),
  grantedBy: uuid('granted_by').references(() => appUser.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (t) => [
  unique('uq_role_grant').on(t.tenantId, t.userId, t.role, t.scope),
  index('ix_role_grant_user').on(t.userId),
]);

/**
 * The session cookie holds an opaque random token; only its SHA-256 hash is
 * stored. A database leak therefore does not yield usable sessions.
 *
 * `familyId` + `refreshRotatedAt` implement rotating single-use refresh tokens:
 * presenting an already-rotated token revokes the whole family, which is the
 * standard signal that a token was stolen and replayed (AUTH-SPEC.md §8).
 */
export const session = pgTable('session', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  refreshHash: text('refresh_hash'),
  familyId: uuid('family_id').notNull().defaultRandom(),
  refreshRotatedAt: timestamp('refresh_rotated_at', { withTimezone: true }),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  /** Enables single logout when the IdP session ends. */
  idpSessionId: text('idp_session_id'),
}, (t) => [
  index('ix_session_user').on(t.userId),
  index('ix_session_tenant').on(t.tenantId),
  index('ix_session_family').on(t.familyId),
]);

export const auditAction = pgEnum('audit_action', [
  'auth.login', 'auth.logout', 'auth.denied',
  'pii.read', 'pii.grant', 'pii.revoke',
  'capture.create', 'document.ingest', 'crm.ingest',
  'deliverable.create', 'deliverable.edit', 'deliverable.approve', 'deliverable.publish',
  'account.resolve', 'account.suppress', 'review.resolve', 'role.grant', 'role.revoke',
]);

export const auditOutcome = pgEnum('audit_outcome', ['allow', 'deny', 'error']);

/**
 * Append-only. UPDATE and DELETE are blocked by a trigger (see migrations),
 * not by convention — an audit trail the application can edit is not one.
 * user_id is nullable because a failed authentication has no user yet.
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenant.id, { onDelete: 'set null' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id'),
  action: auditAction('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  accountId: uuid('account_id'),
  outcome: auditOutcome('outcome').notNull(),
  reason: text('reason'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  meta: jsonb('meta'),
}, (t) => [index('ix_audit_tenant_at').on(t.tenantId, t.at), index('ix_audit_user').on(t.userId)]);

export const piiField = pgEnum('pii_field', ['email', 'phone']);

/** AUTH-SPEC.md §5 / gate S5 — consent_basis is what makes outreach lawful. */
export const piiGrant = pgTable('pii_grant', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  personId: uuid('person_id').notNull(),
  field: piiField('field').notNull(),
  consentBasis: text('consent_basis').notNull(),
  grantedBy: uuid('granted_by').references(() => appUser.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (t) => [unique('uq_pii_grant').on(t.tenantId, t.userId, t.personId, t.field)]);

/** E7 — read receipts. Visible to the `marketing` role only (see PRODUCT-PLAN.md §2.1). */
export const readReceipt = pgTable('read_receipt', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
  deliverableId: uuid('deliverable_id').notNull(),
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ix_read_receipt_deliverable').on(t.deliverableId)]);

export type AppUser = typeof appUser.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
