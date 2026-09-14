# COLDPATH — Phase 1 Pilot Build Specification

**Client:** Ndustrial · **Vertical:** Cold storage & logistics
**Duration:** 2 weeks (10 working days) · **Solo engineer, full-time**
**Client-side contribution:** ~6 hours of marketer time for template critique and review-gate testing
**Document status:** Ready to build · **Companion artefacts:** `../index.html` (working prototype), `data/` (real seed dataset), `connectors/epa_rmp.py` (working, tested connector)

---

## 1. What Phase 1 is

Phase 1 is a **single-vertical pilot that proves two things**: that the engine's research output is good enough for a rep to work a live enterprise account from, and that a marketer can run it without becoming the bottleneck again.

It is deliberately narrow. One vertical (cold storage & logistics), **10 accounts, three deliverable types**, one human review gate, CSV in and CSV/PDF out. Everything that does not directly serve those two proofs is cut and deferred to Phase 2.

**The gate to Phase 2 is not "the software works."** It is: *10 briefs published, and reps have actually used them on live opportunities.* If the output is not good enough that reps choose it over asking a colleague, no amount of additional engineering fixes that, and we should find out on day 10 rather than in month six.

## 2. Validated ground truth

The single largest technical risk in Phase 1 was whether the differentiating data source — the EPA Risk Management Program registry — was actually accessible, actually useful, and actually clean. **It has been tested. It is all three, with one important caveat.**

The connector at `connectors/epa_rmp.py` was run end-to-end against the live API on 11 September 2026. Measured results:

| Metric | Value |
|---|---|
| Facilities in scope across 9 cold-chain NAICS codes | **1,382** |
| Active (non-deregistered) facilities | **1,111** |
| Facilities reporting anhydrous ammonia | **1,374 of 1,382 (99.4%)** |
| Resolved accounts after entity resolution + pilot filter | **114** |
| Prospects (customers suppressed) | **111** |
| Sites in resolved accounts | **748** across **43 states** |
| Validated ammonia inventory | **24.5 million lb** (median 20,023 · p99 180,000 · max 715,862) |
| Accounts scoring ≥70 on the RMP-only ICP model | **10** |
| Existing Ndustrial customers correctly suppressed | **3 of 3** |
| Accounts with more than one reported alias | **54 of 117 (46%)** — 247 aliases total |
| Sites with recorded accident history | **192** — 314 accidents total |
| Records routed to the human review queue | **3** (1 numeric outlier, 2 unresolved names) |
| Dataset currency | v3, exported 2026-02-05, data through 2025-12-30 |

Three findings from that run materially shape the build:

### 2.1 Entity resolution is the highest-risk component, and it is measurable

The same legal entity is reported under many names. Observed in the real pull:

- **Americold** → `Americold Logistics, LLC` (88 sites) · `Americold` (8) · `Americold Realty` (5) · `Americold Realty Trust` (3) = **104 sites, one account**
- **Lineage** → `Lineage Logistics, LLC` (63) · `Lineage  Jessup` (27) = **90 sites, one account**
- **Kroger** → `Kroger, Inc.` (9) · `The Kroger Company` (6)
- **Sysco** → `Sysco Corporation` (50) · `Sysco Foods` (2)
- **C&S** → `C&S Wholesale Grocers, LLC` (12) · `C&S Wholesale Services, Inc.` (3)

**54 of 117 resolved accounts (46%) had more than one alias.**

The critical consequence: a naive exact-match customer blocklist **fails on the largest entities**. `"Americold Logistics, LLC" != "Americold"`, so an 88-site existing customer would have been queued for outbound. That is the single worst failure mode available to this system — it damages the reference account that the entire cold-chain sales motion depends on. Entity resolution is therefore **stage 1 of the pipeline, not a cleanup step**, and it is the first thing acceptance testing targets.

### 2.2 Self-reported regulatory data contains outliers that will corrupt scoring

One facility — `Neches Terminal`, Beaumont TX, reported under `Martin Operating Partnership` — declares **89,000,000 lb** of anhydrous ammonia. The next largest single-site charge in the entire dataset is 715,862 lb (JBS Marshalltown Pork). Median across 749 sites is 20,174 lb; p99 is 200,000 lb.

That single record is **494× the p99** (180,000 lb) and **124× the largest legitimate charge in the dataset** (715,862 lb). The facility is a marine terminal, not a cold store — it appears to be both a units error and a NAICS misclassification. Left unvalidated it scored 60 on the ICP model and ranked **#15 of 114 prospects**, above Hormel, Schwan's and Cargill.

The scale of the distortion is worth stating plainly: **that one record accounted for 78% of all ammonia reported across the entire dataset.** The raw pull totals 113M lb; after validation it is 24.7M lb. Any portfolio statistic computed on unvalidated self-reported data would have been wrong by a factor of four.

The validation gate is **implemented and tested** in the connector (§7.2). It now flags the record, excludes it from scoring, retains it, and writes it to `data/coldchain_rmp_review_queue.csv` with the statistic that triggered the flag. Account count moves 115 → 114 and sites 749 → 748 when the gate runs, which is the correct behaviour: the affected account had no other qualifying site.

**Implication:** every numeric field from a self-reported source requires an outlier gate before it can influence a score.

### 2.3 A measured tuning problem in name normalisation

Four facilities could not be resolved to an account. Two of the four are informative:

- `BrucePac` (Woodburn, OR) — reported parent `JDB, Inc.` → normalises to `JDB` (3 characters)
- `ACS-LLC` (Yuma, AZ) → normalises to `ACS` (3 characters)

