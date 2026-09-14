# COLDPATH — Build & Deployment Guide

Written for someone doing this for the first time. No assumed knowledge.

---

## 1. The mental model

There are three separate things people lump together as "deployment," and keeping them apart prevents most of the confusion:

| | What it is | Where it lives |
|---|---|---|
| **Source code** | The TypeScript files in `app/` | A git repository |
| **Build artefact** | The compiled, runnable thing — here, a **Docker image** | An image registry |
| **Running service** | The artefact executing on a machine, connected to a database, reachable at a URL | The client's infrastructure |

You write source code. You *build* it into an artefact. You *deploy* the artefact somewhere it runs. Those are three different steps and three different places, and a problem in one is not a problem in the others.

**Why a Docker image and not "the code"?** A Docker image bundles your compiled app, its Node runtime, and every dependency at a pinned version into one immutable file. The client's server does not need Node installed, does not need `npm install` to succeed, and cannot accidentally get a different dependency version than you tested. It runs the image or it doesn't. That reproducibility is the entire point.

---

## 2. Environments

You need three, and they exist for different reasons:

**Local** — your laptop. Database is PGlite or a local Postgres; nothing here is real. Today that means `npm run verify` and `npx vitest` — `npm run dev` arrives with the web server in M6, since at M0 there is no HTTP surface to serve yet.

**Staging** — a real deployment with fake or copied-anonymised data. Same image, same configuration shape, different values. This is where you find out that something works on your machine and nowhere else.

**Production** — what the client's six reps actually use.

The rule that makes this worth the effort: **the exact same image artefact gets promoted from staging to production.** You do not rebuild for production. If the image you tested is not the image you ship, you tested nothing.

For a pilot with one marketer and six reps, staging can be as small as a second container on the same server pointed at a second database. It is still worth having.

---

## 3. The decision that determines everything

**Does Ndustrial's IT or security team need to approve where the customer list and SalesIntel contact data live?**

Everything else follows from the answer.

### Path A — their infrastructure (recommended for an enterprise client)

The app and database run inside infrastructure Ndustrial's IT already governs: a VM or container host on their AWS/Azure/GCP account, or a server in their office.

- **For:** the customer list and any PII never leave infrastructure they control. Security review is a conversation about a VM, not about a new third-party vendor. Their data-protection and vendor-risk paperwork is dramatically simpler. When the engagement ends they own everything.
- **Against:** someone has to administer a server. Backups, patching, TLS renewal, monitoring. Either their IT does it or you do it under a support agreement.
- **Effort:** roughly a day to set up, then near-zero per deploy.

### Path B — a managed platform

Vercel runs the app; Neon or Supabase runs Postgres.

- **For:** almost no operations. Push to git, it deploys. TLS, scaling, backups handled for you. Genuinely the fastest route to something live.
- **Against:** a third party holds the customer list and any SalesIntel PII. An enterprise security team may refuse, and you will discover that in week 8 rather than week 1. Also: the platform account is someone's — if it's yours, the client does not own their own product.
- **Effort:** a couple of hours.

### My recommendation

**Ask the question first.** Specifically, ask Ndustrial: *"Where are you comfortable having your customer list and any third-party contact data stored — inside your own cloud tenancy, or is a managed platform acceptable?"*

If they have any security or IT review process at all, the answer will be Path A, and finding that out after you've built on Vercel costs you the migration.

If they say they don't care, Path B is faster and completely reasonable for a pilot — with the caveat that moving later is real work.

**Whichever you choose, the accounts must be theirs, not yours.** See §9.

---

## 4. What actually has to exist on the server

For Path A, concretely:

1. **A Linux machine.** 2 vCPU / 4 GB RAM is ample for this workload. Any of: a cloud VM, a container host, or a physical box in their office.
2. **Postgres 16+.** Either a managed database service (RDS, Azure Database, Cloud SQL) or Postgres in a container beside the app. Managed is worth the money even for a pilot — automated backups are the single thing you do not want to be responsible for.
3. **Two database roles.** This is specific to COLDPATH and it matters more than anything else on this list — see §6.
4. **A domain name and TLS.** `coldpath.ndustrial.com` with a certificate. Let's Encrypt is free and auto-renews via Caddy or Traefik, which also handle HTTPS termination and reverse-proxying to the container.
5. **An OIDC client registration** in their identity provider, with the app's redirect URI. This is an IT ticket, and IT tickets are not same-day.
6. **An LLM API key.** Anthropic by default.
7. **Outbound internet access** from the server. The EPA RMP, SEC EDGAR and news connectors all make outbound calls. A locked-down corporate network that blocks egress will silently produce empty research.

