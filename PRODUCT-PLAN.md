# COLDPATH — Product Build Plan

**From prototype to a stable, functional product.** Not a pilot spec — this is the complete system.

## Decisions locked by your answers

| # | Question | Decision | Architectural consequence |
|---|---|---|---|
| 1 | Internal tool or product? | **Internal now, product later** | Single-tenant deployment, but `tenant_id` on every table and **Postgres Row-Level Security** from day 1 (§4.2). Costs ~6% extra now; makes multi-tenancy a configuration change rather than a rewrite. |
| 2 | Who builds it? | **I build it here** | A real, runnable repository — not documents. See §9 for exactly what can and cannot be verified in this environment. |
| 3 | Where does it run? | **Cloud-agnostic, Docker primary, managed path available** | Container-first, no vendor-specific services in core code. Postgres is the only stateful dependency. Deployment stays a late decision. |
| 4 | CRM? | **HubSpot, CSV only — no connection until Phase 2 (if then)** | CSV is a first-class connector, not a stopgap. Field mapping is HubSpot-shaped so a future connector drops in without remapping. Adapter interface either way. |
| 5 | Model provider? | **Provider-agnostic, default Anthropic Claude** | One `LLMProvider` interface, provider chosen by environment config. Structured output enforced by Zod schemas at the boundary, not by prompt pleading. |

---

## 1. What "done" means

The prototype proves the concept. The product has to survive contact with a working day. Concretely, **done** is:

1. A marketer can import a CRM export, run research on an account, edit the output, and publish it — with every step persisted, attributable and recoverable after a refresh.
2. A rep can open the library on a phone, find an account, read a brief, copy an email body, and rate it — without seeing anything they shouldn't.
3. Every one of the 49 ingestion gates is enforced in code with a test, not described in a document.
4. Nothing is lost. Connector failures degrade visibly. Bad data is quarantined, never dropped.
5. A second tenant could be added by inserting a row and setting an environment variable — no code change, no migration.
6. It can be deployed from a single `docker compose up`, and the same image runs on AWS, Azure, GCP or a managed platform.
7. The test suite passes in CI on every commit, including integration tests against a real Postgres engine.

Item 5 is the one that distinguishes this from a well-built internal tool. It is cheap to get right at the start and effectively impossible to retrofit.

---

## 2. Architecture

### 2.1 Shape

A **Next.js 16 monolith with an enforced service layer**. One deployable, one language, but a hard boundary between HTTP and domain logic.

```
┌─────────────────────────────────────────────────────────────┐
│  Next.js App Router                                         │
│  ┌───────────────┐  ┌───────────────┐  ┌────────────────┐   │
│  │ (marketing)   │  │ (rep)         │  │  api/ routes   │   │
│  │ 14 screens    │  │ library only  │  │  thin, no logic│   │
│  └───────┬───────┘  └───────┬───────┘  └───────┬────────┘   │
└──────────┼──────────────────┼──────────────────┼────────────┘
           │        all three call only ↓        │
┌──────────▼──────────────────▼──────────────────▼────────────┐
│  SERVICES  (src/services) — domain logic, no HTTP, no SQL   │
│  account · signal · pain · person · deliverable · review    │
│  cost · capture · document                                  │
└──────────┬──────────────────────────────────────────────────┘
           │
   ┌───────┴────────┬───────────────┬────────────────┐
   ▼                ▼               ▼                ▼
┌────────┐   ┌────────────┐   ┌──────────┐   ┌─────────────┐
│ PIPELINE│  │ CONNECTORS │   │   LLM    │   │     DB      │
│ 7 stages│  │ 7 sources  │   │ provider │   │ Drizzle +   │
│ + gates │  │ + framework│   │agnostic  │   │ RLS tenancy │
└────────┘   └────────────┘   └──────────┘   └─────────────┘
        ▲              ▲
        └──────┬───────┘
        ┌──────▼──────┐
        │  pg-boss    │  Postgres-backed job queue.
        │  workers    │  No Redis, no second service.
        └─────────────┘
```

**Why a monolith and not a separate API.** Two services means two deploys, two logs, network latency between every call, and a contract to maintain — for a team of one marketer and six reps. The service-layer boundary gives the *option* to extract later without paying for it now. The rule that makes it real: **route handlers contain no domain logic and no SQL.** Enforced by lint, not convention.