Both were rejected by a minimum-name-length rule intended to suppress junk tokens. **Short-acronym legal entities are being routed to human review unnecessarily.** The other two (`Tex-Mex Cold Storage, Inc.` and `Berkshire Refrigerated Warehousing, LLC`) are genuine — their reported parent is the literal string `NA`.

Fix in week 1: replace the length threshold with a stopword-and-junk check, so `JDB` and `ACS` resolve while `NA`, `N/A` and `UNKNOWN` do not. Small, but it is the kind of defect that only shows up against real data — which is the argument for having run the connector before writing this spec.

### 2.4 The dataset is genuinely current, and genuinely licensed

Data is current to 30 December 2025 — well within acceptable staleness for a facility registry, where the underlying assets change slowly. Licence is **CC BY-SA 4.0** with mandatory attribution, and the connector captures licence, attribution and disclaimer metadata on every pull and stores it non-nullably alongside the records. See §15.

---

## 3. Scope

### In scope

| Area | Detail |
|---|---|
| Vertical | Cold storage & logistics only (NAICS 49312 primary) |
| Universe | 114 resolved accounts from RMP; **10 selected for deep research** |
| Source connectors | EPA RMP (**built & tested**) · SEC EDGAR · company website · news search |
| Pipeline | All 7 stages, full confidence model |
| Deliverables | **3 types** — Account Brief, Executive One-Pager, Site Portfolio Analysis (§9) |
| Review gate | Marketing approves, edits, versions, publishes |
| Rep surface | Search + read + "this was wrong" flag + request-a-brief |
| Export | CSV · PDF |
| CRM | **CSV import/export only** — customer list and account ownership loaded from a file |

### Explicitly out of scope — and why

| Cut | Rationale |
|---|---|
| **Outbound Sequence and Business Case Model deliverables** | Two of the five original types. Outbound requires a resolved primary contact at confidence ≥2 — with no paid enrichment in a 2-week window, the gap rate makes it blocked more often than not. The business case model already exists as a working interactive component in the prototype and can be handed over as-is. Both return in Phase 2. |
| **Live CRM sync (Salesforce / HubSpot)** | Replaced by CSV import/export. OAuth, field mapping, sync conflicts and record-locking would consume most of week 2 for no pilot-learning value. |
| **Slack alerts and email digests** | Notification plumbing is not a hypothesis worth testing in 10 days. Reps open the library. |
| **Job board and EPA ECHO connectors** | Both are high-value intent and trigger sources, but four connectors is enough to prove the pipeline. Adding two more is linear work, not new risk. |
| **Feedback-loop retraining** | The "this was wrong" flag is captured and drops a fact to confidence 1. Learning *from* the accumulated corrections requires a corpus we will not have in 10 days. |
| **DOCX export** | PDF covers the leave-behind case. |
| Manufacturing and retail verticals | Three verticals triples the prompt-tuning surface. Prove one. |
| Paid enrichment (Apollo / Clay / ZoomInfo) | Adds cost, contract time and a second data-quality problem. Phase 1 measures how far public data alone gets us — which is the number that decides whether paid enrichment is worth buying. |
| Vector search / semantic retrieval | At 10 accounts, per-account source stores plus full-text search are sufficient. Adding pgvector now is architecture for a problem we do not have yet. |
| Marketing deliverables (campaign brief, letter, social) | Different buyer, different review cycle, different success metric. Adding them doubles the review-gate load without testing the core hypothesis. |
| Scoped role grants, "your devices" session view, single logout, daily directory reconciliation | Base roles and server-side authorization **are** in scope — see `AUTH-SPEC.md` §11. Only the refinements are deferred. |
| Predictive buying-window scoring | Requires win/loss history we do not have yet. Phase 3. |
| Mobile | Reps will use this at a desk before a call. |

---

## 4. Architecture

```
┌───────────────────────────── SOURCES ─────────────────────────────┐
│ EPA RMP API   SEC EDGAR   Company sites   News   Job boards   ECHO │
│        (read-only CRM: Salesforce / HubSpot)                       │
└───────────────────────────────┬───────────────────────────────────┘
                                │  nightly + on-demand
                     ┌──────────▼──────────┐
                     │   Connector layer    │   one module per source
                     │  normalise → store   │   raw payloads retained
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │  Entity resolution   │   STAGE 1 — see §2.1
                     │  alias → canonical   │   human queue for unmatched
                     └──────────┬──────────┘
                                │
        ┌───────────────────────▼───────────────────────┐
        │              RESEARCH PIPELINE                 │
        │  signal detection → pain mapping → commercial  │
        │  translation → decision unit → deliverables    │
        │        every claim carries source + confidence │
        └───────────────────────┬───────────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │   Postgres (system   │   accounts, signals, sources,
                     │      of record)      │   facts, deliverables, versions
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │   Next.js app        │   marketing view + rep view
                     └──────────┬──────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
   REVIEW GATE              REP LIBRARY             EXPORTS
   (marketing)          (read-only, search)     CSV/PDF/DOCX/Slack
        │                       │                       │
        └───────────┬───────────┴───────────────────────┘
                    │  "this was wrong" + win/loss
             ┌──────▼──────┐
             │ FEEDBACK     │  corrects facts, adjusts
             │ LOOP         │  confidence, re-versions
             └─────────────┘
```

**Key architectural decision:** the Postgres database is the system of record, not the LLM. Every fact is stored as a row with a source reference and a confidence rating. The LLM synthesises *from* those rows and cannot introduce facts that are not in them. This is what makes the confidence model enforceable rather than aspirational — see §8.

---

## 5. Data model

