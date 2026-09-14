# COLDPATH — Optimisation & UI Feature Backlog

A menu, not a plan. Pick by ID (e.g. "do A1, B2, D1, E3"). Effort is **S** (hours), **M** (~half a day), **L** (a day or more). Items marked ⚠ have a trap worth reading before you choose them.

Everything below was checked against the current build rather than assumed — §0 lists three things that are defects rather than enhancements.

---

## 0. Defects found while auditing — fix these first

These are not features. They are things that are currently wrong.

| ID | Item | Detail | Effort |
|---|---|---|---|
| **A1** | **Text contrast fails WCAG AA** | `--txt3` (`#647689`) on panel measures **3.78:1**; AA needs 4.5:1. On the page background it is 4.22:1. In light mode `--txt3` on white is **3.45:1**. This colour is used for every label, timestamp, unit, placeholder and source citation in the app — it is the most-used text style there is. | S |
| **A2** | **No responsive layout at all** | Zero `@media` rules in the app CSS. Grids are fixed at 3–4 columns. On a phone or a narrow window the Rep Library — the one screen reps actually use, and the one you asked to be reachable "from any browser" — is unusable. | M |
| **A3** | **No accessibility semantics** | Zero `aria-*` attributes, zero `role` attributes, no `:focus-visible` styles, no focus trap in the modal, no `prefers-reduced-motion` handling (the tour, the pulse animations and the fade transitions all ignore it), no `prefers-color-scheme` (light mode is manual only). Screen-reader users get an unnamed button soup. | L |

A1 is a two-line change with an outsized effect. A2 matters directly for the rep library. A3 is the largest and can be staged.

---

## A. Wayfinding & state

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **B1** | **URL state / deep links** | Refresh currently loses your place. `#/intel/kroger/signals` would let a marketer paste a link to a specific account tab in Slack, and let the browser back button work. Right now back does nothing. | M |
| **B2** | **Command palette (⌘K)** | Jump to any account, deliverable, person or signal by typing. With 114 registry accounts and 18 deliverables, click-navigation is already the slow path. This is the single biggest power-user win. | M |
| **B3** | **Clickable breadcrumbs** | The breadcrumb bar shows your position but isn't clickable. | S |
| **B4** | **Recent items** | "Back to what I was looking at" — the last 6 accounts or deliverables visited, in the sidebar. | S |
| **B5** | **Collapsible sidebar** | Recovers ~236px on a laptop screen, which matters most on the wide tables. | S |
| **B6** | **Persistent account switcher** | The account picker only appears on Account Intelligence and Deliverables. On Command or Build List you have to navigate away to change account. | S |

## B. Search & filtering

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **C1** | **Make the Rep Library filters real** ⚠ | All six filter buttons currently fire a toast and do nothing. Reps will click them, get no result, and conclude the tool is decorative. Either implement or remove — a non-functional control is worse than no control. | S |
| **C2** | **Faceted filtering on Build List** | Filter the 114-account registry by RTO, vertical, site count, accident history and ICP band simultaneously. "PJM + ≥10 sites + accidents > 0" is a real query a marketer will want. | M |
| **C3** | **Sort on any column** | Build List has three fixed sorts. Every column header should sort. | S |
| **C4** | **Saved views** | Name a filter combination and keep it. The marketer's Monday-morning view should be one click. | M |
| **C5** | **Search across everything** | One box that finds accounts, people, signals, deliverables and sources. Currently search exists only on Build List and only over the curated list. | M |
| **C6** | **Global text search inside deliverables** | "Which briefs mention demand charges?" — useful when a rep asks a question you half-remember answering. | S |

## C. Review workflow — the marketer's daily loop

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **D1** | **Actual inline editing** ⚠ | The review gate has an "Approve & publish" button and a toast. There is no way to *edit*. Since the entire model is "machine drafts, human judges," the absence of editing is the biggest functional gap in the product. `contenteditable` on the rendered doc, or a split markdown/source view. | L |
| **D2** | **Version diff** | Deliverables are versioned (v1, v2, v3) but you cannot see what changed. On a refresh, "what is different from what I already approved" is the only question that matters — without it the marketer re-reads everything, which is the bottleneck we are trying to remove. | M |
| **D3** | **Side-by-side research ↔ deliverable** | Show the source facts next to the artefact that cites them, so verification is glanceable rather than a memory test. This is what makes the confidence model usable rather than theoretical. | M |
| **D4** | **Bulk actions on the review queue** | Approve, defer or assign 12 queue items at once. With all five paths exercised the queue holds **22 items, 9 of them blocking**, across six sources — and each currently needs an individual visit. | S |
| **D5** | **Notes to the rep** | "CFO left in June, use Kennerley's successor — confirm before sending." Attached to a published brief, visible only in the library. | S |
| **D6** | **Waiting-time indicator** | How long has this draft been sitting in review? Surfaces the marketer's own queue before it becomes the reps' complaint. | S |
| **D7** | **"Regenerate only what changed"** | On refresh, regenerate the affected sections rather than the whole artefact. Cheaper (see K1) and produces a meaningful diff for D2. | M |