**Why pg-boss and not BullMQ.** BullMQ needs Redis. Redis is a second stateful service to provision, secure, back up and pay for, and it breaks the "Postgres is the only stateful dependency" property that makes container deployment trivial. pg-boss runs inside the same database. At this volume the throughput difference is irrelevant.

### 2.2 The boundary that matters

```
route handler  →  validates input (Zod), calls a service, serialises output
service        →  domain logic, calls repositories and the LLM, knows nothing about HTTP
repository     →  SQL via Drizzle, knows nothing about domain rules
connector      →  fetches and normalises external data, knows nothing about the domain
gate           →  pure function: (record, context) → pass | warn | refuse(reason)
```

Gates are pure functions. That is what makes all 49 of them unit-testable without a database, a network or a model — and it is why the acceptance tests in `INGESTION-GATES.md` §9 can be automated rather than manual.

---

## 3. Stack

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Runtime | **Node 20 LTS** | Already here; matches Next 16 support floor. |
| Framework | **Next.js 16, App Router, TypeScript** | One deployable for UI and API. The prototype's front end ports directly. |
| Language | **TypeScript, `strict: true`** | Non-negotiable for a system whose job is not to invent facts. `noUncheckedIndexedAccess` on. |
| ORM | **Drizzle** | Real SQL, real migrations, full type inference. Prisma's engine is a binary that complicates container builds; Kysely lacks migrations. Drizzle also runs unmodified on PGlite, which is what makes §9 possible. |
| Database | **Postgres 16+** (18.3 in local test) | RLS for tenancy, `jsonb` for raw payloads, full-text search, and it is the only stateful dependency. **Two roles:** a privileged one for migrations and a non-superuser one for the application — see §4.2. |
| Local/test DB | **PGlite** | In-process WASM Postgres. Integration tests run against a real engine with no server — verified working here, including `jsonb`. |
| Jobs | **pg-boss** | Postgres-backed. No Redis. |
| Validation | **Zod** | One schema per boundary: HTTP input, connector output, and **every LLM structured response**. |
| Auth | **openid-client** + own session | Standard OIDC against any IdP. No vendor lock to Auth0/Clerk, which matters for "product later." |
| LLM | **Provider interface**; `@anthropic-ai/sdk`, `openai`, `@azure/azure-openai` behind it | Default Claude. Tenant can override by config. |
| Tests | **Vitest** + PGlite + MSW | Unit, integration (real SQL), and connector tests against recorded HTTP fixtures. |
| Containers | **Dockerfile + compose**, multi-stage, distroless runtime | Cloud-agnostic per decision #3. |
| CI | **GitHub Actions** | typecheck → lint → unit → integration → build. Portable to any CI. |
| Observability | **pino** structured logs + OpenTelemetry hooks | OTel exported but not required; a tenant can point it at their own collector. |

**Deliberately absent:** Redis, Kafka, a vector database, Kubernetes manifests (compose first, Helm when a tenant asks), a design system, and microservices.

### 3.1 Entity resolution stays in application code

PGlite has no `pg_trgm`, and extension availability varies across managed Postgres offerings. Since fuzzy name matching is the single highest-risk component in the system — it is what stops an 88-site customer being queued for outbound — it must behave **identically** in dev, test and production.

So: canonical rules, token normalisation, distinctive-token matching and typo tolerance all live in TypeScript, fully unit-tested. `pg_trgm` is used **only** as an optional pre-filter to narrow candidates at scale, and the code path is identical whether or not it is present.

This is a portability decision disguised as a performance one, and it is why the VersaCold regression test can run in CI.

---

## 4. Data model

### 4.1 Tenancy

Every table carries `tenant_id uuid not null`. No exceptions, including lookup tables.

### 4.2 Row-Level Security — the seam that makes "product later" cheap