```sql
-- Canonical account. One row per real company, not per reported name.
account            (id, canonical_name, vertical, hq, website, ticker,
                    is_customer bool, crm_id, owner, rep, priority, status,
                    icp_score int, created_at, updated_at)

-- Every reported name that resolved to this account. Audit trail for §2.1.
account_alias       (id, account_id, reported_name, source, confidence,
                    resolved_by,  -- 'rule' | 'human' | 'model'
                    created_at)

-- One physical facility. Retains raw source payload.
site               (id, account_id, name, city, state, rto, naics,
                    ammonia_lb int, program_level int, accidents int,
                    rmp_id, lat, lon, url, raw jsonb,
                    validated bool, validation_note)

-- A dated, classed event with commercial consequence.
signal             (id, account_id, site_id null, type, occurred_on,
                    title, detail, impact,          -- critical|high|medium|low
                    why_it_matters text,             -- commercial translation
                    detected_at)

-- An atomic, sourced claim. The unit of the confidence model.
fact               (id, account_id, subject,        -- 'financial'|'person'|'facility'|...
                    predicate, value text, as_of date,
                    source_id, confidence int,       -- 1..3
                    used_in_deliverable bool default false)

-- Provenance for every fact. Nothing exists without one.
source             (id, account_id, kind,            -- 'rmp'|'edgar'|'news'|'web'|'job'
                    title, url, publisher, published_on,
                    retrieved_at, confidence int, raw jsonb,
                    licence text)

-- A named or role-only decision-unit entry. Gaps are rows, not omissions.
person             (id, account_id, name null, title null,
                    role_in_deal, confidence int,
                    is_gap bool default false,       -- see §8
                    gap_reason text, resolution_path text,
                    angle text, provenance text)

-- Pain mapped to one of Ndustrial's four platform pillars.
pain               (id, account_id, pillar int,      -- 0..3
                    title, evidence, ndustrial_angle,
                    severity int,                    -- 1..5, evidence-scored
                    is_weak_fit bool,                -- engine may say "do not lead"
                    supporting_fact_ids int[])

deliverable        (id, account_id, type,            -- brief|exec|outbound|business|portfolio
                    version int, status,              -- draft|in_review|published|superseded
                    body jsonb, rendered_html text,
                    author, approved_by, published_at,
                    min_confidence int,               -- floor enforced at generation
                    blocked_reason text)

-- Feedback is a first-class object, not a comment.
correction         (id, deliverable_id, fact_id null, person_id null,
                    raised_by, kind,                  -- 'wrong'|'stale'|'missing'|'tone'
                    note, resolved bool, created_at)

usage              (id, deliverable_id, rep, action, -- 'view'|'export'|'send'|'mark_wrong'
                    opportunity_id, created_at)
```

**Two design points worth defending:**

- `person.is_gap` is a real column. An unresolved executive is a *stored fact about our knowledge*, not an absence. This is what lets the UI publish gaps with resolution paths instead of silently leaving them blank — and what lets outbound generation be blocked programmatically (§8).
- `deliverable.min_confidence` is enforced at generation time. A deliverable type declares the lowest confidence it will accept for each field class, and generation fails loudly rather than degrading quietly.

---

## 6. Pilot account selection

**10 accounts**, selected from the 111 non-customer accounts by ICP score — but not the top ten by score. Two slots are deliberately spent on hard cases, because a pilot that only tests the easiest accounts tells us nothing.

**Eight highest-value prospects (ICP ≥70):**

| # | Account | ICP | Sites | Ammonia (lb) | States | Grid | Why it is in the pilot |
|---|---|---|---|---|---|---|---|
| 1 | Walmart Inc. | 97 | 39 | 1,903,105 | 28 | PJM | Largest footprint in the registry |
| 2 | Sysco Corporation | 94 | 60 | 973,818 | 33 | PJM | Most sites, most states, 13 reported aliases |
| 3 | JBS USA | 91 | 18 | 2,037,596 | 14 | MISO | Largest single ammonia inventory |
| 4 | United Global Foods | 86 | 9 | 893,135 | 8 | MISO | High accident history (8) |
| 5 | Tyson Foods, Inc. | 84 | 17 | 660,555 | 10 | SPP | Already deeply researched in the prototype |
| 6 | C&S Wholesale Grocers | 83 | 15 | 425,100 | 9 | PJM | Dense PJM exposure |
| 7 | The Kroger Co. | 79 | 17 | 464,610 | 10 | Duke | Already deeply researched; 18 accidents |
| 8 | Albertsons/Safeway | 75 | 10 | 416,416 | 9 | CAISO | Merged-alias resolution test; CAISO grid, distinct from the PJM cluster |

**Two deliberately hard cases:**

- **Gordon Food Service (ICP 51)** — 7 sites, **zero recorded accidents**, near-zero signal. This is a *negative test*: an account with nothing to say must produce a brief that says so, not one that invents urgency. If the engine fabricates a buying window here, it fails.
- **Tippmann Group (ICP 53)** — 5 sites, 5 states, private and family-owned with minimal public disclosure. Tests the gap rate on exactly the account profile that dominates this vertical.

**Alternates**, in score order, if either hard case proves unworkable: Dairy Farmers of America (74 — 13 sites, a cooperative, so a genuinely different decision structure worth testing) and US Foods Holding Corp. (70 — 20 sites, 17 states).

Ten accounts score ≥70 in total; eight are taken and two are held as alternates.

Full scored list: `data/coldchain_rmp_accounts.csv`. Score distribution across the 114 prospects: max 97, median 36, **10 accounts ≥70**, 17 ≥55, 28 ≥45.

---

## 7. Pipeline — seven stages

Each stage below specifies input, logic, output and **failure mode**. Failure modes are not optional documentation; each one has a corresponding acceptance test in §16.

### 7.1 Ingest

**Input:** source configuration. **Output:** `source` rows with raw payloads retained.

Connectors run nightly and on-demand. Each is a separate module with the same contract: `fetch(params) -> list[raw_record]`, plus `provenance() -> {source, licence, retrieved_at, data_through}`.

