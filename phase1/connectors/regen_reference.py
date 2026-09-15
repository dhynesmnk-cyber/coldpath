#!/usr/bin/env python3
"""Regenerate — or verify — the committed reference CSVs from the FROZEN pull.

`epa_rmp.py --outdir ...` fetches from the live EPA API, which means re-running
it mixes two different changes together: whatever moved upstream since the pull,
and whatever changed in our resolution logic. When the reason for regenerating
is a resolution fix, that is exactly what must not happen.

So this script feeds the committed 1,382-facility fixture — the 13 September
2026 pull, the same input the parity test uses — through the same aggregate(),
icp_score() and CSV writers. The only delta in the output is the logic delta.

    python3 phase1/connectors/regen_reference.py            # rewrite the CSVs
    python3 phase1/connectors/regen_reference.py --check     # verify, write nothing

--check IS THE POINT, and it closes a real hole.

The parity test asserts TypeScript(fixture) == committed CSV. It never executes
this Python. So the Python could drift from its own committed output and nothing
would fail — which already happened once: max_ammonia_lb() read only the live
API's chemical shape and not the frozen pull's, so every facility in the fixture
reported 0 lb and two accounts silently vanished from the reference.

--check supplies the missing leg: committed CSV == Python(fixture). Together
with the parity test's leg that gives TypeScript == Python, which is what
"parity" was always claiming. Run in CI; see .github/workflows/ci.yml.

Both committed copies (phase1/data/ and app/tests/fixtures/) are kept
byte-identical and both are checked.

Use epa_rmp.py directly when you actually want a fresh pull from EPA.
"""
from __future__ import annotations

import csv
import difflib
import io
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


def _csv_bytes(fieldnames, rows, extrasaction="raise") -> bytes:
    """Render one CSV exactly as the writer would put it on disk.

    newline="" at the open() call plus csv's default '\\r\\n' terminator means
    the committed files are CRLF. StringIO reproduces that, so comparing the
    ENCODED bytes is an exact check — normalising line endings here would hide
    precisely the kind of difference this script exists to catch.
    """
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction=extrasaction)
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


def render() -> tuple[dict[str, bytes], dict[str, int]]:
    """Build all three reference CSVs in memory. No I/O to the repo."""
    with open(FIXTURE, encoding="utf-8") as fh:
        fixture = json.load(fh)
    facilities = fixture["facilities"]

    accounts, sites, review_queue, unresolved = ref.aggregate(facilities)
    for a in accounts:
        a["icp"] = ref.icp_score(a)

    account_rows = []
    for a in accounts:
        row = {k: a.get(k) for k in ACCOUNT_COLS}
        row["aliases"] = " | ".join(a["aliases"])
        row["icp_score"] = a["icp"]["score"]
        account_rows.append(row)

    files = {
        "coldchain_rmp_accounts.csv": _csv_bytes(ACCOUNT_COLS, account_rows, "ignore"),
        "coldchain_rmp_sites.csv": _csv_bytes(list(sites[0].keys()), sites),
        "coldchain_rmp_review_queue.csv": _csv_bytes(QUEUE_COLS, review_queue, "ignore"),
    }
    stats = {
        "facilities": len(facilities),
        "accounts": len(accounts),
        "sites": len(sites),
        "review_queue": len(review_queue),
        "unresolved": len(unresolved),
        "customers": len([a for a in accounts if a["is_customer"]]),
        "pulled": fixture["meta"]["pulled"],
    }
    return files, stats


def _report(stats: dict) -> None:
    print(f"frozen pull: {stats['facilities']} facilities ({stats['pulled']})")
    print(f"  accounts: {stats['accounts']}   sites: {stats['sites']}")
    print(f"  review queue: {stats['review_queue']}   unresolved names: {stats['unresolved']}")
    print(f"  suppressed as existing customers: {stats['customers']}")


def check(files: dict[str, bytes]) -> int:
    """Verify every committed copy matches what the Python just produced."""
    failures = 0
    for outdir in OUTDIRS:
        rel = os.path.relpath(outdir, ROOT)
        for name, expected in files.items():
            path = os.path.join(outdir, name)
            if not os.path.exists(path):
                print(f"  MISSING  {rel}/{name}")
                failures += 1
                continue
            with open(path, "rb") as fh:
                actual = fh.read()
            if actual == expected:
                print(f"  ok       {rel}/{name}")
                continue
            failures += 1
            print(f"  DRIFT    {rel}/{name}")
            diff = difflib.unified_diff(
                actual.decode("utf-8").splitlines(),
                expected.decode("utf-8").splitlines(),
                fromfile=f"committed/{name}",
                tofile=f"python-output/{name}",
                lineterm="",
                n=1,
            )
            for i, line in enumerate(diff):
                if i > 40:
                    print("           … diff truncated")
                    break
                print(f"           {line}")

    if failures:
        print(
            f"\n  {failures} file(s) drifted.\n"
            "  The committed reference is no longer what the Python produces from the\n"
            "  committed fixture. Either the Python changed and the CSVs were not\n"
            "  regenerated, or the CSVs were edited by something other than this script.\n"
            "  Fix: run `python3 phase1/connectors/regen_reference.py` and review the diff.\n"
            "  If the TypeScript is what changed, change BOTH implementations — see\n"
            "  app/src/lib/resolve/canonical.ts."
        )
        return 1

    print("\n  reference is reproducible: committed CSVs == Python(frozen fixture)")
    return 0


def write(files: dict[str, bytes]) -> int:
    for outdir in OUTDIRS:
        os.makedirs(outdir, exist_ok=True)
        for name, data in files.items():
            with open(os.path.join(outdir, name), "wb") as fh:
                fh.write(data)
        print(f"  wrote {os.path.relpath(outdir, ROOT)}/")
    return 0


def main(argv: list[str]) -> int:
    checking = "--check" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--check"]
    if unknown:
        print(f"unknown argument(s): {' '.join(unknown)}\nusage: regen_reference.py [--check]")
        return 2

    files, stats = render()
    _report(stats)
    return check(files) if checking else write(files)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