```sql
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account FORCE ROW LEVEL SECURITY;   -- applies to the table owner too

CREATE POLICY tenant_isolation ON account
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

Every request runs inside a transaction that first executes `SET LOCAL app.tenant_id = $1`. Two consequences worth stating plainly:

- **A cross-tenant query is not a bug you might write — it is a query that returns nothing.** Forgetting a `WHERE tenant_id = ?` clause degrades to empty results rather than to another company's customer list.
- **`FORCE`** means the policy applies to the table *owner* too, so an admin script run as the owner cannot leak either.

This is the difference between "we designed for multi-tenancy" and "we can prove it."

#### The superuser trap — verified, and it is easy to fall into

`FORCE ROW LEVEL SECURITY` does **not** apply to superusers. Superusers carry `BYPASSRLS` and no table-level setting overrides it. This was tested directly rather than assumed:

| Connection role | `BYPASSRLS` | Rows visible with `app.tenant_id` set to tenant A |
|---|---|---|
| `postgres` (PGlite default, superuser) | **true** | **2 — both tenants. Isolation silently absent.** |
| `app_user` (non-superuser) | false | **1 — correct.** |
| `app_user` via `SET LOCAL ROLE` inside a transaction | false | **1 — correct.** Switching the setting mid-transaction switches the visible rows. |

Two hard requirements follow, and both are deployment facts rather than code:

1. **The application must connect as a non-superuser role that does not own the tables.** Pointing the app at the owner or at `postgres` disables RLS with no error, no warning and no failing query. This is the single easiest way to ship a multi-tenant product that is not actually multi-tenant.
2. **The test harness must assert isolation while connected as that role.** A suite that runs as superuser will report RLS as broken, and the predictable wrong response is to delete the policy. M0 step 3 exists specifically to prevent that.

Migrations run as a privileged role; the application does not. Two database users, one of them used only by the migration tool.

### 4.3 Core tables

Extends `PHASE-1-SPEC.md` §5 with `tenant_id`, RLS, and the auth tables from `AUTH-SPEC.md` §5.

```
tenant            id, name, slug, config jsonb, created_at
app_user          id, tenant_id, idp_subject, email, display_name, is_active, ...
role_grant        id, tenant_id, user_id, role, scope, granted_by, expires_at
session           id, tenant_id, user_id, expires_at, revoked_at, idp_session_id

account           id, tenant_id, canonical_name, vertical, hq, website, ticker,
                  is_customer, owner_id, priority, status, icp_score,
                  research_state jsonb, researched_at, refresh_due_at
account_alias     id, tenant_id, account_id, reported_name, source, confidence, resolved_by
site              id, tenant_id, account_id, name, city, state, rto, naics,
                  ammonia_lb, validated bool, validation_note, raw jsonb, rmp_id

source            id, tenant_id, account_id, kind, title, url, publisher,
                  published_on, retrieved_at, confidence, licence, raw jsonb
fact              id, tenant_id, account_id, subject, predicate, value, as_of,
                  source_id, confidence, citation_range int4range   -- enables F3
signal            id, tenant_id, account_id, site_id, type, occurred_on, title,
                  detail, impact, why_it_matters, detected_at
pain              id, tenant_id, account_id, pillar, title, evidence, angle,
                  severity, is_weak_fit, supporting_fact_ids uuid[]
person            id, tenant_id, account_id, name, title, role_in_deal, confidence,
                  is_gap, gap_reason, resolution_path, angle, provenance, as_of

deliverable       id, tenant_id, account_id, type, version, status, body jsonb,
                  rendered text, min_confidence, blocked_reason,
                  author_id, approved_by, published_at, supersedes_id
deliverable_fact  deliverable_id, fact_id            -- the dependency graph (K6)
correction        id, tenant_id, deliverable_id, fact_id, person_id, raised_by,
                  kind, note, resolved
capture           id, tenant_id, account_id, person_id, captured_by, captured_at,
                  source_url, source_kind, capture_method, raw_text, extracted jsonb,
                  confidence, corroborated_by, expires_at
document          id, tenant_id, account_id, filename, mime, bytes, extracted_text,
                  classification, classification_margin, author, doc_date,
                  age_days, confidence_cap, indexed_for_suppression bool

review_item       id, tenant_id, gate, path, severity, title, detail,
                  resource_type, resource_id, resolved_by, resolved_at, resolution
cost_event        id, tenant_id, at, operation, account_id, units, unit_cost,
                  tokens_in, tokens_out, provider, cost, note
audit_log         id, tenant_id, at, user_id, action, resource_type, resource_id,
                  outcome, reason, ip, user_agent, meta jsonb     -- append-only
