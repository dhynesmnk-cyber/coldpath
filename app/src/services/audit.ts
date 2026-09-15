import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { auditLog } from '../db/schema/index.js';
import { log } from '../lib/log.js';

/**
 * Append-only audit writer — AUTH-SPEC.md §5.
 *
 * The table has UPDATE and DELETE blocked by database triggers, and the
 * application role has neither privilege revoked-by-grant nor any code path here
 * that attempts it. An audit trail the application can edit is not an audit trail.
 */
export type AuditAction =
  | 'auth.login' | 'auth.logout' | 'auth.denied'
  | 'pii.read' | 'pii.grant' | 'pii.revoke'
  | 'capture.create' | 'document.ingest' | 'crm.ingest'
  | 'deliverable.create' | 'deliverable.edit' | 'deliverable.approve' | 'deliverable.publish'
  | 'account.resolve' | 'account.suppress' | 'review.resolve' | 'role.grant' | 'role.revoke';

export interface AuditEntry {
  readonly tenantId?: string | null;
  readonly userId?: string | null;
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly accountId?: string | null;
  readonly outcome: 'allow' | 'deny' | 'error';
  readonly reason?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly meta?: Record<string, unknown> | null;
}

/**
 * Write one audit entry. Never throws: an audit failure must not become the
 * reason a legitimate request fails, but it IS surfaced to the caller's logger
 * so a persistently failing audit trail is visible rather than silent.
 */
export async function audit(db: Db | Tx, entry: AuditEntry): Promise<boolean> {
  try {
    await db.insert(auditLog).values({
      tenantId: entry.tenantId ?? null,
      userId: entry.userId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      accountId: entry.accountId ?? null,
      outcome: entry.outcome,
      reason: entry.reason ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      meta: entry.meta ?? null,
    });
    return true;
  } catch (e) {
    // Structured, and deliberately loud. An audit trail that silently stops
    // recording is worse than one that errors: the absence of entries reads as
    // "nothing happened". This is the signal that the trail is incomplete.
    log.error(
      { action: entry.action, outcome: entry.outcome, tenantId: entry.tenantId, err: String(e) },
      'audit write failed',
    );
    return false;
  }
}

/**
 * Record a T3 read. Called by the serializer's onPiiRead hook, so reading a
 * contact detail is logged whether or not the caller remembered to.
 */
export async function auditPiiRead(
  db: Db | Tx,
  p: { tenantId: string; userId: string; personId: string; field: string; ip?: string | null },
): Promise<boolean> {
  return audit(db, {
    tenantId: p.tenantId, userId: p.userId, action: 'pii.read',
    resourceType: 'person', resourceId: p.personId, outcome: 'allow',
    ip: p.ip ?? null, meta: { field: p.field },
  });
}

/**
 * Read the trail. admin-only — enforced by the caller's permission check.
 *
 * `userId` and `action` were declared here and never applied: the query filtered
 * on tenant alone, so an admin narrowing the trail to one user or one action got
 * the WHOLE trail back with no indication the filter had been ignored. For an
 * audit tool that is worse than an error — the answer looks authoritative and
 * the reviewer has no reason to doubt it.
 */
export async function readAudit(
  db: Db | Tx,
  filter: { tenantId: string; limit?: number; userId?: string; action?: AuditAction },
) {
  const conditions: SQL[] = [eq(auditLog.tenantId, filter.tenantId)];
  if (filter.userId !== undefined) conditions.push(eq(auditLog.userId, filter.userId));
  if (filter.action !== undefined) conditions.push(eq(auditLog.action, filter.action));

  return db.select().from(auditLog)
    .where(and(...conditions))
    .orderBy(sql`${auditLog.at} DESC`)
    .limit(filter.limit ?? 100);
}
