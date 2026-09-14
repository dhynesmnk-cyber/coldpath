# COLDPATH — Build Plan: Full Backlog

**Scope:** all 68 backlog items, less the two you excluded. **Companion:** `BACKLOG.md` (the itemised menu, IDs referenced throughout).

### Your three notes, applied

| Item | Decision | Effect on the plan |
|---|---|---|
| **E7 read receipts** | Build it. Visible to Madeline only, nobody else. | In scope, Package 4. Scoped to the `marketing` **role**, not hardcoded to one person — see §2.1 for why that distinction matters. |
| **I2 debounce search** | Not required yet | **Removed.** Revisit at I1 if the registry expands to the full 18,131-facility set. |
| **J5 shareable links** | Defer | **Removed.** Also the safer call — it needs `AUTH-SPEC.md` §7 tiering to be real first. |

**Net scope: 66 items** — the backlog's 68 unique IDs, minus I2 and J5. The three defects in `BACKLOG.md` §0 (A1, A2, A3) are ordinary backlog items and are scheduled in Packages 0 and 9 like everything else.

---

## 1. The dependency finding — read this before the plan

Five Phase 1 acceptance criteria cannot be met by the system as it stands today. They are not "nice to haves that came later"; they are already in the signed-off pilot gate.

| Phase 1 acceptance criterion | Blocked by | Why |
|---|---|---|
| Day 9: *"a marketer can take an account from draft to published without touching a database"* | **D1** | Approve & publish is currently a toast. There is no editor. |
| Quality gate: *"median review time ≤30 min per account"* | **D1** | You cannot measure review time on a review that cannot be performed. |
| Quality gate: *"both reps rate it more useful than their current process"* | **E8** | There is no mechanism to capture the rating. |
| Day 9: *"a rep can find and open a brief in under 60 seconds"* | **C1** | All six library filter buttons fire a toast and do nothing. |
| Your requirement: *"access the library easily from any browser"* | **A2 + E1** | Zero `@media` rules. On a phone the library is unusable. |

Plus one that is not an acceptance criterion but will contaminate the measurement: **H1**. If reps spend the two-week measurement window clicking buttons that lie to them, the "is this more useful than your current process" answer is already decided.

### 1.1 What this means for the 10-day pilot

Pulling the full versions of those six items forward costs roughly **6.5 engineer-days** — which does not fit in a 10-day build. So: **pull forward a minimal version of each, and build the full version in its package later.**

| Item | Minimal version for the pilot | Full | Pilot cost |
|---|---|---|---|
| D1 | Approve / reject / plain-text edit of the rendered brief, saved as a new version | Rich inline editing, section-level, with validation | 1.0 d (vs 2.5) |
| A2 + E1 | Responsive breakpoints on the Rep Library only | Responsive across all 14 screens | 0.75 d (vs 2.5) |
| C1 | Wire the six filter buttons to real predicates | Faceted, saved, persisted filters | 0.25 d |
| E8 | 👍 / 👎 plus one optional line, stored per deliverable | Rating trends, per-rep, feeding signal weighting | 0.4 d |
| A1 | Fix the three contrast failures | — (it is already complete at that point) | 0.25 d |
| H1 | Audit all 22 stubs; implement the 5 the pilot needs, **disable the rest with a visible reason** | Every stub resolved properly | 0.5 d |
| | | **Total added to pilot** | **3.15 d** |

**Recommendation: extend Phase 1 from 10 to 13 working days.** The alternative is invoking the cut order in `PHASE-1-SPEC.md` §16 and dropping the Site Portfolio Analysis deliverable — which is the one artefact no competitor can produce, so I would extend rather than cut it.

This is a decision, not a detail. It needs an answer before day 1.

---

## 2. Sequencing principles

1. **Foundations before features.** Responsive framework, URL state and the contrast fix touch every screen. Doing them late means doing every other item twice.
2. **Data model changes before UI that depends on them.** F3 (claim→source traceability), D2 (version diff) and K6 (signal→deliverable graph) all require schema changes. Those go early in their packages, not at the end.
3. **The review workflow is the product's centre of gravity.** Package 3 is the largest and the least deferrable — the entire premise is "machine drafts, human judges," and today the human half is a button that toasts.
4. **Nothing ships without a verification line.** Every package below ends with a testable "done when."
5. **Accessibility is not a final package.** A3 sits in Package 9 for the deep work, but ARIA labels and focus order are added *as each screen is touched* in Packages 0–8. Retrofitting accessibility onto 14 finished screens is why it usually doesn't happen.