`connectors/epa_rmp.py` is the reference implementation and is already built and tested. EDGAR, news, job-board and ECHO connectors follow the same shape.

**Failure modes:**
- *Source unavailable* → connector returns empty with an error record; pipeline continues on other sources; account is marked `degraded` rather than `researched`.
- *Schema drift* → the raw payload is retained, so a parser change can be replayed without re-fetching.
- *Rate limiting* → exponential backoff, three retries, then degrade. RMP ceiling is 10 req/s; we run at ~2.9.
- *Licence metadata dropped* → provenance is captured at fetch time and is non-nullable. A record without provenance is rejected, not stored.

### 7.2 Entity resolution

**Input:** raw facility/company records. **Output:** `account` + `account_alias` rows.

Three-pass resolution:
1. **Canonical rule table** (seeded in `epa_rmp.py`, stored in the database thereafter, maintained by the marketer). Handles the known-parent cases in §2.1.
2. **Normalised fuzzy match** — strip legal suffixes and punctuation, then match on token-set similarity above threshold. Catches variants the rule table has not seen.
3. **Human review queue.** Anything below threshold, or matching two candidates ambiguously, is surfaced with both candidates and the evidence. **It is never auto-assigned.**

**Numeric validation gate (from §2.2) — implemented and tested.** Every numeric field is checked against a distribution computed from the whole dataset. A value above `p99 × 10` is flagged `validated = false`, excluded from account aggregation and from ICP scoring, and written to the review queue with the triggering statistic. Without it, one mis-filed record representing 78% of all reported ammonia ranks above Hormel and Cargill.

Note the gate must scan **all** buckets, not only accounts that survive the pilot filter — otherwise the flagged record's account is filtered out and the loudest data-quality signal in the dataset silently disappears. This was a real defect found and fixed while building the connector.

**Name normalisation:** replace the minimum-length threshold with a stopword/junk check (`NA`, `N/A`, `UNKNOWN`, `-`) so short-acronym legal entities like `JDB` and `ACS` resolve. See §2.3.

**Customer suppression:** runs *after* resolution, against canonical names. Tested explicitly with the Americold and Lineage alias sets.

**Failure modes:**
- *False merge* (two different companies collapsed) → every alias is visible on the account record, so a marketer reviewing the account sees the merge and can split it. Merges are reversible.
- *False split* (one company in two accounts) → detected by the alias-similarity report, which lists candidate pairs above a lower threshold for human confirmation.
- *Customer not suppressed* → **blocking acceptance test.** The build does not ship if any of Americold, Lineage or US Cold Storage appears in an outbound-eligible list under any alias.

### 7.3 Signal detection

**Input:** `source` rows. **Output:** `signal` rows.

Extract dated events and classify: `compliance` · `leadership` · `capex` · `expansion` · `restructuring` · `power` · `regulatory` · `sustainability` · `intent`.

Every signal requires: a date, a classification, a source reference, and a **commercial translation** (`why_it_matters`). A signal without `why_it_matters` is stored but never surfaced — the field is what separates intelligence from a news feed.

Impact is scored on three axes: recency, materiality (does it move money or authority?), and proximity to a buying action.

**Failure modes:**
- *Hallucinated event* → impossible by construction: a signal must cite a `source_id` that exists, and the cited passage must be retrievable. Generation fails closed.
- *Duplicate detection across sources* → dedupe on (account, date, classification, title similarity).
- *Stale signal presented as current* → signals carry `occurred_on`, and the UI always shows it. Recency is in the impact score, not hidden.

### 7.4 Pain mapping

**Input:** `signal` rows + `fact` rows. **Output:** `pain` rows.

Each pain maps to one of Ndustrial's four platform pillars (0: real-time energy optimisation, 1: precision cold product storage, 2: grid volatility response, 3: shore power network expansion) and is severity-scored **1–5 on evidence strength, not on sales potential.**

Two behaviours are required and are acceptance-tested:
- **The engine must be able to say a pillar is a weak fit.** `pain.is_weak_fit = true` renders as *"weak fit — do not lead"* in the UI. Manufacturing a reason to sell all four pillars is a failure, not a feature.
- **Severity must trace to evidence.** A pain scored 5/5 must cite at least two independent facts. The scoring rationale is stored with the row.

**Failure modes:**
- *Pain inflation* → severity requires cited evidence; uncited pains cap at 2.
- *Generic pains* → a pain whose `evidence` text contains no account-specific token (name, site, figure, date) is rejected and re-generated.

### 7.5 Decision unit resolution

**Input:** company website, EDGAR proxy/officer filings, news, professional networks. **Output:** `person` rows.

Every person row is either resolved (with name, title, role in deal, angle, provenance, confidence) **or explicitly a gap** (with `gap_reason` and `resolution_path`). There is no third state.

Role-in-deal taxonomy: economic buyer · economic buyer (domain) · financial validator · technical champion · technical evaluator · influencer · end user.

**Failure modes:**
- ***Invented executive*** → **the most damaging possible failure.** Mitigated structurally: a `person` row with `confidence ≥ 2` requires a `source_id` whose `raw` payload contains the name string. Generation cannot produce a name that is not in retrieved text.
- *Stale title* → every person row carries `as_of`. Titles older than 180 days are automatically downgraded one confidence level and flagged for re-verification.
- *Gap silently omitted* → the UI renders gaps visually distinct (dashed border, amber) and the deliverable coverage report counts them.

Expected gap rate on this vertical: **~40% of decision-unit roles.** Measured on the three prototype accounts: 5 of 17 people rows were gaps (29%), and those were large public companies with strong disclosure. Private cold-storage operators will be worse. This is the single strongest argument for buying paid enrichment in Phase 2 — and Phase 1 exists partly to measure it precisely.

