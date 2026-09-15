# COLDPATH — Ingestion Gate Specification

**Purpose:** define every checkpoint data must pass before it is trusted, and every condition under which it is refused.
**Scope:** four data paths plus one specification path — CRM CSV, BD research reports, LinkedIn Sales Navigator capture, SalesIntel feed, and the SalesIntel field specification that governs it.
**Companion:** `../archive/index.html` (working in-browser implementation of all four paths) · `what-is-this/` (first-run explainers)

---

## 0. The principle behind all of this

A gate is not a validation rule. A validation rule asks *"is this well-formed?"* A gate asks **"should we believe this, and what are we allowed to do with it?"**

Three commitments follow from that, and they apply to every path below:

1. **Nothing enters without provenance.** Who supplied it, when, from where, under what licence. Non-nullable. A record without provenance is rejected, not stored with blanks.
2. **Nothing is silently overwritten, merged or dropped.** Every gate that discards, defers or conflicts writes to a review queue a human can see. The loudest problems must be the most visible.
3. **Refusing is a success state.** A gate that blocks bad data has worked. A gate that lets it through quietly has failed. The system is designed to fail loudly, and the acceptance tests target that behaviour specifically.

---

## 1. Universal gates — every path, every record

These nine run in order on everything, regardless of source. Source-specific gates in §2–§5 extend them; none replace them.

| # | Gate | Question it answers | Refusal behaviour |
|---|---|---|---|
| **G0** | **Provenance** | Who supplied this, when, from where? | Reject. No provenance, no storage. |
| **G1** | **Rights & licence** | Are we permitted to store and use this? | Reject and alert. Applies to CC BY-SA attribution duties, LinkedIn ToS, SalesIntel contract terms. |
| **G2** | **PII & sensitivity** | Does this contain personal data beyond business contact details? | Quarantine the field, keep the record. Flag for review. |
| **G3** | **Schema & shape** | Does it parse? Are required fields present and well-typed? | Reject the row, retain the file, report the row number and reason. |
| **G4** | **Entity resolution** | Which canonical account does this belong to? | Route to the human resolution queue. Never auto-assign on a low-confidence match. |
| **G5** | **Deduplication** | Do we already hold this? | Merge with version history, or version the record. Never silently replace. |
| **G6** | **Conflict detection** | Does this contradict what we already hold? | Surface both, with provenance and dates. Neither wins automatically. |
| **G7** | **Confidence assignment** | What trust level does this earn, and why? | Default to the lowest defensible level. Confidence is earned, never assumed. |
| **G8** | **Currency** | How old is it, and when does it expire? | Mark stale. Stale data is still usable as context but is visibly dated and cannot support outbound. |
| **G9** | **Human review trigger** | Does a person need to see this before it is used? | Queue it. The record exists but is marked `pending_review` and is excluded from generation. |

### G4 in detail — the gate that has already been proven necessary

Entity resolution is the highest-risk gate in the system and the only one with a measured, documented failure mode. In the live EPA RMP pull:

- **55 of 122 accounts (45%)** were filed under more than one legal name — 259 names collapsing to 122 accounts
- **Americold** appears as `Americold Logistics, LLC` (88 sites), `Americold` (8), `Americold Realty` (5), `Americold Realty Trust` (3)
- A naive exact-match customer blocklist **fails on the largest entities**, because `"Americold Logistics, LLC" != "Americold"`

The consequence of getting this wrong is not a bad score. It is **outbound contact to an existing flagship customer** — the reference account the entire cold-chain sales motion depends on. G4 therefore runs *before* customer suppression, against canonical names, and its acceptance test is blocking.

#### The opposite failure was found during the build, and it is worse than it looks

The first implementation resolved names by string similarity. It matched **`VersaCold Logistics` to the registry alias `Americold Logistics` at 0.79** — the edit distance between "versacold" and "americold" is only four characters. Because Americold is an existing customer, **VersaCold was silently suppressed as a customer and disappeared from the prospect list.**

VersaCold is Loblaw's cold-chain subsidiary and one of the larger prospects in the vertical. No error was raised, nothing landed in a queue, and the only symptom was a list that was one account shorter than it should have been.

Two lessons, both now encoded in the gate:

1. **Raw string similarity is never sufficient evidence for a merge.** A match now requires at least one shared **distinctive** token — compared against a generic-industry stoplist (`logistics`, `cold`, `storage`, `foods`, `wholesale`, `dairy`…) and a weak-discriminator list (`united`, `national`, `general`, `pacific`…). Typo tolerance is applied *only* to distinctive tokens, and only at ≥0.84 similarity.
2. **Customer suppression requires positive evidence, not a fuzzy hit.** C5 now suppresses only on an exact alias match or a distinctive-token match. A fuzzy similarity alone is routed to the human queue.

