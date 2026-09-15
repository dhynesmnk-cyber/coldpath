import pino from 'pino';

/**
 * Structured logging — PRODUCT-PLAN.md §2.3 (observability) and the M0 list.
 *
 * pino was declared as a dependency and `LOG_LEVEL` was in the environment
 * contract, but nothing imported either: the one log site in the codebase
 * called `console.error`. That is a gap rather than a style preference — an
 * operator who sets LOG_LEVEL expects it to do something, and a line that is
 * not JSON does not survive a log aggregator intact.
 *
 * Deliberately a single shared instance rather than per-module children: there
 * is no request context to bind until the HTTP adapter lands at M2. When it
 * does, that adapter should create a child logger per request carrying the
 * tenant and session id, so every line is attributable without the call sites
 * changing.
 *
 * NEVER log a session token, a refresh token, or a T3 field. The redaction list
 * below is a backstop for accidental object spreads, not permission to pass
 * secrets in. Audit entries are the record of who read what — see
 * services/audit.ts — and they go to the database, not to stdout.
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Tests assert on behaviour, not on log output; keeping them quiet also keeps
  // the acceptance suite readable when a check deliberately triggers a failure.
  enabled: process.env.NODE_ENV !== 'test',
  redact: {
    paths: [
      'token', 'sessionToken', 'refreshToken', 'tokenHash', 'refreshHash',
      'password', 'clientSecret', 'authorization',
      'email', 'phone',
      '*.token', '*.sessionToken', '*.refreshToken', '*.password', '*.clientSecret',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof log;