### 7.6 Deliverable generation

**Input:** the full account record. **Output:** `deliverable` rows at `status = draft`.

Each of the five templates (§9) declares: required sections, the `min_confidence` floor per field class, and which facts it consumes. Generation is templated synthesis over retrieved facts — the model arranges and phrases, it does not supply content.

Generation **fails loudly** when a required field falls below its confidence floor. Example: an outbound sequence requires the primary contact at confidence ≥2; if the primary contact is a gap, generation is blocked and `blocked_reason` records why. This is not a degraded output — it is a refusal, which is the correct behaviour.

**Failure modes:**
- *Unsupported claim in output* → post-generation verification pass re-checks every numeric and named entity in the rendered text against the `fact` table. Unverifiable claims are flagged for the reviewer rather than silently shipped.
- *Version drift* → deliverables reference the account record version. When underlying facts change, dependent deliverables are marked `stale` and queued, never silently edited.
- *Tone drift between accounts* → templates carry voice constraints; the review gate is the final control.

### 7.7 QA and confidence scoring

**Input:** everything above. **Output:** a published account record with a confidence profile.

Produces: a per-account confidence summary, the open-gap list, the stale-fact list, the outlier list from §7.2, and the deliverable coverage matrix.

**An account cannot be promoted to `published` with an open blocking gap.** Blocking gaps are: unresolved primary economic buyer, or any contact at confidence 1 who appears in an outbound-facing deliverable.

---

## 8. Confidence model

Three levels, applied per fact, enforced at generation.

| Level | Meaning | Admissible sources | May appear in |
|---|---|---|---|
| **3 — High** | Named primary source | Regulator publication, SEC filing, official press release, IR page, company website (for self-descriptive facts) | Everything, including prospect-facing outbound |
| **2 — Medium** | Single credible secondary source | Trade press, professional network profile, credible aggregator | Internal documents only, flagged for verification |
| **1 — Gap** | Unresolved, or resolved only from a stale/weak source | — | Published as an explicit gap with a resolution path. **Never in outbound.** |

**Enforcement rules:**

1. `deliverable.min_confidence` per field class, checked at generation. Outbound sequence: primary contact ≥2, company financials ≥3, quoted figures ≥3.
2. A confidence-2 person row is **auto-downgraded to 1** when `as_of` is more than 180 days old.
3. Numeric outliers (§7.2) are held at confidence 1 until a human validates them.
4. Every rendered deliverable displays its own confidence floor and the count of gaps that affected it.
5. Rep feedback marked `wrong` on a fact drops that fact to confidence 1 immediately and queues re-verification.

**Why this matters commercially, not just technically:** it is the honest answer to "won't the AI make things up?" The system is built so that it *cannot* fill a gap silently. Five of seventeen people rows in the prototype are published as gaps. That is the product working, not failing.

---

## 9. Deliverable templates (3 types)

Each template below is the exact section structure to build. The prototype (`../index.html`) contains fully-written reference examples for Kroger, Tyson and NewCold across all nine types — those are the quality bar. Three are built in Phase 1; the other six are specified and demonstrated but deferred.

**Why these three.** The Account Brief is the artefact a rep actually reads before working an account. The Executive One-Pager is what makes a time-critical approach possible. The Site Portfolio Analysis is the one no competitor can produce, because it is built on the RMP registry. Together they test every part of the hypothesis.

**Deferred to Phase 2:** Outbound Sequence, Discovery Call Guide, Battlecard, Business Case Model, Campaign Brief, Executive Letter, Social/LinkedIn. The Business Case Model already exists as a working interactive component in the prototype and can be handed over as reference code.

### 9.1 Account Brief — *the core artefact*
1. The thirty-second version (≤90 words, must contain a number and a date)
2. Why now (the buying window, with the clocks named)
3. The number that matters (KPI block)
4. Where we win — pain map (severity, pain, pillar)
5. Decision unit (name, role in deal, confidence, angle)
6. The wedge (proof point specific to this account)
7. Recommended plays, in order
8. Risk register and known gaps
9. Provenance

*Floor: financials ≥3, primary contact ≥2. Gaps allowed and must be listed in §8 of the brief.*

### 9.2 Executive One-Pager
1. Who they are and what they own right now
2. The question to put in front of them (one sentence, verbatim-usable)
3. What they care about — and what they do not (two-column lead-with / avoid)
4. Their likely first three objections, with responses
5. Relationship path (primary, validation, air cover, **missing**)
6. Recommended first move

*Floor: primary contact ≥2. One page. If it does not fit, it is wrong.*

### 9.3 Site Portfolio Analysis — *vertical-specific, enabled by §2*
This is the artefact that only this data source makes possible, and it is the reason cold storage is the right pilot vertical.

1. Facility table from RMP: site, city, state, RTO, ammonia charge, program level, accident history, submission count
2. Portfolio roll-up: total sites, total ammonia, geographic and grid concentration
3. **Grid exposure map** — sites by RTO, with the current capacity-price position for each
4. **Replacement-cycle signal** — accident history and RMP submission cadence as a proxy for refrigeration asset age and stress
5. Prioritised site list for a pilot deployment, with rationale
6. Data-quality notes, including any records held below validation

*Floor: RMP fields ≥3 (regulator-published). Any outlier-flagged record shown but marked.*

### Deferred templates — specified, not built

The Outbound Sequence, Discovery Call Guide, Battlecard, Business Case Model, Campaign Brief, Executive Letter and Social/LinkedIn templates are all fully written for Kroger, Tyson and NewCold in the prototype and can be lifted directly into Phase 2. The blocking rule that matters carries forward: **an outbound sequence must be refused, not degraded, when the primary contact is a gap.** With no paid enrichment in Phase 1, that rule would block outbound on most of the ten pilot accounts — which is precisely why it is deferred rather than built half-working.

