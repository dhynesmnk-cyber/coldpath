# COLDPATH — Authentication & Authorization Specification

**Status:** Ready to build · **Supersedes:** the prototype's client-side PIN gate
**Companion:** `INGESTION-GATES.md` (gates L2, R8, S4, S5 all depend on real identity) · `PHASE-1-SPEC.md` §10

---

## 1. Why this document exists

The prototype authenticates with a four-digit PIN checked in the browser. Both codes are visible in the page source. The session is a `localStorage` entry. There is no server.

**That is obfuscation, not authentication.** Anyone who receives the HTML file has every account record, every deliverable, every gap and every source citation. If SalesIntel contact details are loaded into it, they have those too.

The prototype is fine as a prototype, and the login card says so plainly. It is not fine as the thing reps open on a laptop in an airport, which is what "access the library easily from any browser" implies.

This document specifies what replaces it.

### 1.1 The mistake to avoid

The prototype gates access by **hiding navigation entries and restricting the client-side router**. That is a user-experience decision, and it must stay — but it is not a control. In the production build:

> **Every authorization decision is made server-side, on every request, against the authenticated session. The client hides things for usability; the server refuses things for security.**

A rep who edits the URL, replays a request, or opens devtools must get a `403`, not a rendered screen. Anything less means the role model is decorative.

---

## 2. What is actually being protected

Authentication design follows from the asset inventory, not from convention. Four things matter here, and they are not equally sensitive.

| # | Asset | Sensitivity | Why |
|---|---|---|---|
| **A1** | **The customer list** — who is already a customer, under every alias and subsidiary | **Highest** | Disclosure is not the risk; *misuse* is. A leak here is minor. An outbound email to Americold or Lineage — the reference accounts the entire cold-chain motion depends on — is a commercial incident. This is the asset gate C5 exists to protect. |
| **A2** | **Gated contact details** — SalesIntel emails and direct dials, rep-captured LinkedIn data | **High** | Personal data under a contract with specific permitted-use terms (gate S1), subject to outreach-consent checks (S5). Retrieval must be logged (S4). |
| **A3** | **Prospect research and deliverables** — briefs, pains, decision units, buying windows, competitive analysis | **Medium-high** | Competitively sensitive. A leaked battlecard naming a competitor's weakness, or a buying-window analysis on a live enterprise deal, is genuinely damaging. |
| **A4** | **Derived public data** — RMP registry pulls, EDGAR filings, news signals | **Low** | Sourced from public records. The obligation is *attribution* (CC BY-SA 4.0), not confidentiality. |

Two consequences that shape everything below:

1. **A1 and A2 need different controls from A3 and A4.** A single "can they see the app?" decision is too coarse. Access must be tiered (§7).
2. **Attribution is a security property, not a bookkeeping one.** Gates L2 and R8 require knowing *who* did something. If identity is a shared code, attribution is self-asserted and therefore worthless — which means the audit trail that makes A2 defensible under the SalesIntel contract does not exist. §9 covers this.

---

## 3. Design principles

1. **Do not build authentication.** Ndustrial almost certainly has Google Workspace or Microsoft Entra ID. Use it. Custom password storage means owning hashing, reset flows, breach notification, MFA and support — none of which is this product.
2. **Identity is asserted by the server, never supplied by the client.** `captured_by`, `approved_by` and `accessed_by` are written from the authenticated session. There is no field a user can populate with someone else's name.
3. **Least privilege by default.** A new user sees nothing until granted a role. Roles grant read; writes and PII access are separate grants.
4. **Authorize on the resource, not the screen.** "Can this user read *this* contact's email?" — not "can this user see the SalesIntel page?"
5. **Log access to A2, not just changes to it.** Reading a direct dial is the sensitive act.
6. **Offboarding is a first-class flow.** A system holding the customer list and live deal intelligence must revoke access the day someone leaves, not when their password happens to expire.
7. **Fail closed.** An unparseable token, an expired session, a missing role claim, an unavailable IdP — all resolve to *deny*, with a clear message. Never to a permissive default.

---

## 4. Recommended architecture

### 4.1 Primary: OIDC against Ndustrial's existing IdP

