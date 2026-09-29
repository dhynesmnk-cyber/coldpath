"""
COLDPATH Expansion prototype — Connector: EPA RMP, Water & Wastewater vertical
==============================================================================

Enumerates the US water-treatment / wastewater-treatment universe from public
EPA Risk Management Program filings, using the SAME transport, entity-resolution
machinery and numeric-validation gate as connectors/epa_rmp.py. This is the
horizontal-expansion proof requested in EXPANSION-PLAN.md §Vertical 1: one
connector pattern, a new NAICS scope, a new proxy metric, a new scoring model.

WHY THIS VERTICAL FIRST
-----------------------
It requires zero new data contracts: rmpmap.org already serves it. Chlorine is
the dominant disinfectant at scale (gas chlorine storage >10,000 lb triggers an
RMP filing), so the registry enumerates large treatment plants with address,
parent utility, inventory size and incident history — exactly the shape of the
cold-chain list, for a market whose elevated tanks behave like a thermal
battery (pumps can ride through a peak window on stored gravity head).

PROXY MODEL HONESTY — READ BEFORE USE
-------------------------------------
Cold chain had a direct proxy for load: ammonia lb ≈ refrigeration plant kW.
Water does NOT. Chlorine inventory measures plant DISINFECTION scale, not
electrical demand, and many large utilities switched to sodium hypochlorite or
UV and file no RMP at all. The registry is therefore a LOWER BOUND on the
market, biased toward gas-chlorine plants. `est_peak_kw` below is an explicit
engineering ESTIMATE (≈150 kW per MGD design flow; max single pump 200–2,000 hp)
derived from proxy + program level, and every account brief must carry that
caveat. The score is a triage ranking, not a qualification.

DATA PROVENANCE AND LICENSING — READ BEFORE USE
-----------------------------------------------
Source : U.S. EPA Risk Management Program
Via    : Data Liberation Project (FOIA), served by rmpmap.org
Licence: CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/
  1. Attribute the Data Liberation Project AND the EPA RMP Program in any
     published or client-facing output derived from this data.
  2. Bulk redistribution must remain CC BY-SA 4.0 or compatible.
  3. Rate limit <=10 req/s; this module pages at ~2.9 req/s.
  4. Do NOT present this data as official EPA output or imply endorsement.
Self-reported: "may contain errors or omissions". Every field is an unverified
input until it passes the confidence model.

Usage
-----
    python water_rmp.py                     # full pull, writes CSV + JSON
    python water_rmp.py --state PA          # single state
    python water_rmp.py --dry-run           # fetch counts only, write nothing

Outputs (to ./data by default)
    water_rmp_accounts.csv        — one row per resolved utility account
    water_rmp_sites.csv           — one row per facility
    water_rmp_review_queue.csv    — outliers + unresolved names, never dropped
    water_rmp_seed.json           — both, nested, with provenance metadata
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import os
import re
import sys
import time

# Reuse the cold-chain connector wholesale: transport (API/UA/search/_get_json/
# fetch_data_version), percentile(), validate_numerics() shape, legal-suffix
# stripping, junk-name set. Importing rather than copying keeps the two
# verticals honest — a fix to the shared gate fixes both.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import epa_rmp as base

OUT_PREFIX = "water_rmp"

# NAICS codes defining the water/wastewater addressable market (5-digit prefixes
# as reported in this dataset). MEASURED: 2283 + 1550 + 10 filings, 3,710 unique
# facilities, 1,425 active at pull time.
NAICS_IN_SCOPE = {
    "22131": "Water supply & irrigation systems",
    "22132": "Sewage treatment facilities",
    "22133": "Steam & air conditioning supply & water treatment",
}

# Chemical ids confirmed against the live API: 17 = Chlorine, 56 = Ammonia
# (anhydrous). Chlorine is the primary census signal; ammonia appears at some
# WWTPs (and, fatally, at fertilizer plants that misfile NAICS — see exclusion).
CHLORINE_IDS = {17}
AMMONIA_IDS = {56}

# Continuous-process exclusion — the physical rule from EXPANSION-PLAN.md:
# loads that cannot stop for 15 minutes without destroying core business value
# are HARD REFUSED, not scored low. A pulp/paper bleach plant files under water
# NAICS sometimes; a fertilizer/ammonia-manufacturing plant files under 325311
# but shows up inside these NAICS pulls via parent-company aliasing. Refusing
# here is the analogue of customer suppression: wrong-positive cost is furnace
# collapse, not a wasted sales cycle.
EXCLUDE_NAME_PATTERNS = [
    (r"\bpulp\b|\bpaper mill|\bbleach(ing)? plant\b", "continuous process — pulp & paper"),
    (r"\bfertilizer\b|\bnitrogen fertil|\bammonia plant\b|\burea\b", "ammonia manufacturing, not water service"),
    (r"\bsolvent\b|\bchemical (solvents|plant)\b|\brefiner(y|ies)\b|\bpetrochem\b", "chemical manufacturing"),
]
_EXCL = [(re.compile(p, re.I), why) for p, why in EXCLUDE_NAME_PATTERNS]

# ISO / RTO / balancing authority by state — identical table as cold chain.
# Drives criterion 2 (price exposure). KNOWN GAP carried from v1: non-RTO
# Southeast/West states fall back to investor-owned territory labels.
RTO_BY_STATE = base.RTO_BY_STATE

# Regulated (cost-of-service) vs deregulated retail markets. In regulated
# territory the lever is coincident/on-peak DEMAND charges; in deregulated
# retail-choice states municipal utilities face RTP-capable tariffs. Recorded
# separately so the score never conflates the two pricing mechanisms.
DEREGULATED_RETAIL = {"TX", "NY", "PA", "NJ", "MA", "CT", "NH", "ME", "MD", "OH", "IL", "MI"}

# ---------------------------------------------------------------------------
# Entity resolution — water-specific seed rules.
# MEASURED, same failure family as cold chain: American Water reports under
# EIGHT distinct parent strings ("American Water", "PA-American Water Company",
# "Pennsylvania American Water", "New Jersey American Water", "Missouri
# American Water Company", "American Water Works Company, Inc.", …) covering
# 22 sites in 7 states. Exact-match grouping splits it into six accounts.
# Municipals are the opposite problem: "City of Millington, TN" vs "Town of
# Vidalia" are genuinely different operators — there is no corporate parent to
# merge them into, and string similarity must NOT be allowed to invent one.
# Patterns go through base._guard-style anchoring semantics: leading boundary
# always required (no mid-word absorption, the Sodus/Cold-Storage lesson).
# ---------------------------------------------------------------------------
WATER_CANONICAL_SOURCES = [
    (r"^american water|^pa-?american water|pennsylvania american water|new jersey american water|missouri american water|american water works", "American Water Utilities Holdings"),
    (r"^aquа america|^aqua america|aqua (long island|brattleboro|clearwater|experts in water)", "Aqua America, Inc."),  # NB kept ASCII-safe below
    (r"^national water company|^nj water service", "National Water Companies"),
    (r"great lakes water authority", "Great Lakes Water Authority"),
    (r"metropolitan water district of (southern|so\.?) california", "Metropolitan Water District of Southern California"),
    (r"^city of los angeles department of water", "Los Angeles Department of Water & Power"),
    (r"dallas water utilities", "Dallas Water Utilities"),
    (r"^el paso water", "El Paso Water"),
    (r"san antonio water system", "San Antonio Water System"),
    (r"^miami-dade water and sewer", "Miami-Dade Water & Sewer Management Dept"),
    (r"north texas municipal water district", "North Texas Municipal Water District"),
    (r"puerto rico aqueduct and sewer authority", "PR Aqueduct & Sewer Authority (ACQUEDUCTOS)"),
    (r"trinity river authority", "Trinity River Authority of Texas"),
    (r"sonoma county water agency", "Sonoma County Water Agency"),
    (r"east bay municipal utility district", "East Bay Municipal Utility District"),
    (r"st\.? louis board of (water|utilities)", "St. Louis Board of Water Supply"),
    (r"philadelphia water department", "Philadelphia Water Department"),
    (r"new york city departments of water", "NYC DEP"),
    (r"watershed management (authority|district)|central florida water management", "Regional Water Management Authority"),
    (r"virginia water resources", "Virginia American Water"),  # VAWRE was acquired by AW; keep merged
]
# strip the accidental non-ASCII in the aqua line above before compiling
WATER_CANONICAL_SOURCES[1] = (r"^aqua america|aqua long island|aqua brattleboro|aqua clearwater", "Aqua America, Inc.")


def _wguard(source: str) -> re.Pattern:
    """Leading-boundary guard per alternative (same discipline as epa_rmp._guard).

    Trailing guard omitted deliberately: legitimate variants continue past the
    token ("American Water Works Company"). Leading-only is the safe direction:
    it prevents 'X-american water' absorbing into unrelated strings mid-word
    while allowing suffix continuation.
    """
    parts = []
    for alt in source.split("|"):
        start_anchored = alt.startswith("^")
        body = alt[1:] if start_anchored else alt
        lead = "^" if start_anchored else r"(?<![a-z0-9])"
        parts.append(lead + body)
    return re.compile("|".join(parts))


WATER_CANONICAL_PARENTS = [(_wguard(src), canonical) for src, canonical in WATER_CANONICAL_SOURCES]

# Existing Ndustrial customers in this vertical — populated from CRM in
# production, never hardcoded. Empty placeholder keeps the suppression code path
# exercised and visible.
KNOWN_CUSTOMERS: set[str] = set()


def canonicalise(name: str | None) -> tuple[str, str, str] | None:
    """Resolve a reported name to (bucket_key, display_name, resolved_by).

    Same contract as epa_rmp.canonicalise: returns None when unusable so the
    caller routes the facility to the human review queue instead of inventing
    an account. Water twist: when parentCompanyName is absent, municipality
    utilities report their OPERATOR in facilityName ("City of Ardmore Water
    Treatment Plant"), so facilityName is a legitimate fallback here — unlike
    food processing where a plant nickname would fragment a national brand.
    """
    if not name or not name.strip():
        return None
    low = name.lower()
    for pattern, canonical in WATER_CANONICAL_PARENTS:
        if pattern.search(low):
            return base.match_key(canonical), canonical, "rule"
    key = base.match_key(name)
    if not key or key in base.JUNK_NAMES:
        return None
    shown = base.display_name(name)
    if not shown:
        return None
    return key, shown, "fallback"


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------
def max_charge(facility: dict, ids: set[int], name_frag: str) -> int:
    """Largest single reported charge for a chemical, reading BOTH record shapes.

    Live API uses {chemicalId, chemicalName, quantity}; the frozen fixture uses
    compact {_chem:[{id,name,qty}]}. The cold-chain connector learned this the
    hard way (reading one shape silently zeroed every site in the fixture); the
    lesson is inherited, not rediscovered.
    """
    qs = [c.get("quantity") or 0 for c in (facility.get("chemicals") or [])
          if c.get("chemicalId") in ids or name_frag in (c.get("chemicalName") or "")]
    qs += [c.get("qty") or 0 for c in (facility.get("_chem") or [])
           if c.get("id") in ids or name_frag in (c.get("name") or "")]
    return max(qs, default=0)


def chlorine_lb(facility: dict) -> int:
    return max_charge(facility, CHLORINE_IDS, "Chlorine")


def ammonia_lb(facility: dict) -> int:
    return max_charge(facility, AMMONIA_IDS, "mmonia")


def excluded_reason(facility: dict) -> str | None:
    """Hard-refusal check. Returns the reason string or None."""
    hay = " ".join(filter(None, (facility.get("facilityName"),
                                 facility.get("parentCompanyName"),
                                 facility.get("operatorName"))))
    for rx, why in _EXCL:
        if rx.search(hay):
            return f"{why} — continuous/unsuitable process, refused at ingestion"
    return None


# ---------------------------------------------------------------------------
# Proxy metrics and scoring
# ---------------------------------------------------------------------------
# est_peak_kw — an ENGINEERING ESTIMATE, explicitly labelled as such everywhere
# it surfaces. Derivation, stated so Ndustrial engineers can attack the number
# rather than the black box: gas-chlorine inventory tiers roughly track design
# flow (each 100 lb/day Cl2 ≈ 22.7 m³/day ≈ 0.006 MGD treated); main pumping
# typically dominates site kW (one 1,000 hp pump ≈ 750 kW). We bucket by the
# regulatory program level (which itself thresholds on chemical inventory) and
# chlorine mass, then let the buffer estimate ride on top. Replace with metered
# kW at enrichment stage; the field exists so the funnel carries the ROI
# triangle as DATA rather than vibes.
def est_peak_kw(site: dict) -> int:
    cl, lvl = site["chlorine_lb"], site.get("program_level") or 3
    if cl >= 300_000: return 8_000
    if cl >= 100_000: return 5_000
    if cl >= 40_000:  return 3_000
    if cl >= 10_000:  return 1_500
    if lvl == 1:      return 2_000   # worst-case-release offsite-consequence plants are big
    if lvl == 2:      return 1_200
    return 500


# buffer_hours_est — elevated potable storage and wet-well/inflow detention are
# the gravity equivalents of the cold-store thermal battery. Hours depend on
# tank volume vs demand, which RMP does not report; we record the QUALITATIVE
# class only (high for water supply pulled from elevated networks, medium for
# WWTP headworks/inflow buffers) and mark it inferred. It is never numerically
# scored in Phase 1 — pretending otherwise would be the dishonest version of
# this prototype.
WATER_RX = re.compile(r"\b(water|aquifer|wellfield|well field|irrigation)\b", re.I)
SEWER_RX = re.compile(r"\b(sewerage|sewage|wastewater|waste water|wwtp|reclamation|"
                      r"water resource recovery|pollution control)\b", re.I)


def site_buffer_class(site: dict) -> str:
    """Per-site buffer class. NAICS is self-reported and unreliable at the
    margin (a sewering district files under 22131; a treatment plant's name
    says what it actually is), so classify on facility NAME first, NAICS as
    tie-breaker — same lesson as reading both chemical record shapes."""
    hay = site.get("name") or ""
    naics = str(site.get("naics") or "")
    if SEWER_RX.search(hay): return "wet-well / inflow detention (inferred)"
    if WATER_RX.search(hay): return "elevated storage network (inferred)"
    if naics.startswith("22131"): return "elevated storage network (inferred)"
    if naics.startswith("22132"): return "wet-well / inflow detention (inferred)"
    return "buffer unknown"


def account_buffer_class(scored_sites: list[dict]) -> str:
    """Account-level buffer = majority over the sites' own classes. Mixed
    portfolios resolve to whichever side dominates; ties prefer the weaker
    evidence ('unknown') rather than inventing inertia."""
    c = collections.Counter(site_buffer_class(s) for s in scored_sites)
    top, n = c.most_common(1)[0]
    tied = [k for k, v in c.items() if v == n]
    if len(tied) > 1:
        return "mixed portfolio (per-station audit required)"
    return top


def icp_score(a: dict) -> dict:
    """Expansion ICP score — the three ROI conditions, made explicit.

    Transparent and additive like the cold-chain model, but the criteria are
    now NAMED after the physics/commercial test they stand for, because the
    whole point of this prototype is showing Ndustrial the triangle survives
    translation to a new vertical:

      meter_size      (0-25)  large electrical meter / high peak-kW draw
                              → proxy: estimated aggregate site kW
      price_exposure  (0-25)  volatile pricing → RTO label + deregulated retail
      sheddability    (0-25)  buffer/inertia → QUALITATIVE class only, capped
                              at 15 without a human confirmation flag. An
                              unconfirmed inference must never outvote physics.
      operating_signal(0-15)  accidents/recent incidents + filing-cycle recency
      channel_fit     (0-10)  multi-site operator OR named authority = partner-
                              sellable footprint (OEM/EPC GTM needs accounts with
                              repeatable station designs)
    """
    kw = a["est_peak_kw_total"]
    parts = {}
    parts["meter_size"] = min(25, round(kw / 400))                      # 10 MW+ saturates
    rto = a["primary_rto"]
    pe = 12 if rto in {"PJM", "ERCOT", "ISO-NE", "NYISO", "CAISO"} else \
         8 if rto in {"MISO", "SPP", "SERC", "Duke", "TVA"} else 5
    if a["dereg_state"]: pe += 6                                        # RTP-capable tariff class
    parts["price_exposure"] = min(25, pe)
    sh = 15 if a["buffer_confirmed"] else (12 if a["buffer_class"].startswith("elevated") else
        9 if a["buffer_class"].startswith("wet-well") else
        8 if a["buffer_class"].startswith("mixed") else 4)
    parts["sheddability"] = sh
    parts["operating_signal"] = min(15, a["sites_with_accidents"] * 4 + (3 if a["recent_accident_sites"] else 0))
    parts["channel_fit"] = min(10, (2 if a["multi_site"] else 0) + (4 if a["states"] > 1 else 0) +
                               (4 if a["is_authority"] else 0))
    total = sum(parts.values())
    return {"score": min(100, total), "components": parts}


AUTHORITY_RX = re.compile(r"\b(authority|district|utility|utilities|board|municipal|public service|"
                          r"commission|metropolitan|region\w*)\b", re.I)


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------
def aggregate(facilities: list[dict]) -> tuple[list, list, list, list]:
    """Collapse facility records into resolved utility accounts.

    Mirrors epa_rmp.aggregate contract: returns (accounts, sites, review_queue,
    unresolved_records); nothing is silently dropped. Differences, each forced
    by observed water-universe behaviour:

      * exclusion pass runs BEFORE resolution (continuous-process refusal);
      * 304/1,425 active facilities report NO parent name — resolution falls
        back to facilityName, and failures go to the queue with the operator
        hint preserved;
      * pilot filter differs: cold chain could require ≥2 sites or ≥250k lb
        because it targeted enterprise logos. Here a SINGLE megawatt-scale
        plant is a valid target (that's how utilities buy), so the filter is
        est_peak_kw ≥ 1,000 across validated sites — plus multi-site operators
        regardless of size, because those are the partner-channel accounts.
    """
    buckets: dict[str, dict] = collections.defaultdict(lambda: {"sites": [], "aliases": set(), "name": ""})
    unresolved: list[dict] = []
    excluded: list[dict] = []

    for f in facilities:
        if f.get("isDeregistered"):
            continue
        why = excluded_reason(f)
        if why:
            excluded.append({"rmp_id": f.get("facilityId"), "name": f.get("facilityName"),
                             "city": f.get("city"), "state": f.get("state"),
                             "naics": f.get("naicsCode"), "chlorine_lb": chlorine_lb(f),
                             "ammonia_lb": ammonia_lb(f), "reason": why,
                             "action": "confirm refusal or reclassify (human)"})
            continue
        reported = next((v for v in (f.get("parentCompanyName"), f.get("operatorName"),
                                     f.get("facilityName")) if isinstance(v, str) and v.strip()), None)
        resolved = canonicalise(reported)
        if resolved is None:
            unresolved.append({"rmp_id": f.get("facilityId"), "name": f.get("facilityName"),
                               "city": f.get("city"), "state": f.get("state"),
                               "reported_name": reported, "naics": f.get("naicsCode"),
                               "chlorine_lb": chlorine_lb(f),
                               "reason": "no usable parent/operator/facility name after normalisation",
                               "action": "assign to a utility account or create one"})
            continue
        key, shown, by = resolved
        bucket = buckets[key]
        bucket["aliases"].add(reported)
        if by == "rule":
            bucket["name"] = shown
        elif not bucket.get("name"):
            bucket["name"] = shown
        bucket["sites"].append({
            "name": f.get("facilityName"), "city": f.get("city"), "state": f.get("state"),
            "naics": f.get("naicsCode"), "chlorine_lb": chlorine_lb(f),
            "ammonia_lb": ammonia_lb(f), "program_level": f.get("programLevel"),
            "accidents": f.get("allAccidentsCount", 0) or 0,
            "recent_accidents": f.get("recentAccidentsCount", 0) or 0,
            "submissions": f.get("submissionsCount", 0) or 0,
            "rmp_id": f.get("facilityId"), "url": f.get("facilityURL") or "",
            "lat": f.get("facilityLat"), "lon": f.get("facilityLong"),
        })

    all_sites = [s for b in buckets.values() for s in b["sites"]]
    validate_water_numerics(all_sites)

    accounts = []
    for b in buckets.values():
        sites = b["sites"]
        scored_sites = [s for s in sites if s.get("validated", True)]
        if not scored_sites:
            continue
        for s in scored_sites:
            s["est_peak_kw"] = est_peak_kw(s)
            s["buffer_class"] = site_buffer_class(s)
        kw_total = sum(s["est_peak_kw"] for s in scored_sites)
        largest_cl = max((s["chlorine_lb"] for s in scored_sites), default=0)
        if kw_total < 1_000 and len(scored_sites) < 2:
            continue
        states = collections.Counter(s["state"] for s in sites)
        rtos = collections.Counter(RTO_BY_STATE.get(s["state"], "Other") for s in sites)
        naics = collections.Counter(str(s["naics"]) for s in sites)
        primary_naics = naics.most_common(1)[0][0]
        primary_state = states.most_common(1)[0][0]
        buffer = account_buffer_class(scored_sites)
        name = b["name"]
        accounts.append({
            "account": name,
            "is_customer": name in KNOWN_CUSTOMERS,
            "aliases": sorted(b["aliases"]),
            "sites": len(sites),
            "chlorine_lb": sum(s["chlorine_lb"] for s in scored_sites),
            "max_site_chlorine_lb": largest_cl,
            "ammonia_lb_note": sum(s["ammonia_lb"] for s in scored_sites),
            "unvalidated_sites": len(sites) - len(scored_sites),
            "est_peak_kw_total": kw_total,
            "buffer_class": buffer,
            "buffer_confirmed": False,   # no human has confirmed inertia yet
            "states": len(states),
            "state_list": ",".join(sorted(states)),
            "primary_state": primary_state,
            "primary_rto": rtos.most_common(1)[0][0],
            "dereg_state": primary_state in DEREGULATED_RETAIL,
            "multi_site": len(scored_sites) > 1,
            "is_authority": bool(AUTHORITY_RX.search(name)),
            "accidents": sum(s["accidents"] for s in sites),
            "sites_with_accidents": sum(1 for s in scored_sites if s["accidents"] > 0),
            "recent_accident_sites": sum(1 for s in scored_sites if s["recent_accidents"] > 0),
            "primary_naics": primary_naics,
            "vertical": NAICS_IN_SCOPE.get(primary_naics[:5], "Other"),
            "_sites": sites,
        })

    accounts.sort(key=lambda a: (-a["est_peak_kw_total"], -a["chlorine_lb"]))
    for i, a in enumerate(accounts, 1):
        a["rank"] = i
    sites_out = [dict(s, account=a["account"]) for a in accounts for s in a["_sites"]]

    surviving = {id(s) for a in accounts for s in a["_sites"]}
    flagged = [{**s, "account": b["name"], "kind": "numeric_outlier",
                "reason": s.get("validation_note", ""),
                "action": "verify the filing, correct the value, or confirm exclusion"}
               for b in buckets.values() for s in b["sites"]
               if not s.get("validated", True) and id(s) not in surviving]
    review_queue = (flagged
                    + [{**r, "kind": "unresolved_name"} for r in unresolved]
                    + [{**e, "kind": "process_exclusion"} for e in excluded])
    return accounts, sites_out, review_queue, unresolved


# ---------------------------------------------------------------------------
# Numeric validation gate — chlorine ceiling + ammonia cross-check
# ---------------------------------------------------------------------------
# MEASURED NECESSITY, demonstrated twice in this very pull:
#   * Koch Fertilizer Enid (OK) reports 180,000,000 lb ammonia inside a water
#     NAICS filing; Nutrien Augusta (GA) 72,000,000 lb. These are nitrogen
#     fertilizer plants (NAICS 325311) surfacing via parent aliasing — the
#     name-pattern exclusion catches them, but the distribution gate must ALSO
#     catch them independently, because exclusion is heuristic and the gate is
#     arithmetic. Belt AND braces, both logged.
#   * Chlorine p99 sits near 250,000 lb; anything beyond p99×10 is a probable
#     units error (kg filed as lb) or a bulk terminal, not a treatment plant.
def validate_water_numerics(sites: list[dict]) -> list[dict]:
    for field, label in (("chlorine_lb", "chlorine"), ("ammonia_lb", "ammonia")):
        vals = [s[field] for s in sites if s[field] > 0]
        p99 = base.percentile(vals, 0.99)
        ceiling = p99 * base.OUTLIER_FACTOR
        median = base.percentile(vals, 0.5)
        for s in sites:
            s.setdefault("validated", True)
            s.setdefault("validation_note", "")
            if s[field] > ceiling:
                s["validated"] = False
                note = (f"{field} {s[field]:,} exceeds p99 ({p99:,.0f} lb) x "
                        f"{base.OUTLIER_FACTOR}; median {median:,.0f} lb. Probable units "
                        f"error, bulk storage terminal, or misfiled {label} plant. "
                        f"Excluded from scoring pending human review.")
                s["validation_note"] = (s["validation_note"] + " | " if s["validation_note"] else "") + note
        flagged = sum(1 for s in sites if not s["validated"])
        print(f"  ! {label} validation gate: p99 {p99:,.0f} lb · ceiling {ceiling:,.0f} lb · "
              f"{flagged} cumulative site flag(s)")
    return sites


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def run(state: str | None, outdir: str, dry: bool) -> int:
    print("COLDPATH expansion connector — EPA RMP, Water & Wastewater")
    print("=" * 62)
    ver = base.fetch_data_version()
    print(f"  dataset v{ver.get('version')} · exported {ver.get('dataExportDate')} · "
          f"through {ver.get('dataThroughDate')}")
    print(f"  licence {ver.get('_meta', {}).get('license')} — attribution required\n")

    facilities: dict[str, dict] = {}
    for code in NAICS_IN_SCOPE:
        params = {"naicsCodes": code}
        if state:
            params["state"] = state
        for f in base.search(params, f"NAICS {code} {NAICS_IN_SCOPE[code][:26]}"):
            facilities[f["facilityId"]] = f
    print(f"\n  unique facilities in scope: {len(facilities)}")

    accounts, sites, review_queue, unresolved_records = aggregate(list(facilities.values()))
    for a in accounts:
        a["icp"] = icp_score(a)
    excl_n = sum(1 for r in review_queue if r["kind"] == "process_exclusion")
    print(f"  resolved accounts (pilot filter applied): {len(accounts)}")
    print(f"  sites: {len(sites)}   chlorine (validated): {sum(a['chlorine_lb'] for a in accounts)/1e6:.2f}M lb")
    print(f"  est. aggregate peak kW across accounts: {sum(a['est_peak_kw_total'] for a in accounts):,}")
    print(f"  review queue: {len(review_queue)} record(s)  "
          f"({sum(1 for r in review_queue if r['kind']=='numeric_outlier')} numeric outliers, "
          f"{len(unresolved_records)} unresolved names, {excl_n} process exclusions)")
    print(f"  existing customers suppressed: {[a['account'] for a in accounts if a['is_customer']]}")
    print(f"  accounts with >1 reported alias: {sum(1 for a in accounts if len(a['aliases']) > 1)}")

    if dry:
        print("\n  --dry-run: nothing written")
        return 0

    os.makedirs(outdir, exist_ok=True)
    acct_cols = ["rank", "icp_score", "account", "is_customer", "sites", "unvalidated_sites",
                 "chlorine_lb", "max_site_chlorine_lb", "est_peak_kw_total", "buffer_class",
                 "buffer_confirmed", "states", "state_list", "primary_state", "primary_rto",
                 "dereg_state", "multi_site", "is_authority", "accidents", "sites_with_accidents",
                 "recent_accident_sites", "primary_naics", "vertical", "aliases"]
    with open(os.path.join(outdir, f"{OUT_PREFIX}_accounts.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=acct_cols, extrasaction="ignore")
        w.writeheader()
        for a in accounts:
            row = {k: a.get(k) for k in acct_cols}
            row["aliases"] = " | ".join(a["aliases"])
            row["icp_score"] = a["icp"]["score"]
            w.writerow(row)
    site_cols = ["account", "name", "city", "state", "naics", "chlorine_lb", "ammonia_lb",
                 "program_level", "est_peak_kw", "buffer_class", "accidents", "recent_accidents",
                 "submissions", "validated", "validation_note", "rmp_id", "url", "lat", "lon"]
    with open(os.path.join(outdir, f"{OUT_PREFIX}_sites.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=site_cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(sites)
    with open(os.path.join(outdir, f"{OUT_PREFIX}_review_queue.csv"), "w", newline="") as fh:
        cols = ["kind", "rmp_id", "name", "city", "state", "naics", "chlorine_lb", "ammonia_lb",
                "reported_name", "account", "reason", "validation_note", "action"]
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(review_queue)
    with open(os.path.join(outdir, f"{OUT_PREFIX}_seed.json"), "w") as fh:
        json.dump({
            "meta": {"source": "U.S. EPA Risk Management Program via Data Liberation Project (rmpmap.org)",
                     "license": ver.get("_meta", {}).get("license"),
                     "dataset_version": ver.get("version"),
                     "data_export_date": ver.get("dataExportDate"),
                     "data_through_date": ver.get("dataThroughDate"),
                     "connector": "water_rmp.py/1.0",
                     "pulled_at": ver.get("_meta", {}).get("pulled_at"),
                     "naics_in_scope": NAICS_IN_SCOPE,
                     "proxy_caveat": "chlorine_lb is a disinfection-scale proxy, NOT metered kW; "
                                     "est_peak_kw is an engineering estimate and must be replaced "
                                     "by bill/meter data during enrichment. Registry misses "
                                     "hypochlorite/UV utilities entirely (lower bound).",
                     "attribution": "U.S. EPA Risk Management Program via Data Liberation Project. CC BY-SA 4.0."},
            "accounts": [{k: v for k, v in a.items() if k != "_sites"} for a in accounts],
            "sites": sites,
            "review_queue": review_queue,
        }, fh, indent=1, default=str)
    print(f"\n  wrote {outdir}/{OUT_PREFIX}_accounts.csv ({len(accounts)} rows)")
    print(f"  wrote {outdir}/{OUT_PREFIX}_sites.csv ({len(sites)} rows)")
    print(f"  wrote {outdir}/{OUT_PREFIX}_review_queue.csv ({len(review_queue)} rows)")
    print(f"  wrote {outdir}/{OUT_PREFIX}_seed.json")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--state", help="restrict to one state (e.g. PA)")
    p.add_argument("--outdir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    p.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    a = p.parse_args()
    return run(a.state, os.path.normpath(a.outdir), a.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