---

## 10. UI scope

Built as two surfaces over one dataset.

**Marketing view** — Command · Build List · Research Queue · Account Intelligence · Deliverable Studio. Carries over from the prototype with these cuts: coverage matrix limited to the 3 built types, no multi-vertical switching, no campaign/letter/social, no Slack or DOCX export.

**Rep view** — one search box, a filtered list, the artefact, and two buttons: *"this was wrong"* and *"request a brief."* Deliberately minimal. If a rep needs training to use it, the pilot has failed.

**Carried over unchanged from the prototype:** the confidence display, the gap rendering, the live slider-driven business case, and the source list with per-source ratings. These are the features that make the output trustworthy and they are not negotiable.

---

## 11. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Application | **Next.js (App Router) + TypeScript** | One deployable, one language across UI and workers. The prototype is already single-file HTML/CSS/JS; porting it to Next.js is day 1 work, not a rewrite |
| Database | **Postgres** (managed: Supabase or RDS) | `jsonb` for raw payloads, full-text search covers Phase 1 retrieval. No vector DB yet |
| Job queue | **Postgres-backed queue** (pg-boss) | Avoids standing up Redis for a 25-account workload |
| LLM | Claude or GPT via API, **structured outputs / tool calling only** | Forces schema conformance; free-text generation is not used for facts |
| PDF/DOCX export | Puppeteer (PDF) + docx (DOCX) | Server-side, deterministic |
| Hosting | Vercel + managed Postgres | Zero ops overhead for a pilot |
| Connectors | **Python** (as built) invoked as scheduled jobs | The RMP connector is written and tested in Python; rewriting it in TypeScript for purity is wasted pilot time |

**Deliberately not chosen:** a vector database, a message broker, Kubernetes, a separate API tier, or a design system. All are correct decisions at Phase 3 scale and all would consume the pilot.

**Estimated LLM cost:** ~$1.50–$3.00 per full account research run at current pricing. 10 accounts × (1 initial + ~2 refreshes during tuning) ≈ **$50–$90 total for the pilot**, plus iteration overhead during template tuning — budget **$150** to be safe. Negligible against the fee. Worth stating explicitly in the pitch, because "AI costs" is a question every buyer asks and almost nobody has a real number for.

---

## 12. Ten-day build plan

Fixed scope. Each day has a **done-when** condition — if a day slips, scope comes out, the date does not move.

### Week 1 — data and intelligence

| Day | Build | Done when |
|---|---|---|
| **1** | Stand up the app from the prototype codebase (Next.js + TypeScript). Postgres schema per §5, migrations. Deploy to Vercel + managed Postgres. **OIDC integration against Ndustrial's IdP; `app_user`, `role_grant`, `session` tables (`AUTH-SPEC.md` §4–5).** Import the customer list and account ownership from the Ndustrial CSV. Seed the RMP dataset from `data/coldchain_rmp_seed.json`. | The screens render against a live database with real seeded data behind a real sign-in. Customer suppression is active. |
| **2** | Port `connectors/epa_rmp.py` behind the connector interface with nightly scheduling. Wire entity resolution and the numeric validation gate to the database. Build the human review queue UI. | A fresh connector run reproduces 117 accounts / 755 sites / 3 review-queue records. All 3 customers suppressed under every alias. |
| **3** | SEC EDGAR connector — 10-K, 10-Q, 8-K, DEF 14A (officers). Company website connector — leadership, sustainability, facility pages. Provenance capture on every record, licence metadata non-nullable. | All 10 pilot accounts have ≥8 sources with retrievable raw payloads and complete provenance. |
| **4** | News search connector. Signal detection with classification and impact scoring. Commercial translation (`why_it_matters`) generation. | Every pilot account has dated, classified signals, each with a commercial translation and a source reference. |
| **5** | Pain mapping to the four pillars with evidence-based severity. Weak-fit detection. Confidence scoring on every fact. | Pains severity-scored with cited evidence; ≥2 of the 10 accounts correctly show a weak-fit pillar; every fact carries a source and a confidence level. |

### Week 2 — deliverables and surfaces

| Day | Build | Done when |
|---|---|---|
| **6** | Decision unit resolution with explicit gap states and resolution paths. | All 10 accounts have a decision unit; every unresolved role is a stored gap with a reason and a path, never an omission. |
| **7** | The three deliverable templates (§9). Confidence floors enforced at generation with blocking and `blocked_reason`. | 10 account briefs generated. No deliverable contains a numeric claim absent from the fact table. |
| **8** | Post-generation verification pass (claims re-checked against the fact table). Versioning and stale-marking. Site Portfolio Analysis template with the RMP table, grid-exposure map and data-quality notes. | Deliberately corrupting one fact causes the verification pass to flag it. Site Portfolio Analysis renders for all 10 accounts. |
| **9** | Review gate — inline edit, approve, reject, re-version, publish. Rep view — search, read, "this was wrong", request-a-brief. CSV and PDF export. **Server-side authorization on every route; tier serializer with field omission; append-only `audit_log`; attribution written from session (`AUTH-SPEC.md` §7, §9).** | A marketer can take an account from `draft` to `published` without touching a database. A rep can find and open a brief in under 60 seconds. **A rep cannot reach a marketing screen by any client-side route — verified by direct URL and replayed request.** |
| **10** | Load the 10 accounts end-to-end. Run the full pipeline. Publish. Walkthrough and handover with the Ndustrial marketer and the two pilot reps. Brief them on the feedback flag. | 10 briefs published. Reps have credentials and know how to flag a problem. Written handover delivered. |