```
Browser ──► COLDPATH app ──► redirect to IdP (Google Workspace / Entra ID)
                                    │
                              user authenticates
                              (password + MFA, owned by Ndustrial IT)
                                    │
                            ◄───────┘  authorization code
Browser ──► COLDPATH server ──► token exchange ──► id_token (JWT)
                                     │
                          verify signature, issuer, audience, expiry
                          read email + group claims
                                     │
                          map groups → COLDPATH roles (§6)
                                     │
                          issue own session cookie (§8)
                                     │
Browser ◄── Set-Cookie: HttpOnly, Secure, SameSite=Lax
```

**Why this is the right answer for a 10-day build:**

- No password storage, no reset flow, no MFA implementation, no breach surface. Ndustrial IT already owns all of it.
- **Group claims give role assignment for free.** A `coldpath-marketing` and `coldpath-sales` group in their directory becomes the source of truth. Joiners and leavers are handled by the process they already run.
- It satisfies "from any browser" *better* than a shared PIN: reps are already signed into Google or Entra on any device, so there is nothing to remember and nothing to type.
- Roughly **1–1.5 days** of work versus 2+ for custom auth, and it removes an entire category of incident.

### 4.2 Fallback: managed auth (Clerk, Auth0, or Supabase Auth)

If IdP integration cannot be arranged inside the pilot window, use a managed provider with Google SSO enabled. Same OIDC flow, they host the ceremony. About **1 day**. Costs a few dollars a month at pilot scale and adds one vendor.

### 4.3 Last resort, and only if both above are blocked

Email + password with **Argon2id** (`m=64MB, t=3, p=4`), mandatory MFA via TOTP, and lockout after 5 failures. Only then, and only with written acknowledgement that Ndustrial is accepting password-management responsibility. **This is roughly 2 days and is the worst of the three options.**

### 4.4 Not recommended under any circumstances

- Keeping the shared rep PIN in production
- Client-side-only authorization
- Passing identity as a request parameter or in the request body
- Long-lived bearer tokens in `localStorage` (readable by any XSS; cookies with `HttpOnly` are not)
- Building a custom "admin creates users" screen before SSO has been tried

---

## 5. Identity data model

```sql
-- Populated from the IdP on first successful sign-in, refreshed each session.
app_user        (id uuid pk,
                 idp_subject text unique not null,   -- stable IdP identifier, never the email
                 email citext unique not null,
                 display_name text not null,
                 initials text,
                 is_active bool not null default true,
                 last_seen_at timestamptz,
                 created_at timestamptz not null default now())

-- Roles are granted, not inherent. A user may hold several; effective
-- permission is the union, and denials always win over grants.
role_grant      (id uuid pk,
                 user_id uuid references app_user(id) on delete cascade,
                 role text not null check (role in
                      ('admin','marketing','sales_lead','rep','viewer')),
                 scope text,                          -- null = global; else an account id
                 granted_by uuid references app_user(id),
                 granted_at timestamptz not null default now(),
                 expires_at timestamptz,              -- contractors, agency staff
                 unique (user_id, role, scope))

session         (id uuid pk,
                 user_id uuid references app_user(id) on delete cascade,
                 issued_at timestamptz not null default now(),
                 expires_at timestamptz not null,
                 revoked_at timestamptz,
                 ip inet, user_agent text,
                 idp_session_id text)                 -- enables single logout

-- Append-only. No UPDATE, no DELETE. Enforced by grant, not by convention.
audit_log       (id bigserial pk,
                 at timestamptz not null default now(),
                 user_id uuid,                        -- nullable: failed auth has no user
                 action text not null,                -- 'pii.read' | 'capture.create' | 'deliverable.publish' | ...
                 resource_type text not null,
                 resource_id text,
                 account_id uuid,
                 outcome text not null,               -- 'allow' | 'deny' | 'error'
                 reason text,                         -- the gate that denied it
                 ip inet, user_agent text,
                 meta jsonb)

-- Field-level grants for A2 (see §7). Absence of a row means no access.
pii_grant       (id uuid pk,
                 user_id uuid references app_user(id) on delete cascade,
                 person_id uuid not null,             -- the contact record
                 field text not null check (field in ('email','phone')),
                 consent_basis text not null,          -- gate S5: what makes outreach lawful
                 granted_by uuid references app_user(id),
                 granted_at timestamptz not null default now(),
                 expires_at timestamptz)
```

**Two deliberate choices:**

