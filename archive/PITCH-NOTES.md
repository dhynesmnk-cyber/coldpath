# COLDPATH — prototype walkthrough notes

**What it is:** a working prototype of an account-intelligence engine for Ndustrial's go-to-market team, plus a costed Phase 1 pilot build.

| Artefact | What it is for |
|---|---|
| `index.html` | The interactive prototype. Open in any browser — fully self-contained, no network, no build step. Runs offline from a laptop or a USB stick in a meeting room. |
| `one-pager.html` | **The leave-behind.** One printed A4 page: the problem, the mechanism, the live data proof, the $10,000 / 2-week offer, and what we need from them. Print or save as PDF. |
| `phase1/PHASE-1-SPEC.md` | The buildable engineering spec — 18 sections, ten-day plan, acceptance criteria. |
| `phase1/INGESTION-GATES.md` | **49 gate rules** across five paths, with refusal behaviour and 18 acceptance tests. |
| `phase1/what-is-this/` | Five standalone first-run explainers, one per path, generated from the same source object as the in-app panels so they cannot drift. |
| `phase1/connectors/epa_rmp.py` | A **working, tested connector** that pulls the real addressable market. Not a diagram of one. |
| `phase1/data/*.csv` | **114 real scored accounts, 748 real sites** — usable before Phase 1 starts. |

**New since the pitch meeting:** the prototype now has **working in-browser ingestion** across five paths — a new *Ingest* section in the left nav. Real CSV parsing and field mapping, real entity resolution against the 114-account registry, real LinkedIn field extraction with attribution, real document classification, real verification-window evaluation, and a real field-specification parser. Sample fixtures with deliberate faults are built into every path, so you can watch the gates fire rather than describe them.

**Also new:** the unified review queue is now surfaced on the **Command dashboard** as "Needs your judgement", severity-ranked, drawing from all five paths *and* from account research. A gate whose output is only visible on a screen nobody opened is not a gate.

**What is real vs. simulated:** the *research is real*. Every signal, date, dollar figure, executive name and source across the three deep accounts was gathered from public sources and is traceable to a citation inside the app. The *target list is real* — the Build List screen renders an actual EPA RMP pull. The *plumbing is simulated*: LLM calls, CRM sync and the review-gate state machine are represented by baked-in data so the prototype runs standalone.

---

## The ingestion demo — do this second, it is the newest thing

Open **Ingest → CRM Target List** and click *Load a sample export*. The sample is 15 rows with faults planted in it on purpose. Walk the gate results top to bottom:

- **C5** suppresses `Lineage Logistics LLC` and `AmeriCold Logistics LLC` as existing customers — both filed under aliases that a naive string match would miss
- **G3** rejects one blank row, by row number, and still ingests the valid ones
- **C6** flags four accounts with no owner
- **C8** flags Tippmann Group as untouched for 557 days
- **C7** produces three lists: 8 matched, 4 CRM-only, and **103 whitespace accounts** in their addressable market that are not in the CRM at all

Then **Ingest → Sales Navigator** → *Load a sample*. Point at the field table: every field is tagged `clean` or `inferred`, and separately `observed` or `interpreted`. Click the tags — they toggle. Note that tenure reads **3 yr 7 mo**, not the "18 years" that appears in the About section: the extractor only marks a duration clean when it is anchored to the current role. Then show the immutable attribution record on the right, and the confidence ceiling — **level 2, with no code path that can raise it.**

Then **Ingest → BD Reports** → load both samples. One classifies as prior research and gets flagged **912 days old**, so it becomes historical context capped at confidence 2. The other classifies as an activity record and indexes **two failed outcomes** for play suppression. Click *Try a scanned PDF* to watch R1 refuse it with a reason and route it to the extraction queue rather than ingest it empty.

Then **Ingest → SalesIntel**. Two gates are blocking by default — S1 legal sign-off and S5 outreach consent. Click them to clear. Show that Robert Kelleher's verification lapsed 192 days ago and auto-downgraded to confidence 1, while Jane Whitfield at 21 days holds confidence 2, and that her record reconciles against the LinkedIn capture you filed a minute ago.

Finally **Ingest → SalesIntel Field Spec** → *Load a typical spec (with faults)*. It maps 12 fields, then reports **one critical omission: `verification_date`** — and generates the request text to send back. This is the moment to make the point below.

