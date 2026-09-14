import { tenantCtx, withTenant, type Db, type Tx } from '../../db/client.js';
import { audit } from '../../services/audit.js';
import { CSRF_COOKIE, CSRF_HEADER, csrfValid, parseCookies, SESSION_COOKIE } from './cookies.js';
import { can } from './permissions.js';
import { resolveSession } from './session.js';
import { AuthError, type Permission, type Principal, type RequestContext } from './types.js';

/**
 * The request pipeline — AUTH-SPEC.md §3, §4.
 *
 *   authenticate → CSRF → route match → authorize → tenant context
 *
 * Framework-agnostic on purpose: it consumes a plain `InboundRequest` and
 * throws `AuthError` carrying an HTTP status. Whatever HTTP adapter ships in
 * Phase 2 (Express, Hono, Fastify) maps that to a response; the decision logic
 * lives here, once, where it is testable without a server.
 *
 * Two defaults matter more than any rule in the table below:
 *   - UNKNOWN ROUTE = REFUSE. A path nobody registered gets a 403, not a 404 —
 *     existence of routes is not information, and "forgot to protect the new
 *     endpoint" fails closed.
 *   - DENIALS ARE 403, NOT REDIRECTS (acceptance test #1). A redirect to login
 *     lets a client-side router treat "unauthorized" as "navigate elsewhere";
 *     a refusal cannot be misread.
 */

export interface InboundRequest {
  readonly method: string;
  readonly path: string;
  /** Header names lower-cased. `headers['cookie']`, `headers['x-coldpath-csrf']`. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly ip?: string | null;
}

export interface RouteRule {
  readonly methods: readonly string[];
  readonly pattern: RegExp;
  /** Omit for "any authenticated user" (e.g. /api/me). */
  readonly permission?: Permission;
  /** True only for the auth endpoints themselves. */
  readonly public?: boolean;
}

const GET = ['GET'] as const;
const POST = ['POST'] as const;

/**
 * The Phase-1 route table. Page routes are listed too: the SPA is served by the
 * same process, and a rep asking the server for /command must get a 403 from the
 * server, not a 200 whose JavaScript then decides to look empty.
 */
export const ROUTES: readonly RouteRule[] = [
  // --- auth endpoints: public by necessity, protected by state/PKCE/CSRF ---
  { methods: GET, pattern: /^\/api\/auth\/login$/, public: true },
  { methods: GET, pattern: /^\/api\/auth\/callback$/, public: true },
  { methods: POST, pattern: /^\/api\/auth\/logout$/, public: true },
  { methods: POST, pattern: /^\/api\/auth\/refresh$/, public: true },

  // --- identity ---
  { methods: GET, pattern: /^\/api\/me$/ },

  // --- library & research ---
  { methods: GET, pattern: /^\/api\/accounts(\/[^/]+)?$/, permission: 'library.read' },
  { methods: GET, pattern: /^\/api\/search$/, permission: 'library.search' },
  { methods: GET, pattern: /^\/api\/research(\/.*)?$/, permission: 'research.read' },
  { methods: GET, pattern: /^\/api\/dashboard$/, permission: 'dashboard.view' },
  { methods: GET, pattern: /^\/api\/costs(\/.*)?$/, permission: 'cost.read' },
  { methods: GET, pattern: /^\/api\/audit(\/.*)?$/, permission: 'audit.read' },
  { methods: ['GET', 'POST', 'PUT', 'DELETE'], pattern: /^\/api\/customer-list(\/.*)?$/, permission: 'customer_list.manage' },

  // --- contributions ---
  { methods: POST, pattern: /^\/api\/captures$/, permission: 'capture.create' },
  { methods: POST, pattern: /^\/api\/corrections$/, permission: 'correction.create' },
  { methods: POST, pattern: /^\/api\/briefs$/, permission: 'brief.request' },

  // --- marketing operations ---
  { methods: POST, pattern: /^\/api\/ingest(\/.*)?$/, permission: 'ingest.execute' },
  { methods: POST, pattern: /^\/api\/deliverables\/[^/]+\/approve$/, permission: 'review.approve' },
  { methods: POST, pattern: /^\/api\/deliverables\/[^/]+\/publish$/, permission: 'deliverable.publish' },
  { methods: POST, pattern: /^\/api\/reviews\/[^/]+\/resolve$/, permission: 'review.resolve' },
  { methods: POST, pattern: /^\/api\/accounts\/[^/]+\/assign$/, permission: 'account.assign' },
  { methods: POST, pattern: /^\/api\/roles(\/.*)?$/, permission: 'role.grant' },

  // --- pages (the SPA shells; data still comes through /api) ---
  { methods: GET, pattern: /^\/library$/, permission: 'library.read' },
  { methods: GET, pattern: /^\/command$/, permission: 'dashboard.view' },
  { methods: GET, pattern: /^\/research(\/.*)?$/, permission: 'research.read' },
  { methods: GET, pattern: /^\/audit$/, permission: 'audit.read' },
  { methods: GET, pattern: /^\/settings(\/.*)?$/, permission: 'role.grant' },
];

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function matchRoute(method: string, path: string): RouteRule | null {
  const clean = path.split('?', 1)[0] ?? path;
  for (const rule of ROUTES) {
    if (!rule.pattern.test(clean)) continue;
    if (rule.methods.includes(method.toUpperCase())) return rule;
  }
  return null;
}

