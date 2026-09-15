/**
 * COLDPATH — OIDC identity provider client (AUTH-SPEC §2, §12 #10).
 *
 * Provider-agnostic, defaulting to whatever speaks OIDC. `openid-client` v6 does
 * the protocol work — discovery, PKCE, and, critically, validation of the ID
 * Token (signature, issuer, audience, expiry, nonce). We do not re-implement any
 * of that validation, because hand-rolled token validation is where
 * authentication bugs live.
 *
 * Acceptance test #10 — "unparseable, expired, or wrong-audience token is
 * denied with no fallback" — is satisfied by construction: there is no code path
 * here that catches a validation failure and proceeds. Failures surface as
 * `idp_error` and are logged with the reason.
 */
import * as client from 'openid-client';
import { randomOpaqueToken } from './cookies.js';
import { AuthError } from './types.js';
import type { IdpProfile } from './types.js';

export interface IdpConfig {
  /** Issuer URL, e.g. `https://login.microsoftonline.com/<tenant>/v2.0`. */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** Defaults to `openid profile email`. */
  scopes?: string[];
  /**
   * Claim carrying directory group membership. Defaults to `groups` (Entra ID).
   * Some providers use `roles`, `cognito:groups`, or a namespaced claim.
   */
  groupClaim?: string;
  /**
   * Permit an `http://` issuer. For the local mock IdP in tests only — the
   * config loader must refuse to set this outside NODE_ENV=test, because in
   * production it would downgrade token transport security silently.
   */
  allowInsecure?: boolean;
}

/** The three values a caller must persist between redirect and callback. */
export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface IdentityProvider {
  /** Begin an authorization request. Persist the result in the signed state cookie. */
  beginAuthorization(): Promise<AuthorizationRequest>;
  /** Complete it, exchanging the callback URL and returning the verified profile. */
  exchangeCallback(currentUrl: URL, stored: AuthorizationRequest): Promise<IdpProfile>;
}

export class OidcIdentityProvider implements IdentityProvider {
  #configPromise: Promise<client.Configuration> | null = null;
  #scopes: string[];
  #groupClaim: string;

  constructor(
    private readonly cfg: IdpConfig,
    private readonly log: (...args: unknown[]) => void = (): void => undefined,
  ) {
    this.#scopes = cfg.scopes ?? ['openid', 'profile', 'email'];
    this.#groupClaim = cfg.groupClaim ?? 'groups';
  }

  /** Discovery is cached; the IdP's metadata is stable for the process lifetime. */
  #config(): Promise<client.Configuration> {
    // enableNonRepudiationChecks: the OIDC spec lets a client SKIP ID Token
    // signature validation when the token arrives over TLS directly from the
    // token endpoint (the channel vouches for the issuer). We don't take that
    // option. Validating against the IdP's JWKS is defense in depth, it makes
    // test (http) and production (https) behave identically, and a
    // signature-verified token is stronger evidence in the audit trail.
    const execute: ((config: client.Configuration) => void)[] = [
      client.enableNonRepudiationChecks,
    ];
    // The documented way to talk to a local http:// issuer. Deprecated by the
    // library precisely so it stands out; we gate it behind cfg.allowInsecure,
    // which the production config loader must refuse outside NODE_ENV=test.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (this.cfg.allowInsecure === true) execute.push(client.allowInsecureRequests);

