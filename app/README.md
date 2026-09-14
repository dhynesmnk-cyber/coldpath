# COLDPATH — account intelligence engine

Production codebase. See `../PRODUCT-PLAN.md` for architecture and milestones; this file is how to run it.

**Status: M1 core complete.** Foundations, schema, tenancy and RLS (M0), plus the identity layer: OIDC client, session management, RBAC middleware, identity lifecycle and the AUTH-SPEC §12 acceptance suite. What M1 still needs from Ndustrial: an IdP choice and OIDC client registration (§13 of AUTH-SPEC), then live sign-on against it.

Verification at this commit: typecheck clean, lint clean, 69 vitest tests (unit + a 20-test OIDC protocol suite against a local mock IdP + 21 connector-parity), and 41/41 plain-node integration checks (19 RLS + 22 acceptance).

---

## Quick start

```bash
npm ci
npm run verify          # typecheck + lint + build + integration verifier
npm test                # full suite (needs ~2 GB — see "Memory" below)
```

Requires Node 20.11+. No database server needed for local development — tests run against PGlite, an in-process WASM Postgres 18.3.

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit`, strict + `noUncheckedIndexedAccess` |
| `npm run lint` | ESLint with the layer-boundary rules from PRODUCT-PLAN.md §2.2 |
| `npm test` | Full vitest suite |
| `npm run test:lowmem` | Same suite, serialised in one process (for <2 GB machines) |
| `npm run build` | Compile to `dist/` and copy `.sql` migrations |
| `npm run verify:integration` | Build, then run the RLS + AUTH-SPEC §12 acceptance suite against real Postgres via PGlite |
| `npm run db:generate` | Generate a migration from schema changes |

## Memory

Each integration test loads a WASM Postgres (~300 MB). Vitest's default is one isolated fork per file, so a full run needs roughly 2 GB.

On a constrained machine use `npm run test:lowmem`, which sets `COLDPATH_LOW_MEMORY=1` to serialise files into a single process. That mode is an escape hatch, not the design: files then share a process, so a test that leaked global state could affect another. Every integration file builds and closes its own PGlite instance, so this holds today.

Below roughly 1.5 GB even low-memory vitest gets OOM-killed on the DB-backed files (observed: exit 137 in a 1 GB cgroup — vitest's runtime plus a WASM Postgres does not fit). There, the sanctioned path is `npm run build && npm run verify:integration`: the plain-node verifier runs the identical RLS and acceptance assertions against one PGlite instance in ~5 seconds, plus the non-DB suites (`vitest run tests/unit tests/integration/oidc.test.ts tests/integration/connector-parity.test.ts`) which need no database at all. This is why the acceptance assertions live in `auth.checks.ts` with `node:assert` instead of inside the vitest file: same proofs, two runners, no drift.

`tests/integration/rls.test.ts` (vitest) and `scripts/verify-integration.ts` (plain node) run **the same assertions** from `tests/integration/rls.checks.ts`, written with `node:assert` so they are framework-independent and cannot drift.

---

## The two things worth knowing before you change anything

### 1. Tenancy isolation depends on the database role, not on the query

Row-Level Security is enabled and forced on all 21 tenant-scoped tables. **`FORCE` does not apply to superusers.** PGlite connects as `postgres`, which has `BYPASSRLS`, so a query issued outside `withTenant()` sees every tenant's rows.

This is verified, not theoretical — `tests/integration/rls.checks.ts` contains a **negative control** that asserts the superuser *does* see everything. If that assertion ever fails, the role wiring has regressed and every isolation assertion above it is meaningless.

Consequences:
- The application connects as `coldpath_app`: non-superuser, `NOBYPASSRLS`, and **not** the owner of any table.
- Migrations run as `coldpath_migrator`, a separate privileged role. `scripts/migrate-prod.ts` refuses to complete if `coldpath_app` is a superuser or has `BYPASSRLS`.
- Every request goes through `withTenant()`, which does `SET LOCAL ROLE` and `set_config('app.tenant_id', …, true)` inside a transaction.

Pointing the app at the owner role disables tenancy isolation with no error, no warning and no failing query.

### 2. Entity resolution stays in application code

`pg_trgm` is unavailable in PGlite and extension support varies across managed Postgres offerings. Because fuzzy name matching is the highest-risk logic in the system — it is what stops an 88-site existing customer being queued for outbound — it must behave identically in dev, test and production.

So canonical rules, token normalisation, distinctive-token matching and typo tolerance all live in TypeScript under `src/lib/resolve/`, fully unit-tested. `pg_trgm` may be used later as an optional candidate pre-filter; the decision path never depends on it.

---

## Layout

```
src/
  db/
    schema/        22 tables across 6 domain modules, every one tenant-scoped
    migrations/    generated SQL. The security layer is deliberately NOT generated —
                   drizzle-kit cannot model roles or RLS, so keeping them separate
                   means regenerating a migration can never silently drop isolation.
    rls.ts         role + policy SQL, derived from the schema (not a hand-kept list)
    client.ts      withTenant() — the only sanctioned way to touch tenant data
    migrate.ts     applies migrations then security, and verifies RLS is actually on
  lib/
    resolve/       entity resolution: normalise, distinctive-token match, canonical rules
    validation/    numeric outlier gate
    csv.ts         RFC-4180 reader (quoted fields, embedded commas and newlines)
  connectors/
    epa-rmp/       ported from phase1/connectors/epa_rmp.py, parity-tested
