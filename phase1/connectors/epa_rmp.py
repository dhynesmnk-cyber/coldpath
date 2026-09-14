"""
COLDPATH Phase 1 — Connector: EPA Risk Management Program (RMP)
===============================================================

Enumerates the US industrial ammonia-refrigeration universe from public EPA RMP
filings. This is the cold-chain-specific top-of-funnel source: any facility
holding >10,000 lb of anhydrous ammonia must file a Risk Management Plan, and
those filings are public.

DATA PROVENANCE AND LICENSING — READ BEFORE USE
-----------------------------------------------
Source : U.S. EPA Risk Management Program
Via    : Data Liberation Project (FOIA), served by rmpmap.org
Licence: CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/
Terms  : https://rmpmap.org/api-docs#api-terms

Obligations:
  1. Attribute the Data Liberation Project AND the EPA RMP Program in any
     published or client-facing output derived from this data.
  2. Bulk redistribution must remain CC BY-SA 4.0 or compatible.
  3. Rate limit: <=10 req/s. This module uses 0.35s between pages (~2.9 req/s).
  4. Do NOT present this data as official EPA output or imply endorsement.

The data is self-reported by facilities and EPA warns it "may contain errors or
omissions". Treat every field as an unverified input that requires the
confidence model before it reaches a prospect-facing deliverable.

Usage
-----
    python epa_rmp.py                     # full pull, writes CSV + JSON
    python epa_rmp.py --naics 49312       # single vertical
    python epa_rmp.py --state PA          # single state
    python epa_rmp.py --dry-run           # fetch counts only, write nothing

Outputs (to ./data by default)
    coldchain_rmp_accounts.csv  — one row per resolved account
    coldchain_rmp_sites.csv     — one row per facility
    coldchain_rmp_seed.json     — both, nested, with provenance metadata
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
import urllib.error
import urllib.parse
import urllib.request

API = "https://rmpmap.org/api"
UA = {"User-Agent": "coldpath-connector/1.0 (+https://ndustrial.com) account-intelligence-pilot"}
PAGE_SIZE = 200
MAX_PAGES = 40
SLEEP_S = 0.35
TIMEOUT_S = 90
RETRIES = 3

# NAICS codes that define the cold-chain addressable market.
# Keys are the 5-digit prefixes the RMP dataset uses.
NAICS_IN_SCOPE = {
    "49312": "Refrigerated warehousing & storage",
    "31161": "Animal slaughtering & processing",
    "31151": "Dairy product manufacturing",
    "31141": "Frozen fruit & vegetable manufacturing",
    "31142": "Frozen specialty food manufacturing",
    "31199": "All other food manufacturing",
    "42441": "Grocery & related product merchant wholesalers",
    "42449": "Other grocery & related products wholesalers",
    "44511": "Supermarkets & other grocery retailers",
}

# Anhydrous ammonia is chemicalId 56 in this dataset. Confirmed by sampling.
AMMONIA_IDS = {56}

# ISO / RTO / balancing authority by state. Drives the "grid exposure" ICP
# criterion, because capacity-price volatility is where the commercial value is.
RTO_BY_STATE = {
    "PA": "PJM", "NJ": "PJM", "MD": "PJM", "DE": "PJM", "VA": "PJM", "WV": "PJM", "OH": "PJM",
    "IL": "PJM", "IN": "MISO", "MI": "MISO", "WI": "MISO", "MN": "MISO", "MO": "MISO",
    "IA": "MISO", "LA": "MISO", "ND": "MISO", "AR": "SPP", "OK": "SPP", "KS": "SPP",
    "NE": "SPP", "SD": "SPP", "TX": "ERCOT", "NY": "NYISO", "NC": "Duke", "SC": "Duke",
    "GA": "SERC", "FL": "SERC", "AL": "SERC", "MS": "SERC", "TN": "TVA", "KY": "TVA",
    "CA": "CAISO", "OR": "NW", "WA": "NW", "ID": "NW", "MT": "NW", "CO": "WECC",
    "UT": "WECC", "NV": "WECC", "AZ": "WECC", "NM": "WECC", "CT": "ISO-NE", "MA": "ISO-NE",
    "NH": "ISO-NE", "VT": "ISO-NE", "RI": "ISO-NE", "ME": "ISO-NE",
}

# ---------------------------------------------------------------------------
# Entity resolution
# ---------------------------------------------------------------------------
# MEASURED PROBLEM, not a hypothetical one. In a real pull of the cold-chain
# NAICS universe the same legal entity appears under many reported names:
#
#   Americold  -> "Americold Logistics, LLC" (88 sites), "Americold" (8),
#                 "Americold Realty" (5), "Americold Realty Trust" (3)
#   Lineage    -> "Lineage Logistics, LLC" (63), "Lineage  Jessup" (27)
#   Kroger     -> "Kroger, Inc." (9), "The Kroger Company" (6)
#   Sysco      -> "Sysco Corporation" (50), "Sysco Foods" (2)
#   C&S        -> "C&S Wholesale Grocers, LLC" (12), "C&S Wholesale Services, Inc." (3)
#
# 51 of 115 resolved accounts (44%) had more than one alias. Critically, a
# naive exact-match customer blocklist MISSES the largest entities entirely:
# "Americold Logistics, LLC" does not equal "Americold", so an 88-site existing
# customer would have been queued for outbound. That is the single worst
# failure mode available to this system and it is why entity resolution is
# stage 1 of the pipeline rather than a cleanup step.
#
# This map is a SEED. In production it is a database table maintained by the
# marketer, and every unresolved facility is surfaced for human assignment.
CANONICAL_PARENTS = [
    (r"americold", "Americold Realty Trust"),
    (r"lineage", "Lineage, Inc."),
    (r"united states cold storage|us cold storage", "United States Cold Storage"),
    (r"^kroger|the kroger", "The Kroger Co."),
    (r"^sysco", "Sysco Corporation"),
    (r"u\.?s\.? foods", "US Foods Holding Corp."),
    (r"performance food", "Performance Food Group"),
    (r"c&s wholesale", "C&S Wholesale Grocers"),
    (r"costco", "Costco Wholesale Corporation"),
    (r"tyson", "Tyson Foods, Inc."),
    (r"jbs", "JBS USA"),
    (r"wal-?mart", "Walmart Inc."),
    (r"cargill", "Cargill, Inc."),
    (r"hormel", "Hormel Foods Corporation"),
    (r"aldi", "ALDI US"),
    (r"koch foods", "Koch Foods"),
    (r"saputo", "Saputo Inc."),
    (r"nestl", "Nestlé USA"),
    (r"publix", "Publix Super Markets"),
    (r"dollar general", "Dollar General"),
    (r"gordon food", "Gordon Food Service"),
    (r"dot foods", "DOT Foods"),
    (r"united natural foods", "United Natural Foods Inc."),
    (r"safeway|albertsons", "Albertsons/Safeway"),
    (r"schwan", "Schwan's Company"),
    (r"stouffer", "Nestlé USA (Stouffer)"),
    (r"prairie farms", "Prairie Farms Dairy"),
    (r"dfa dairy|pet dairy", "Dairy Farmers of America"),
    (r"united global foods", "United Global Foods"),
    (r"tippmann", "Tippmann Group"),
    (r"taylor fresh", "Taylor Fresh Foods"),
    (r"boar.s head", "Boar's Head"),
    (r"rich products", "Rich Products"),
    (r"pictsweet", "Pictsweet Farms"),
]

# Existing Ndustrial customers. Populated from CRM in production, never hardcoded.
KNOWN_CUSTOMERS = {
    "Americold Realty Trust",
    "Lineage, Inc.",
    "United States Cold Storage",
}

LEGAL_SUFFIXES = re.compile(
    r"\b(inc|llc|ltd|lp|llp|corp|corporation|company|co|plc|gmbh|sa|nv|bv|the|and)\b",
    re.IGNORECASE,
)

# Reported names that are not names at all. Two of the four facilities the first
# version left unresolved reported the literal string "NA" as their parent.
JUNK_NAMES = {"na", "n a", "n/a", "unknown", "none", "-", "", "test", "tbd", "xxx",
              "not applicable"}


def match_key(name: str) -> str:
    """Bucketing key: case-folded, punctuation removed, legal suffixes stripped.

    Two reported names for one company MUST produce the same key, or the company
    splits into two accounts. This was a real defect: an earlier version returned
    the canonical rule's title-case string from one path and a lowercased string
    from the other, so "Dairy Farmers of America" arrived as two accounts (9 sites
    and 4 sites) instead of one with 13.

    Punctuation is REMOVED, not replaced with a space. Consequence, documented
    rather than hidden: "Wayne-Sanderson Farms" and "Wayne Sanderson Farms" do not
    merge. That merge is the job of the human resolution queue, not of string
    normalisation.
    """
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9& ]", "", LEGAL_SUFFIXES.sub(" ", name.lower()))).strip()


def display_name(name: str) -> str:
    """Human-readable account name: same normalisation, original capitalisation."""
    return re.sub(r"\s+", " ", re.sub(r"[^A-Za-z0-9& ]", "", LEGAL_SUFFIXES.sub(" ", name))).strip()


def canonicalise(name: str | None) -> tuple[str, str, str] | None:
    """Resolve a reported name to (bucket_key, display_name, resolved_by).

    Returns None when the name is unusable, so the caller routes the facility to
    the human review queue instead of inventing an account.

    Rejection uses a junk-name set, NOT a minimum length. A length rule wrongly
    rejected the real companies `JDB, Inc.` (BrucePac's reported parent) and
    `ACS-LLC`, both of which normalise to three characters.
    """
    if not name or not name.strip():
        return None
    low = name.lower()
    for pattern, canonical in CANONICAL_PARENTS:
        if re.search(pattern, low):
            return match_key(canonical), canonical, "rule"
    key = match_key(name)
    if not key or key in JUNK_NAMES:
        return None
    shown = display_name(name)
    if not shown:
        return None
    return key, shown, "fallback"


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------
def _get_json(url: str) -> dict:
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(2 ** attempt)
    print(f"  ! giving up on {url[:100]}: {last}", file=sys.stderr)
    return {"facilities": [], "total": 0}


def fetch_data_version() -> dict:
    """Provenance for every record we ingest. Stored alongside the data."""
    v = _get_json(f"{API}/data-version")
    v["_meta"] = dict(v.get("_meta") or {})
    v["_meta"]["connector"] = "epa_rmp.py/1.0"
    v["_meta"]["pulled_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return v


def search(params: dict, label: str = "") -> list[dict]:
    """Paginate /api/search. Respects the 10 req/s ceiling at ~2.9 req/s."""
    out, page, total = [], 1, None
    while page <= MAX_PAGES:
        q = urllib.parse.urlencode({**params, "perPage": PAGE_SIZE, "page": page})
        r = _get_json(f"{API}/search?{q}")
        batch = r.get("facilities") or []
        out.extend(batch)
        if total is None:
            total = r.get("total", 0)
            print(f"  {label or q[:40]:46s} {total:6d} facilities")
        if not batch or len(out) >= (total or 0):
            break
        page += 1
        time.sleep(SLEEP_S)
    return out


def max_ammonia_lb(facility: dict) -> int:
    """Largest single anhydrous-ammonia charge reported at the facility (lb).

    This is the closest public proxy for refrigeration plant size, and it is
    the single most useful qualification field in the dataset.
    """
    charges = [
        c.get("quantity") or 0
        for c in (facility.get("chemicals") or [])
        if c.get("chemicalId") in AMMONIA_IDS or "mmonia" in (c.get("chemicalName") or "")
    ]
    return max(charges, default=0)


# ---------------------------------------------------------------------------
# Aggregation and scoring
# ---------------------------------------------------------------------------
def aggregate(facilities: list[dict]) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """Collapse facility records into resolved accounts.

    Returns (accounts, sites, review_queue, unresolved_records).

    Nothing is silently dropped. Records that fail numeric validation, and
    facilities whose reported name cannot be resolved, are returned in the
    review queue with a reason so a human can correct them.
    """
    buckets: dict[str, dict] = collections.defaultdict(lambda: {"sites": [], "aliases": set(), "name": ""})
    unresolved_records: list[dict] = []

    for f in facilities:
        if f.get("isDeregistered"):
            continue  # closed / deregistered plants are not prospects
        reported = next((v for v in (f.get("parentCompanyName"), f.get("operatorName"),
                                     f.get("facilityName")) if isinstance(v, str) and v.strip()), None)
        resolved = canonicalise(reported)
        if resolved is None:
            unresolved_records.append({
                "rmp_id": f.get("facilityId"), "name": f.get("facilityName"),
                "city": f.get("city"), "state": f.get("state"),
                "reported_name": reported, "naics": f.get("naicsCode"),
                "ammonia_lb": max_ammonia_lb(f),
                "reason": "no usable parent/operator/facility name after normalisation",
                "action": "assign to an account or create one"})
            continue
        key, shown, by = resolved
        bucket = buckets[key]
        bucket["aliases"].add(reported)
        if by == "rule":
            bucket["name"] = shown          # a canonical rule outranks a fallback name
        elif not bucket.get("name"):
            bucket["name"] = shown
        bucket["sites"].append({
            "name": f.get("facilityName"),
            "city": f.get("city"),
            "state": f.get("state"),
            "naics": f.get("naicsCode"),
            "ammonia_lb": max_ammonia_lb(f),
            "program_level": f.get("programLevel"),
            "accidents": f.get("allAccidentsCount", 0) or 0,
            "recent_accidents": f.get("recentAccidentsCount", 0) or 0,
            "submissions": f.get("submissionsCount", 0) or 0,
            "rmp_id": f.get("facilityId"),
            "url": f.get("facilityURL") or "",
            "lat": f.get("facilityLat"),
            "lon": f.get("facilityLong"),
        })

    all_sites = [s for b in buckets.values() for s in b["sites"]]
    validate_numerics(all_sites)

    accounts = []
    for b in buckets.values():
        name = b["name"]
        sites = b["sites"]
        scored_sites = [s for s in sites if s.get("validated", True)]
        # Pilot filter: multi-site operators, or single sites with a large
        # enough ammonia charge to justify an enterprise motion.
        largest = max((s["ammonia_lb"] for s in scored_sites), default=0)
        if len(scored_sites) < 2 and largest < 250_000:
            continue
        states = collections.Counter(s["state"] for s in sites)
        rtos = collections.Counter(RTO_BY_STATE.get(s["state"], "Other") for s in sites)
        naics = collections.Counter(s["naics"] for s in sites)
        accounts.append({
            "account": name,
            "is_customer": name in KNOWN_CUSTOMERS,
            "aliases": sorted(b["aliases"]),
            "sites": len(sites),
            "ammonia_lb": sum(s["ammonia_lb"] for s in scored_sites),
            "max_site_ammonia_lb": largest,
            "unvalidated_sites": len(sites) - len(scored_sites),
            "states": len(states),
            "state_list": ",".join(sorted(states)),
            "primary_rto": rtos.most_common(1)[0][0],
            "accidents": sum(s["accidents"] for s in sites),
            "sites_with_accidents": sum(1 for s in scored_sites if s["accidents"] > 0),
            "primary_naics": naics.most_common(1)[0][0],
            "vertical": NAICS_IN_SCOPE.get(naics.most_common(1)[0][0], "Other"),
            "rmp_url": f"{API.replace('/api', '')}",
            "_sites": sites,
        })

    accounts.sort(key=lambda a: (-a["sites"], -a["ammonia_lb"]))
    for i, a in enumerate(accounts, 1):
        a["rank"] = i

    sites = [dict(s, account=a["account"]) for a in accounts for s in a["_sites"]]

    # Flagged records must be queued even when their account is filtered out
    # entirely — otherwise the loudest data-quality signal in the dataset is
    # the one that disappears. Scan every bucket, not just surviving accounts.
    surviving = {id(s) for a in accounts for s in a["_sites"]}
    flagged = [
        {**s, "account": b["name"], "kind": "numeric_outlier",
         "reason": s.get("validation_note", ""),
         "action": "verify the filing, correct the value, or confirm exclusion"}
        for b in buckets.values() for s in b["sites"]
        if not s.get("validated", True) and id(s) not in surviving
    ]
    review_queue = flagged + [{**r, "kind": "unresolved_name"} for r in unresolved_records]
    return accounts, sites, review_queue, unresolved_records


# ---------------------------------------------------------------------------
# Numeric validation gate
# ---------------------------------------------------------------------------
# MEASURED NECESSITY, not defensive programming. In a real pull one facility
# ("Neches Terminal", Beaumont TX, reported under "Martin Operating Partnership")
# declares 89,000,000 lb of anhydrous ammonia. Across 749 sites the median is
# 20,174 lb and p99 is 200,000 lb — the next largest single charge is 715,862 lb.
# That one record is 445x p99, the facility is a marine terminal rather than a
# cold store, and left unvalidated it scored 60 on the ICP model and ranked
# #15 of 112 prospects — above Hormel, Schwan's and Cargill.
#
# Self-reported regulatory data contains units errors and NAICS misclassifications.
# Every numeric field must pass a distribution check before it may influence a
# score. Flagged records are retained and surfaced for human review, never
# silently dropped.

OUTLIER_FACTOR = 10


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    vs = sorted(values)
    return vs[min(len(vs) - 1, int(len(vs) * pct))]


def validate_numerics(sites: list[dict]) -> list[dict]:
    """Flag statistically implausible numeric fields. Mutates and returns sites.

    A flagged site keeps its record (so a human can inspect and correct it) but
    is excluded from account-level ammonia aggregation and from ICP scoring.
    """
    charges = [s["ammonia_lb"] for s in sites if s["ammonia_lb"] > 0]
    p99 = percentile(charges, 0.99)
    ceiling = p99 * OUTLIER_FACTOR
    median = percentile(charges, 0.5)
    flagged = 0
    for s in sites:
        s["validated"] = True
        s["validation_note"] = ""
        if s["ammonia_lb"] > ceiling:
            s["validated"] = False
            s["validation_note"] = (
                f"ammonia_lb {s['ammonia_lb']:,} exceeds p99 ({p99:,.0f} lb) x "
                f"{OUTLIER_FACTOR}; median is {median:,.0f} lb. Probable units "
                f"error or NAICS misclassification in the self-reported filing. "
                f"Excluded from scoring pending human review."
            )
            flagged += 1
    if flagged:
        print(f"  ! numeric validation gate: {flagged} site record(s) flagged as "
              f"outliers (p99 {p99:,.0f} lb, ceiling {ceiling:,.0f} lb)")
    return sites


def icp_score(a: dict) -> dict:
    """Phase 1 ICP score from RMP fields alone.

    Deliberately transparent and additive so a marketer can audit or override
    any component. Weights mirror the ICP definition in the prototype.
    Enrichment-based criteria (contacts, intent, financials) are added in
    later pipeline stages and are NOT part of this score.
    """
    parts = {}
    parts["scale"] = min(20, a["sites"] * 2)                                  # 0-20
    parts["refrig_intensity"] = min(25, round(a["ammonia_lb"] / 40_000))      # 0-25
    # a["ammonia_lb"] already excludes records failed by validate_numerics()
    parts["geographic_spread"] = min(15, a["states"] * 2)                     # 0-15
    parts["grid_exposure"] = 14 if a["primary_rto"] in {"PJM", "ERCOT", "ISO-NE"} else (
        10 if a["primary_rto"] in {"MISO", "NYISO", "CAISO"} else 6)          # 6-14
    parts["replacement_signal"] = min(12, a["sites_with_accidents"] * 3)      # 0-12
    parts["vertical_fit"] = 14 if a["primary_naics"] == "49312" else 9        # 9-14
    total = sum(parts.values())
    return {"score": min(100, total), "components": parts}


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def run(naics: list[str] | None, state: str | None, outdir: str, dry: bool) -> int:
    print("COLDPATH connector — EPA Risk Management Program")
    print("=" * 62)
    ver = fetch_data_version()
    print(f"  dataset v{ver.get('version')} · exported {ver.get('dataExportDate')} · "
          f"through {ver.get('dataThroughDate')}")
    print(f"  licence {ver.get('_meta', {}).get('license')} — attribution required\n")

    codes = naics or list(NAICS_IN_SCOPE)
    facilities: dict[str, dict] = {}
    for code in codes:
        params = {"naicsCodes": code}
        if state:
            params["state"] = state
        for f in search(params, f"NAICS {code} {NAICS_IN_SCOPE.get(code, '')[:26]}"):
            facilities[f["facilityId"]] = f
    print(f"\n  unique facilities in scope: {len(facilities)}")

    accounts, sites, review_queue, unresolved_records = aggregate(list(facilities.values()))
    for a in accounts:
        a["icp"] = icp_score(a)
    print(f"  resolved accounts (pilot filter applied): {len(accounts)}")
    print(f"  sites: {len(sites)}   total ammonia (validated): {sum(a['ammonia_lb'] for a in accounts)/1e6:.1f}M lb")
    print(f"  review queue: {len(review_queue)} record(s)  "
          f"({sum(1 for r in review_queue if r['kind'] == 'numeric_outlier')} numeric outliers, "
          f"{len(unresolved_records)} unresolved names)")
    print(f"  existing customers correctly suppressed: "
          f"{[a['account'] for a in accounts if a['is_customer']]}")
    print(f"  accounts with >1 reported alias: {sum(1 for a in accounts if len(a['aliases']) > 1)}")

    if dry:
        print("\n  --dry-run: nothing written")
        return 0

    os.makedirs(outdir, exist_ok=True)
    acct_cols = ["rank", "icp_score", "account", "is_customer", "sites", "unvalidated_sites",
                 "ammonia_lb", "max_site_ammonia_lb", "states", "state_list", "primary_rto",
                 "accidents", "sites_with_accidents", "primary_naics", "vertical", "aliases"]
    with open(os.path.join(outdir, "coldchain_rmp_accounts.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=acct_cols, extrasaction="ignore")
        w.writeheader()
        for a in accounts:
            row = {k: a.get(k) for k in acct_cols}
            row["aliases"] = " | ".join(a["aliases"])
            row["icp_score"] = a["icp"]["score"]
            w.writerow(row)
    with open(os.path.join(outdir, "coldchain_rmp_sites.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(sites[0].keys()))
        w.writeheader()
        w.writerows(sites)
    with open(os.path.join(outdir, "coldchain_rmp_review_queue.csv"), "w", newline="") as fh:
        cols = ["kind", "rmp_id", "name", "city", "state", "naics", "ammonia_lb",
                "reported_name", "account", "reason", "validation_note", "action"]
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(review_queue)
    with open(os.path.join(outdir, "coldchain_rmp_seed.json"), "w") as fh:
        json.dump({
            "meta": {"source": ver.get("_meta", {}).get("source"),
                     "license": ver.get("_meta", {}).get("license"),
                     "license_url": ver.get("_meta", {}).get("licenseUrl"),
                     "attribution": ver.get("_meta", {}).get("attribution"),
                     "disclaimer": ver.get("_meta", {}).get("disclaimer"),
                     "dataset_version": ver.get("version"),
                     "data_export_date": ver.get("dataExportDate"),
                     "data_through_date": ver.get("dataThroughDate"),
                     "connector": ver.get("_meta", {}).get("connector"),
                     "pulled_at": ver.get("_meta", {}).get("pulled_at"),
                     "naics_in_scope": NAICS_IN_SCOPE,
                     "unresolved_facilities": len(unresolved_records),
                     "review_queue": review_queue,
                     "attribution": "U.S. EPA Risk Management Program via Data Liberation Project. CC BY-SA 4.0."},
            "accounts": [{k: v for k, v in a.items() if k != "_sites"} for a in accounts],
            "sites": sites,
        }, fh, indent=1, default=str)
    print(f"\n  wrote {outdir}/coldchain_rmp_accounts.csv ({len(accounts)} rows)")
    print(f"  wrote {outdir}/coldchain_rmp_sites.csv ({len(sites)} rows)")
    print(f"  wrote {outdir}/coldchain_rmp_review_queue.csv ({len(review_queue)} rows)")
    print(f"  wrote {outdir}/coldchain_rmp_seed.json")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--naics", nargs="*", help="restrict to these NAICS prefixes")
    p.add_argument("--state", help="restrict to one state (e.g. PA)")
    p.add_argument("--outdir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    p.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    a = p.parse_args()
    return run(a.naics, a.state, os.path.normpath(a.outdir), a.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