pii_grant         id, tenant_id, user_id, person_id, field, consent_basis,
                  granted_by, expires_at
read_receipt      id, tenant_id, deliverable_id, user_id, at      -- E7, marketing-only view
```

**Three design notes:**

- `fact.citation_range` is what makes **F3** (hover a claim, see its source) possible. Without it, provenance is document-level and traceability is a claim rather than a feature. Adding it later means re-generating every deliverable, so it goes in now.
- `deliverable_fact` is the join that makes **D2** (version diff) and **K6** (signal→deliverable dependency) cheap. When a fact changes, one query answers "which artefacts are now stale?"
- `audit_log` has no update or delete path, enforced by database grants. An audit trail the application can edit is not an audit trail.

---

## 5. The LLM layer

```ts
interface LLMProvider {
  readonly id: 'anthropic' | 'openai' | 'azure-openai';
  complete<T>(req: {
    schema: ZodSchema<T>;        // structured output, validated on return
    system: string;
    messages: Message[];
    maxTokens: number;
    temperature: number;
  }): Promise<{ data: T; usage: Usage; raw: string }>;
}
```

**Four rules, all enforced in code:**

1. **No free-text generation for facts.** Every pipeline stage returns a Zod-validated structure. A response that fails validation is retried once, then recorded as a gate refusal — never coerced.
2. **Grounding is checked, not assumed.** Each generated claim carries `source_id` values that must exist in the `source` table for that account. A claim citing a nonexistent source is dropped and logged. This is what makes "the model cannot invent a fact" an enforced property rather than a prompt instruction.
3. **Usage is metered at the boundary.** Every call writes a `cost_event` row with tokens and cost. The Usage & Cost screen reads real data, not estimates.
4. **Provider is configuration.** `LLM_PROVIDER=anthropic|openai|azure-openai` plus the matching key. A future tenant brings their own.

Model choice per stage is also configuration — cheap models for classification, the strongest available for pain mapping and deliverable synthesis. That is a cost lever worth several hundred dollars a month at scale.

---

## 6. Ingestion framework

```ts
interface Connector<Raw, Norm> {
  readonly id: string;
  readonly kind: 'registry' | 'filings' | 'web' | 'news' | 'crm' | 'enrichment' | 'document';
  readonly licence: Licence | null;          // non-nullable in the source row
  provenance(): Provenance;
  fetch(params: FetchParams): AsyncIterable<Raw>;
  normalise(raw: Raw): Norm | NormError;     // pure, unit-testable
}
```

Seven connectors: **epa-rmp** (ported from the working Python implementation, including the validation gate), **sec-edgar**, **company-web**, **news**, **hubspot-csv**, **salesintel** (interface + CSV/mock implementation until a contract exists), **document-upload**.

Every connector retains the raw payload. Schema drift becomes a re-parse, not a re-fetch. Licence metadata is non-nullable — the CC BY-SA attribution duty on RMP data is enforced by the type system, not by remembering.

**The 49 gates** from `INGESTION-GATES.md` are implemented as pure functions in `src/lib/gates/`, one module per path (`universal.ts`, `crm.ts`, `reports.ts`, `capture.ts`, `salesintel.ts`), each returning `{status, reason, evidence}`. Refusals write `review_item` rows. The 19 acceptance tests in that document — plus the 13 in `AUTH-SPEC.md` §12, 32 in total — become the automated integration suite.

---

## 7. Milestones

Sequenced by dependency, not by calendar. Each milestone ends with something demonstrable and a test suite that passes.

| M | Milestone | Delivers | Depends on |
|---|---|---|---|
| **M0** | **Foundations** | Monorepo, TypeScript strict, ESLint boundary rules, Vitest + PGlite harness, Drizzle schema and migrations, RLS policies, Dockerfile + compose, CI, pino logging, env config | — |
| **M1** | **Identity** | OIDC login (any provider), session cookies, RBAC middleware, `tenant_id` propagation, `SET LOCAL` on every request, audit log, sign-out, offboarding | M0 |
| **M2** | **Data & ingestion** | Connector framework, EPA RMP connector (ported), HubSpot CSV connector, document upload, raw-payload retention, provenance, licence capture | M0 |
| **M3** | **Gates & resolution** | All 49 gates as pure functions, entity resolution (rules → fuzzy → human queue), numeric validation, customer suppression, the unified review queue and its UI | M2 |
| **M4** | **Research pipeline** | LLM provider layer, all 7 stages, grounding checks, confidence scoring, signal detection with commercial translation, pain mapping, decision unit with explicit gaps | M1, M3 |
| **M5** | **Deliverables & review** | Generation under confidence floors, blocking with reasons, versioning, **inline editing (D1)**, **version diff (D2)**, side-by-side verification (D3), publish state machine | M4 |
| **M6** | **Surfaces** | Port all 14 prototype screens to React, responsive across breakpoints, command palette, URL state, the Rep Library as its own route group with role gating | M5 |
| **M7** | **Operations** | pg-boss workers, nightly connector runs, staleness engine, cost metering wired to real usage, exports (PDF/DOCX/ICS), notifications | M4–M6 |
| **M8** | **Hardening** | Full accessibility pass, virtualised tables, load testing, security review, backup/restore, observability dashboards, runbook | M7 |
| **M9** | **Ship** | Deployment to the chosen target, seed with the real RMP dataset, migrate the prototype's three researched accounts, handover | M8 |

**The prototype is not thrown away.** Its 424 KB of working UI becomes the visual reference and its baked data becomes the M9 seed fixtures. The three fully-researched accounts (Kroger, Tyson, NewCold) and the 18 written deliverables are the acceptance corpus — the product must reproduce output of at least that quality.

---

## 8. Migration from prototype

| Prototype artefact | Becomes |
|---|---|
| 424 KB single-file UI, 14 screens | React components under `src/app/`, same design tokens as CSS custom properties |
| `REG` (124 accounts, 264 aliases) | Seed migration + the `account`/`account_alias` tables |
| `RMP` stats blob | Deleted — computed from real tables |
| `ACCOUNTS`, `DELIV`, `ROI` baked data | Test fixtures and the M9 acceptance corpus |
| `connectors/epa_rmp.py` | Ported to TypeScript, same three-pass resolution and validation gate, same output |
| Client-side PIN gate | Replaced by M1 OIDC. **Deleted, not adapted.** |
| Client-side CSV parsing | Kept for instant preview; the authoritative parse moves server-side |
| `INGESTION-GATES.md` 19 acceptance tests | The integration suite |
| `phase1/data/*.csv` | Seed data, with attribution preserved |

---

## 9. What I can and cannot verify here

Stated plainly, because a plan that implies full verification is a plan that will disappoint.

**Can verify in this workspace:**

- TypeScript compiles under `strict` with `noUncheckedIndexedAccess`
- The full unit suite — gates, entity resolution, confidence, pipeline logic
- **Integration tests against real Postgres 18.3** via PGlite — verified working: DDL, DML, `jsonb` (`jsonb_build_object`), sequences, `CREATE ROLE`, `SET ROLE`, `SET LOCAL` inside transactions, and **Row-Level Security isolation** when connected as a non-superuser role (see §4.2).
- The Next.js production build (`next build`) succeeds
- Connector logic against recorded HTTP fixtures
- LLM structured-output validation against mocked provider responses
- Front-end rendering, and the existing 163-check behavioural harness as a parity reference

**Cannot verify here:**

| Gap | Why | Mitigation |
|---|---|---|
| Live OIDC against a real IdP | No IdP, no client registration | **Mitigation now built:** a 16-test protocol suite (`tests/integration/oidc.test.ts`) drives the real `openid-client` against a local mock issuer — discovery, PKCE, RS256+JWKS validation, and every §12 #10 denial case. Remaining gap is only the live client registration, at M1 handover. |
| Live Anthropic/OpenAI calls | No API key | Provider contract tests with recorded fixtures; schema validation tested exhaustively against malformed responses |
| `docker build` / `compose up` | No Docker daemon | Dockerfile written to spec and linted with `hadolint`-style review; first real build is on your machine |
| Real Postgres extensions | **`pg_trgm` is unavailable in PGlite** — verified by attempting `CREATE EXTENSION` | Resolution logic is extension-independent by design (§3.1). A CI job against real Postgres should be added before M3 is signed off. |
| Superuser-only behaviour | PGlite connects as `postgres`, which bypasses RLS | The harness creates `app_user` and runs all isolation assertions as it (§4.2). Verified that this reproduces production semantics exactly. |
| HubSpot / SalesIntel APIs | No credentials, no contract | CSV connector is the real implementation; API connectors are interfaces with mock adapters |
| Load and soak testing | No infrastructure | Benchmark harness written and run against PGlite for correctness; real numbers need real hardware |
| Deployment | No target | Runbook written; first deploy is supervised |

**The honest summary:** I can build and test everything except the four things that require credentials or infrastructure you have and I don't. Each is isolated behind an interface precisely so that verifying it later does not require redesigning anything.

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **RLS is silently disabled by connecting as the wrong role** | Verified failure mode, not hypothetical (§4.2). Two controls: the app role is non-superuser and does not own the tables, and CI includes a **negative control** asserting that the same query *does* leak when run as superuser. If that assertion ever passes unexpectedly, the role wiring has regressed. |
| 1b | **RLS adds latency to every query** | Measured in M0. `SET LOCAL` inside an existing transaction is microseconds; if it isn't, fall back to repository-enforced `tenant_id` with a lint rule and an integration test per table. Decide with data, not opinion. |
| 2 | **LLM grounding checks reject too much and the pipeline produces gaps everywhere** | The grounding threshold is configuration, not code. Start permissive, tighten against the acceptance corpus (the three researched accounts) until output quality matches. Measure rejection rate per stage. |
| 3 | **Porting the Python connector to TypeScript introduces subtle resolution differences** | The Python implementation is the reference. Port it, then run both against the same 1,382-facility input and diff the output. **The VersaCold case is a named regression test** — the port is not done until it passes. |
| 4 | **Next.js 16 and TypeScript 7 are both recent** | Pin exact versions. TypeScript 7 is the native compiler and is new; pin 5.x unless 7 proves stable in M0. Revisit deliberately, never implicitly. |
| 5 | **Scope: this is a large build** | Milestones are independently demonstrable. M0–M3 alone produce something more capable than the prototype. There is no point at which the work is worthless because it is unfinished. |
| 6 | **The prototype and the product diverge during the build** | The prototype freezes at M0. It becomes a reference and a fixture source, not a parallel codebase. |
| 7 | **No SalesIntel contract yet** | The connector is an interface with a CSV/mock adapter. Nothing downstream depends on it being live. |

---

## 11. What I need from you

Only three things, and none of them block M0.

| # | Need | By | Blocks |
|---|---|---|---|
| 1 | **IdP** — Google Workspace or Entra ID, and an OIDC client registration | Before M1 sign-off | Live authentication testing |
| 2 | **An Anthropic API key** (or OpenAI / Azure) | Before M4 sign-off | Live model testing; mocked until then |
| 3 | **A real HubSpot CSV export** | Before M2 sign-off | Confirming the field mapping against their actual column names rather than my assumption |

Everything else — a deployment target, a SalesIntel contract, DNS, a domain — can wait until the code exists.

---

## 12. First move

**M0, in this order:**

1. Repository scaffold, TypeScript strict, ESLint with the layer-boundary rules from §2.2
2. Drizzle schema for all tables in §4.3, with `tenant_id` and RLS policies
3. PGlite test harness — creates the non-superuser `app_user` role and proves, **while connected as that role**, that migrations apply, `SET LOCAL app.tenant_id` scopes every query, a missing `WHERE tenant_id` clause returns nothing rather than another tenant's rows, and the same query run as superuser does return everything (a negative control proving the test would actually catch a misconfigured role)
4. Dockerfile + compose + CI
5. The ported EPA RMP connector, passing the VersaCold regression test against the real 1,382-facility dataset

Step 5 is the proof that the port is faithful. It runs against data we already have, needs no credentials, and tests the highest-risk logic in the system. If M0 ends with that passing, the rest is engineering rather than discovery.

---

*Companion documents: `BACKLOG.md` (66 UI/feature items, all folded into M5–M8) · `BUILD-PLAN.md` (the prototype-completion plan, superseded by this) · `phase1/AUTH-SPEC.md` (identity, roles, data tiers) · `phase1/INGESTION-GATES.md` (49 gates, 19 acceptance tests) · `phase1/PHASE-1-SPEC.md` (research pipeline detail)*
