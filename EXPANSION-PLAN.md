# COLDPATH — Horizontal Expansion Plan: New Verticals, Sources & Triggers

**Client:** Ndustrial · **Extends:** `phase1/PHASE-1-SPEC.md` §17 (Phase 2) and `PRODUCT-PLAN.md` M2/M3
**Status:** Proposal for review — plan document only; no schema or code changed yet (the file you are reading is the only new artefact).
**Premise:** Cold chain was won because EPA RMP ammonia filings are a near-complete census of the market *and* ammonia refrigeration is exactly the load Ndustrial optimises. The question for every new vertical is the same two-part test: **is there a public registry that enumerates the sites, and does the site's physics satisfy the ROI triangle?**

---

## 0. The qualification model — make it explicit in code

The current ICP score (`epa_rmp.py::icp_score`, ported to `app/src/connectors/epa-rmp/`) encodes the cold-chain triangle implicitly: `ammonia_lb` ≈ load size, `primary_rto` ∈ {PJM, ERCOT, ISO-NE} ≈ price exposure, "refrigerated warehousing" ≈ sheddability. It cannot be reused as-is, because **sheddability must now be inferred, not assumed**. Before any connector work, restate the three conditions as per-site fields:

| Criterion | Field (proposed) | How it is evidenced per vertical |
|---|---|---|
| **C1 — Meter scale** | `est_peak_kw` + `peak_kw_basis` | Ammonia lb (cold), pump kW from permits (water), clinker capacity (cement), thermal MW (district), charger count × kW (depots) |
| **C2 — Price exposure** | `tariff_class` (RTP / demand-charge / flat), `coincident_peak_rto` | Already partially present via `site.rto`; add tariff structure from EIA-861 and state commission dockets |
| **C3 — Shed buffer** | `buffer_type` enum + `buffer_hours_est` | `thermal_mass` (cold/district), `elevated_storage_gal` (water), `silo_days` (cement), `dispatch_flexibility` (EV depots) |

Two rules fall out of this, and they encode the user's exclusion directly:

- **Continuous-process exclusion.** Glass, steel, paper, and cement *kiln-front continuous grinding* get `buffer_type = 'none'` and are hard-excluded at the gate, not scored low. This is a categorical refusal (like customer suppression C5), because a false positive here doesn't waste a sales cycle — it destroys a furnace. New enum value on the pain side: `is_weak_fit` reason = *"continuous process — curtailment physically impossible."*
- **Buffer is a fact, not an inference.** Every `buffer_hours_est` must cite a source row (G0/G7 apply unchanged). A model-generated "this plant probably has silos" is dropped by the grounding check like any invented fact.

**Schema deltas required** (all additive; each needs a Drizzle migration — migrations run as the privileged role, app role untouched):

- `verticalEnum`: add `municipal_water_wastewater`, `cement_minerals`, `district_energy`, `ev_depot_transport` (+ keep `other`).
- `rtoEnum`: add `non-RTO` (much of the Southeast/South is vertically integrated non-RTO utility territory — see §5 risk 4).
- `sourceKind`: add `state-registry`, `utility-program`, `procurement`, `grants`. (`job`, `enforcement`, `rto`, `tariff` already exist.)
- `signalType`: add `procurement` (RFPs/bids — the primary trigger for water utilities). Existing types cover the rest.
- `site`: `est_peak_kw`, `buffer_type`, `buffer_hours_est`, `tariff_class`, `metered_load_basis` jsonb.
- `account`: nothing structural — `vertical` and `icpScore` already exist.

---

## 1. Municipal Water & Wastewater

**Physics fit:** strong. Elevated storage = thermal battery analogue; gravity feed provides minutes-to-hours of headroom. Pumps are batch-like (cycle with demand), not continuous.
**Commercial fit:** the hard part, as noted — procurement cycles, risk aversion, no RTP for most ratepayers. Exposure comes from **bulk-supply wholesale customers, large municipal aggregators, and ISO-territory utilities**, plus demand-charge structures on the pumping side.

### Universe sources (the "RMP equivalent")