    this.#configPromise ??= client
      .discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        // A string here is openid-client's shorthand for `{ client_secret }`.
        this.cfg.clientSecret,
        this.cfg.clientSecret ? client.ClientSecretBasic(this.cfg.clientSecret) : client.None(),
        { execute },
      )
      .catch((err: unknown) => {
        this.#configPromise = null; // don't cache a failed discovery
        throw this.#wrap('discovery failed', err);
      });
    return this.#configPromise;
  }

  async beginAuthorization(): Promise<AuthorizationRequest> {
    const config = await this.#config();
    const codeVerifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = randomOpaqueToken(16);
    const nonce = randomOpaqueToken(16);

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.cfg.redirectUri,
      scope: this.#scopes.join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    return { url: url.toString(), state, nonce, codeVerifier };
  }

  async exchangeCallback(currentUrl: URL, stored: AuthorizationRequest): Promise<IdpProfile> {
    const config = await this.#config();

    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: stored.codeVerifier,
        expectedState: stored.state,
        expectedNonce: stored.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw this.#wrap('authorization code exchange failed', err);
    }

    const claims = tokens.claims() as Record<string, unknown> | undefined;
    if (!claims) throw new AuthError('idp_error', 'token response carried no ID Token');
    return this.#profile(claims, tokens, config);
  }

  /**
   * Normalize provider-specific claims into the shape the rest of COLDPATH uses.
   * Subject and email are mandatory; a missing subject means we cannot tie the
   * identity to our directory, so we refuse rather than guess.
   */
  async #profile(
    claims: Record<string, unknown>,
    tokens: { access_token: string },
    config: client.Configuration,
  ): Promise<IdpProfile> {
    const subject = claim(claims, 'sub');
    if (!subject) throw new AuthError('idp_error', 'ID Token has no subject claim');

    let email = claim(claims, 'email') ?? claim(claims, 'preferred_username');
    let name = claim(claims, 'name') ?? claim(claims, 'given_name');

    // Some providers put almost nothing in the ID Token, so UserInfo is how the
    // profile gets filled in. It is called only when something is actually
    // missing, and it can only ADD — see the merge below.
    if (!email || !name) {
      try {
        const ui = (await client.fetchUserInfo(config, tokens.access_token, subject)) as Record<
          string,
          unknown
        >;
        email ??= claim(ui, 'email') ?? claim(ui, 'preferred_username');
        name ??= claim(ui, 'name');
        // ID TOKEN WINS. A plain UserInfo response is JSON over TLS — it is not
        // signed, and we deliberately validate the ID Token against the IdP's
        // JWKS rather than trusting the channel (enableNonRepudiationChecks
        // above). Merging the other way round threw that away: `Object.assign(
        // claims, ui)` let an unsigned response OVERWRITE signature-verified
        // claims, including the group claim that decides every role in the
        // system. UserInfo may only FILL GAPS, never override.
        //
        // The group claim is excluded from the merge entirely. It is the one
        // claim that grants authority, so it comes from the signed token or it
        // does not come at all — a user with no groups gets zero roles and is
        // refused, which is the correct failure direction.
        for (const [key, value] of Object.entries(ui)) {
          if (key === this.#groupClaim) continue;
          if (!(key in claims)) claims[key] = value;
        }
      } catch (err) {
        // UserInfo failing is not fatal if the ID Token already had what we need.
        this.log('userinfo fetch failed', err instanceof Error ? err.message : err);
      }
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError('idp_error', `ID Token carries no usable email (subject ${subject})`);
    }

    return {
      subject,
      email: email.toLowerCase(),
      name: name ?? null,
      groups: readGroups(claims[this.#groupClaim]),
      claims,
    };
  }

  #wrap(stage: string, err: unknown): AuthError {
    const detail = err instanceof Error ? err.message : String(err);
    // The library's own error code (e.g. `invalid_grant`) is what an operator
    // needs when an integration breaks, so it goes in the log and on `cause`.
    this.log(`oidc ${stage}: ${detail} (code=${errorCode(err)})`);
    const wrapped = new AuthError('idp_error', `oidc ${stage}: ${detail}`);
    wrapped.cause = err;
    return wrapped;
  }
}

/** Extract the protocol-level error code from any openid-client failure. */
function errorCode(err: unknown): string {
  if (
    err instanceof client.ResponseBodyError ||
    err instanceof client.AuthorizationResponseError
  ) {
    return err.error;
  }
  if (err instanceof client.ClientError) return err.code ?? 'client_error';
  if (err instanceof client.WWWAuthenticateChallengeError) return 'www_authenticate';
  return 'unknown';
}

export function readGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function claim(c: Record<string, unknown>, key: string): string | null {
  const v = c[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