Then go back to **Command** and point at *Needs your judgement*. Every refusal from every path is in one severity-ranked list, blocking items first. That is the answer to "how do we know it isn't quietly dropping things?"

## The SalesIntel point worth making early

SalesIntel's entire differentiator is the **90-day human re-verification cycle**. Gate S2 depends on knowing *when* each record was verified.

**If their export omits `verification_date`, every contact arrives undated and must be treated as confidence 1** — which quietly makes the whole feed unusable for outbound. It is the easiest line item in the specification to overlook, because it is metadata about the data rather than data.

Ask for it by name, in writing, before the contract is signed. The field-spec screen generates that request for you.

Two other fields worth requesting that are not standard: **`technologies`** (an incumbent Metasys or Niagara detection turns the opening line from *"do you have an EMS?"* into *"how is your Metasys performing?"*) and **`naics_codes`** (an exact join key to the RMP registry, instead of relying on name similarity — which is the exact failure mode the VersaCold bug demonstrated).

## Two bugs we found in ourselves

Both are worth telling. A vendor who can describe the defects they found in their own system, why each mattered, and what changed, is more credible than one claiming there aren't any.

### The VersaCold bug

This is the single most persuasive thing in the whole build, because it is a failure we found in ourselves.

> The first version of the entity resolver matched names by string similarity. It matched **VersaCold Logistics** to the registry alias **Americold Logistics** at 0.79 — the edit distance between "versacold" and "americold" is five characters. Americold is an existing customer, so **VersaCold was silently suppressed and vanished from the prospect list.** No error, no queue item. The only symptom was a list one account shorter than it should have been.

VersaCold is Loblaw's cold-chain subsidiary — a genuine top-tier prospect in this vertical. The fix now requires a shared *distinctive* token, filtered against generic-industry words (`logistics`, `cold`, `storage`, `wholesale`) and weak discriminators (`united`, `national`, `pacific`), and customer suppression requires positive evidence rather than a fuzzy hit.

It is also the concrete answer to *"how do we know it won't quietly delete accounts?"*

### The false-absence bug

The field-spec parser originally matched alternative provider names only against its own dictionary. A client sending `Verified At` got told the field was **unrecognised**, and `verification_date` was reported **missing** — a false absence that would have blocked an adequate feed and sent them chasing a field they were already supplying.

Fixed by indexing provider naming variants into the critical-requirement check. Both defects are now regression tests (acceptance tests 1b, 13 and 16).

The pattern is the same in both cases: **the failure was silent.** Nothing errored. A list was one account short; a spec reported a field absent that was present. That is why every gate in this system writes to a visible queue instead of resolving quietly.

## The screens, and what each one proves

| Screen | Proves |
|---|---|
| **Command** | The marketing person stops being a request queue. Signals, pipeline and recommended plays in one place. |
| **Build List** | Top-of-funnel is systematic, not ad hoc. 412 accounts ingested → 26 scored to ICP, with exclusions and their reasons shown, not hidden. |
| **Research Queue** | The seven-stage pipeline is visible and auditable, including the stage an account is currently stuck on. |
| **Account Intelligence** | Research depth: signals carry a *commercial consequence*, pains are mapped to Ndustrial's four platform pillars and severity-scored on evidence strength. |
| **Deliverable Studio** | Breadth: nine artefact types across sales and marketing, generated from one research run. The coverage matrix shows exactly what exists and what is blocked. |
| **Rep Library** | The consumption surface. Deliberately simpler — marketing builds and approves, reps search and read. |
| **How It Works** | Architecture, the confidence model, staleness handling, and a phased build plan. |
| **Business Case** | The arithmetic of the bottleneck, with live sliders. |

---

## A five-minute demo path

