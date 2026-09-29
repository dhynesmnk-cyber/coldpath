#!/usr/bin/env python3
"""Async Jev triage batch — run AFTER water_rmp.py finishes (never inline in
ingestion; §3 budget guardrail / §5.3 step 1).

    python phase1/jev_triage.py --limit 50            # live (needs TYPESAFE_API_KEY)
    python phase1/jev_triage.py --limit 50 --mock     # offline plumbing test

Writes judgments to the sidecar (data/jev_judgments.jsonl), then runs
jev_score.py's composition + eval gate, producing data/water_jev_triage.csv.
Re-running with the same prompt/state hits the sidecar cache: zero API calls,
identical output (determinism property #1 of the Option-B contract).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)                        # jev_score.py lives beside this script
sys.path.insert(0, os.path.join(HERE, "connectors"))
import jev as J
import jev_score as S

def main() -> int:
    args = sys.argv[1:]
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else 50
    mock = "--mock" in args

    seed = json.load(open(os.path.join(HERE, "data", "water_rmp_seed.json"), encoding="utf-8"))
    accounts = seed["accounts"]
    sites_by: dict[str, list[dict]] = {}
    for s in seed["sites"]:
        sites_by.setdefault(s["account"], []).append(s)

    rows = J.run_batch(accounts, sites_by, limit=limit, mock=mock)
    # Append-only sidecar; readers take last-write-wins per request_hash, so
    # re-appending cached rows is harmless but we skip it to keep the file lean.
    already = J.load_sidecar()
    fresh = [r for r in rows if r["request_hash"] not in already]
    if fresh:
        J.append_sidecar(fresh)
    print(f"sidecar: {len(fresh)} new rows appended -> {J.SIDECAR_PATH}", file=sys.stderr)

    S.main(limit=limit)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