### The auth load, stated plainly

`AUTH-SPEC.md` §11 puts authentication and authorization at **~3.25 days** — roughly a third of a ten-day build. That is not padding; without it gate S1 cannot be satisfied, because the SalesIntel contract will ask how access to contact data is controlled and logged.

Three ways to absorb it, in order of preference:

1. **IdP integration is approved before day 1** (`AUTH-SPEC.md` §13). This is the 1–1.5 day path and the reason the estimate is 3.25 rather than 5.
2. **Cut the Site Portfolio Analysis deliverable**, per the cut order in §16. Recovers about a day and preserves the correctness criteria.
3. **Extend to 13 working days.** The honest option if neither of the above is available. What must not happen is shipping without server-side authorization, because the failure is invisible until it is not.

### The two weeks after handover

Days 1–10 build it. **The pilot measurement happens in the following two weeks**, when reps use the briefs on live opportunities. That measurement window needs no engineering time — only the marketer's ~2 hours per week and a 15-minute daily standup with the two reps. The Phase 2 decision document is written at the end of it.

The build delivers the working system and the handover. The measurement window is client-run — no engineering time is required during it, only the marketer's ~2 hours a week and a short daily standup with the two reps.

## 13. Risks

Ranked by measured evidence, not by intuition.

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| 1 | **Customer outreach disaster** — an existing customer queued for outbound | Confirmed failure mode: naive name matching misses `Americold Logistics, LLC` (88 sites) | Canonical resolution before suppression; blocking acceptance test in week 1; suppression list sourced from CRM, not hardcoded |
| 2 | **Invented executive or figure reaches a prospect** | Industry-standard LLM failure | Structural: facts require retrievable source text; confidence floors enforced at generation; post-generation verification pass; human gate before publish |
| 3 | **Data quality corrupts scoring** | Confirmed and quantified: one record at 89M lb (494× p99, 124× the largest legitimate charge) was 78% of all reported ammonia and ranked #15 of 111 | Validation gate **implemented and tested**; outliers excluded from scoring, retained, and written to `data/coldchain_rmp_review_queue.csv` |
| 4 | **High gap rate on private accounts** | Measured 29% on large public companies; cold storage is heavily private and family-owned | Publish gaps honestly; measure the real rate in the pilot; that number is the Phase 2 business case for paid enrichment |
| 5 | **Output good enough to read, not good enough to send** | The core pilot risk; unmeasurable before reps touch it | The two-week measurement window after handover exists solely to test this. Two reps, live accounts. The gate to Phase 2 is rep usage, not feature completeness |
| 6 | **RMP dataset staleness** | Data through 2025-12-30, ~8 months old at pull time | Acceptable for a facility registry (assets change slowly); re-pull quarterly; the 5-year RMP submission cycle is itself a useful signal |
| 7 | **Upstream API disappears** | rmpmap.org is a FOIA-derived community service, not an EPA product | Raw payloads retained locally on every pull; fallback is direct EPA RMP national data + Envirofacts DMAP API (`data.epa.gov/dmapservice/`), confirmed reachable during research (the older `data.epa.gov/efservice/` path is **dead** — 404 — so do not build against it) |
| 8 | **Scope creep inside a 10-day build** | Commercial pressure, not technical | §3 is explicit. Any addition moves the handover date. §16 names the cut order — third deliverable type first, then account count 10 → 8 |
| 9 | **Marketer review gate becomes the new bottleneck** | The failure mode we are trying to eliminate | Measure review time per account during the measurement window. Target ≤30 min. If it exceeds 45 min, templates are too verbose — fix the templates, not the process |

---

## 14. What we need from Ndustrial

**The compressed timeline makes these more critical, not less.** In a six-week build a late customer list costs a few days. In a ten-day build it costs the pilot. Every item below is blocking on the day stated.

| # | Need | From | Needed by | Blocks |
|---|---|---|---|---|
| 0 | **IdP confirmation** — Google Workspace or Entra ID, and an OIDC client registered | IT | **Before day 1** — IT tickets are not same-day. See `AUTH-SPEC.md` §13. |
| 0b | **Will SalesIntel contact data be loaded during the pilot?** If yes, `pii_grant` and per-contact consent move into the 10 days and something comes out | Sales leadership + Legal | **Before day 1** |
| 1 | **Authoritative customer list** — including subsidiaries, DBAs and acquired entities | RevOps + Sales leadership | **Day 1, before kickoff** | Day 1–2. Without it, customer suppression cannot be tested and no outbound-eligible list can be trusted. See risk #1. |
| 2 | **CRM export (CSV)** — accounts, contacts, opportunities, ownership | RevOps | **Day 1** | Day 1. Replaces live sync in this scope. |
| 3 | **Two named pilot reps** in cold storage, committed for the measurement window | Sales leadership | **Day 5** | Day 10 handover and the entire measurement window |
| 4 | **Three real deliverables to critique** — briefs, emails or decks reps actually used | Marketing | **Day 3** | Day 7 template build. Without a house reference, template voice is guesswork. |
| 5 | **Marketer availability** — ~6 hours across days 3, 7 and 9 | Marketing | Days 3, 7, 9 | Template quality and review-gate testing |
| 6 | **Approved proof points and their constraints** — which references may be named, to whom, in what framing | Marketing + Legal | **Day 6** | Day 7. Blocks the wedge section of every brief. |
| 7 | **Legal sign-off on CC BY-SA data use** and the required attribution wording | Legal | **Day 4** | Day 8. Blocks the Site Portfolio Analysis deliverable. |
| 8 | Security questionnaire for vendor onboarding | IT/Security | Day 9 | Deployment to a Ndustrial-accessible environment |