## D. Rep experience

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **E1** | **Mobile-friendly library** | Depends on A2. Reps read briefs in a car park before a site visit. If it needs a laptop, it will not be used. | M |
| **E2** | **Print stylesheet** | A brief should print to two clean pages. Some reps will print; fighting that is pointless. Currently printing produces a dark-mode screenshot. | S |
| **E3** | **Copy-to-clipboard that works** | Export and copy buttons are toasts. Real clipboard writes for email bodies and one-pagers are the difference between using the tool and retyping from it. | S |
| **E4** | **Account bundle download** | "Everything on Tyson" as one PDF — brief, one-pager, discovery guide, site portfolio. Useful before a meeting with no connectivity. | M |
| **E5** | **Brief age, prominently** | Show "researched 8 Sept · refreshes 8 Oct" on the library card, not only inside. A rep should know if they are holding stale intel without opening it. | S |
| **E6** | **Request-a-brief with context** | The button exists and toasts. A real form — which meeting, when, what do you need — turns a vague interruption into a scoped task the marketer can triage. This directly attacks the original pain. | M |
| **E7** | ⚠ **Read receipts** | Tempting for marketing ("did anyone read this?"). **Advise against unless reps are told.** Undisclosed tracking of a sales team's reading habits is a trust-destroyer, and the first rep who discovers it will stop using the library. If you want the signal, ask for explicit feedback instead (E8). | M |
| **E8** | **One-click usefulness rating** | "Was this brief useful? 👍 👎 + optional line." Cheap, honest, and it is the measurement the Phase 1 gate depends on. | S |

## E. Trust & provenance

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **F1** | **Per-account confidence summary** | A single bar: 34 high / 9 medium / 5 gaps. Currently you have to open the decision unit and count. | S |
| **F2** | **Live source links** | Sources are listed as text ("justice.gov — DOJ ENRD press release"). Make them clickable. A marketer verifying a claim should be one click away, not one search away. | S |
| **F3** | **Claim → source traceability** | Hover a number in a deliverable, see which source it came from. This is the feature that makes "it won't hallucinate" demonstrable rather than asserted. | L |
| **F4** | **Conflict view** | Gate G6 raises conflicts and the spec says both values are retained — but there is no screen to see or resolve them. Right now the behaviour is specified and not built. | M |
| **F5** | **Gap resolution workflow** | Gaps are published with a resolution path but cannot be actioned. Assign, mark resolved, attach the source. Turns a list of problems into a worklist. | M |
| **F6** | **Source health per connector** | Last successful pull, records returned, failures. If EDGAR silently returns nothing, the research degrades invisibly. | M |
| **F7** | **Staleness countdown** | "Refreshes in 12 days" and auto-flag at 90. The staleness engine is specified; the visible half of it is not built. | S |

## F. Ingestion UX

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **G1** | **Drag-drop anywhere** | Only the drop zone accepts files. Dropping on the page should work — it is what people try first. | S |
| **G2** | **Paste CSV directly** | A textarea alongside the file picker. Most CRM exports are copied from a grid, not saved as a file. | S |
| **G3** | **Remember column mappings** | The marketer maps the same Salesforce export every month. Persist the mapping per source shape. | S |
| **G4** | **Import preview before commit** | Show the reconciliation result, then commit or cancel. Currently "Commit N accounts" is a toast with no undo. | M |
| **G5** | **Capture queue for reps** | Reps paste through the day; the marketer reviews the batch each morning. Right now each capture is filed immediately with no review step — which contradicts the human-gate principle everywhere else in the product. | M |
| **G6** | **Expected-format template** | "Here is the CSV shape we want" as a download. Removes a round trip every onboarding. | S |
| **G7** | **PDF/DOCX text extraction** | Currently refused by R1 with a clear reason — correct behaviour, but it means most of their existing documents cannot be ingested in the prototype. Needs server-side `pdf-parse` / `mammoth`. Already in the Phase 1 plan. | L |

## G. Making the 22 stubbed buttons real

| ID | Feature | Detail | Effort |
|---|---|---|---|
| **H1** | **Audit and resolve every toast-only control** | There are **22 buttons** that show a message and do nothing: publish, export, copy, regenerate, refresh, re-score, filter, request. In a demo they read as "coming soon"; in daily use they read as broken. Options per button: implement, disable with a reason, or remove. A disabled button that says *why* is honest; a live button that lies is not. | M |

This is the highest-trust item on the list. It is also the cheapest way to make the whole product feel finished.