- `idp_subject` is the stable key, **not** the email address. People change names and emails; the IdP subject does not. Keying on email means a rename silently creates a second identity and orphans the first one's audit history.
- `audit_log` is append-only at the database permission level. An audit trail that the application can edit is not an audit trail.

---

## 6. Roles and permission matrix

| Capability | admin | marketing | sales_lead | rep | viewer |
|---|:---:|:---:|:---:|:---:|:---:|
| Rep Library — read published deliverables | ✓ | ✓ | ✓ | ✓ | ✓ |
| Search accounts and briefs | ✓ | ✓ | ✓ | ✓ | read-only |
| Raise a correction ("this was wrong") | ✓ | ✓ | ✓ | ✓ | — |
| Request a new brief | ✓ | ✓ | ✓ | ✓ | — |
| **LinkedIn capture — create** | ✓ | ✓ | ✓ | ✓ | — |
| **See gated PII (email, direct dial)** | ✓ | ✓ | own accounts | own accounts | — |
| Command dashboard, review queue | ✓ | ✓ | ✓ | — | — |
| Account Intelligence — full research record | ✓ | ✓ | ✓ | — | — |
| Ingestion paths 1–5 (CRM, BD reports, SalesIntel) | ✓ | ✓ | — | — | — |
| Review gate — approve, edit, version | ✓ | ✓ | — | — | — |
| **Publish to the Rep Library** | ✓ | ✓ | — | — | — |
| Resolve review-queue items | ✓ | ✓ | — | — | — |
| Assign account ownership | ✓ | ✓ | ✓ | — | — |
| Usage & cost — read | ✓ | ✓ | — | — | — |
| Grant and revoke roles | ✓ | — | — | — | — |
| Read the audit log | ✓ | — | — | — | — |
| Configure the customer-suppression list (A1) | ✓ | ✓ | — | — | — |

**Notes on the non-obvious entries:**

- **`rep` sees gated PII only for their own accounts.** Not "all PII", not "no PII". Ownership is already a field on the account record (gate C6), so the check is `pii_grant` exists **and** the account's owner matches the session user **or** the user holds `sales_lead`.
- **`sales_lead` is the role that makes the matrix work.** Without it, either reps see everything or nobody can reassign an account when someone leaves. It is the only role with cross-account read but no publish right.
- **Only `admin` reads the audit log.** Marketing should not be able to review access to records they themselves administer. Separation of duties is the point.
- **Publishing is `marketing` and above.** This is the review gate from `PHASE-1-SPEC.md` §7.7 expressed as a permission: reps never see a draft because reps cannot create one, and cannot promote one.

---

## 7. Data classification and field-level control

Screen-level access is not enough, because a single deliverable can contain both A3 and A2 material. Classification is therefore per **field**, and enforced at serialization.

| Tier | Data | Who | Control |
|---|---|---|---|
| **T0** | Derived public data — RMP registry, EDGAR, news, company pages | any authenticated user | none beyond login |
| **T1** | Internal analysis — pains, signals, confidence, gaps, decision-unit *roles* | `rep` and above | role check |
| **T2** | Prospect research and deliverables — briefs, buying windows, battlecards | `rep` and above, **published only** unless `marketing` | role + status check |
| **T3** | **Gated PII** — emails, direct dials | account owner, `sales_lead`, `marketing`, `admin` | `pii_grant` row + ownership check + **audit-logged read** |
| **T4** | **Customer list and suppression data (A1)** | `marketing`, `admin` | role check; never serialized into any deliverable or export |

### 7.1 Implementation

Serialization is the enforcement point, not the UI:

```
respond(user, record):
    out = {}
    for field in record:
        tier = classify(field)
        if tier <= T2 and role_allows(user, tier):
            out[field] = record[field]
        elif tier == T3 and pii_allowed(user, record, field):
            audit('pii.read', user, record, field)     # logged BEFORE returning
            out[field] = record[field]
        else:
            omit(field)                                  # not null, not masked — absent
    return out
```

**Omitted, not masked.** A masked field (`j***@acme.com`) still confirms the record exists and leaks its shape. Absence leaks nothing and cannot be un-masked client-side.

**T4 never reaches a deliverable.** The customer list is used by gate C5 to *suppress* rows; it is not itself content. No export, no PDF, no CSV, no API response includes it for any role below `marketing`. This is a structural control, not a filter.