**The two that will slip and hurt most:** #1 (the customer list) and #3 (named reps). If #1 is not in hand on day 1, the honest options are to start the clock later or to build against a provisional list that is re-verified before any outbound use — and to record that caveat in the handover. If #3 is not settled by day 5, the measurement window cannot run and the Phase 2 decision will have no evidence behind it.

We will ask for #1 and #2 in writing before kickoff, not on day 1.

---

## 15. Data licensing and compliance

The RMP dataset is **CC BY-SA 4.0**, obtained by the Data Liberation Project from EPA under FOIA and served via rmpmap.org. Obligations that must be designed in, not bolted on:

1. **Attribution.** Any client-facing or published output derived from RMP data must credit both the Data Liberation Project and the EPA RMP Program. Implemented as a standing footer on the Site Portfolio Analysis deliverable and a `licence` field on every `source` row.
2. **ShareAlike.** Bulk redistribution of the data must remain CC BY-SA 4.0 or compatible. **We do not redistribute the dataset.** We store it, derive analysis from it, and share derived insights about specific accounts with Ndustrial internally. Legal should confirm this reading (dependency #7).
3. **No implied endorsement.** The data must never be presented as official EPA output. The Site Portfolio Analysis template carries a standing disclaimer: *"Source data is self-reported by facilities to EPA under the Risk Management Program and may contain errors or omissions."*
4. **Rate limiting.** API terms request ≤10 req/s. The connector runs at ~2.9 req/s with backoff.
5. **Self-reported data caveat.** EPA explicitly warns the data may contain errors. This is not a disclaimer to hide — it is the justification for the validation gate in §7.2 and should be shown to users.
6. **No prospect-confidential data.** Everything ingested in Phase 1 is public. This is a deliberate constraint: it is what makes unsolicited, specific outreach ethically and legally safe, and it should be stated plainly in the pitch.

---

## 16. Acceptance criteria

Phase 1 is complete when all of the following are measured and met. The correctness items are testable on day 10; the quality items are measured during the two-week client-run measurement window that follows.

### Correctness — automated, blocking
- [ ] All 3 known customers suppressed under **every** observed alias (Americold ×4, Lineage ×2, USCS)
- [ ] No `person` row at confidence ≥2 exists without a `source_id` whose raw payload contains the name string
- [ ] No deliverable contains a numeric claim absent from the `fact` table
- [ ] The 89M lb outlier is flagged, excluded from scoring, retained, and present in `coldchain_rmp_review_queue.csv`
- [ ] Short-acronym entities (`JDB`, `ACS`) resolve without human intervention; junk names (`NA`, `N/A`) still route to the queue
- [ ] Outbound sequences are **blocked**, with a recorded reason, for every account whose primary contact is a gap
- [ ] All 10 pilot accounts have ≥8 ingested sources with complete, non-null provenance including licence metadata
- [ ] Every account record shows its open gaps; zero gaps are silently omitted
- [ ] A fresh connector run reproduces the reference dataset: 117 accounts, 755 sites, 3 review-queue records

### Quality — human, measured during the two-week measurement window
- [ ] 10 account briefs published through the review gate
- [ ] **≥8 of 10 rated "usable as-is or with minor edits"** by the reviewing marketer
- [ ] Gordon Food Service produces a brief that honestly reports low signal — **it must not invent a buying window**. This is the negative test and it is a pass/fail criterion, not a nice-to-have.
- [ ] Median marketer review time **≤30 minutes** per account (target), **≤45** (hard ceiling)
- [ ] Both pilot reps independently rate the briefs **more useful than their current process**
- [ ] **≥3 live opportunities** worked using a published brief
- [ ] ≥1 rep-sourced correction that measurably improved a subsequent deliverable

### Outcome
- [ ] A written Phase 2 recommendation with: measured gap rate, measured review time, measured rep usage, and a costed enrichment decision

**The pilot fails if reps do not use it.** Not if the software has gaps — it will. If, given the choice, reps go back to asking the marketer, then the output is not good enough and Phase 2 should not proceed on the current design.

**Scope is the release valve, not the date.** If a day slips during the build, the third deliverable type (Site Portfolio Analysis) is the first thing cut, then account count drops from 10 to 8. The handover date and the acceptance criteria on correctness do not move. Cutting scope is recoverable; shipping an unverified customer-suppression list is not.

---

## 17. What Phase 2 looks like if this works

Not committed. Listed so the Phase 1 cuts in §3 are legible as deferrals rather than omissions, and so the pilot can be scoped against what comes next.

- All three verticals (adds manufacturing & food production, retail & food service)
- 100+ accounts, with the RMP connector extended to the full US registry (18,131 facilities) plus Title V air permits for sub-threshold sites
- Paid enrichment (Apollo or Clay) — **justified by the gap rate measured in the pilot**, not assumed
- All 9 deliverable types, including the outbound sequence and the marketing assets
- Live two-way CRM sync, Slack alerts, email digests, DOCX export
- Staleness engine with event-driven re-runs
- Signal weighting against win/loss outcomes

The pilot is designed so that Phase 2 can be scoped from measurement rather than from optimism. That is the real reason to keep it small.

---

*Companion artefacts: `../index.html` (working prototype — three fully researched live accounts, 18 generated deliverables, five working ingestion paths) · `INGESTION-GATES.md` (49 gate rules) · `AUTH-SPEC.md` (authentication, roles, data tiers, attribution integrity) · `what-is-this/` (first-run explainers) · `data/coldchain_rmp_accounts.csv` (114 real scored accounts) · `data/coldchain_rmp_sites.csv` (755 real facilities) · `data/coldchain_rmp_review_queue.csv` (5 records needing human judgement) · `connectors/epa_rmp.py` (built and tested connector)*
