#!/usr/bin/env python3
"""Regenerate the committed reference CSVs from the FROZEN facility pull.

`epa_rmp.py --outdir ...` fetches from the live EPA API, which means re-running
it mixes two different changes together: whatever moved upstream since the pull,
and whatever changed in our resolution logic. When the reason for regenerating
is a resolution fix, that is exactly what must not happen.

So this script feeds the committed 1,382-facility fixture — the 13 September
2026 pull, the same input the parity test uses — through the same aggregate(),
icp_score() and CSV writers. The only delta in the output is the logic delta.

    python3 phase1/connectors/regen_reference.py

Writes to both committed copies (phase1/data/ and app/tests/fixtures/), which
are kept byte-identical, and prints a summary of what moved.

Use epa_rmp.py directly when you actually want a fresh pull from EPA.
"""
from __future__ import annotations

import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)

import epa_rmp as ref  # noqa: E402

FIXTURE = os.path.join(ROOT, "app", "tests", "fixtures", "rmp-facilities.json")
OUTDIRS = [
    os.path.join(ROOT, "phase1", "data"),
    os.path.join(ROOT, "app", "tests", "fixtures"),
]

ACCOUNT_COLS = [
    "rank", "icp_score", "account", "is_customer", "sites", "unvalidated_sites",
    "ammonia_lb", "max_site_ammonia_lb", "states", "state_list", "primary_rto",
    "accidents", "sites_with_accidents", "primary_naics", "vertical", "aliases",
]
QUEUE_COLS = [
    "kind", "rmp_id", "name", "city", "state", "naics", "ammonia_lb",
    "reported_name", "account", "reason", "validation_note", "action",
]


def main() -> int:
    with open(FIXTURE, encoding="utf-8") as fh:
        fixture = json.load(fh)
    facilities = fixture["facilities"]
    print(f"frozen pull: {len(facilities)} facilities ({fixture['meta']['pulled']})")

    accounts, sites, review_queue, unresolved = ref.aggregate(facilities)
    for a in accounts:
        a["icp"] = ref.icp_score(a)

    customers = [a["account"] for a in accounts if a["is_customer"]]
    print(f"  accounts: {len(accounts)}   sites: {len(sites)}")
    print(f"  review queue: {len(review_queue)}   unresolved names: {len(unresolved)}")
    print(f"  suppressed as existing customers: {customers}")

    for outdir in OUTDIRS:
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, "coldchain_rmp_accounts.csv"), "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=ACCOUNT_COLS, extrasaction="ignore")
            w.writeheader()
            for a in accounts:
                row = {k: a.get(k) for k in ACCOUNT_COLS}
                row["aliases"] = " | ".join(a["aliases"])
                row["icp_score"] = a["icp"]["score"]
                w.writerow(row)
        with open(os.path.join(outdir, "coldchain_rmp_sites.csv"), "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(sites[0].keys()))
            w.writeheader()
            w.writerows(sites)
        with open(os.path.join(outdir, "coldchain_rmp_review_queue.csv"), "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=QUEUE_COLS, extrasaction="ignore")
            w.writeheader()
            w.writerows(review_queue)
        print(f"  wrote {os.path.relpath(outdir, ROOT)}/")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