## H. Performance & scale

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **I1** | **Virtualised tables** ⚠ | The site table is 755 rows and the registry is 117. Both render fully today, which is fine at this size. Worth doing before the registry expands to the full 18,131-facility US set in Phase 2 — **not before**. Premature now. | M |
| **I2** | **Debounce search input** | The Build List filter re-renders the whole view on every keystroke. Imperceptible at 26 rows, noticeable at 114. | S |
| **I3** | **Lazy-render heavy screens** | Build List renders 51KB of HTML. Defer off-screen cards. | M |
| **I4** | **Cache research between navigations** | Switching account tabs re-renders from scratch. Memoise. | S |

## I. Output & sharing

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **J1** | **Real PDF export** | Server-side Puppeteer. Currently a toast. Pairs with E2 and E4. | M |
| **J2** | **DOCX export** | Was cut from Phase 1. Marketing edits briefs in Word whether we like it or not. | M |
| **J3** | **Email a brief to a rep** | Direct handoff rather than "go look in the library." | M |
| **J4** | **Buying-window calendar export** | The window dates are the most actionable output in the system. `.ics` puts them where the rep already plans their week. | S |
| **J5** | ⚠ **Shareable read-only links** | Useful, and a security trap. Requires `AUTH-SPEC.md` §7 tiering to be real first — a link that bypasses login leaks T2/T3 material. Defer until server-side auth exists. | L |

## J. Engine intelligence

| ID | Feature | Why it matters | Effort |
|---|---|---|---|
| **K1** | **Cost-aware regeneration** | The Usage & Cost screen shows $0.34 per artefact. Regenerating all nine when one signal changed costs ~$3 and produces an unreadable diff. D7 + K1 together cut both spend and review time. | M |
| **K2** | **Whitespace prioritisation** | Registry accounts absent from the CRM (106 against the sample import — the real number depends on their export) currently arrive as a list sorted by ICP score and nothing else. Rank them by fit × accessibility × grid exposure × accident history instead. This is the most commercially valuable output of the CRM import. | M |
| **K3** | **Cross-account pattern detection** | "Four PJM prospects with accident history in the same quarter" is a campaign, not four separate facts. The engine holds the data; nothing looks across it. | L |
| **K4** | **Buying-window countdown on Command** | The Kroger window closes when Ibbotson's first hundred days end. A countdown is the difference between acting and reading. | S |
| **K5** | **Orphan alerts** | Accounts with active critical signals and no owner. Currently surfaced only inside the review queue. | S |
| **K6** | **Signal → deliverable dependency graph** | "This new signal affects 4 artefacts. Regenerate?" Makes staleness actionable instead of theoretical. | M |
| **K7** | **Duplicate-account review UI** | The 51 multi-alias accounts are resolved automatically. A human should be able to inspect and split a bad merge — the spec promises this is reversible and there is no interface to do it. | M |

## K. Polish

| ID | Feature | Effort |
|---|---|---|
| **L1** | Empty states that explain what to do next (several screens show a bare "nothing yet") | S |
| **L2** | Loading states for research runs — currently instant, which reads as fake | S |
| **L3** | Toast queueing (they currently overwrite each other) and screen-reader announcement | S |
| **L4** | Consistent number formatting (some tables use `1,903,105`, others `1.9M`) | S |
| **L5** | Keyboard shortcut overlay (`?`) | S |
| **L6** | Table row density toggle — comfortable vs compact | S |
| **L7** | Persist theme, tour-seen and view state per user rather than per browser | S |

---

## If you want the biggest change for the least effort

My top eight, in order:

1. **A1** — contrast fix. Two lines, and it improves every screen.
2. **H1** — resolve the 22 stubbed buttons. Nothing makes a product feel unfinished faster than a button that lies.
3. **D1** — real inline editing. Without it the "human review gate" is a label, not a workflow.
4. **B2** — command palette. The largest single usability jump for daily use.
5. **E1 + A2** — mobile layout for the Rep Library. It is the screen reps touch, and "from any browser" implies a phone.
6. **D2** — version diff. It is what stops the marketer re-reading everything, which is the whole point of the product.
7. **B1** — URL state. Back button, refresh survival, shareable links.
8. **E8** — usefulness rating. Cheap, and it produces the evidence the Phase 1 gate needs.

## Three I would push back on

- **E7 read receipts** — the trust cost outweighs the insight. Use E8 instead.
- **I1 virtualisation** — correct at 18,131 facilities, premature at 114. Do it in Phase 2.
- **J5 shareable links** — genuinely useful, but unsafe until server-side tiering exists. Shipping it early creates the exact leak `AUTH-SPEC.md` §7 is written to prevent.

---

*Roughly 60 items across 12 groups. Nothing here is committed — this is the menu.

**Counts verified against the running build, not estimated:** 18 deliverables (9 published, 4 in review, 4 draft, 1 queued) · 9 template types · 17 rep-library cards · 114 registry accounts · 755 sites · 22 toast-only buttons · 0 `@media` rules · 0 ARIA attributes · 3 contrast failures.*