1. **Command** — open on the live signal feed. Point at Kroger's DOJ/EPA settlement and say *"this was detected in May, and the engine knew within hours that a new Chief Store Operations Officer starting in September would inherit it."*
2. **Build List → the EPA RMP callout.** This is the differentiator. Every US facility holding >10,000 lb of anhydrous ammonia must file a public Risk Management Plan. That is a near-complete enumeration of Ndustrial's entire addressable market, free, and no competitor is using it.
3. **Account Intelligence → Kroger → Signals.** Each signal has *why this matters commercially*, not just what happened.
4. **Pain map.** Note the Shore Power pillar scored 3/5 and explicitly flagged "weak fit — do not lead." The engine refuses to manufacture a reason to sell.
5. **Decision unit.** Two of six roles are published as **gaps** with a recommended resolution path. Say: *"it did not guess a name. That is the whole product."*
6. **Deliverable Studio → Business Case Model.** Drag a slider. Everything recomputes. This is the artefact you hand a CFO.
7. **Business Case screen.** Drag `accounts per rep` to 50 and watch coverage collapse. Then make the point below.

---

## The line that closes it

> At six reps and thirty accounts each, keeping the list researched demands **2,160 hours a year**. The marketer has roughly **720 hours** available for it. That is **3× over capacity** — so only **60 of 180 accounts** ever get researched, and the other 120 are worked blind.
>
> This is not a productivity problem. It is arithmetic, and arithmetic does not respond to working harder.

Then be honest about the return: reclaimed time is worth ~$39K/year against ~$44K of running cost — **the hours alone do not repay the build.** The return is coverage and revenue. At a $750K enterprise ACV, the entire year-one build is repaid by **0.44 deals**. Kroger and Tyson are both $750K-plus conversations.

Do not oversell the time saving. Ndustrial's own brand is *guaranteed savings, verified by real people* — an inflated internal business case would be off-brand and they will spot it.

---

## Why these three accounts

Chosen to span Ndustrial's three stated verticals and to demonstrate the engine handling genuinely different situations:

**The Kroger Co. (NYSE: KR)** — Retail & Food Service. Fit 94, P0, published.
The hero account. Three synchronised clocks: a $100M / 600-unit federal retrofit obligation (May 2026 DOJ/EPA settlement), a new Chief Store Operations Officer starting 14 September 2026, and an FY2027 budget cycle closing in Q4. Underlying it all: a 0.7% net margin and PJM capacity prices up 11.4×. The wedge is that **Lineage — a Kroger 3PL partner — is already a named Ndustrial reference.**

**Tyson Foods (NYSE: TSN)** — Manufacturing & Food Production. Fit 88, P0, in review.
Demonstrates the engine finding a non-obvious insight. Three beef plants closed in nine months. The angle is *not* energy savings — it is that redistributed volume silently re-rates the receiving plants into higher demand tiers, and that plants running below design throughput during the cattle shortage operate at their worst part-load efficiency, so **energy cost per pound rises while the monthly bill looks like good news.** Note the engine's judgement call: sustainability is flagged as the *wrong door* at Tyson.

**NewCold** — Cold Storage & Logistics. Fit 91, P1, mid-research.
Demonstrates the engine reasoning about a *changed* situation. EPA's 26 May 2026 rule extended the cold-storage HFC transition deadline from Jan 2026 to **Jan 2032** — which kills the obvious compliance pitch. The engine detects this and reframes: the extension frees discretionary capital, and the real play is that a $275M facility is being commissioned into a power market that repriced 11.4×. Sharpest angle: **verified kWh-per-pallet-position is a bid-winning asset** against Lineage and Americold.
Also deliberately shown mid-run, with an unassigned CRM owner and two unresolved contacts, so the "queued / blocked" states are visible rather than hidden.

---

## Numbers to have ready

- **11.4×** — PJM capacity clearing price, $28.92/MW-day (2024/25) → $329.17/MW-day (2026/27)
- **$100M / 600 units / 24 months** — Kroger's DOJ/EPA settlement obligation
- **0.7%** — Kroger FY2025 net margin, so **$1 of energy saved ≈ $143 of sales**
- **$54.4B** — Tyson FY2025 sales; **$1,098M** operating income weighed down by **$738M** of legal accruals
- **39%** — Tyson Q3 FY2026 operating income growth, i.e. cost-out has executive air cover *now*
- **$275M** — NewCold's Hagerstown MD investment, in PJM territory
- **1 Jan 2032** — the extended cold-storage HFC deadline that removes compliance urgency
- **$113M** — energy spend Lineage avoided on Nsight; the single best proof point available
- **35% / 10%** — share of US / global temperature-controlled food passing through Ndustrial-monitored sites

---

## Raise these before they do

