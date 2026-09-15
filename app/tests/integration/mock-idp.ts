import { createHash, generateKeyPairSync, randomBytes, sign as rsaSign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal but STANDARDS-HONEST OIDC provider for tests.
 *
 * It exists so `OidcIdentityProvider` is exercised against the real protocol —
 * discovery, PKCE S256, client_secret_basic, RS256-signed ID Tokens validated
 * against a published JWKS — rather than against a stub of our own client. A
 * stub can only prove we agree with ourselves; this proves we agree with
 * openid-client, which is what a real IdP will also use as its reference.
 *
 * Fault injection is the point (acceptance test #10): `controls` can produce an
 * expired token, a wrong-audience token, a token signed by a different key, or
 * a syntactically invalid one. Every mutation happens at the IdP, so the client
 * under test sees exactly what a hostile or broken provider would send.
 */

export interface MockUser {
  sub: string;
  email: string;
  name: string;
  groups: string[];
}

export interface MockIdpControls {
  /** Who the IdP authenticates on the next /authorize hit. */
  user: MockUser;
  /** ID Token lifetime; negative values produce an already-expired token. */
  tokenLifetimeSec: number;
  /** Applied to the claim set AFTER defaults, BEFORE signing. */
  claimMutator: ((claims: Record<string, unknown>) => Record<string, unknown>) | null;
  /** Sign with a key whose public half is NOT in the JWKS → invalid signature. */
  signingKey: KeyObject;
  /** Bypass signing entirely; returned verbatim as id_token → unparseable. */
  rawIdToken: string | null;
  /** /authorize returns error=access_denied instead of a code. */
  failAuthorize: boolean;
  /**
   * Merged into the /userinfo response, overriding its defaults. Lets a test
   * make UserInfo DISAGREE with the signed ID Token — which is the whole point
   * of the trust-boundary test, since UserInfo is not signed.
   */
  userinfoOverride: Record<string, unknown> | null;
}

export interface MockIdp {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly controls: MockIdpControls;
  /** The IdP's real signing key — swap controls.signingKey away from this to forge. */
  readonly key: KeyObject;
  stop(): Promise<void>;
}

interface StoredCode {
  readonly nonce: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly scope: string;
  used: boolean;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64url');

function safeDecode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

function signJwt(key: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = rsaSign('sha256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

export interface StartMockIdpOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly redirectUri?: string;
  readonly kid?: string;
}

export async function startMockIdp(opts: StartMockIdpOptions = {}): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const clientId = opts.clientId ?? 'coldpath-test';
  const clientSecret = opts.clientSecret ?? 'test-secret';
  const kid = opts.kid ?? 'mock-key-1';

  const codes = new Map<string, StoredCode>();
  const accessTokens = new Map<string, Record<string, unknown>>();

  let issuer = '';
  const controls: MockIdpControls = {
    user: { sub: 'idp-sub-001', email: 'm.belvin@ndustrial.test', name: 'Madeline Belvin', groups: [] },
    tokenLifetimeSec: 300,
    claimMutator: null,
    signingKey: privateKey,
    rawIdToken: null,
    failAuthorize: false,
    userinfoOverride: null,
  };

  const redirectUri = opts.redirectUri ?? 'http://127.0.0.1:9999/api/auth/callback';

  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid, use: 'sig', alg: 'RS256' };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', issuer || 'http://localhost');
    try {
      if (url.pathname === '/.well-known/openid-configuration') {
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          subject_types_supported: ['pairwise'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          scopes_supported: ['openid', 'profile', 'email'],
          claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'name', 'groups'],
        }); return;
      }

      if (url.pathname === '/jwks') {
        json(res, 200, { keys: [jwk] }); return;
      }

      if (url.pathname === '/authorize' && req.method === 'GET') {
        if (controls.failAuthorize) {
          const back = new URL(url.searchParams.get('redirect_uri') ?? redirectUri);
          back.searchParams.set('error', 'access_denied');
          const st = url.searchParams.get('state');
          if (st) back.searchParams.set('state', st);
          res.writeHead(302, { Location: back.toString() }).end();
          return;
        }
        const params = url.searchParams;
        const cid = params.get('client_id');
        const ruri = params.get('redirect_uri');
        const challenge = params.get('code_challenge');
        const nonce = params.get('nonce');
        const state = params.get('state');
        if (cid !== clientId || !ruri || !challenge || params.get('code_challenge_method') !== 'S256') {
          json(res, 400, { error: 'invalid_request', error_description: 'missing client_id, redirect_uri or S256 challenge' }); return;
        }
        const code = randomBytes(24).toString('base64url');
        codes.set(code, {
          nonce: nonce ?? '',
          challenge,
          redirectUri: ruri,
          clientId: cid,
          scope: params.get('scope') ?? '',
          used: false,
        });
        const back = new URL(ruri);
        back.searchParams.set('code', code);
        if (state) back.searchParams.set('state', state);
        res.writeHead(302, { Location: back.toString() }).end();
        return;
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const auth = req.headers.authorization ?? '';
        const [scheme, b64] = auth.split(' ');
        const decoded = scheme === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
        // RFC 6749 §2.3.1: client_id and client_secret are form-urlencoded in
        // the Basic credentials, so openid-client sends `coldpath%2Dtest:...`.
        // Split on the FIRST colon (an encoded value can never contain a raw
        // one), then decode each half.
        const sep = decoded.indexOf(':');
        const cid = sep >= 0 ? safeDecode(decoded.slice(0, sep)) : '';
        const secret = sep >= 0 ? safeDecode(decoded.slice(sep + 1)) : '';
        const secretOk =
          cid === clientId &&
          secret.length === clientSecret.length &&
          timingSafeEqual(Buffer.from(secret), Buffer.from(clientSecret));
        if (!secretOk) {
          json(res, 401, { error: 'invalid_client' }, { 'WWW-Authenticate': 'Basic' }); return;
        }

        const form = new URLSearchParams(await readBody(req));
        if (form.get('grant_type') !== 'authorization_code') {
          json(res, 400, { error: 'unsupported_grant_type' }); return;
        }
        const code = form.get('code');
        const stored = code ? codes.get(code) : undefined;
        if (!code || !stored) { json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' }); return; }
        if (stored.used) { json(res, 400, { error: 'invalid_grant', error_description: 'code already used' }); return; }
        stored.used = true;
        if (form.get('redirect_uri') !== stored.redirectUri) {
          json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }); return;
        }
        const verifier = form.get('code_verifier') ?? '';
        const computed = createHash('sha256').update(verifier).digest('base64url');
        if (computed !== stored.challenge) {
          json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }); return;
        }

        const now = Math.floor(Date.now() / 1000);
        let claims: Record<string, unknown> = {
          iss: issuer,
          sub: controls.user.sub,
          aud: clientId,
          iat: now,
          exp: now + controls.tokenLifetimeSec,
          nonce: stored.nonce,
          email: controls.user.email,
          email_verified: true,
          name: controls.user.name,
          groups: controls.user.groups,
        };
        if (controls.claimMutator) claims = controls.claimMutator(claims);

        const idToken = controls.rawIdToken ?? signJwt(controls.signingKey, kid, claims);
        const accessToken = randomBytes(24).toString('base64url');
        // UserInfo answers from the canonical user, NOT from the (possibly
        // mutated) ID Token claims — a real provider's UserInfo endpoint is
        // unaffected by how thin or broken the ID Token was.
        accessTokens.set(accessToken, { sub: typeof claims.sub === 'string' ? claims.sub : controls.user.sub });

        json(res, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: Math.max(controls.tokenLifetimeSec, 1),
          id_token: idToken,
        }); return;
      }

      if (url.pathname === '/userinfo' && req.method === 'GET') {
        const [, token] = (req.headers.authorization ?? '').split(' ');
        const ref = token ? accessTokens.get(token) : undefined;
        if (!ref) {
          json(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer' }); return;
        }
        json(res, 200, {
          sub: ref.sub,
          email: controls.user.email,
          email_verified: true,
          name: controls.user.name,
          groups: controls.user.groups,
          ...(controls.userinfoOverride ?? {}),
        }); return;
      }

      json(res, 404, { error: 'not_found' });
    } catch (err) {
      json(res, 500, { error: 'server_error', error_description: String(err) });
    }
  };

  const server = createServer((req, res) => { void handle(req, res); });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${addr.port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    controls,
    key: privateKey,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((e) => { if (e) reject(e); else resolve(); });
    }),
  };
}

/** A second, unrelated signing key — signing with it yields an invalid signature. */
export function forgeKey(): KeyObject {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}

/** Drive the authorization-code flow the way a browser would, without a browser. */
export async function browserStep(authorizationUrl: string): Promise<URL> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status !== 302 || location === null) {
    throw new Error(`expected 302 from mock IdP, got ${res.status}`);
  }
  return new URL(location);
}