### 2.1 On E7: role, not person

You asked for read receipts visible to Madeline only. The implementation should scope to the **`marketing` role**, with Madeline as its current holder — not to her user id.

Hardcoding one person means the feature breaks the week she is on leave, and it puts a named individual into access-control logic where a role belongs. `AUTH-SPEC.md` §6 already defines `marketing` as the role that owns the review gate; read receipts belong to the same authority. Functionally identical today, correct in six months.

One implementation note worth recording: reads are logged in `audit_log` either way (§5 of the auth spec), so the data exists regardless. E7 is a *view* over data already being captured, which is why it is only 0.75 d.

---

## 3. The ten packages

Effort assumes one engineer. **S = 0.25 d · M = 0.5–1.0 d · L = 1.5–3.0 d**, adjusted per item where the backlog label understates the work.

### Package 0 — Foundations · 3.5 d · *no dependencies*

| ID | Item | d |
|---|---|---|
| A1 | Contrast: fix the three AA failures (`--txt3` dark and light) | 0.25 |
| A2 | Responsive framework — breakpoints, fluid grids, collapsible table columns | 1.5 |
| B1 | URL state — hash routing for view/account/tab/deliverable, back button works | 1.0 |
| I4 | Memoise research records between navigations | 0.25 |
| H1 | Stub audit — classify all 22 buttons: implement / disable-with-reason / remove | 0.5 |

**Done when:** the app is legible on a 360px viewport; refresh and back preserve position; AA contrast passes on every text token in both themes; every remaining non-functional button says why.

*H1 is an audit, not an implementation — the buttons it decides to implement are built in their own packages. Its output is a decision table, and that table prevents the "why is this dead?" question recurring for the rest of the programme.*

### Package 1 — Core interaction · 3.25 d · *after P0*

| ID | Item | d |
|---|---|---|
| B2 | Command palette (⌘K) across accounts, deliverables, people, signals | 1.0 |
| B3 | Clickable breadcrumbs | 0.25 |
| B4 | Recent items in the sidebar | 0.25 |
| B5 | Collapsible sidebar | 0.25 |
| B6 | Persistent account switcher on every account-scoped screen | 0.25 |
| C1 | Real Rep Library filters *(minimal version already in the pilot — this is the full one)* | 0.25 |
| C3 | Sort on any column | 0.25 |
| L5 | Keyboard shortcut overlay (`?`) | 0.25 |
| L6 | Table density toggle | 0.25 |
| L7 | Persist theme, tour-seen and view state per user | 0.25 |

**Done when:** any account or deliverable is reachable in ≤3 keystrokes from anywhere; every table column sorts; state survives a reload.

### Package 2 — Search & filtering · 2.5 d · *after P1*

| ID | Item | d |
|---|---|---|
| C5 | Global search across accounts, people, signals, deliverables, sources | 1.0 |
| C2 | Faceted filtering on Build List (RTO × vertical × sites × accidents × ICP band) | 0.75 |
| C4 | Saved views | 0.5 |
| C6 | Full-text search inside deliverable bodies | 0.25 |

**Done when:** "which briefs mention demand charges" and "PJM prospects with ≥10 sites and accident history" are both one query.

### Package 3 — Review workflow · 5.75 d · *after P0; the critical package*

| ID | Item | d |
|---|---|---|
| D1 | Full inline editing — rich text, section-level, saved as a new version | 2.5 |
| D2 | Version diff — what changed since the last approval | 1.0 |
| D3 | Side-by-side research record ↔ deliverable, for claim verification | 0.75 |
| D7 | Regenerate only the sections affected by changed facts | 0.75 |
| D4 | Bulk actions on the review queue | 0.25 |
| D5 | Notes to the rep, attached to a published brief | 0.25 |
| D6 | Waiting-time indicator on drafts | 0.25 |

**Done when:** a marketer can open a draft, see what changed since they last approved it, edit any sentence, verify a claim against its source without leaving the screen, and publish — never touching a database. This is the package that makes the product's central claim true.

