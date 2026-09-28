# JEV / TypeSafe integration plan — COLDPATH top-of-funnel

Skill used: `typesafe-ai` (https://github.com/typesafe-ai/skills — read directly
from raw SKILL.md rather than installing via npx, since this repo has no agent
tooling to install into; re-fetch before implementation). Live docs at
docs.typesafe.ai were read while writing this plan — primitives, confidence,
composite-scoring, confidence-routing, entity-alignment, pre-parsed-value-extraction.

## 0. What JEV is, and the one-line fit test

Jev is a System One model: you send it **state** (JSON) plus narrow typed
questions (**Choice** = pick one of a defined set, **Score** = position on
ordered descriptive levels, **Noul** = probability of yes), and it returns
calibrated probabilities instead of text. Code owns the workflow; Jev supplies
programmable common sense exactly where ordinary code needs semantic
understanding.

Fit test for this repo: *where does the pipeline currently guess with regexes,
cap scores because inference is unconfirmed, or queue work for humans?* Those
are the seams. The water connector was built with deliberate honesty gaps —
"an unconfirmed inference must never outvote physics" — and every gap is a
named place where a calibrated judgment could legally raise or lower confidence
without touching the arithmetic gates.

## 1. What NOT to use it for (guardrails first)

| Temptation | Why refused |
|---|---|
| Replace `est_peak_kw`, p99×10 outlier gate, customer suppression | Known rules, calculations, exact lookups stay in code. A language model must never veto an ingestion gate. |
| Let Jev write the ICP total | Policy stays explicit: Jev returns raw judgments; `icp_score()` composes them. Changing weights/thresholds must not rerun inference (composite-scoring pattern). |
| Free-text generation of briefs into the dataset | Typed output guarantees the interface, not truth; anything prospect-facing keeps human sign-off (PRODUCT-PLAN review culture). |
| Single mega-question "is this a good target?" | Destroys the triangle. Ask independent dimensions over shared state; speculative fan-out costs tokens. |

## 2. Use cases, ranked by value ÷ effort

### UC-1 — Buffer/sheddability classifier (the flagship) ★ build first
The water connector caps sheddability at 15/25 unless `buffer_confirmed`,
because tank presence is *inferred* from facility name + NAICS. That cap exists
for exactly one reason: our evidence was weak. Jev turns weak evidence into a
**calibrated** judgment with an auditable rationale-shaped distribution — the
one sanctioned way to earn back points without lying.

Design (per account, one request, questions are independent):
- State: `{"account": name, "sites": [{name, city, state, naics, chlorine_lb}…]}`
- **Score `buffer_class`** — levels written as concrete situations:
  "name states elevated storage/pumping station feeding a pressurised network",
  "name states treatment works with wet-well/inflow capacity",
  "mixed portfolio needing per-station audit", "no buffer evidence".
- **Noul `process_continuous`** — "could any listed site plausibly be a
  continuous thermal process (kiln, furnace, paper machine, distillation train)
  that must never be curtailed?" → a *second-axis* tripwire feeding the
  exclusion pass (see UC-4).
- **Noul `operator_is_regulated_utility`** — supports channel_fit.
Composition in code: high-confidence elevated-storage ⇒ allow the inferred 12
path AND mark `buffer_review="jev"` so a human confirms in bulk; low
confidence ⇒ straight to review queue. The 15-cap only lifts on *human*
confirmation, but Jev changes **who reviews what, in what order** — that alone
makes the 732-account list triageable.

Why flagship: it attacks the vertical's acknowledged weakest link, reuses data
we already pulled, and demos the pitch line "the engine still refuses to guess,
but now it guesses *calibrated*".

