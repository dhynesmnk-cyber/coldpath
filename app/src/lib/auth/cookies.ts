import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cookie handling as pure functions.
 *
 * Every security attribute required by AUTH-SPEC.md §8 is set here and nowhere
 * else, so there is exactly one place to get it wrong and exactly one test that
 * would catch it. Tokens never touch localStorage: it is readable by any script
 * on the page, HttpOnly cookies are not.
 */
export interface CookieOptions {
  readonly maxAgeSeconds?: number;
  readonly path?: string;
  readonly secure?: boolean;
  readonly domain?: string;
  /**
   * Defaults to true. The ONLY cookie that may set this to false is the CSRF
   * double-submit token, which JavaScript must be able to read in order to
   * echo it back in a header. Session and refresh tokens are never readable.
   */
  readonly httpOnly?: boolean;
}

export const SESSION_COOKIE = 'coldpath_session';
export const REFRESH_COOKIE = 'coldpath_refresh';

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly'); // never readable by script
  parts.push('SameSite=Lax');                   // permits the IdP redirect, blocks cross-site POST
  if (opts.secure !== false) parts.push('Secure');
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  return parts.join('; ');
}

export function clearCookie(name: string, opts: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...opts, maxAgeSeconds: 0 });
}

/** Parse a Cookie header. Malformed pairs are skipped, never thrown on. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

/**
 * Opaque session token. 32 random bytes, base64url — no structure to forge and
 * no payload to read. The session lives in the database; the cookie is a lookup
 * key, which is what makes server-side revocation immediate rather than waiting
 * for expiry.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Random value for protocol nonces (OIDC state, nonce, CSRF). Same primitive
 * as the session token, named for what it is at the call site.
 */
export function randomOpaqueToken(bytes = 32): string {
  return generateToken(bytes);
}

/** Double-submit CSRF token: read from a non-HttpOnly cookie, echoed in a header. */
export const CSRF_COOKIE = 'coldpath_csrf';
export const CSRF_HEADER = 'x-coldpath-csrf';

export function csrfValid(cookieToken: string | undefined, headerToken: string | undefined): boolean {
  if (!cookieToken || !headerToken) return false;
  if (cookieToken.length < 16 || headerToken.length < 16) return false;
  // Constant-time compare; token length is not secret but timing is.
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(headerToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