### 7.2 Interaction with the ingestion gates

- **S4** ("gated access, logged retrieval, suppressed from exports") is this tier model. S4 is the policy; §7 is the implementation.
- **S5** ("lawful basis before outbound") is the `consent_basis` column on `pii_grant`. A PII field with no consent basis is readable for research but **cannot be used to generate outbound** — generation refuses, per gate L8.
- **G2 / L12** (refuse protected-characteristic data) is enforced at ingest, before storage. Nothing in this spec can admit it, because it never enters.

---

## 8. Session management

| Property | Value | Rationale |
|---|---|---|
| Transport | `Set-Cookie`, **`HttpOnly`, `Secure`, `SameSite=Lax`** | Not readable by script, so XSS cannot exfiltrate it. `Lax` permits the IdP redirect without opening CSRF on cross-site POST. |
| Access session | **8 hours**, sliding | One working day. Survives a lunch break; does not survive a lost laptop indefinitely. |
| Refresh | **30 days**, rotating, single-use | Rotation with reuse detection: a presented refresh token that has already been consumed revokes the whole family, which is the standard signal of theft. |
| CSRF | Double-submit token on all state-changing requests | Cookies plus `SameSite=Lax` is good; this is defence in depth for POST/PATCH/DELETE. |
| Concurrent sessions | Allowed, listed in a "your devices" view | Reps legitimately use phone and laptop. Revoking silently breaks their day. |
| Idle timeout | 30 minutes on T3 reads | PII screens re-authenticate; research screens do not. |
| Auth rate limiting | 10 attempts / 5 min / IP, plus per-account backoff | The IdP handles credential stuffing; this protects our own endpoints. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Non-negotiable with `Secure` cookies. |

**Single logout:** store `idp_session_id` so a sign-out at the IdP can be honoured, and so `admin` can revoke a specific session rather than every session.

---

## 9. Attribution integrity

This is the section that justifies retiring the shared PIN.

Gates **L2** ("captured by — recorded automatically from the session, not optional, not editable") and **R8** ("activity records attributed to the rep") both assume the system *knows* who is acting. The prototype satisfies this by asking the rep to pick their name from a list after entering a shared code.

That is self-assertion. It is better than nothing — it makes captures distinguishable and creates social accountability — but it is not evidence:

- Any rep can select any other rep's name.
- There is no cryptographic or administrative link between the assertion and the person.
- An audit trail built on it cannot support a data-protection request, a SalesIntel contract review, or a dispute about who contacted a prospect.

### 9.1 Production rule

> `captured_by`, `approved_by`, `raised_by` and `accessed_by` are written **server-side from the validated session**. They are not request parameters. There is no API that accepts them as input, and no client field that maps to them.

The prototype's name picker is removed entirely. In its place the capture record shows the authenticated identity, read-only, with the session issued-at timestamp.

### 9.2 Immutability

Attribution fields are `not null` and have no update path. A correction to a capture creates a **new** record referencing the old one (`supersedes_id`), rather than editing it. The original observation, its author and its timestamp survive — which is the entire evidentiary value.

### 9.3 What this costs

Nothing at build time, because SSO provides it for free. It is the reason to prefer §4.1 over §4.3 even if password auth would be marginally faster to wire.

---

## 10. Offboarding — the flow everyone forgets

A system holding A1 (customer list), A2 (contact PII) and A3 (live deal intelligence) must revoke access reliably. Three layers, all required:

1. **Directory is the source of truth.** Removing a user from the `coldpath-*` groups at the IdP removes their role claims. Because access tokens are short-lived (§8), the change takes effect within 8 hours without any action in COLDPATH.
2. **Explicit revocation for immediacy.** `admin` sets `app_user.is_active = false` and revokes all `session` rows. Takes effect on the next request — seconds, not hours. This is the flow used for a same-day departure.
3. **Reconciliation job, daily.** Any `app_user` not returned by the IdP directory query is flagged for review and auto-deactivated after 7 days of absence. This catches the case where someone is removed from the directory without anyone telling us.

**Data retention after departure:** the user's *identity* is retained permanently, because the audit log and attribution records reference it and must remain intelligible. Their *access* is revoked. Their `pii_grant` rows expire. Their captures and corrections stay attributed to them — that is the point of attribution.

