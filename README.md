# COLDPATH

**Account intelligence engine for the cold chain.**

COLDPATH turns public regulatory data into a researched, gated, attributable prospect list. Any US facility holding more than 10,000 lb of anhydrous ammonia must file a Risk Management Plan with the EPA, and those filings are public — which makes the registry a near-complete map of the cold-chain market. The current pull resolves **1,382 facilities into 124 accounts across 771 sites in 43 states**.

The hard part is not fetching the data. It is deciding what may be trusted, what must be reviewed by a person, and what must never reach outbound — and proving those decisions in code rather than describing them in a document.

---

## Where to start

| If you want to… | Read |
|---|---|
| Run the code, see the tests pass | **[`app/README.md`](app/README.md)** — the operational guide |
| Understand the architecture and milestones | [`PRODUCT-PLAN.md`](PRODUCT-PLAN.md) |
| Understand the data rules | [`phase1/INGESTION-GATES.md`](phase1/INGESTION-GATES.md) — 49 gates across 5 ingestion paths |
| Understand authentication, roles and data tiers | [`phase1/AUTH-SPEC.md`](phase1/AUTH-SPEC.md) |
| Deploy it | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| See the concept working, with no install | [`archive/index.html`](archive/index.html) — open in any browser |

## Status

**M0 and M1 complete.** Foundations, schema, tenancy and Row-Level Security; then the identity layer — OIDC client, session management, RBAC middleware, identity lifecycle, and the AUTH-SPEC §12 acceptance suite.

Verified at this commit:

```
typecheck   clean (strict, noUncheckedIndexedAccess)
lint        clean (incl. layer-boundary rules)
tests       124 passing
integration 43/43 checks, run on PGlite AND on real Postgres 16
```

Reproduce with `cd app && npm ci && npm run verify && npm test`.

**Not built yet:** HTTP server, UI, LLM calls. Those are M2, M4 and M6. The identity layer is deliberately framework-agnostic so the Phase-2 HTTP adapter owns no decision logic — see `app/README.md`, "What is deliberately not here yet".

**Blocked on Ndustrial:** an IdP choice and OIDC client registration (AUTH-SPEC §13), then live sign-on.

## The engineering decisions worth knowing

Four choices shape everything else. Each exists because a test or a measured failure forced the question — the reasoning is in the linked docs, not just the code.

1. **Tenancy isolation depends on the database role, not on the query.** RLS is enabled *and forced* on all 21 tenant-scoped tables, and the app connects as a non-superuser that owns no tables. `FORCE ROW LEVEL SECURITY` does not apply to superusers, so pointing the app at the wrong role would disable isolation with no error and no failing query. There is a negative-control test asserting a superuser *does* see everything — if it ever fails, every isolation assertion above it is meaningless. (`app/src/db/rls.ts`)

2. **Entity resolution stays in application code.** It is the highest-risk logic in the system: it is what stops an existing customer being emailed, and what stops a real prospect being silently suppressed. `pg_trgm` is unavailable in PGlite and varies across managed Postgres, so matching lives in TypeScript and behaves identically in dev, test and production. (`app/src/lib/resolve/`)

3. **Refusals fail closed, everywhere.** No roles means no access, not viewer-by-default. An unregistered route is a 403, not a 404. A denial is never a redirect. Omitted fields are absent from the payload, not masked or nulled.

4. **Multi-tenancy is built in, not retrofitted.** Single-tenant deployment today, but `tenant_id` on every table from day one. Adding a tenant is a row and an environment variable. This costs ~6% now and is effectively impossible to add later.

## Layout

```
app/          production codebase — TypeScript, Drizzle, Postgres
phase1/       specifications, the Python reference connector, source data
archive/      the browser prototype and pitch material
DEPLOYMENT.md operational runbook
```

`app/` is the product. `phase1/` is the specification it is built against, and holds the Python implementation the TypeScript connector is parity-tested against — both are maintained together, and a divergence fails the build.

## Data and licence

`app/tests/fixtures/rmp-facilities.json` is a live EPA Risk Management Program pull — 1,382 facilities across nine cold-chain NAICS codes, retrieved 13 September 2026.

**Licence: CC BY-SA 4.0.** Source: U.S. EPA Risk Management Program, obtained under FOIA by the Data Liberation Project. Redistribution must remain CC BY-SA compatible. EPA states the data is self-reported and "may contain errors or omissions" — which is exactly why the numeric validation gate exists, and why one facility declaring 89 million pounds of ammonia is a regression test rather than a line in the prospect list.