scripts/
  migrate-prod.ts        production migration entrypoint (privileged role)
  verify-integration.ts  runs the RLS assertions without a test framework
tests/
  unit/                  28 tests — resolution, matching, rounding, outlier gate
  integration/
    harness.ts           builds a migrated two-tenant PGlite instance
    rls.checks.ts        19 runner-agnostic assertions incl. the negative control
    rls.test.ts          vitest wrapper
    connector-parity.test.ts   21 tests diffing the TS port against the Python CSV
  fixtures/
    rmp-facilities.json          1,382 real facilities from the live EPA pull
    coldchain_rmp_accounts.csv   the Python reference output
```

## Fixtures are real data

`tests/fixtures/rmp-facilities.json` is the live EPA Risk Management Program pull — 1,382 facilities across nine cold-chain NAICS codes, retrieved 13 September 2026.

**Licence: CC BY-SA 4.0.** Source: U.S. EPA Risk Management Program, obtained under FOIA by the Data Liberation Project. Redistribution must remain CC BY-SA compatible, and EPA states the data is self-reported and "may contain errors or omissions" — which is precisely why the numeric validation gate exists.

The reference CSVs are the output of `../phase1/connectors/epa_rmp.py`. **If you change resolution logic, change both implementations and regenerate the reference.** The parity test exists so a divergence is caught immediately rather than discovered in production as a missing prospect or an emailed customer.

Regenerate with:

```bash
python3 ../phase1/connectors/regen_reference.py
```

That runs the Python reference against the **committed fixture**, not the live EPA API, so the only delta in the output is your logic delta. Running `epa_rmp.py` directly re-pulls from EPA and mixes upstream drift into the same diff — do that only when a fresh pull is what you actually want.

Note what the parity test does and does not prove. It pins the TypeScript port to the committed CSVs; it does not re-run the Python. So the Python can drift from its own committed output without the test noticing — which had already happened once, and is why the regeneration path above exists and is verified to reproduce the reference byte-for-byte.

## What is deliberately not here yet

No HTTP server, no LLM calls, no UI. The identity layer exists as framework-agnostic primitives — `authorizeRequest()` consumes a plain request object and throws `AuthError` with a status, so the Phase-2 adapter (Express/Hono/Fastify) maps refusals to responses without owning any decision logic. Those are M2, M4 and M6. The layer boundaries in `eslint.config.js` are already enforced so the code written from here has nowhere to put domain logic except a service.

### Identity (M1) — what each piece is

| File | Role |
|---|---|
| `src/lib/auth/oidc.ts` | Provider-agnostic OIDC client on `openid-client` v6. Signature validation is ON (`enableNonRepudiationChecks`) rather than relying on TLS alone. |
| `src/lib/auth/session.ts` | Hashed opaque tokens, rotating single-use refresh with family revocation on replay. |
| `src/lib/auth/middleware.ts` | authenticate → CSRF → route → authorize → tenant. Unknown routes are refused, not 404'd. |
| `src/lib/auth/permissions.ts` | The AUTH-SPEC §6 matrix as data, so it is exhaustively testable. |
| `src/lib/auth/tiers.ts` | T0–T4 field serializer. Fields are omitted, never masked or nulled. |
| `src/services/identity.ts` | Provisioning, group→role sync, offboarding, orphaned-account queue. |
| `src/services/capture.ts` | Attribution: `captured_by` comes from the session and cannot be supplied by a caller. |

Two decisions worth knowing about, both made because a test forced the question:

- **`signIn` runs as two committed transactions.** A refused login (zero roles) still commits the group sync. One transaction would roll the revocation back, and removing a user from the IdP group would then not remove their role — acceptance #7 failing silently.
- **Denials are audited outside the refusing transaction.** Inside it, the rollback that makes the refusal correct also deletes the record of it.

## Acceptance tests (AUTH-SPEC §12)

`tests/integration/auth.checks.ts` holds the assertions using `node:assert`, so the identical checks run two ways: `tests/integration/auth.test.ts` under vitest, and `scripts/verify-integration.ts` under plain node for environments too small to host both. Item #10 (bad tokens denied with no fallback) is `tests/integration/oidc.test.ts`, which drives a protocol-honest mock IdP in `tests/integration/mock-idp.ts` — real discovery, PKCE S256, `client_secret_basic`, RS256 tokens validated against a published JWKS.

Twelve of the thirteen items pass now. The honest remainder: #1 and #13 each have a UI half ("modified router state", "visible on the Command dashboard") that cannot be exercised until the front end exists. The server half of both is proven — a refusal is a 403, never a redirect or an empty payload, and the unassigned queue is computed correctly. Those halves are re-tested at M2.
