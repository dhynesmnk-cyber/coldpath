import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationResponseError, ResponseBodyError, WWWAuthenticateChallengeError } from 'openid-client';
import { OidcIdentityProvider, readGroups, type IdpConfig } from '../../src/lib/auth/oidc.js';
import { AuthError } from '../../src/lib/auth/types.js';
import { browserStep, forgeKey, startMockIdp, type MockIdp, type MockUser } from './mock-idp.js';

/**
 * OIDC against a protocol-honest mock IdP — acceptance test #10 plus the happy
 * path. No database is involved: this file tests the trust boundary itself.
 *
 * The negative cases are the product. Each one mutates the token AT THE IdP
 * (expiry, audience, signing key, syntax) and asserts the client refuses with
 * `idp_error` — no default role, no anonymous fallback, no "close enough".
 */

let idp: MockIdp;

const DEFAULT_USER: MockUser = {
  sub: 'idp-sub-001',
  email: 'm.belvin@ndustrial.test',
  name: 'Madeline Belvin',
  groups: [],
};

function makeProvider(overrides: Partial<IdpConfig> = {}): OidcIdentityProvider {
  return new OidcIdentityProvider({
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: idp.redirectUri,
    allowInsecure: true, // http://127.0.0.1 — tests only, refused in prod config
    ...overrides,
  });
}

/** Runs begin → mock browser redirect → exchange, with optional tampering of the stored values. */
async function fullFlow(
  provider: OidcIdentityProvider,
  tamper: (stored: { state: string; nonce: string; codeVerifier: string }) => void = (): void => undefined,
) {
  const request = await provider.beginAuthorization();
  const callbackUrl = await browserStep(request.url);
  const stored = { state: request.state, nonce: request.nonce, codeVerifier: request.codeVerifier };
  tamper(stored);
  return provider.exchangeCallback(callbackUrl, { url: request.url, ...stored });
}

beforeAll(async () => {
  idp = await startMockIdp({ redirectUri: 'http://127.0.0.1:9999/api/auth/callback' });
}, 30_000);

afterAll(async () => {
  await idp.stop();
});

// Reset AFTER every test: a failed assertion must not leak fault-injection
// state into the next test (a leaked negative exp once cascaded through the
// whole suite and masked what each test was actually exercising).
afterEach(() => {
  idp.controls.user = { ...DEFAULT_USER };
  idp.controls.tokenLifetimeSec = 300;
  idp.controls.claimMutator = null;
  idp.controls.signingKey = idp.key;
  idp.controls.rawIdToken = null;
  idp.controls.failAuthorize = false;
});