### UC-2 — Entity-resolution adjudicator (review queue + alias assignment)
Regex canonicalisation produced 9 `unresolved_name` rows ("C.P.W.S.D. # 2 of
Ray County", "St. Martin Parish Water Treatment Plant") and merged American
Water across 8 parent strings by hand-written patterns. This is the documented
entity-alignment cookbook applied to utility registries:
- **Choice `assign_account`**: options = candidate existing accounts (retrieved
  in code by state/NAICS/name-token shortlist — check candidate coverage!) plus
  `"NEW_ACCOUNT"` no-match outcome.
- Companion **Nouls** surfacing which fields disagree (county vs parent vs
  trade-name), mirroring the beer-catalogue cookbook.
Value: converts the review queue from "open a spreadsheet" to "approve a
ranked list"; each accepted adjudication becomes a new deterministic rule we
can promote into the regex layer later (Jev bootstraps code, doesn't replace it).

### UC-3 — Trigger relevance reranker (EXPANSION-PLAN §3 feeds)
Once RFPs/rate cases/ESCO awards are scraped, dedupe-by-hash stays in code;
then, per signal × account pair: **Score `buying_window_strength`** ("names
this operator AND pump/lift-station scope AND peak > $ threshold" … "generic
hygiene"). One question per pair, batched via parallel-questions pattern
(12× cheaper/faster per the GDPR cookbook); code sets the display threshold.
This is what makes the demo's "trigger ticker" honest at scale.

### UC-4 — Exclusion-pass net, confidence-gated
Current regex exclusions caught Koch fertilizer misfiles, a pulp mill, a
refinery. Regex precision/recall is unknown here — dangerous direction is a
false *inclusion*. UC-1's `process_continuous` Noul runs on everything that
passes regex; probability ≥ τ ⇒ hard review tag (never auto-drop — serious
violations need separate conditions, not compensation).

### UC-5 — Brief composer verifier (later phase)
When Account Briefs get drafted, **Noul `claim_supported`** per bullet against
the cited source span (citation-check cookbook). Keeps the "every number has a
provenance string" promise machine-checked.

### UC-6 — Natural-language list filtering (app UI, cheap win)
User types "big deregulated Texas authorities with recent incidents" →
function_calling-cookbook pattern: Choice picks filter, typed args fill it.
Nice for the Ndustrial demo day; zero funnel risk.

## 3. Prototype slice (what "built" means)

1. `phase1/connectors/jev.py` — thin Python-SDK wrapper (server-side key only),
   prompt/criteria definitions for UC-1 (+UC-2 if time), retries, cost log.
2. `phase1/jev_triage.py` — reads `water_rmp_seed.json`, runs UC-1 over the
   **top 50 accounts by current icp_score**, writes
   `data/water_jev_triage.csv`: account, current score, jev buffer class +
   probability + confidence, agreement-with-regex flag, disposition
   (`keep / human-review / demote`). Deterministic-first: same run twice,
   compare disagreement rate to ground-truth spot checks.
3. Success metric stated before running: agreement with the existing heuristic
   on clear cases, *and* a nonempty set of low-confidence cases correctly routed
   to review. If Jev merely reproduces the regex, ship nothing; if it finds
   real elevated-storage plants the regex missed (hypochlorite-named sites, the
   known registry blind spot), that's the demo money-shot.
4. Demo wiring: add `jev_flags` into `water_rmp_seed.json` as a third panel
   beside the existing cold-chain/water lists — labels show "judged, pending
   confirmation" so the honesty story survives the pitch.

Budget guardrail: ~50 accounts × 3 questions ≈ 1–2 batched calls/account;
measure actual tokens (skill says measure, don't assume). No Jev call may block
the nightly CSV build — run async after ingestion, degrade gracefully offline.

## 4. Sequencing

Week 1: UC-1 prototype + eval harness (slice above). Week 2: UC-2 on the full
review queue; UC-4 as regression test on the 8 known exclusions. Only after
both clear a labeled-sample accuracy bar: UC-3 when the first trigger feed
lands. UC-5/6 are app-phase items, tracked in BACKLOG.md style tickets.

## 5. Resolution log

**Q1 — "AI in scoring vs triage" → ANSWERED 2026-09-29: Option B.** Consequences were
expanded first (§5.1), then the choice made: Jev judgments may feed `icp_score()`
as *inputs*, composed by code under versioned mapping rules. The four acceptance
conditions listed under Option B in §5.1 are now **preconditions, not caveats** —
the machinery must exist before any judgment-derived point ships (see §5.3).
Option C remains refused regardless. Q2=NO still applies underneath: a
Jev-influenced score can rank and badge, but outbound eligibility keeps
requiring human confirmation or deterministic qualification (§5.2 rule 5 is
superseded where noted in §5.3; all other §5.2 rules stand unchanged).
**Q2 — "May judged-but-unconfirmed accounts enter outbound?" → ANSWERED: NO.**
This is now a hard pipeline rule, not a policy suggestion. See §5.2 for what it
concretely forbids and where it is enforced.

### 5.1 Q1 explained: why the scoring-vs-triage distinction matters

The question sounds procedural. It is actually a decision about who owns the
number that decides where salespeople spend their day — and each answer has
different failure modes, audit stories, and re-run costs.

**Option A — Jev stays out of scoring entirely (triage only). ← this plan's default**
`icp_score()` remains pure deterministic code; Jev only sorts work for humans
(review-queue ordering, alias adjudication shortlists, buying-window flags).
- *Consequence when right:* every score is reproducible and explainable to a
  prospect ("your pumps are 8 MW, you're in ERCOT, your tower gives you
  inertia"). Changing weights never reruns inference — composite-scoring pattern.
- *Consequence when limiting:* sheddability stays capped at 12/15 for hundreds
  of accounts whose buffer evidence is actually obvious-to-a-human. The list
  tops out at ~63–69 with only 2 accounts ≥70. Ndustrial SDRs work a flat,
  conservative list; triage throughput improves but ranking quality doesn't.

**Option B — Jev judgments feed scoring as inputs (still composed by code)**
Jev returns raw probabilities; `icp_score()` maps them through explicit,
versioned rules (e.g. `buffer_class="elevated"` ∧ p≥0.85 ∧ conf≥0.7 ⇒ treat as
inferred-elevated at full 12 without waiting for human queue; p<τ ⇒ demote).
- *Consequence when right:* the cap problem solves itself at scale — calibrated
  judgment earns points instead of regex guessing them, and the 732-account
  list becomes genuinely rankable. This is the highest-value version of UC-1.
- *Consequences to accept before choosing it:*
  1. **Reproducibility:** scores become a function of model + prompt version.
     Nightly builds must pin both and store the response hash (same discipline
     as `source_license` provenance strings) or month-over-month deltas stop
     meaning anything.
  2. **Silent drift:** a model update can shift the whole distribution without
     any code change. Needs a fixed eval set (the 8 known exclusions + 50
     hand-labeled accounts) run on every version bump, like a regression suite.
  3. **Audit story changes:** "why is this account 74?" now includes "a judge
     said X with probability p." Fine internally; risky if a municipal customer
     ever asks how they were selected. Mitigation: keep Jev-derived components
     visible and labeled in the Account Brief, never laundered into "data."
  4. **Cost/latency coupling:** ingestion currently must not depend on an LLM
     call. Option B forces the async-after-ingestion design in §3 permanently.

**Option C — Jev writes the total score directly (one mega-question).**
Refused outright in §1 regardless of anyone's appetite: it destroys the ROI
triangle, makes weights un-tunable, and lets a language model veto physics.
Included here only so the boundary is documented, not negotiable later.

**Practical framing for Ndustrial:** the real ask is *"what error do you fear
more — a good account sitting at 63 forever, or a bad account at 74 getting a
sales email?"* If the second, stay in Option A. If they want Option B, we add
the version-pinning + eval-set machinery first, and the two-tier confirmation
rule from §5.2 still applies underneath it.

### 5.2 Q2 = NO: what "judged-but-unconfirmed cannot reach outbound" enforces

Given the answer, the invariant becomes: **outbound eligibility requires either
(a) a purely deterministic qualification path, or (b) a human confirmation
flag. Jev output alone can never satisfy either.** Concretely:

1. **No auto-promotion of `buffer_confirmed`.** The field flips to `True` only
   via human action (bulk-confirm UI or review-queue approval). Jev's best case
   is `buffer_review="jev_high_confidence"` — a queue *ordering tag*, worth zero
   outbound eligibility. UC-1's "allow the inferred 12 path" therefore means:
   Jev agrees with the regex so the human confirms faster, not that Jev confirms
   it.
2. **Outbound gate check.** Any export feeding sequences/SDR lists filters on
   `qualification_basis ∈ {"deterministic", "human_confirmed"}`. Accounts whose
   only positive signal is Jev-judged are excluded from the export but remain
   visible in the app with a "judged, pending confirmation" badge (matches the
   §3 demo-labeling decision — the honesty story survives the pitch precisely
   because the badge blocks the send).
3. **UC-2 alias adjudications inherit the same rule.** A Jev-chosen merge is
   provisional: the merged account inherits `qualification_basis="jev_adjudicated"`
   (ineligible) until a human approves the merge, at which point it upgrades to
   `human_confirmed`. Approved adjudications get promoted into the regex layer
   (bootstraps-code principle) so future runs qualify deterministically.
4. **UC-4 exclusion tags are asymmetric-safe under this rule.** Jev can only
   *add* review burden (tag suspected continuous-process sites), never clear it.
   Since clearance already requires human sign-off, Q2=NO costs us nothing here.
5. **Score caps under Option A + Q2=NO** read: `sh ≤ 15` unless
   `buffer_confirmed`, and Jev's entire legitimate value surface was review
   ordering, merge shortlists, trigger relevance display, and label bootstrap.
   ~~That is still enough to make the 732-account list triageable~~ → superseded
   by the Q1=Option B decision; see §5.3 for the revised cap rule. All other
   rules in this section (1–4) stand unchanged.

Next step (done 2026-09-29): folded into EXPANSION-PLAN §7 item 6, and written
into `phase1/INGESTION-GATES.md` as gate **C10** ("judged-but-unconfirmed never
exports") so it's enforced by the same suppression-gate mechanism as customer
suppression rather than by convention. (Numbered C10, not the originally
anticipated C6, because C6 "Ownership" already exists in that table.)

### 5.3 Q1 = Option B: the implementation contract (decided 2026-09-29)

Option B is chosen, which converts §5.1's four "consequences to accept" into
**preconditions that must ship before any judgment-derived score point does**.
Ordered build sequence — none of steps 1–4 exist yet; UC-1 prototype (§3) runs
against them, not around them:

1. **Version pinning + provenance.** Every Jev response stored with
   `(model_version, prompt_version, request_hash, response_hash)` in a sidecar
   table (`jev_judgments`), joined to accounts at scoring time. Nightly CSV
   build reads judgments from the sidecar; it never calls the model inline
   (preserves "ingestion must not block on an LLM call", §3 budget guardrail).
2. **Eval-set regression gate.** Fixed labeled set: the 8 known continuous-
   process exclusions from the water pull + 50 hand-labeled accounts (mix of
   elevated-storage / wet-well-only / unknown-buffer). `icp_score()` output on
   this set is snapshotted per run. A model or prompt version bump that shifts
   more than N labeled scores (N declared *before* first bump, same
   pre-declared-metric discipline as §3) fails the gate → judgments are
   quarantined and scoring falls back to last-pinned version. This is the
   silent-drift defense; without it Option B is not allowed to ship.
3. **Mapping rules as code, versioned.** The judgment→points mapping lives in
   one function with an explicit `SCORING_RULES_VERSION` constant, e.g.:
   - `buffer_class="elevated"` ∧ p≥0.85 ∧ conf≥0.70 ⇒ sheddability cap lifts
     from 15 to **20/25** (never 25 — full marks still require human confirm);
   - `buffer_class="wet_well_only"` ⇒ cap stays 12 regardless of p (physics:
     wet-well inertia is hours, not the half-day+ we need);
   - agreement between Jev and the regex ⇒ flag `confirm_candidate=True`
     (speeds human queue, changes nothing else);
   - disagreement (Jev high-confidence contradicts regex) ⇒ demote to review
     queue head, cap 10. Judgment can always *lower* trust; lifting requires
     the calibrated-high path above.
4. **Audit labeling.** Any component derived from judgment renders in the
   Account Brief and Build List as `judged · v<rules_ver> · p=0.xx`, never
   laundered into "data". Month-over-month score deltas compare only within the
   same `SCORING_RULES_VERSION`; cross-version deltas show "n/c".
5. **Revised cap rule (supersedes §5.2 rule 5):** `sh ≤ 15` unless
   `buffer_confirmed` **or** the §5.3(3) calibrated-high path applies (cap 20).
   `buffer_confirmed` itself still flips only via human action — Q2=NO is
   untouched: Option B changes *ranking*, never *outbound eligibility*. Gate C10
   in INGESTION-GATES.md remains exactly as written; no export-rule change.

Expected effect on current data: accounts like American Water (22 sites,
regex-inferred elevated storage on several) move from flat 63–69 toward the
low-to-mid 70s if — and only if — Jev agrees at p≥0.85 and the eval gate
passes. That is the honest upside pitch; the downside risk is now owned by
steps 1–2 rather than by hope.

Remaining open sub-question (was flagged in EXPANSION-PLAN §7 item 6): cost
ceiling for re-running the sidecar after each version bump (~732 accounts ×
3 questions per refresh; measure tokens, don't assume).