Item 7 is the one that surprises people. Test it explicitly on day one: can the server reach `rmpmap.org` and `data.sec.gov`?

---

## 5. The deploy, step by step

### One-time setup

```
1. Client provisions the machine and the database.
2. Client (or you, with their credentials) creates the two DB roles — §6.
3. Client registers the OIDC client and gives you the issuer, client id and secret.
4. You write /etc/coldpath/coldpath.env on the server, mode 600, owned by root.
   It is never committed to git. Copy .env.example and fill it in.
5. Install Docker, and Caddy or Traefik for TLS + reverse proxy.
6. Deploy once, run migrations, log in, confirm the review queue renders.
```

### Every deploy after that

```
You, locally:
  npm ci
  npm run verify                      # typecheck + lint + build + integration tests
  docker build -t coldpath:1.4.0 .
  docker push <registry>/coldpath:1.4.0

On the server:
  pg_dump … > backup-$(date +%F-%H%M).sql   # ALWAYS. See §7.
  docker pull <registry>/coldpath:1.4.0
  docker compose run --rm app node dist/scripts/migrate-prod.js
  docker compose up -d app
  curl -fsS https://coldpath.ndustrial.com/healthz
```

That is the whole thing. Four commands after the backup.

### Rollback

```
  docker compose run --rm app node dist/scripts/migrate-prod.js   # only if you must
  # edit docker-compose.yml or the .env to pin the previous tag
  docker compose up -d app
```

**Tag images with versions, never `latest`.** `latest` is how you discover you have no idea what is running. If a migration has already run and you need to roll back the app, you may also need to restore the database from that backup — which is why the backup happens *before* the migration, not after.

---

## 6. The COLDPATH-specific trap

This system's tenant isolation depends on Row-Level Security, and **RLS does not apply to superusers or to the role that owns the tables.** `FORCE ROW LEVEL SECURITY` covers the owner; nothing covers a superuser.

So:

- `coldpath_migrator` — privileged, owns the tables, runs migrations. Used by nothing else.
- `coldpath_app` — non-superuser, `NOBYPASSRLS`, owns nothing. This is what the application connects as.

**If you point `APP_DATABASE_URL` at the migrator role, tenancy isolation is silently disabled.** No error. No warning. No failing query. Every test still passes if the tests also use the wrong role. The only symptom is that a future second tenant can read the first one's customer list.

`scripts/migrate-prod.ts` refuses to complete if `coldpath_app` is a superuser or has `BYPASSRLS`, and the integration suite includes a **negative control** asserting that a superuser *does* see everything — so if that test ever fails, you know the role wiring regressed rather than assuming isolation still works.

For a single-tenant pilot this is theoretical. It stops being theoretical the day you add a second client, and by then the mistake is three years old and invisible.

---

## 7. Backups and migrations

**Backups.** Managed Postgres does this for you — confirm the retention period and, once, actually test a restore. An untested backup is a hope. If you run Postgres yourself, `pg_dump` on a cron plus offsite copy, and test the restore.

**Migrations.** `src/db/migrations/` contains numbered SQL files. They are applied in order and recorded, so re-running is safe. Two rules:

1. **Back up before migrating.** Always. Not "for big changes."
2. **Migrations must be backwards-compatible with the running code** if you want zero-downtime deploys. Add a column as nullable, deploy code that writes it, then make it required — not all in one step. For a pilot with six users, a thirty-second restart is fine and you can ignore this.

---

## 8. Secrets

A secret is anything that lets someone act as you: database passwords, the OIDC client secret, the LLM API key.

- **Never in git.** Not in a commit, not in a "temporary" commit, not in a screenshot. Git history is forever and repositories leak. Add `.env` to `.gitignore` on day one — it already is.
- **On the server**, in a root-owned `600` file, or in the cloud's secret manager (AWS Secrets Manager, Azure Key Vault). The compose file reads from the environment; nothing is baked into the image.
- **Rotatable.** If a key is committed by accident, treat it as compromised and rotate it. Deleting the commit does not help.
- **Scoped.** The LLM key should have a spend limit. An uncapped key in a compromised container is an expensive night.