/** Step 1 — who is this? Never throws; an absent or bad session is `principal: null`. */
export async function authenticate(db: Db, req: InboundRequest): Promise<RequestContext> {
  const cookies = parseCookies(req.headers.cookie);
  const resolved = await resolveSession(db, cookies[SESSION_COOKIE]);
  return {
    principal: resolved?.principal ?? null,
    tenantId: resolved?.principal.tenantId ?? null,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

export function requirePrincipal(ctx: RequestContext): Principal {
  if (ctx.principal === null) {
    throw new AuthError('unauthenticated', 'no valid session');
  }
  if (!ctx.principal.isActive) {
    throw new AuthError('inactive', 'user is deactivated');
  }
  return ctx.principal;
}

export function requireTenant(ctx: RequestContext): string {
  if (ctx.tenantId === null) throw new AuthError('tenant_missing', 'session carries no tenant');
  return ctx.tenantId;
}

/** Step 2 — what may they do? Pure; auditing happens in authorizeRequest. */
export function authorize(ctx: RequestContext, permission: Permission | undefined): void {
  const principal = requirePrincipal(ctx);
  requireTenant(ctx);
  if (permission === undefined) return;
  if (!can(principal.roles, permission)) {
    throw new AuthError(
      'forbidden',
      `roles [${principal.roles.join(', ')}] lack '${permission}'`,
    );
  }
}

/**
 * The whole pipeline, in the order the spec mandates. Throws AuthError (with
 * status) on any refusal and records `auth.denied` for every refusal.
 *
 * Everything runs inside a tenant-scoped transaction — including the session
 * lookup, so a session row can never be read outside its tenant's RLS policy
 * even by the authentication layer itself. The tenant comes from the deployment
 * (single-tenant pilot; a multi-tenant future resolves it from the host first,
 * then calls this identically). Denials by anonymous callers are audited with
 * the deployment tenant when set, else NULL via the audit_anonymous_insert
 * policy — a failed login is the entry you most want when investigating.
 */
export async function authorizeRequest(
  db: Db,
  req: InboundRequest,
  deploy: { readonly tenantId: string | null },
): Promise<RequestContext> {
  // Mutable holders so the catch below knows WHO was denied and WHY: the
  // pipeline's transaction rolls back on throw, taking any in-tx audit insert
  // with it. A denial that is rolled back is a denial that never happened —
  // exactly the record an incident review needs. So the audit is written in
  // its own committed transaction, after the refusal is certain.
  const seen: { ctx: RequestContext | null; reason: string | null } = { ctx: null, reason: null };
  try {
    if (deploy.tenantId === null) return await pipeline(db, req, null, seen);
    return await withTenant(db, tenantCtx(deploy.tenantId), (tx) => pipeline(tx, req, deploy.tenantId, seen));
  } catch (err) {
    if (err instanceof AuthError) {
      const tenantId = seen.ctx?.tenantId ?? deploy.tenantId;
      const entry = {
        tenantId,
        userId: seen.ctx?.principal?.userId ?? null,
        action: 'auth.denied' as const,
        resourceType: 'route',
        resourceId: `${req.method} ${req.path}`,
        outcome: 'deny' as const,
        reason: seen.reason ?? err.code,
        ip: seen.ctx?.ip ?? req.ip ?? null,
        userAgent: seen.ctx?.userAgent ?? req.headers['user-agent'] ?? null,
      };
      try {
        if (tenantId !== null) await withTenant(db, tenantCtx(tenantId), (tx) => audit(tx, entry));
        else await audit(db, entry);
      } catch {
        // An audit failure must not mask the denial itself; audit() logs it.
      }
    }
    throw err;
  }
}

async function pipeline(
  db: Db | Tx,
  req: InboundRequest,
  _deployTenantId: string | null,
  seen: { ctx: RequestContext | null; reason: string | null },
): Promise<RequestContext> {
  const ctx = await authenticate(db, req);
  seen.ctx = ctx;
  const rule = matchRoute(req.method, req.path);

  // Default-deny: an unregistered path is refused, not 404'd.
  if (rule === null) {
    seen.reason = 'no route';
    throw new AuthError('forbidden', `no route for ${req.method} ${req.path}`);
  }

  // CSRF on every unsafe method, including the public auth endpoints. The IdP
  // callback is a GET and is protected by state+PKCE instead; logout/refresh
  // are POSTs an attacker page would otherwise be able to fire blind.
  if (UNSAFE_METHODS.has(req.method.toUpperCase())) {
    const cookies = parseCookies(req.headers.cookie);
    if (!csrfValid(cookies[CSRF_COOKIE], req.headers[CSRF_HEADER])) {
      seen.reason = 'csrf';
      throw new AuthError('forbidden', 'CSRF validation failed', 403);
    }
  }

  if (rule.public === true) return ctx;

  try {
    authorize(ctx, rule.permission);
  } catch (err) {
    if (err instanceof AuthError) seen.reason = err.code;
    throw err;
  }
  return ctx;
}