describe('OIDC happy path', () => {
  it('completes the authorization code flow with PKCE and returns a normalized profile', async () => {
    idp.controls.user = {
      sub: 'entra-sub-madeline',
      email: 'M.Belvin@Ndustrial.test',
      name: 'Madeline Belvin',
      groups: ['COLDPATH-Marketing', 'COLDPATH-Admins'],
    };
    const profile = await fullFlow(makeProvider());

    expect(profile.subject).toBe('entra-sub-madeline');
    expect(profile.email).toBe('m.belvin@ndustrial.test'); // lowercased
    expect(profile.name).toBe('Madeline Belvin');
    expect(profile.groups).toEqual(['COLDPATH-Marketing', 'COLDPATH-Admins']);
    expect(profile.claims.iss).toBe(idp.issuer);
  }, 30_000);

  it('reads groups from a custom claim and comma-separated strings (readGroups)', () => {
    expect(readGroups(['a', 'b', 3, null])).toEqual(['a', 'b']);
    expect(readGroups('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(readGroups(undefined)).toEqual([]);
    expect(readGroups('')).toEqual([]);
  });

  it('honours a non-default group claim (cognito:groups)', async () => {
    idp.controls.user = { sub: 'sub-2', email: 'rep@ndustrial.test', name: 'Rep One', groups: [] };
    idp.controls.claimMutator = (c) => ({ ...c, 'cognito:groups': ['COLDPATH-Reps'] });
    const profile = await fullFlow(makeProvider({ groupClaim: 'cognito:groups' }));
    expect(profile.groups).toEqual(['COLDPATH-Reps']);
  }, 30_000);

  it('falls back to UserInfo when the ID Token lacks email', async () => {
    idp.controls.user = { sub: 'sub-3', email: 'thin@ndustrial.test', name: 'Thin Token', groups: [] };
    idp.controls.claimMutator = (c) => {
      const { email: _e, name: _n, ...rest } = c;
      return rest; // ID Token carries only the protocol claims
    };
    const profile = await fullFlow(makeProvider());
    expect(profile.email).toBe('thin@ndustrial.test'); // came from /userinfo
    expect(profile.name).toBe('Thin Token');
  }, 30_000);
});

describe('acceptance #10 — bad tokens are denied with no fallback', () => {
  type ReasonCheck = RegExp | ((cause: unknown) => boolean);

  /**
   * Every denial must be an AuthError('idp_error', 401) AND must fail for the
   * reason under test. The second assertion matters: a misconfigured mock once
   * made all of these "pass" by failing client authentication before any token
   * was ever issued. Pinning the cause keeps each test honest.
   */
  async function expectIdpError(run: () => Promise<unknown>, label: string, reason: ReasonCheck): Promise<void> {
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, `${label}: expected a throw, got success`).toBeInstanceOf(AuthError);
    const ae = err as AuthError;
    expect(ae.code, label).toBe('idp_error');
    expect(ae.status, label).toBe(401);

    // openid-client normalizes its own messages ('JWT timestamp claim value
    // failed validation') but keeps the detailed oauth4webapi error on .cause.
    // Walk the chain so each test pins the REAL rejection reason.
    const cause = ae.cause;
    const detail = causeChain(cause) || ae.message;
    const ok = reason instanceof RegExp
      ? reason.test(detail)
      : cause !== undefined && reason(cause);
    expect(ok, `${label}: denied for the WRONG reason — cause chain was: ${detail}; own message: ${ae.message}`).toBe(true);
  }

  function causeChain(start: unknown): string {
    const parts: string[] = [];
    let cur: unknown = start;
    for (let depth = 0; cur instanceof Error && depth < 5; depth++) {
      parts.push(`${cur.constructor.name}: ${cur.message}`);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }

  it('denies an expired ID Token', async () => {
    idp.controls.tokenLifetimeSec = -120; // exp two minutes in the past
    await expectIdpError(() => fullFlow(makeProvider()), 'expired', /timestamp|"exp"/i);
    idp.controls.tokenLifetimeSec = 300;
  }, 30_000);

  it('denies a wrong-audience ID Token', async () => {
    idp.controls.claimMutator = (c) => ({ ...c, aud: 'some-other-product' });
    await expectIdpError(() => fullFlow(makeProvider()), 'wrong audience', /aud|audience/i);
  }, 30_000);

  it('denies a token signed by a key not in the JWKS', async () => {
    idp.controls.signingKey = forgeKey();
    await expectIdpError(() => fullFlow(makeProvider()), 'bad signature', /signature/i);
  }, 30_000);

  it('denies an unparseable id_token', async () => {
    idp.controls.rawIdToken = 'this.is.not-a-jwt';
    await expectIdpError(() => fullFlow(makeProvider()), 'unparseable', /parsing|parse|jwt|malformed/i);
  }, 30_000);

  it('denies a token with no subject claim', async () => {
    idp.controls.claimMutator = (c) => {
      const { sub: _s, ...rest } = c;
      return rest;
    };
    await expectIdpError(() => fullFlow(makeProvider()), 'no sub', /\"sub\"|subject/i);
  }, 30_000);

  it('denies a token with no usable email even after UserInfo', async () => {
    idp.controls.user = { sub: 'sub-4', email: 'not-an-email', name: 'No Email', groups: [] };
    // This one is our own refusal (the library accepts the token; the profile
    // is unusable), so the message rather than a library cause is the reason.
    await expectIdpError(() => fullFlow(makeProvider()), 'no email', /no usable email/i);
  }, 30_000);

  it('denies when the stored state does not match the callback (CSRF on the flow)', async () => {
    await expectIdpError(
      () => fullFlow(makeProvider(), (s) => { s.state = 'attacker-chosen-state'; }),
      'state mismatch',
      /state/i,
    );
  }, 30_000);

  it('denies when the stored nonce does not match the ID Token', async () => {
    await expectIdpError(
      () => fullFlow(makeProvider(), (s) => { s.nonce = 'wrong-nonce'; }),
      'nonce mismatch',
      /nonce/i,
    );
  }, 30_000);

  it('denies when the PKCE verifier does not match the challenge', async () => {
    await expectIdpError(
      () => fullFlow(makeProvider(), (s) => { s.codeVerifier = 'stolen-flow-wrong-verifier'; }),
      'pkce mismatch',
      (c) => c instanceof ResponseBodyError && c.error === 'invalid_grant',
    );
  }, 30_000);

  it('denies a replayed authorization code (single use at the IdP)', async () => {
    const provider = makeProvider();
    const request = await provider.beginAuthorization();
    const callbackUrl = await browserStep(request.url);
    const stored = { url: request.url, state: request.state, nonce: request.nonce, codeVerifier: request.codeVerifier };
    await provider.exchangeCallback(callbackUrl, stored); // first use: fine
    await expectIdpError(
      () => provider.exchangeCallback(callbackUrl, stored),
      'code replay',
      (c) => c instanceof ResponseBodyError && c.error === 'invalid_grant',
    );
  }, 30_000);

  it('surfaces an IdP authorization error (access_denied) as idp_error', async () => {
    idp.controls.failAuthorize = true;
    await expectIdpError(
      () => fullFlow(makeProvider()),
      'authorize error',
      (c) => c instanceof AuthorizationResponseError && c.error === 'access_denied',
    );
  }, 30_000);

  it('denies when the wrong client secret is used at the token endpoint', async () => {
    await expectIdpError(
      () => fullFlow(makeProvider({ clientSecret: 'wrong-secret' })),
      'bad client auth',
      (c) => c instanceof WWWAuthenticateChallengeError,
    );
  }, 30_000);
});