The prototype deliberately surfaces its own weaknesses. Volunteer them — it is far more credible than being caught.

1. **Private companies are harder.** NewCold's CFO and engineering leadership could not be resolved from public sources. Expect a higher gap rate on private accounts, which is what paid enrichment (Apollo/Clay) buys in phase 2.
2. **Contact data needs a paid source.** Public research resolves *roles* reliably and *named individuals* inconsistently. Eric Taylor's Kroger title is Medium confidence, inferred from a professional profile.
3. **Savings figures are models, not measurements.** Every ROI number uses published benchmarks and deliberately conservative assumptions. A verified baseline requires deployment.
4. **The human gate is not optional.** The engine cuts research from hours to minutes; it does not remove the marketing review. Budget 20–30 minutes per account, not zero.
5. **It will get things wrong.** The confidence model exists so errors are visible *before* they reach a prospect. That is the difference between this and "paste an account into ChatGPT."

---

## The close — Phase 1

**$10,000 fixed fee · 10 working days · solo engineer, full time.** 50% on kickoff, 50% on handover. ~$200 of infrastructure and LLM cost passed through at cost.

- One vertical: cold storage & logistics
- **10 accounts** — the 8 highest-scoring prospects plus 2 deliberate hard cases
- **3 deliverable types:** Account Brief, Executive One-Pager, Site Portfolio Analysis
- All 7 pipeline stages, confidence model, review gate, rep library
- 4 connectors: EPA RMP (**already built**), SEC EDGAR, company web, news
- CSV in, CSV/PDF out
- Then a **two-week client-run measurement window** — no engineering time billed

**Gate to Phase 2:** 10 briefs published, ≥8 rated usable as-is or with minor edits, ≥3 live opportunities worked from a published brief, median review time ≤30 min.

### Answer the obvious objection before they raise it

*"How is a 6-week build now 2 weeks for a fifth of the price?"*

It is not a discount. It is a different scope, and it is credible because **roughly 40% of the hard work is already done and de-risked** — the full UI exists as a working prototype, and the two hardest components (the RMP connector and the entity-resolution logic) are built and tested against live data. What remains is integration, not invention.

Say this out loud. Underpricing without an explanation reads as desperation; underpricing *with* a structural explanation reads as preparation.

### The two things that will sink the timeline

Both are client-side and both are needed on **day 1, before kickoff**:

1. **The authoritative customer list** — including subsidiaries, DBAs and acquired entities. Without it, customer suppression cannot be tested. This is the same failure mode the real data already demonstrated: `Americold Logistics, LLC` (88 sites) does not string-match "Americold".
2. **A CRM CSV export** — accounts, contacts, opportunities, ownership.

Ask for both in writing before kickoff, not on day 1.

### Scope is the release valve, not the date

If a day slips, the Site Portfolio Analysis is cut first, then account count drops from 10 to 8. The handover date and the correctness acceptance criteria do not move. Cutting scope is recoverable; shipping an unverified customer-suppression list is not.

---

## The live data — lead with this if the room is technical

The Build List screen is not a mockup. It renders a real EPA RMP pull from 11 September 2026:

- **1,382 facilities** across 9 cold-chain NAICS codes → **114 accounts, 748 sites, 43 states**
- **111 prospects**, 3 existing customers correctly suppressed
- **24.5M lb** of validated anhydrous ammonia inventory
- Top by ICP score: Walmart (97), Sysco (94), JBS USA (91), United Global Foods (86), Tyson (84), C&S (83), Kroger (79), Albertsons/Safeway (75)

Two findings to tell as stories, because they prove engineering rigour rather than asserting it:

**Entity resolution.** 51 of 114 accounts (45%) were filed under more than one legal name. Americold appears four ways. A naive blocklist would have queued an 88-site flagship customer for outbound.

**Dirty data.** One facility — a *marine terminal* in Beaumont, Texas — declares 89,000,000 lb of ammonia. That is 445× the p99 and **78% of all ammonia reported in the entire raw pull**. Unvalidated it ranked #15 of 111 prospects, above Hormel and Cargill. The validation gate flags it, excludes it from scoring, retains it, and writes it to a human review queue.

Then hand over `phase1/data/coldchain_rmp_accounts.csv`. It is a usable target list they keep whether or not they buy anything. That is the strongest possible close.