---

## 9. Ownership — the part agencies get wrong

This is a commercial and legal issue, not a technical one, and it is far easier to get right at the start than to untangle later.

**Everything should be in the client's accounts from day one:**

| Thing | Whose account | Why it matters |
|---|---|---|
| Cloud / server | Ndustrial | They can run their product without you |
| Domain + DNS | Ndustrial | If you own `coldpath.ndustrial.com`, you control whether it resolves |
| Image registry | Ndustrial (or theirs via your CI) | The artefact that runs in production |
| Database | Ndustrial | Their customer list, their data |
| OIDC client | Ndustrial | Authentication is theirs |
| LLM API key | Ndustrial | Their spend, their data-processing agreement with the provider |
| Source repository | **Decide explicitly, in writing** | See below |

**Source code ownership is a contract question, not a technical one.** Three common arrangements, all legitimate:

1. **Client owns it outright.** You deliver the repository and all rights. Highest fee, cleanest handover.
2. **You own it and licence it.** They get a perpetual licence to run it. This is what makes "product later" viable — you can sell it to other cold-chain companies. Lower fee, and they will want the licence terms in writing.
3. **Joint / escrow.** They own it but you retain the right to reuse general components.

Given your "internal now, product later" answer, **arrangement 2 or 3 is almost certainly what you want** — and it needs to be settled before you hand anything over, not after. If you build the whole thing and then discover they assume they own it, that conversation is unpleasant and expensive.

Also worth settling now: **who is on call when it breaks at 7am on a Monday**, and what that costs. "You built it" is not an answer either side will be happy with six months in.

---

## 10. Handover package

What Ndustrial needs to run this without you:

- The repository, with `README.md` (already written) and this document
- `docker-compose.yml`, `Dockerfile`, `.env.example`
- The runbook: how to deploy, how to roll back, how to restore a backup, how to read the logs
- Where the secrets live and who can rotate them
- The two database roles, what each is for, and why the app must not use the privileged one
- The connector list and their rate limits / licences — including the **CC BY-SA attribution requirement** on EPA RMP data, which must remain visible in the product
- Known limitations, stated plainly (`PRODUCT-PLAN.md` §9 and the README's "deliberately not here yet")
- Who to call, for how long, and what it costs

The test of a good handover: **their IT person can deploy a new version next month without emailing you.**

---

## 11. Mistakes worth avoiding

1. **Deploying on your own accounts** and migrating later. The migration is the painful part; do it once, at the start.
2. **No staging.** "It worked on my machine" is a complete sentence and a complete explanation for most bad deploys.
3. **`latest` tags.** You lose the ability to roll back or to say what is running.
4. **Migrating without a backup.** The one unrecoverable mistake on this list.
5. **Pointing the app at the privileged database role.** Silent, and specific to this system. §6.
6. **Secrets in git.** Also effectively unrecoverable — rotate, don't delete.
7. **Assuming outbound internet works.** Corporate networks block egress; the connectors then fail quietly and produce empty research that looks like a data problem.
8. **Deploying Friday afternoon.** Not superstition — you want the person who deployed to be available when the first problem appears, and Monday morning problems get found by users.
9. **No health check.** If nothing verifies the service is up, you learn about outages from the marketer, not from a dashboard.
10. **Leaving ownership ambiguous** until the engagement ends. §9.

---

## 12. What this looks like for the pilot, concretely

Smallest thing that is still done properly:

- One VM in Ndustrial's cloud, 2 vCPU / 4 GB
- Managed Postgres 16 with automated backups, two roles created
- Docker + Caddy for TLS, one compose file, two services
- `coldpath.ndustrial.com` on their domain, OIDC against their existing IdP
- GitHub Actions builds and pushes the image to their registry on merge to `main`
- Deploys are the four commands in §5, run by you for the first month, then by them

That is a day of setup and about fifteen minutes per deploy afterwards. It is not a large amount of infrastructure, and nothing about it needs to change when a second tenant arrives — which is the whole point of having put `tenant_id` and RLS in at M0.