**Account reassignment on departure** is a `sales_lead` action (gate C6 ownership). An orphaned account with no owner lands in the unassigned queue and is visible on the Command dashboard, so this cannot fail silently.

---

## 11. What ships in the 10 days

Auth is not free, and the pilot has no slack. This is the honest split.

### In scope — days 1 and 9

| Item | Effort |
|---|---|
| OIDC integration against Ndustrial's IdP (§4.1) | 0.75 d |
| `app_user`, `role_grant`, `session` tables; group→role mapping | 0.25 d |
| Session cookie handling, refresh rotation, CSRF token | 0.5 d |
| Server-side authorization middleware on every route (§1.1) | 0.5 d |
| Tier classification + serializer omission (§7.1) | 0.5 d |
| `audit_log` — append-only, PII reads and all writes | 0.25 d |
| Attribution written from session; name picker removed (§9) | 0.25 d |
| Offboarding: `is_active` flag + session revocation (§10.2) | 0.25 d |
| **Total** | **~3.25 days** |

That is a third of the build. It is not optional: without it, gate S1 (permitted use under the SalesIntel contract) cannot be satisfied, because the contract will ask how access to contact data is controlled and logged.

### Deferred to Phase 2

- `pii_grant` with per-contact consent basis — **unless SalesIntel data is loaded during the pilot, in which case it moves into scope.** Flag this decision on day 1.
- `sales_lead` role and scoped grants
- "Your devices" session view and single logout
- Daily directory reconciliation job (§10.3)
- IP allow-listing, conditional access
- Export watermarking (who exported what, embedded in the PDF)

### Removed from the prototype

- The PIN pad, both codes, and the rep name picker
- The client-side router restriction (kept as UX, but no longer load-bearing)
- `localStorage` session persistence

---

## 12. Acceptance tests

The build does not ship until all of these pass. Items 1–4 are blocking.

1. **A rep cannot reach a marketing screen by any client-side route.** Direct URL, replayed request, modified router state, and `fetch` from the console all return `403`. Not a redirect, not an empty screen — a refusal.
2. **A rep cannot read PII for an account they do not own**, even when the account id is supplied directly to the API.
3. **Attribution cannot be forged.** No request parameter, header or body field can set `captured_by` to anyone other than the session user. Verified by attempting it.
4. **T4 never appears in any export.** Generate every deliverable type, every export format, for every role, and assert the customer list is absent from all of them.
5. **A revoked session is refused on the next request**, not at token expiry.
6. **A refresh token presented twice revokes the token family.**
7. **Removing a user from the IdP group removes their role** within one access-session lifetime.
8. **`audit_log` records every T3 read** with user, resource, field, timestamp and IP — and cannot be updated or deleted by the application role.
9. **Omitted fields are absent, not null or masked**, in every serialized response.
10. **An unparseable, expired or wrong-audience token denies access** with no fallback to a default role.
11. **Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`** and no token is ever written to `localStorage`.
12. **A deactivated user's existing captures remain attributed to them** and their `pii_grant` rows no longer authorize access.
13. **Orphaned accounts surface.** Deactivating the sole owner of an account puts it in the unassigned queue (C6), visible on the Command dashboard.

---

## 13. The one decision to make on day 1

**Does Ndustrial have Google Workspace or Microsoft Entra ID, and can we get an OIDC client registered in the pilot window?**

- **Yes** → §4.1, roughly 1–1.5 days, no passwords stored, attribution solved properly, offboarding handled by a process they already run.
- **No, but a managed provider is acceptable** → §4.2, roughly 1 day, one extra vendor.
- **Neither** → §4.3, roughly 2 days, and Ndustrial formally accepts password-management and MFA responsibility in writing.

This needs an answer before day 1, not during it. IdP client registration is an IT ticket at most organisations, and IT tickets are not same-day.

The related question, worth asking at the same time: **will SalesIntel contact data be loaded during the pilot?** If yes, `pii_grant` and per-contact consent basis move from Phase 2 into the 10 days, and something else has to come out — most likely the Site Portfolio Analysis deliverable, per the cut order in `PHASE-1-SPEC.md` §16.

---

*Companion documents: `INGESTION-GATES.md` (49 gate rules — L2, R8, S1, S4, S5 depend on this spec) · `PHASE-1-SPEC.md` (build plan, scope, acceptance criteria) · `what-is-this/` (first-run explainers)*