| Source | What it gives | Access | Licence/caveat |
|---|---|---|---|
| **EPA ICIS-NPDES (State DMR loader)** | Every permitted discharge facility — POTWs by name, city, receiving water, design flow (MGD → proxy for pump scale) | Public download, ~quarterly refresh | Federal public data; design flow ≠ kW, needs a stated conversion basis |
| **EPA FEI (Facility Registry / FSIS)** | Water systems + STPs geocoded; join to RTO by lat/lon | REST API | Public |
| **AWWA Member Directory** | Utility names, contacts, population served | Membership-gated | **G1 flag** — likely no redistribution rights; use for entity reconciliation only, never store scraped rows |
| State permit databases (e.g., TCEQ, DEP) | Pump-station-level permits where federal data stops at plant level | Per-state, uneven | Highest engineering cost; defer to wave 2 |

Design-flow → kW conversion (rule of thumb ~1,500 kWh/MG average, big pumps 500–2,000 hp) becomes a `validation/outliers.ts` distribution check — the Neches lesson applies verbatim: one mis-keyed MGD figure would corrupt the whole ranking.

### Triggers (signal detection)

| Trigger | Source | signalType |
|---|---|---|
| Pump-station / lift-station **construction RFP** | BidNet, OpenGov, Fusion, Merit, state eProcurement (Solicitations USA feeds many) | `procurement`, `capex` |
| Energy-audit or **ESCO award** at a utility | Same bid portals + news | `intent` |
| **PFAS treatment / biosolids digester capex** (new massive electrical loads) | State permitting + news + EDGAR for the vendors | `regulatory`, `capex` |
| Rate-case filing introducing **demand/time-of-use rates** for large customers | State commission dockets (e.g., PA PUC, MD PSC); Full Service Network / RegTek for aggregation | `power` |
| Emergency declarations, **boil-water advisories**, pump failures | EPA OW / state notifications + local news | `compliance` — analogue of the accident-history signal that scores cold chain today |
| New **interconnection/storage co-location** projects at utilities | ISO queue dashboards (already contemplated via `rto` kind) | `expansion` |
| Sustainability commitments naming Scope-2/energy | CDP responses (free for signatories), utility IRPs | `sustainability` |

**Go-to-market consequence for the engine:** the user's strategy is "sell through pump OEMs and EE firms, not city councils." That means the engine should also run these accounts as **partner-target lists**: Xylem, Grundfos, Flowserve, and the design-build engineering firms (Black & Veatch, HDR, Stantec — all trackable via their own EDGAR/news feeds) become *accounts whose signals enumerate utility projects*. The RFP stream doubles as an OEM channel-intelligence stream. One connector, two uses.

---

## 2. Cement & Bulk Minerals

**Physics fit:** strong at raw mill / finish mill / crushers (batch, silo-backed). **Explicitly exclude kiln-side continuous operation** — the exclusion list (§0) is the feature here.
**Commercial fit:** excellent — among the largest industrial power loads, heavy coincident-peak exposure, publicly traded operators mean public money trails.

### Universe sources

| Source | What it gives | Access |
|---|---|---|
| **USGS Cement Plants and Kilns database** | Named plants, owners, kiln vs grinding-only, capacity, locations | Public CSV — the closest thing to an RMP-equivalent census |
| **EPA TRS / National Air Toxics Assessment inputs** | PM/NOx/SO₂-emitting mineral processing plants beyond cement (lime, gypsum, aggregates grinding) | Public downloads |
| **Title V air permits** (via EPA AirData / state portals) | Integrated permit inventory — already deferred to Phase 2 in PHASE-1-SPEC §17; this vertical is the reason it exists | Bulk-ish, painful parsing |
| **EIA Manufacturing Energy Consumption (MECS)** | Sector-level kWh baselines to calibrate `est_peak_kw` from capacity | Public |

### Triggers

