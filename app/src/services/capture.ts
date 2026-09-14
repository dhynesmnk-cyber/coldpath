import type { Db, Tx } from '../db/client.js';
import { capture } from '../db/schema/index.js';
import { can } from '../lib/auth/permissions.js';
import { requirePrincipal, requireTenant } from '../lib/auth/middleware.js';
import { AuthError, type RequestContext } from '../lib/auth/types.js';
import { audit } from './audit.js';

/**
 * Capture intake — gate L2, acceptance test #3.
 *
 * `capturedBy` is derived from the validated session and there is no parameter,
 * header or body field through which a caller can supply it. The input type
 * below simply does not contain the field, and the insert below builds its
 * values exclusively from whitelisted keys — so even a JavaScript caller who
 * smuggles `capturedBy` into the object at runtime has it ignored. Attribution
 * forgery is not checked-and-rejected here; it is inexpressible.
 */
export interface CaptureInput {
  readonly rawText: string;
  readonly expiresAt: Date;
  readonly accountId?: string | null;
  readonly personId?: string | null;
  readonly sourceUrl?: string | null;
  readonly sourceKind?: string;
  readonly captureMethod?: 'manual_paste' | 'csv_export' | 'api';
  /** Extracted fields, confidence-capped at 2 by the schema default rule L7. */
  readonly extracted?: Record<string, unknown>;
}

export async function createCapture(
  db: Db | Tx,
  ctx: RequestContext,
  input: CaptureInput,
): Promise<{ id: string }> {
  const principal = requirePrincipal(ctx);
  const tenantId = requireTenant(ctx);

  if (!can(principal.roles, 'capture.create')) {
    await audit(db, {
      tenantId, userId: principal.userId, action: 'auth.denied',
      resourceType: 'capture', outcome: 'deny',
      reason: `roles [${principal.roles.join(', ')}] lack 'capture.create'`,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    throw new AuthError('forbidden', 'capture.create not granted');
  }

  if (input.rawText.trim().length === 0) {
    throw new AuthError('forbidden', 'capture has no content'); // 400 in the adapter; refusal either way
  }

  const [row] = await db.insert(capture).values({
    tenantId,
    capturedBy: principal.userId,          // ← the only attribution path
    rawText: input.rawText,
    expiresAt: input.expiresAt,
    accountId: input.accountId ?? null,
    personId: input.personId ?? null,
    sourceUrl: input.sourceUrl ?? null,
    sourceKind: input.sourceKind ?? 'linkedin_sales_navigator',
    captureMethod: input.captureMethod ?? 'manual_paste',
    extracted: input.extracted ?? {},
    // L7: captures enter at confidence ≤ 2; corroboration raises it elsewhere.
    confidence: 2,
  }).returning({ id: capture.id });

  if (!row) throw new Error('capture insert returned no row');

  await audit(db, {
    tenantId, userId: principal.userId, action: 'capture.create',
    resourceType: 'capture', resourceId: row.id, accountId: input.accountId ?? null,
    outcome: 'allow', ip: ctx.ip, userAgent: ctx.userAgent,
  });

  return { id: row.id };
}