*Sequencing note: D2 depends on versions being stored with their content, and D7 depends on facts carrying a `used_in` link. Both are schema changes and are built first inside this package.*

### Package 4 — Rep experience · 4.5 d · *after P0; parallelisable with P2/P3*

| ID | Item | d |
|---|---|---|
| E1 | Mobile-optimised Rep Library *(full version; minimal is in the pilot)* | 1.0 |
| E4 | Account bundle — everything on one account as a single download | 0.75 |
| E7 | Read receipts — **`marketing` role only**, per §2.1 | 0.75 |
| E6 | Request-a-brief with context (meeting, date, what's needed) | 0.5 |
| E2 | Print stylesheet — briefs print to two clean pages | 0.5 |
| E8 | Usefulness rating with trend view *(full version)* | 0.5 |
| E3 | Real clipboard writes for email bodies and one-pagers | 0.25 |
| E5 | Brief age on the library card, not only inside | 0.25 |

**Done when:** a rep can read a brief on a phone, print it, copy an email body, rate it, and request the next one with context — and a marketer can see whether anyone opened any of it, without the reps seeing that she can.

### Package 5 — Trust & provenance · 5.5 d · *after P3*

| ID | Item | d |
|---|---|---|
| F3 | Claim → source traceability (hover a figure, see its source) | 2.5 |
| F4 | Conflict view — G6 conflicts surfaced and resolvable | 0.75 |
| F5 | Gap resolution workflow — assign, resolve, attach source | 0.75 |
| F6 | Source health per connector — last pull, records returned, failures | 0.5 |
| F7 | Staleness countdown and 90-day auto-flag | 0.5 |
| F1 | Per-account confidence summary bar | 0.25 |
| F2 | Live source links | 0.25 |

**Done when:** every number in every deliverable can be traced to a source in one click; every gap can be actioned rather than only read; a failed connector is visible before the research degrades.

*F3 is the largest item here and the one that most changes the data model — it requires fact-level citation ranges, not just fact-level source ids. Build it first in the package so D3 can consume it.*

### Package 6 — Ingestion · 3.75 d · *independent, can run in parallel*

| ID | Item | d |
|---|---|---|
| G7 | PDF / DOCX text extraction — replaces the current R1 refusal with real extraction | 1.5 |
| G5 | Capture queue — reps paste through the day, marketer reviews as a batch | 0.75 |
| G4 | Import preview before commit, with cancel | 0.5 |
| G1 | Drag-drop anywhere on the page | 0.25 |
| G2 | Paste CSV directly into a textarea | 0.25 |
| G3 | Remember column mappings per source shape | 0.25 |
| G6 | Expected-format template download | 0.25 |

**Done when:** the documents they actually have can be ingested; a bad CSV import can be previewed and abandoned; a rep can file six captures before lunch without the marketer context-switching six times.

*G5 resolves a real inconsistency: today each capture is filed immediately with no review step, which contradicts the human-gate principle applied everywhere else in the product.*

### Package 7 — Output & export · 2.25 d · *after P3*

| ID | Item | d |
|---|---|---|
| J1 | Real PDF export (server-side Puppeteer) | 0.75 |
| J2 | DOCX export — marketing edits briefs in Word whether we like it or not | 0.75 |
| J3 | Email a brief to a rep | 0.5 |
| J4 | Buying-window `.ics` export | 0.25 |

**Done when:** every artefact leaves the system in a format its recipient will actually use.

### Package 8 — Engine intelligence · 5.25 d · *after P5*

| ID | Item | d |
|---|---|---|
| K3 | Cross-account pattern detection — the only genuinely new pipeline stage | 2.0 |
| K2 | Whitespace prioritisation — fit × accessibility × grid exposure × accident history | 0.75 |
| K6 | Signal → deliverable dependency graph | 0.75 |
| K7 | Duplicate-account review UI — inspect and split a bad merge | 0.75 |
| K1 | Cost-aware regeneration | 0.5 |
| K4 | Buying-window countdown on Command | 0.25 |
| K5 | Orphan alerts — active signals, no owner | 0.25 |

**Done when:** the engine notices things across accounts rather than only within one; a bad entity merge can be undone by a human; regeneration cost tracks the size of the change.

*K7 closes a promise the gates spec already makes — §1 asserts merges are reversible, and today there is no interface to reverse one.*

### Package 9 — Accessibility, scale & polish · 5.75 d · *last, by design*

| ID | Item | d |
|---|---|---|
| A3 | Full accessibility — ARIA across 14 screens, focus trap, `prefers-reduced-motion`, `prefers-color-scheme`, screen-reader announcements | 3.0 |
| I1 | Virtualised tables — needed when the registry grows to 18,131 facilities | 0.75 |
| I3 | Lazy-render heavy screens | 0.5 |
| L1 | Empty states that explain the next action | 0.5 |
| L2 | Loading states for research runs | 0.5 |
| L3 | Toast queueing + screen-reader announcement | 0.25 |
| L4 | Consistent number formatting | 0.25 |

**Done when:** the product is usable with a keyboard only and with a screen reader; the 18,131-facility registry renders without jank; no screen shows a bare "nothing yet."

*A3 is last for the deep pass only. Labels, roles and focus order are added incrementally from Package 0 — retrofitting them onto 14 finished screens is precisely how accessibility work gets dropped.*

---

## 4. Total effort and resourcing

| | Engineer-days |
|---|---|
| Package 0 — Foundations | 3.5 |
| Package 1 — Core interaction | 3.25 |
| Package 2 — Search & filtering | 2.5 |
| Package 3 — Review workflow | 5.75 |
| Package 4 — Rep experience | 4.5 |
| Package 5 — Trust & provenance | 5.5 |
| Package 6 — Ingestion | 3.75 |
| Package 7 — Output & export | 2.25 |
| Package 8 — Engine intelligence | 5.25 |
| Package 9 — Accessibility, scale & polish | 5.75 |
| **Subtotal** | **42.0** |
| Contingency @ 15% | 6.3 |
| **Total** | **~48.3 engineer-days** |

**Resourcing options:**

| Shape | Calendar | Notes |
|---|---|---|
| 1 engineer | **~10 weeks** | Simplest coordination. Longest feedback loop. |
| 2 engineers | **~5–6 weeks** | Pairs cleanly: one takes P0→P1→P2→P3 (interaction), the other P6→P5→P8 (data and engine). P4, P7 and P9 shared. Only ~10% coordination overhead because the split is along a real seam. |
| 2 engineers + designer | **~5 weeks** | Worth it only if A3 and the responsive work in A2/E1 are done properly rather than adequately. |

**Plus the pilot:** the 13-day Phase 1 build (§1.1) is *additional* to this, though ~3.15 days of it is the minimal versions of items completed properly here later.

### 4.1 Prototype versus production — an honest split

This backlog was written against a **single self-contained HTML file with no backend**. Some items cannot be fully built in that form.

| Buildable in the prototype (client-side) | Needs a server |
|---|---|
| A1, A2, A3, B1–B6, C1–C6, D3–D7, E1–E6, E8, F1, F2, F4, F5, F7, G1–G6, I1, I3, I4, J4, K1, K2, K4–K7, L1–L7 | **D1** persistence · **D2** stored versions · **E7** read receipts · **F3** fact-level citations · **F6** live connector health · **G7** PDF/DOCX extraction · **J1–J3** export generation · **K3** cross-account corpus |

Two workarounds worth knowing: `pdf.js` runs client-side, so **G7 has a prototype path**; and browser print-to-PDF covers a credible **J1** without Puppeteer. Everything else in the right column is genuinely server-dependent.

**Implication:** roughly 60% of the backlog can be built and demonstrated in the existing single-file prototype. The other 40% is production work and should be planned against the real Phase 1 codebase, not the prototype. Trying to fake the server-dependent 40% in a static file produces demos that collapse the moment someone asks a follow-up question.

---

## 5. Critical path

```
P0 Foundations ──┬─► P1 Core interaction ─► P2 Search ─┐
                 │                                      │
                 ├─► P3 Review workflow ────────────────┼─► P5 Trust ─► P8 Engine ─┐
                 │        │                             │                          │
                 │        └────────────► P7 Output ─────┘                          ├─► P9 Accessibility
                 │                                                                 │      & polish
                 └─► P4 Rep experience (parallel) ─────────────────────────────────┤
                 └─► P6 Ingestion (parallel) ──────────────────────────────────────┘
```

**The critical path is P0 → P3 → P5 → P8 → P9** — 25.75 days of the 42. P1, P2, P4, P6 and P7 have slack and can be interleaved or parallelised.

Two hard dependencies worth naming:
- **P3 before P5** — D3 (side-by-side verification) is consumed by F3 (claim traceability), not the reverse.
- **P5 before P8** — K6 (signal→deliverable graph) needs the fact-to-deliverable links that F3 establishes.

If the calendar is tight, **P4 and P6 can run in parallel with everything** by a second engineer from day 1, since neither touches the review workflow.

---

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **D1 is larger than estimated.** Rich inline editing with versioning, validation and conflict-safe saves is a small CMS. | The pilot ships a minimal plain-text editor first (§1.1). If the full version runs past 3 days, cut section-level editing and keep whole-document. |
| 2 | **F3 forces a data-model change late.** Fact-level citation ranges touch every generated artefact. | Build it first in P5, not last. If it slips, D3 degrades to document-level sourcing rather than claim-level — still useful, visibly weaker. |
| 3 | **A3 becomes a big-bang retrofit.** | Labels, roles and focus order are added as each screen is touched from P0 onward. P9 is the audit and the deep pass, not the first attempt. |
| 4 | **Scope re-expands.** 65 items over 10 weeks invites additions. | The cut order is fixed: L-items first, then K, then I. P0, P3 and P4 are not cuttable — they are what makes the product usable and measurable. |
| 5 | **E7 chills rep adoption.** | Scoped to the `marketing` role, never surfaced to reps, and the underlying read log exists regardless (§2.1). If rep engagement drops measurably after it ships, it is the first thing to switch off. |
| 6 | **Prototype/production divergence.** Building 60% in a static file and 40% against a server risks two codebases. | Decide at the end of P0 whether the prototype is promoted to the real app or discarded. Carrying both past Package 3 is how the work gets done twice. |

---

## 7. Verification

Every package ends with an automated check plus a human one. The automated suite currently stands at **163 checks** across three files and runs in about two seconds; each package adds to it rather than replacing it.

| Package | Automated gate | Human gate |
|---|---|---|
| P0 | Contrast ≥4.5:1 on every text token in both themes; 360px viewport renders all 14 screens without overflow; every route round-trips through the URL | Navigate the whole app by URL alone |
| P1 | Any account reachable in ≤3 keystrokes; every table column sorts both directions | Use it for a day, note every reach-for-the-mouse moment |
| P2 | Both named queries in §P2 return correct results | — |
| P3 | Edit → save → new version → diff shows exactly the edit; publish state machine has no unreachable transitions | Take one account from draft to published, timed |
| P4 | Library usable at 360px; read receipts visible to `marketing` and provably absent for `rep` | A rep completes a full pre-meeting prep on a phone |
| P5 | Every numeric claim in every deliverable resolves to a citation; omitting a citation fails the build | Pick five claims at random and verify them |
| P6 | A real PDF ingests and classifies; a bad CSV can be previewed and abandoned | Ingest their actual documents, not samples |
| P7 | PDF, DOCX and `.ics` all open correctly in their native applications | — |
| P8 | Cross-account patterns reproduce on known cases; a bad merge can be split and the split persists | — |
| P9 | axe-core clean; keyboard-only completion of the three core tasks; no `prefers-reduced-motion` animation fires | Full keyboard-only pass with a screen reader |

---

## 8. Excluded

| Item | Reason |
|---|---|
| **I2** Debounce search | Your call — not required yet. Revisit with I1 if the registry grows to 18,131 facilities. |
| **J5** Shareable read-only links | Deferred. Requires `AUTH-SPEC.md` §7 tiering in production; shipping it earlier creates the exact leak that spec exists to prevent. |
| Anything not in `BACKLOG.md` | Deliberately. New items go into the backlog and get sequenced, not inserted mid-package. |

---

## 9. The one decision needed before starting

**Extend Phase 1 from 10 to 13 working days, or drop the Site Portfolio Analysis deliverable.**

Five acceptance criteria in `PHASE-1-SPEC.md` §16 cannot be met without D1, C1, E8, A2 and E1 (§1 above). The minimal versions cost 3.15 days. I would extend rather than cut, because Site Portfolio Analysis is the only artefact in the product that no competitor can produce — it exists solely because of the EPA RMP registry.

Everything else in this plan can start the moment that is settled.