The same rule prevents the mirror-image error: `United Global Foods` and `United Natural Foods Inc.` share only the weak token "united", and are no longer at risk of merging into one account.

Both cases are regression tests in the build (§9, items 1 and 13).

Three passes, in order:
1. **Canonical rule table** — maintained by the marketer, stored in the database, seeded from known parent companies
2. **Normalised fuzzy match** — strip legal suffixes and punctuation, token-set similarity above threshold
3. **Human resolution queue** — anything below threshold, or matching two candidates ambiguously, is surfaced with both candidates and the evidence

A fourth rule: **a fuzzy hit is never enough on its own.** Where distinctive tokens overlap only partially, or two candidates score within 0.12 of each other, the record goes to the human resolution queue with both candidates shown. The engine does not pick.

A fifth, quieter rule: **short-acronym entities must not be rejected as junk.** Measured in the live pull — `JDB, Inc.` (BrucePac's reported parent) and `ACS-LLC` both normalise to three characters and were incorrectly routed to the review queue. The filter is a stopword-and-junk check (`NA`, `N/A`, `UNKNOWN`, `-`), not a minimum length.

### G6 in detail — conflicts are the product, not an error state

When a rep's LinkedIn paste says one thing and SalesIntel says another, the system does not pick a winner. It stores both, with dates and provenance, and surfaces the conflict to the marketer.

This is deliberate. Conflicts are **information**: a title that changed, a person who moved, a data provider whose 90-day cycle has lapsed. Suppressing them destroys the signal. The review queue item shows both values, both sources, both dates, and asks which is current.

### G7 in detail — confidence is earned

| Level | Earned by | May appear in |
|---|---|---|
| **3 — High** | Regulator publication, SEC filing, official press release, IR page, company website (self-descriptive facts), or **a level-2 record independently corroborated by any of these** | Everything, including prospect-facing outbound |
| **2 — Medium** | Trade press, professional-network profile, **rep-pasted LinkedIn capture**, **internal prior research**, SalesIntel record inside its verification window | Internal documents only, visibly flagged |
| **1 — Low / Gap** | Unresolved, stale beyond its expiry, single weak source, or a rep's interpretation rather than an observation | Published as an explicit gap with a resolution path. **Never in outbound.** |

Promotion is always evidence-driven: a level-2 record becomes level 3 when an *independent* source at level 3 confirms the same value. Demotion is automatic on expiry (G8) or on a rep marking it wrong.

---

## 2. CRM CSV — their current target list

**The path:** marketing exports accounts from Salesforce or HubSpot as CSV, drops the file in, maps fields once, and the engine ingests it.

**Why it is first:** this is the authoritative record of who they are already working, who owns what, and — critically — **who is already a customer.** Everything else is enrichment on top of it.

### Gates specific to this path

| # | Gate | Rule | Refusal |
|---|---|---|---|
| **C1** | **Delimiter & encoding** | Detect comma/semicolon/tab and UTF-8/Latin-1. Confirm against a sample before parsing. | Abort with a plain-language error; never parse into garbage. |
| **C2** | **Header detection** | First row must be headers. Detect and skip leading title/summary rows common in CRM exports. | Ask the user which row is the header. |
| **C3** | **Field mapping** | Auto-detect common names (`Account Name`, `Name`, `Website`, `Industry`, `Annual Revenue`, `Owner`, `Type`). Unmapped columns are offered for manual assignment. | Required fields unmapped → block ingestion, show what is missing. |
| **C4** | **Required fields** | Minimum viable record = account name. Everything else is enrichment. | Row rejected with its row number; file still ingests the valid rows. |
| **C5** | **Customer suppression** | Match every row against the canonical customer list **after** G4 resolution, including subsidiaries, DBAs and acquired entities. Suppression requires an exact alias match or a distinctive-token match — a fuzzy similarity alone is never enough. | Suppressed rows are retained and visibly listed — never silently deleted, so the marketer can audit every suppression. Fuzzy-only candidates go to the human queue instead. |
| **C6** | **Ownership** | Every surviving account has an owner or is routed to an `unassigned` queue. | Unassigned is a visible state, not a blank field. |
| **C7** | **Cross-source reconciliation** | Match CRM accounts against the RMP-resolved universe. Report: matched, CRM-only, RMP-only. | No refusal — this gate produces the whitespace report, which is often the most valuable output of the whole import. |
| **C8** | **CRM activity currency** | Capture last-activity and created dates. An account untouched for 12+ months is flagged. | Flag only. Stale CRM records are still real accounts. |
| **C9** | **Read-only guarantee** | The engine never writes back to the CRM in Phase 1. | Structural — no write credentials exist. |

### What C7 produces, and why it matters

Three lists come out of a CRM import, and only the first one is obvious:

- **Matched** — CRM accounts that also appear in the RMP registry. These get refrigeration-intelligence enrichment immediately.
- **CRM-only** — accounts they work that have no RMP filing. Either below the 10,000 lb ammonia threshold, non-US, or not refrigeration-intensive. Worth knowing, because it tells them which accounts the engine can enrich deeply and which it cannot.
- **RMP-only** — **accounts in their addressable market that are not in their CRM at all.** This is whitespace. In the live pull there are 111 such prospects, including Walmart (39 sites), Sysco (60), JBS USA (18) and C&S Wholesale Grocers (15).

That third list is the commercial argument for the whole exercise, and it only exists because the CRM import and the registry pull are reconciled against each other rather than stored separately.

---

## 3. BD research reports — past business development activity

**The path:** marketing drops in the documents they already have. They arrive **mixed** — the marketer's own prior account research alongside BD activity records, sometimes interleaved inside single files.

**Why this path is hardest:** these documents are authoritative-sounding, internally written, and often **old**. An account brief from 2024 reads with total confidence and is frequently wrong about everything that matters today. Treating them as facts is the single easiest way to poison the system.

### Gates specific to this path

| # | Gate | Rule | Refusal |
|---|---|---|---|
| **R1** | **Text extraction** | Extract text from PDF/DOCX/PPTX/TXT/MD/EML. Detect scanned-image PDFs with no text layer. | Scanned documents route to an OCR queue or are rejected with a clear reason. Never silently ingest an empty document. |
| **R2** | **Document classification** | Classify each document — and each section within long documents — as **prior research**, **activity record**, **mixed**, or **unclassifiable**. | Unclassifiable goes to a human sorting queue. **The engine does not guess.** Classification confidence is shown with the result. |
| **R3** | **Authorship & date** | Extract author and document date from metadata and content. If absent, ask. | A document with no date is ingested as `date unknown` and **cannot support any current-tense claim.** |
| **R4** | **Currency** | Compare document date to today. Prior research older than 12 months is historical context, not current fact. | Downgrade. Old research is cited as *"as of <date>"* everywhere it appears. |
| **R5** | **No-fact-creation** | A claim in an internal document **never** becomes a confidence-3 fact. Internal prior research caps at **confidence 2**, regardless of how authoritative it sounds. | Structural. The only route to level 3 is an independent external source. |
| **R6** | **Contradiction** | Where the document disagrees with current machine research, record both. Do not resolve. | Surface to the marketer as a conflict, with both dates. Often the most valuable output — it shows what changed. |
| **R7** | **Voice extraction (separate track)** | Prior research is also mined for house voice, terminology and framing — feeding deliverable templates. | This track creates **no facts at all.** It is stylistic. Kept structurally separate so style mining can never contaminate the fact store. |
| **R8** | **Activity-record attribution** | Call notes, meeting summaries and outreach logs are attributed to the rep and dated. Authorship is asserted by the session, not typed in (`AUTH-SPEC.md` §9). | Unattributed activity records are ingested as `unknown author` and flagged. |
| **R9** | **Play-already-tried** | Activity records are indexed so the engine can detect a recommended play that has already been attempted and failed. | Suppress or annotate the recommendation. A brief that recommends an outreach already made and rejected destroys rep trust instantly. |
| **R10** | **Win/loss linkage** | Where an activity record resolves to an outcome, link it. | This is the seed data for Phase 3 signal weighting. Captured now, used later. |

### R2 — how classification actually works

Two scores per document, from lexical and structural signals:

- **Prior research** markers: market analysis, competitive landscape, ICP, pain points, addressable market, 10-K references, revenue figures, executive bios, positioning
- **Activity record** markers: call notes, met with, spoke to, follow-up, objection raised, next steps, voicemail, email sent, attended, demo scheduled, no answer

Decision rule: the higher score wins **only if the margin exceeds a threshold.** Inside the margin → `mixed` (section-level classification attempted). Neither score meaningful → `unclassifiable`, human queue.

**The threshold is deliberately conservative.** Misclassifying an activity log as prior research promotes sales chatter into the fact store; misclassifying research as activity loses insight. The first error is worse, so the tie breaks toward the human queue.

### R5 — the rule that protects the whole system

This deserves emphasis because it is counter-intuitive and will be questioned.

Ndustrial's own research is written by a competent marketer who read the primary sources. It is often **better** than what the engine produces. So why cap it at confidence 2?

Because the engine cannot verify it. A confidence level is a statement about **traceability**, not about quality. An internal document's claims cannot be traced to a retrievable source passage by the system — only by the person who wrote it. Capping at 2 is not a judgement on the marketer; it is a statement that the machine cannot check the work.

The practical effect is mild and useful: prior research appears in internal deliverables, visibly attributed and dated, and it **corroborates** machine findings — pushing a level-2 machine fact to level 3 when both agree. It simply cannot, on its own, authorise something to be said to a prospect.

---

## 4. LinkedIn Sales Navigator — manual capture by reps

**The path:** a rep finds something in Sales Navigator, copies it, pastes it into a capture box. The engine parses it, attributes it, and files it.

**Why manual:** Sales Navigator caps exports at 25 leads per action with a 10,000 saved-lead ceiling, and automated collection violates LinkedIn's terms and risks account bans. Manual capture by a logged-in rep is the compliant path — and it has a side benefit: a human looked at it.

### Gates specific to this path

| # | Gate | Rule | Refusal |
|---|---|---|---|
| **L1** | **Manual-capture attestation** | Capture is one record at a time, initiated by a logged-in user. No bulk paste of search results exceeding a small threshold, no automated collection, no scraping. | Bulk input is refused with an explanation of why. This is a **ToS compliance gate, not a convenience.** |
| **L2** | **Attribution — captured by** | The capturing rep's identity, written **server-side from the validated session**. Not a request parameter, not editable, not self-selected (`AUTH-SPEC.md` §9). | Reject. An unattributed human capture has no provenance and fails G0. |
| **L3** | **Attribution — captured at** | Timestamp recorded automatically at paste, in the rep's local timezone, stored as UTC. | Reject if absent. |
| **L4** | **Attribution — source** | The profile or search URL, pasted alongside. If the rep cannot supply it, the capture is accepted but marked `source URL missing` and capped at confidence 1. | Degrade, don't reject — the observation may still be valuable, but it must be visibly weaker. |
| **L5** | **Field extraction** | Parse name, headline, company, location, connection degree, tenure. Each extracted field is individually marked **clean** or **inferred**. | Inferred fields are shown to the rep for confirmation before filing. Never filed silently on a guess. |
| **L6** | **Observation vs interpretation** | Every field is tagged as something the rep **saw on the profile** or something the rep **concluded**. Both cap at confidence 2, but the tag travels with the record permanently. | Structural. This is metadata, not a confidence tier — it tells a reviewer whether they are looking at a fact or a colleague's read. |
| **L7** | **Confidence ceiling** | Rep-pasted LinkedIn data is **confidence 2, always.** It cannot be filed at 3 by a human. | Structural. Promotion to 3 requires an independent level-3 source confirming the same value (see §1, G7). |
| **L8** | **Outbound block** | A confidence-2 contact **cannot** appear in any generated outbound sequence. | Generation is refused with the reason recorded. This is the gate that prevents an unverified title reaching a prospect. |
| **L9** | **Corroboration path** | Each level-2 record carries an explicit, actionable route to level 3 — e.g. *"confirm against the company leadership page"* or *"match against SalesIntel verified record."* | Not a refusal — a standing prompt. Turns a dead end into a task. |
| **L10** | **SalesIntel reconciliation** | Where the same person exists in SalesIntel, compare. Agreement raises both records' effective confidence; disagreement creates a G6 conflict. | Surface, never auto-resolve. |
| **L11** | **Decay** | LinkedIn profiles are updated irregularly and job changes are often not reflected for months. A capture expires at **180 days**, after which it auto-downgrades to confidence 1 pending re-verification. | Automatic, visible, and reversible on re-capture. |
| **L12** | **No storage of protected characteristics** | Reject any captured text containing apparent protected-characteristic data. | Quarantine the field, keep the rest, flag for review. |

### The attribution record

Every capture stores, permanently and immutably:

```
captured_by      the rep's identity, from session
captured_at      UTC timestamp, auto-set at paste
source_url       the LinkedIn profile or search URL
source_kind      'linkedin_sales_navigator'
capture_method   'manual_paste'
raw_text         exactly what was pasted, unmodified
extracted        the parsed fields, each marked clean|inferred
observation_vs   per-field: 'observed' | 'interpreted'
confidence       2 (ceiling; see L7)
corroborated_by  null until an independent level-3 source confirms
expires_at       captured_at + 180 days
account_id       resolved via G4, or null → human queue
```

`raw_text` is retained verbatim. If the parser is later improved, every historical capture can be re-parsed without asking the rep to do it again — and any extraction can be audited against what was actually pasted.

### Why the confidence ceiling is 2 and not 3

A rep looking at a profile with their own eyes is genuinely more reliable than a scraper. But **confidence measures traceability, not sincerity.** The system cannot re-check what the rep saw; it can only record that they saw it. Level 2 says exactly that: *a named human observed this, on this date, at this URL, and here is precisely what they pasted.*

That is a strong record — strong enough to work from internally, strong enough to corroborate other sources, and strong enough that promoting it to 3 later is a one-step check rather than a research project. It is simply not strong enough, on its own, to put a job title in front of a prospect.

---

## 5. SalesIntel — enrichment feed

**The path:** a contracted feed of verified B2B contact data, ingested on a schedule.

**What makes it different:** SalesIntel is the only inbound path with a **published verification cadence** — a 90-day human re-verification cycle, with a 95% accuracy claim. That cadence is a feature the engine should exploit rather than ignore.

### Gates specific to this path

| # | Gate | Rule | Refusal |
|---|---|---|---|
| **S1** | **Contract & permitted use** | Confirm what the contract allows us to store, for how long, and whether derived analysis may be shown to third parties. Satisfying this presupposes access control and retrieval logging — `AUTH-SPEC.md` §7 and §11. | Block ingestion until Legal confirms. Recorded against every ingested record. |
| **S2** | **Verification-window tracking** | Each contact carries its SalesIntel verification date. Inside 90 days → confidence 2. Outside → confidence 1 pending refresh. | Automatic downgrade on expiry. Visible on the record. |
| **S3** | **Accuracy-claim scepticism** | A 95% published accuracy rate is a portfolio statistic, **not a property of any individual record.** No record inherits the aggregate claim. | Structural. Sampling audits measure our actual observed accuracy over time. |
| **S4** | **Contact-detail handling** | Emails and mobile numbers are PII. Store, gate access, log retrieval, suppress from exports. Implemented as tier **T3** in `AUTH-SPEC.md` §7: a `pii_grant` row plus an ownership check, with every read written to an append-only audit log. Unauthorized fields are **omitted from the response, not masked** — a masked address still confirms the record exists. | Fields quarantined by default; surfaced only to the account owner, `sales_lead` or above. |
| **S5** | **Outreach consent** | Before any email or phone number is used for outbound, confirm a lawful basis exists — recorded as `consent_basis` on the `pii_grant` row (`AUTH-SPEC.md` §5). A PII field with no consent basis is readable for research but cannot generate outbound. | Block outbound generation for that contact until confirmed. |
| **S6** | **Refresh cadence** | Re-pull on a schedule shorter than the 90-day verification cycle, so a lapsed record is caught by us before it is caught by a bounced email. | Stale records flagged, not deleted. |
| **S7** | **LinkedIn reconciliation** | Compare against rep captures for the same person. Agreement is corroboration; disagreement is a G6 conflict surfaced to the marketer. | Never auto-resolve. |
| **S8** | **Deduplication across feeds** | The same person may arrive from SalesIntel, LinkedIn and the CRM. Resolve to one person record with multiple sources. | Unresolved duplicates queue for human review. |

### S2 and S7 together — the interesting case

SalesIntel verifies on a 90-day cycle. LinkedIn captures decay at 180 days. When both sources hold the same person and **agree inside their respective windows**, the effective confidence of the title rises — two independent channels, both current, saying the same thing.

That agreement is what promotion to level 3 should look for when no filing or press release exists. It is not a substitute for an independent level-3 source, but it is the strongest evidence available for a private-company executive who appears in no public filing — which describes a large share of this vertical.

**Recommended rule for Phase 2:** SalesIntel-current + LinkedIn-current + agreement on title = confidence 3 for internal use, still 2 for outbound until a public source confirms. This is a judgement call worth surfacing to the client rather than deciding silently.

### 5.1 Path 5 — the field specification that governs path 4

Path 4 is a data feed. Path 5 is the **agreement about what that feed contains**, and it exists because the gates in §5 cannot be evaluated against an unknown schema. It is configuration, not a second data source — but it has its own screen, its own first-run explainer and its own gate results, because getting it wrong silently degrades everything downstream.

The specification assigns every field one of six classes:

| Class | Meaning | Consequence |
|---|---|---|
| **critical** | A gate cannot function without it | Ingestion blocked until supplied |
| **required** | Records are unusable without it | Row rejected |
| **pii** | Personal contact data | S4 gating, S5 consent, suppressed from exports |
| **request** | Not standard, high value | Prompted for, never assumed |
| **optional** | Useful enrichment | Accepted if present |
| **refused** | No legitimate use | Quarantined at ingest whatever the spec says |

#### The field that decides whether the feed is usable at all

`verification_date` is the only field marked **critical** on its own authority. SalesIntel's differentiator is the 90-day human re-verification cycle. **If the export omits the date each record was verified, gate S2 cannot function** — every contact becomes effectively undated and must be treated as confidence 1, which quietly renders the whole feed unusable for outbound.

This is the easiest line item in the entire specification to overlook, because it is metadata about the data rather than data. It should be requested by name, in writing, before the contract is signed.

#### Provider naming variants must not create false absences

A feed that sends `Verified At`, `Job Title` or `Company Name` satisfies the critical requirement just as well as one that sends `verification_date`, `current_title` or `company`. The specification therefore matches each critical requirement against a list of **acceptable alternatives**, and indexes provider naming variants into that check.

This was a real defect found during the build: the first implementation matched alternatives only against its own field dictionary, so `Verified At` was reported as *unrecognised* and `verification_date` as *missing* — a false absence that would have blocked an adequate feed and sent the client chasing a field they were already supplying.

#### Fields worth requesting that are not standard

- **technologies** — an incumbent BAS/EMS detection (Johnson Controls Metasys, Honeywell Niagara, Schneider EcoStruxure) changes the opening conversation from *"do you have an EMS?"* to *"how is your Metasys performing?"* That is a materially different sales motion.
- **intent_topics** — a prospect actively researching energy management or refrigeration is a dated, attributable buying signal that feeds straight into signal detection.
- **naics_codes** — an **exact** join key to the EPA RMP registry. Without it, matching SalesIntel accounts to refrigeration sites relies on name similarity alone, which is precisely the failure mode the VersaCold defect demonstrated (§1).
- **previous_title** — a title change is the strongest job-change signal available and should trigger re-verification of the account's decision unit.
- **legal_name / parent_company** — catches the subsidiary and DBA problem at source rather than inferring it.

#### Refused whatever the spec says

Demographic and protected-characteristic attributes (raw *or* inferred), personal non-business contact details, and any field whose only purpose would be to infer one of these are quarantined at ingest by G2 and L12. A client spec that requests them is overridden, not honoured.

---

## 6. The review queues — where refusals go

Nothing is discarded. Every gate that refuses, defers or conflicts writes here, and the marketer sees a single ranked list.

| Queue | Fed by | Typical volume | Action required |
|---|---|---|---|
| **Entity resolution** | G4, C5, S8 | Low, but high-stakes | Assign to an account, merge, or create a new one |
| **Unclassified documents** | R2 | Moderate on first bulk import | Sort into prior research / activity record / discard |
| **Conflicts** | G6, L10, S7 | Grows with sources | Decide which value is current; both are retained either way |
| **Expired records** | G8, L11, S2 | Predictable, cyclical | Re-verify or archive |
| **Numeric outliers** | validation gate | Rare | Confirm or correct the value |
| **Unassigned accounts** | C6 | Low | Allocate an owner |
| **Outbound blocked** | L8, S5 | Per-contact | Resolve the contact, or accept the block |
| **PII quarantined** | G2, L12, S4 | Should be near zero | Review and release or delete |
| **Below threshold** | G9, pilot filter | 27 on the RMP pull | Confirm whether it is a prospect; approving admits it |
| **Merge rescues** | G4 pattern guards | Near zero, high-stakes | Confirm the two companies really are separate |

In the live RMP run this machinery was already exercised end-to-end: **31 records** landed in review (1 numeric outlier, 2 unresolved names, 27 below threshold, 1 merge rescue), including the 89,000,000 lb marine-terminal filing that would otherwise have ranked #15 of the prospect list.

### 6.1 Below threshold — the largest category of silent refusal

The pilot filter admits multi-site operators, or single sites above an ammonia floor. Everything else was **dropped with no record**: 354 of 472 resolved companies on the current pull. That is not a rounding error at the edge of the dataset, it is the biggest refusal the system performs, and it performed it silently — which made "nothing is discarded" untrue.

Two changes, because one number could not do both jobs:

- **The pilot floor came down to 100,000 lb** (from 250,000). At 250,000 the filter admitted exactly *three* single-site companies out of 357 — in practice "multi-site only" rather than a floor — while excluding genuine prospects whose single in-scope RMP filing understates the business. Smithfield Fresh Meats (88,000 lb), Charoen Pokphand Foods (110,000 lb) and Mitsubishi (82,000 lb) are not small companies.

- **The 50,000–100,000 lb band is queued, not admitted.** Below 100,000 the data quality falls off sharply, and it falls off in ways a person spots instantly and a rule does not: operator names that are actually individuals, facility codes filed as company names, and a duplicate Perdue. Admitting that band unreviewed would have put **named private individuals into a prospect registry** — a G2 concern, not untidiness.

Lower floors do not help. The EPA reporting threshold is 10,000 lb, so the dropped set is dense at the bottom: a 25,000 lb floor queues 120 records and a queue that size goes unread, which is silent dropping wearing a hat.

**On approval**, a queued company becomes an ordinary account — ICP-scored, outbound-eligible like any other — carrying a flag that records it entered below the pilot floor. The flag is what later answers whether the queue is finding real business or just noise. *(The approval step itself needs the M2 review UI; the connector emits the queue rows and the rule is specified and tested now.)*

### 6.2 Merge rescues — recording a near-miss, not just preventing it

Gate G4's pattern guards stop a name being absorbed into the wrong canonical account. `us cold storage` is a substring of "Sod-us cold storage", so before the guards **Sodus Cold Storage Co. was filed under United States Cold Storage — an existing customer — and suppressed from outbound**, with no error and no queue entry.

The guard prevents that now. But prevention is *silent*: the only evidence is a prospect list one company longer, which is exactly as unreadable as the original bug. So when a guard fires, the record goes to the queue naming the account it escaped and whether that account is a customer.

The detector compares **bucket keys, not canonical names**, and the distinction is load-bearing. "SCHWANS COMPANY" looks rescued on names — the guard moves it from the rule path to the fallback path — but normalisation maps both to the same key, so it lands in the same bucket and nothing was rescued. Comparing names reports two hits on the current pull; comparing keys reports the one that is real.

---

## 7. Gate coverage matrix

| Gate | CRM CSV | BD reports | LinkedIn paste | SalesIntel | Field spec |
|---|:---:|:---:|:---:|:---:|:---:|
| G0 Provenance | ✓ | ✓ | ✓ | ✓ | ✓ |
| G1 Rights & licence | ✓ | ✓ | ✓ | ✓ | ✓ |
| G2 PII & sensitivity | ✓ | ✓ | ✓ | ✓ | ✓ |
| G3 Schema & shape | ✓ | ✓ | ✓ | ✓ | ✓ |
| G4 Entity resolution | ✓ | ✓ | ✓ | ✓ | ✓ |
| G5 Deduplication | ✓ | ✓ | ✓ | ✓ | — |
| G6 Conflict detection | ✓ | ✓ | ✓ | ✓ | — |
| G7 Confidence assignment | ✓ | ✓ | ✓ | ✓ | — |
| G8 Currency | ✓ | ✓ | ✓ | ✓ | — |
| G9 Human review trigger | ✓ | ✓ | ✓ | ✓ | — |
| C1–C9 (CRM-specific) | ✓ | — | — | — | — |
| R1–R10 (report-specific) | — | ✓ | — | — | — |
| L1–L12 (capture-specific) | — | — | ✓ | — | — |
| S1–S8 (feed-specific) | — | — | — | ✓ | ✓ |

**49 distinct gate rules.** Ten universal, plus 9 + 10 + 12 + 8 source-specific. Path 5 adds no new rules — it is the configuration surface that determines whether path 4's S-gates can be evaluated at all.

**Authentication caveat.** The prototype's PIN gate is **obfuscation, not authentication** — both codes are in the page source and the session is a `localStorage` entry. Gate L2 in the prototype is satisfied by a self-selected name after a shared code, which makes captures distinguishable but not attributable. `AUTH-SPEC.md` specifies what replaces it, and why L2, R8, S1, S4 and S5 all depend on real server-asserted identity.

**Implementation status:** all five paths are working in the browser in `../archive/index.html` — real CSV parsing, real field mapping, real entity resolution against the 114-account registry, real LinkedIn field extraction with attribution, real document classification, real verification-window evaluation, and real field-specification parsing with alternative-name matching. Sample fixtures with deliberate faults are built into each path so the gates can be watched firing rather than taken on trust.

**The review queue is unified.** Refusals, deferrals and conflicts from all five paths and from account research land in one severity-ranked list, surfaced both on the Ingest overview and on the Command dashboard. A gate whose output is only visible on a screen nobody opened is not a gate.

---

## 8. What is explicitly out of scope for these gates

- **Automated LinkedIn collection.** No scraping, no browser automation, no bulk harvest. L1 exists to prevent it, not to manage it.
- **Prospect-confidential data.** Everything ingested is either public, contractually supplied, or created by Ndustrial. No third-party confidential material is ever accepted.
- **Writing back to the CRM.** C9 is structural — no write credentials exist in Phase 1.
- **Inferring protected characteristics.** L12 refuses the field. There is no legitimate use for it in this system.
- **Auto-resolving conflicts.** G6 never picks a winner. A human does.

---

## 9. Acceptance tests for the gates

The build does not ship until all of these pass. Each corresponds to a real, measured failure mode rather than a theoretical one.

1. **Customer suppression survives aliasing.** `Americold Logistics, LLC`, `Americold`, `Americold Realty` and `Americold Realty Trust` are all suppressed against a customer list containing only "Americold Realty Trust". *(Blocking.)*
   - **…and does not over-reach.** `VersaCold Logistics` is **not** suppressed and does **not** resolve to Americold, despite an edit distance of four characters. This is the measured regression from §1. *(Also blocking.)*
2. **A CRM CSV with 3 malformed rows ingests the valid rows** and reports the 3 failures by row number and reason.
3. **A LinkedIn paste with no source URL is accepted at confidence 1**, visibly marked, and cannot reach outbound.
4. **A LinkedIn paste cannot be filed at confidence 3 by any user action.** *(Blocking — structural, per L7.)*
5. **A 2024 account brief is ingested as historical context**, dated, capped at confidence 2, and every claim from it renders with "as of 2024".
6. **A document that cannot be classified lands in the human sorting queue** — it is not silently assigned to a category.
7. **A scanned PDF with no text layer is rejected with a clear reason**, not ingested as an empty document.
8. **A SalesIntel contact outside its 90-day window auto-downgrades** to confidence 1 and appears in the expired queue.
9. **Where SalesIntel and a LinkedIn capture disagree, both are retained** and a conflict is raised. Neither is overwritten.
10. **An outlier numeric value is excluded from scoring, retained, and surfaced** — reproducing the 89M lb case exactly.
11. **Bulk paste into the LinkedIn capture box is refused** with an explanation referencing the manual-capture rule.
12. **Nothing writes to the CRM.** Verified by absence of credentials, not by configuration.
12b. **Attribution cannot be forged.** No request parameter, header or body field can set `captured_by` to anyone other than the session user (`AUTH-SPEC.md` §12, item 3).
12c. **A company dropped by the pilot filter is queued, not discarded**, when its charge is above the review floor — and approving it admits it as an account flagged sub-threshold. *(Gate G9; §6.1.)*
12d. **A guarded near-miss is recorded.** Where a pattern guard stops a name merging into another account, the record appears in the queue naming that account and whether it is a customer. `Sodus Cold Storage Co.` must appear there naming `United States Cold Storage`. Detection compares bucket keys, so `SCHWANS COMPANY` — which normalises to the same key either way — must **not** appear. *(Blocking; §6.2.)*
12e. **One company does not become two on a spelled-out legal suffix.** `Perdue Farms Incorporated` and `Perdue Farms, Inc.` resolve to a single account.
13. **Distinct companies sharing only a generic or weak token do not merge.** `United Global Foods` / `United Natural Foods Inc.`, `Penske Logistics` / `VersaCold Logistics`, and `Vertical Cold Storage` / `Sodus Cold Storage` must each resolve independently or route to the human queue.
14. **An unanchored duration is never filed as a clean tenure.** A LinkedIn "About" blurb reading *"18 years across ammonia systems"* must not be extracted as role tenure; only a duration anchored to the current role's date range may be marked clean. Everything else is marked `inferred` and shown for confirmation.
15. **A SalesIntel spec missing `verification_date` blocks S2** with the reason stated, and the request text names the field explicitly.
16. **Provider naming variants satisfy the critical check.** A spec supplying `Verified At`, `Job Title` and `Company Name` must not report `verification_date`, `current_title` or `company` as missing. This is the measured false-absence defect from §5.1.
17. **Refused categories stay refused** even when the client spec explicitly requests them.
18. **Every gate refusal appears in the unified queue**, tagged with its gate and its path, severity-ranked, and visible on the Command dashboard — not only on the screen that produced it.

---

*Companion artefacts: `../archive/index.html` (working in-browser implementation of all five ingestion paths, with live gate results) · `what-is-this/` (first-run explainers, one per process) · `AUTH-SPEC.md` (authentication, roles, data tiers, attribution integrity) · `PHASE-1-SPEC.md` (build specification)*