| Trigger | Source | signalType |
|---|---|---|
| **New grinding capacity / plant-modernisation announcements** | Company press releases + EDGAR 8-K material-event exhibits | `capex`, `expansion` |
| Alternative-fuel-injection or **electrofilter baghouse upgrades** (permit modifications = capital projects landing) | State air-permit modification notices, TRS submissions | `regulatory`, `capex` |
| **EPD registrations** (Portland-Lime's EPD program; sustainability product lines) | Public EPD directory | `sustainability` |
| Ready-mix / aggregates acquisitions | DOJ/FTC premerger filings + news | `restructuring` |
| **Utility rate cases adding/increasing coincident-peaking demand charges** in cement states (TX, FL, CA, MI) | Commission dockets | `power` — the single most direct "money moved" trigger for this vertical |
| Leadership change (energy/utility manager hired) | News, LinkedIn capture path (existing gates apply) | `leadership` |
| Carbon-capture MOU / DOE pilot awards | DOE press releases, grants.gov, news | `capex` |

Note the restart-staging failure mode the user raised is a **product/engineering constraint, not a targeting constraint** — but it belongs in the account brief template for this vertical ("your savings are capped by inrush staging; here's how the platform handles it"), which argues for vertical-specific deliverable templates alongside the existing Site Portfolio Analysis (§9.3 of PHASE-1-SPEC).

---

## 3. District Energy (Cooling & Heating Networks)

**Physics fit:** strongest of the four — literally the cold-storage pattern, distributed. Existing cold-chain prompts, pains and pillars port almost unchanged.
**Universe problem:** no census exists. There is no filing threshold that says "you own a district loop." The universe must be **assembled from registries + intent signals**, and completeness claims must be downgraded accordingly (an honest G7 confidence ceiling: this vertical's registry is *partial*, unlike RMP).

| Source | What it gives |
|---|---|
| **DTC Global Directory** (District Energy in Cities Consortium) | Best available global roster of systems, sizes (MW-th), owners |
| **Census of Community District Energy** (ACEEE/Berkeley) | US system counts by type/state, free |
| **ENERGY STAR Portfolio Manager / Benchmarking datasets** | Campus-level EUI for universities/hospitals/municipal buildings — identifies large central plants even without knowing they're district systems |
| **EDGAR text search** (`full-text` API) | "district energy," "chilled water plant," "cogen" inside 10-Ks/10-Qs of campuses' parent companies, REITs (Boston Properties, Vornado — CBD loops), operators like Equinix-style campus landlords |
| State utility commissions | **Special-firm / DSP deregulation tariffs** (MI, TX, NY, PA, DC) — a district loop under a special firm is your RTP criterion delivered by law |
| News + DTC project tracker: **thermal-energy-storage project announcements** | The highest-intent trigger available anywhere in this vertical — TES is literally pre-positioned buffering for load-shaping software |

### Triggers

| Trigger | Source | signalType |
|---|---|---|
| **TES / chiller-plant retrofit or plant-expansion tender** | Owner procurement portals, news, DTC project tracker | `capex`, `intent` |
| University/hospital **master plan updates naming energy** | Published master plans (web connector + document-upload path — R-gates already handle PDFs once G7 lands) | `expansion` |
| FERC/DOE **grid-services pilots naming DER aggregation** | FERC docket RSS, DOE press | `power`, `regulatory` |
| Special-firm tariff changes / supplier-contract expiry windows | Commission dockets | `power` — creates a *buying window*, feeding the existing window-date machinery (J4) |
| Operator RFPs ("request for proposal — energy services company") | News + procurement portals | `procurement`, `intent` |

Integration note from the user (DEMS pressure-dynamics) again shapes the *deliverable*, not the funnel: briefs for this vertical need a pillar-2 pain framed around differential-pressure constraints, and the decision unit typically includes a campus chief engineer absent from warehouse org charts — decision-unit resolution (§7.5) needs a vertical-specific role taxonomy.

---

## 4. Heavy Transport EV Depots

**Physics fit:** conditional by design — sheddability depends entirely on dispatch flexibility, which is **not observable from public data**. Target instead on the *observable* half of the condition: megawatt-scale charging buildouts, which are always public because they require permits, utility interconnection, and often public subsidy.

| Source | What it gives |
|---|---|
| **AFDC Alternative Fuels Data Center station locator** | Public + private charging stations, EV-count, access type, address — the seed census |
| **Utility Make-Ready / fleet-rebate program filings & reports** (PG&E, SCE, SDG&E, Duke, Dominion, National Grid…) | **Named depot sites with charger counts and kW** — the single best structured source; utilities publish annual program reports listing participants (some redacted; G1 check per report licence) |
| **Grants.gov / state energy offices / CARB / EPA Clean School Bus & Industrial Diesel Replacement** | Awarded projects = named fleets + funded charger scale |
| **DTEP (Drive to Zero Platform)** pledge register + signatory news | Fleet-owner intent layer |
| Local building/electrical permits (per-jurisdiction portals) | Transformer/switchgear permits at depot addresses — early-stage capex signal |
| EDGAR/news for the listed players (Walmart, Amazon via parent, Old Dominion, Schneider National and other 3PLs; OEMs Freightliner/Peterbilt via Daimler/TRATON foreign filings) | Capex cadence, leadership, sustainability targets |

### Triggers

| Trigger | Source | signalType |
|---|---|---|
| **Make-ready rebate application/award naming a site** | Utility program reports/portals | `capex`, `intent` — the buying window opens *now* |
| Depot groundbreaking / "largest charging hub" press | News connector | `expansion` |
| **Transformer or major electrical service permits** at known depot addresses | Permit portals | `capex` |
| Fleet-electrification pledges with dated targets | DTEP, CDP, 10-K sustainability sections | `sustainability` |
| Utility **time-of-use / critical-peak pricing riders aimed at EVSE** filed at commissions | Dockets | `power` |
| Real-estate transactions: cross-dock land assembly near interstate corridors | CoStar-shaped news, county records | `expansion` |

Dispatch-flexibility screening (the disqualifier) happens at the **research stage, not the funnel**: the discovery-guide template for this vertical asks about departure-window rigidity, and the brief marks pillar-0/2 fit `is_weak_fit` until answered — exactly the mechanism PHASE-1-SPEC §7.4 already enforces.

---

## 5. Cross-cutting risks — stated before committing, in the repo's style

1. **Entity resolution gets harder, not easier.** RMP gave one authoritative parent-name field. Utility names span "City of X," "X Authority," "X Water District"; cement has holding-company layers (Holcim↔Hanson, CRH↔readymix brands). The canonical-rule table (`app/src/lib/resolve/canonical.ts`) grows per vertical; expect the 46%-multi-alias rate to rise. Keep the VersaCold rule: fuzzy match alone never merges, and never suppresses (C5).
2. **Numeric validation is mandatory on every new numeric field.** Each vertical introduces one proxy metric (MGD, clinker tons, MW-th, charger kW) that drives `est_peak_kw`. Every one gets the p99×10 outlier gate from `lib/validation/outliers.ts` before it can touch a score. No exceptions — the 89M-lb record is the standing proof.
3. **Licence heterogeneity (G1).** Government data is mostly public-domain; DTC/ACEEE/DTEP directories carry attribution or non-commercial terms; AWWA and CoStar-derived data likely carries **no redistribution rights at all**. The `licence` column being non-nullable and enforced by type is what makes this survivable; some sources will resolve to "query-only, don't store."
4. **The RTO heuristic breaks.** Much of the growth territory (Southeast water utilities, Florida/Texas cement) sits in non-RTO vertically-integrated utility land where RTP barely exists. C2 evidence must come from tariff structures, not state→RTO mapping. Mitigation: a small **utility-tariff reference table** maintained manually per target geography from commission filings, keyed to `site.state + utility_name` — cheap, auditable, and prevents silently scoring grid exposure wrong for half the country.
5. **Don't ship five verticals at once.** Follow the Phase-1 discipline: pick **one** expansion vertical, prove the funnel produces ≥10 briefs reps actually use, then replicate. The connectors are linear work (PHASE-1-SPEC §3 said exactly this about job-board/ECHO); the prompt-tuning surface multiplies per vertical.

**Recommended first vertical: District Energy.** It reuses the cold-chain physics language, the existing ammonia→thermal reasoning, the Kroger/Lineage-style corporate buyers, and its top trigger (TES announcements) is the cleanest buying-window signal of the four. Water is second (biggest TAM, slowest sales motion); cement third (great triggers, narrow buyer set); EV depots last (best trigger density, weakest sheddability observability).

---

## 6. Build sequence (maps onto PRODUCT-PLAN milestones, does not reorder them)

| Step | Deliverable | Milestone hook | Verification |
|---|---|---|---|
| 1 | Qualification-model spec: C1/C2/C3 fields, exclusion gate definition, per-vertical proxy-metric conversion tables | Amend PHASE-1-SPEC §5/§7.4 | Doc review + gate-pure-function signature sketch |
| 2 | Schema deltas + migration (verticals, sourceKinds, signalTypes, site meter/buffer columns) | M2/M3 | Migration applies on PGlite **and** real Postgres CI job; RLS assertions still pass |
| 3 | **Exclusion gate** (`continuous-process`) as a pure function + blocking acceptance test mirroring C5's structure | M3 | Test: a glass/steel/paper fixture record refuses with reason, routes to review, never scores |
| 4 | Connector #1: **DTC directory + Census of District Energy** (small, static, parseable — proves multi-source registry assembly) | M2 | Parity harness pattern from epa-rmp: recorded fixtures, normalise() unit-tested |
| 5 | Connector #2: **EDGAR full-text** (shared by cement + district + EV parents) | M2 | MSW-fixture tests; grounding checks unchanged |
| 6 | Connector #3: **procurement/bid portal** adapter interface + one concrete feed (OpenGov or Merit public search) | M2 | Interface + mock adapter first, like salesintel |
| 7 | AFDC + grants.gov connectors (EV depot funnel) | M2 | Outlier gate on charger-kW proxy |
| 8 | Utility-tariff reference table + C2 rescoring logic | M3 | Manual seed, audited by marketer in review UI |
| 9 | Per-vertical ICP weight profiles (config, not code — same transparent additive structure as `icp_score`) | M3 | Unit tests per profile; regression against cold-chain weights unchanged |
| 10 | Pilot: 10 district-energy accounts end-to-end, same Phase-1 gate criteria | M4–M6 | Rep-use measurement, identical to Phase 1's success bar |

Steps 1–3 are the true prerequisites; 4+ are parallelisable once the qualification model exists.

---

## 7. What we need from Ndustrial

| # | Need | Why |
|---|---|---|
| 1 | **Vertical priority call** (recommendation: District Energy first) | Everything downstream is scoped by it |
| 2 | Confirmation of the **continuous-process exclusion list** as policy — who counts as "cannot shut down": glass, steel, paper, chemicals-once-through, others? | Becomes the exclusion gate's rule table; needs a domain expert, not a guess |
| 3 | Whether partner-channel targeting (pump OEMs, EE firms, DEP integrators) is a **first-class account type** or just a lens inside utility briefs | Changes whether `account` needs a `role_in_motion` concept or the existing decision-unit layer suffices |
| 4 | Any **customer-list additions** before suppression runs on new verticals | C5 fails worst on flagship customers; the CRM CSV remains the authoritative blocklist |
| 5 | Access to one **real tariff/rate schedule** per target geography (or confirmation none exists internally) | Seeds the utility-tariff reference table honestly |
| 6 | ~~AI appetite: scoring vs triage~~ → **RESOLVED 2026-09-29 (two-part)**: Q1 = **Option B** (Jev judgments feed `icp_score()` as inputs under versioned mapping rules; preconditions in `JEVS-PLAN.md` §5.3 — sidecar provenance, eval-set regression gate, labeled audit badges). Q2 = outbound on judged-but-unconfirmed accounts remains **NO**; enforced unchanged by gate C10 in `INGESTION-GATES.md` (Option B lifts *score caps*, never *export eligibility*). Remaining sub-question narrowed to: acceptable **cost ceiling per re-run** of the judgment sidecar after each model/prompt version bump (~732 accounts × 3 questions) | Locks UC-1 design; §5.3 machinery is now a build prerequisite for any judgment-derived point |

---

*Companion documents: `phase1/PHASE-1-SPEC.md` (§7 pipeline, §17 Phase 2) · `PRODUCT-PLAN.md` (§6 connector framework, §7 milestones) · `phase1/INGESTION-GATES.md` (G0–G9 universal gates govern every source above) · `BACKLOG.md` (K2 whitespace prioritisation becomes far more valuable with multiple verticals in the registry).*
