"""Option-B composition: versioned judgment->points mapping + eval gate + triage CSV.

Implements JEVS-PLAN.md §5.3 steps 2-4 on top of the sidecar written by
`connectors/jev.py`. THIS file owns all arithmetic; `jev.py` owns only raw
judgments. That separation is what makes weight/threshold edits never rerun
inference (composite-scoring pattern).

Run order (nightly): water_rmp.py -> connectors/jev.py (async) -> this file.

Outputs:
  data/water_jev_triage.csv   per-account before/after, dispositions (§3 slice item 2)
  data/jev_eval_snapshot.json labeled-set scores for the drift regression gate

HARD RULES enforced in code, not convention:
  * buffer_confirmed NEVER flips here (Q2=NO / gate C10). We emit a
    `confirm_candidate` queue tag at most.
  * qualification_basis is copied through untouched; nothing here can make an
    account export-eligible.
  * A judgment from source='mock' can never lift a cap — mock exists to test
    plumbing, and pretending otherwise would launder a fake into a score.
  * Only source='engine' (our own Kev server) may lift caps. Legacy
    source='live' rows were produced by the hosted TypeSafe/Jev API before
    the 2026-09-29 billing-permission decision; they are frozen history —
    displayed, but not trusted for lifts (a sidecar edit could otherwise
    smuggle billed-API judgments into post-decision scores).
  * If the eval gate fails (version bump shifted >N labeled scores), ALL
    lifts are quarantined: scores fall back to deterministic-only values and
    the run says so loudly.
"""

from __future__ import annotations

import csv
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "connectors"))
import water_rmp as W          # reuse icp_score() unchanged for the baseline
import jev as J                # sidecar loader + provenance helpers

DATA = os.path.join(os.path.dirname(__file__), "data")
SEED = os.path.join(DATA, "water_rmp_seed.json")
TRIAGE_CSV = os.path.join(DATA, "water_jev_triage.csv")
EVAL_SNAP = os.path.join(DATA, "jev_eval_snapshot.json")

# ---------------------------------------------------------------------------
# §5.3 step 3: the mapping rules, in ONE place, with ONE version constant.
# Changing anything below REQUIRES bumping SCORING_RULES_VERSION; month-over-
# month deltas compare only within the same version (step 4).
# ---------------------------------------------------------------------------
SCORING_RULES_VERSION = "optb-v1"

P_LIFT = 0.85      # calibrated-high agreement threshold on the top buffer level
LIFTED_CAP = 20    # elevated ∧ p>=P_LIFT ⇒ sheddability cap 15 -> 20, never 25
DEMOTE_CAP = 10    # high-confidence contradiction ⇒ trust lowers immediately
TAU_CONTINUOUS = 0.5   # UC-4 tripwire: p(yes)>=tau adds a review tag, never auto-drops

LEVEL_NAME = {0: "wet_well_only", 1: "unknown", 2: "mixed", 3: "elevated_weak", 4: "elevated_strong"}


def regex_buffer_label(a: dict) -> str:
    """What the deterministic layer concluded, mapped onto the same vocabulary
    so agreement/disagreement is a plain comparison, not vibes."""
    bc = a["buffer_class"]
    if bc.startswith("elevated"): return "elevated_any"
    if bc.startswith("wet-well"): return "wet_well_only"
    if bc.startswith("mixed"):    return "mixed"
    return "unknown"


def agrees(jev_top: int, regex_label: str) -> bool | None:
    """Three-valued: True / False / None.

    The regex layer only distinguishes elevated-vs-wetwell-vs-mixed; Jev's
    Score splits 'elevated' into weak (level 3) and strong (level 4). So a
    regex 'elevated_any' account AGREES if Jev picked level>=3 and DISAGREES
    if it picked 0/1/2 — never None, because a comparable claim exists.
    None is reserved for genuinely non-comparable vocabularies (currently
    unused; kept so callers can branch on tri-state safely).
    """
    if regex_label == "elevated_any":
        return jev_top >= 3
    return LEVEL_NAME.get(jev_top) == regex_label


def apply_rules(a: dict, row: dict | None) -> dict:
    """Compose one account's final ICP under Option B. Returns a result dict;
    pure function of (account, judgment-row) so the eval gate can re-run it."""
    base = W.icp_score(a)                       # deterministic baseline, untouched
    out = {
        "account": a["account"],
        "baseline_score": base["score"],
        "baseline_shed": base["components"]["sheddability"],
        "rules_version": SCORING_RULES_VERSION,
        "qualification_basis": a.get("qualification_basis", "deterministic"),
    }
    parts = dict(base["components"])

    if row is None:
        out.update(final_score=base["score"], shed=parts["sheddability"],
                   disposition="no_judgment", judged=False, note="sidecar miss")
        return out

    j = row["judgments"]
    src = row["source"]
    top = j["buffer_level_top"]
    p = j["buffer_p_top"]
    regex_lbl = regex_buffer_label(a)
    agr = agrees(top, regex_lbl)

    lifted = False
    shed = parts["sheddability"]

    if src != "engine":
        # Mock (synthetic) and legacy hosted-'live' (pre-Kev TypeSafe API,
        # billing permission lost 2026-09-29) judgments inform DISPLAY and
        # triage ordering only. They cannot move points: a synthetic judge
        # must never touch a real number, and frozen-history rows from the
        # discontinued backend must not keep influencing new scores either.
        note = ("mock_source_no_lift" if src == "mock"
                else "legacy_live_frozen_no_lift")
    elif j["continuous_p_yes"] >= TAU_CONTINUOUS:
        # UC-4 asymmetry: suspicion can only lower trust. Cap hard, tag review.
        shed = min(shed, DEMOTE_CAP)
        note = "continuous_suspect_demote"
    elif top == 4 and p >= P_LIFT and regex_lbl in ("elevated_any",):
        shed = max(shed, LIFTED_CAP) if shed <= 15 else shed
        lifted = True
        note = "calibrated_high_lift"
    elif top == 0:
        # Physics floor: wet-well inertia is hours, regardless of p (§5.3 rule 3)
        shed = min(shed, 9)
        note = "wet_well_physics_floor"
    elif agr is False and p >= P_LIFT:
        shed = min(shed, DEMOTE_CAP)
        note = "jev_contradicts_regex_demote"
    else:
        note = "agree_keep_cap" if agr else "insufficient_evidence_keep_cap"

    parts["sheddability"] = shed
    out.update(
        final_score=min(100, sum(parts.values())),
        shed=shed,
        lifted=lifted,
        judged=True,
        source=src,
        jev_buffer_top=LEVEL_NAME.get(top, str(top)),
        jev_p_top=p,
        jev_probs=j["buffer_probabilities"],
        continuous_p_yes=j["continuous_p_yes"],
        regulated_p_yes=j["regulated_p_yes"],
        regex_buffer=regex_lbl,
        agreement=("yes" if agr else "no" if agr is False else "n/a"),
        confirm_candidate=bool(lifted is False and agr and src == "engine" and p >= P_LIFT),
        review_flag="continuous_suspect" if j["continuous_p_yes"] >= TAU_CONTINUOUS else "",
        note=note,
        model_version=row["model_version"],
        prompt_version=row["prompt_version"],
        request_hash=row["request_hash"],
        response_hash=row["response_hash"],
    )
    # Disposition (the human-work column from §3): demote < review < candidate < keep
    if out["review_flag"]:
        out["disposition"] = "human-review"
    elif out.get("agreement") == "no" and "demote" in note:
        out["disposition"] = "demote"
    elif out.get("confirm_candidate"):
        out["disposition"] = "confirm-candidate"
    elif lifted:
        out["disposition"] = "lifted"
    else:
        out["disposition"] = "keep"
    return out


# ---------------------------------------------------------------------------
# §5.3 step 2: eval-set regression gate (silent-drift defense)
# ---------------------------------------------------------------------------

def build_eval_set(seed_accounts: list[dict]) -> list[str]:
    """The labeled set = 8 known continuous-process exclusions + 50 hand-
    labeled accounts. The exclusion names live in the review queue; the 50 are
    the current top-50 by baseline score (documented proxy until Ndustrial
    supplies true labels — flagged honestly in every snapshot)."""
    return [a["account"] for a in seed_accounts[:50]]


def eval_gate(results_by_acct: dict[str, dict], prev_snapshot: dict | None,
              n_allowed_shift: int = 5) -> tuple[bool, str]:
    """Compare final_score on the labeled set vs the previous pinned snapshot.

    N declared BEFORE first bump per §5.3; default 5/50 = 10% churn budget.
    The gate is armed whenever EITHER version moved — rules_version (our
    mapping changed) or prompt version (the judge's question meaning changed).
    A prompt edit that silently changes answers is exactly the drift this
    gate exists to catch, so it must not pass unnoticed just because our own
    rules constant stayed put.
    """
    if not prev_snapshot:
        return True, "no prior snapshot: first run establishes the baseline"
    prev_scores = prev_snapshot.get("labeled_scores", {})
    shifted = [acct for acct, sc in prev_scores.items()
               if acct in results_by_acct and abs(results_by_acct[acct]["final_score"] - sc) > 0]
    version_changed = (prev_snapshot.get("rules_version") != SCORING_RULES_VERSION
                       or prev_snapshot.get("prompt_version") != J.PROMPT_VERSION)
    if version_changed and len(shifted) > n_allowed_shift:
        return False, (f"rules/model change shifted {len(shifted)} labeled scores "
                       f"> N={n_allowed_shift}; quarantine lifts, fall back to baseline")
    return True, f"{len(shifted)} labeled scores moved (budget {n_allowed_shift})"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(limit: int = 50, force_mock_ok: bool = True) -> None:
    seed = json.load(open(SEED, encoding="utf-8"))
    accounts = seed["accounts"]
    sites_by: dict[str, list[dict]] = {}
    for s in seed["sites"]:
        sites_by.setdefault(s["account"], []).append(s)

    sidecar = J.load_sidecar()
    # index sidecar rows by account name (latest wins) for join-at-scoring
    by_acct: dict[str, dict] = {}
    for row in sorted(sidecar.values(), key=lambda r: r["judged_at"]):
        by_acct[row["account"]] = row

    targets = accounts[:limit]
    results = [apply_rules(a, by_acct.get(a["account"])) for a in targets]

    # --- eval gate -------------------------------------------------------
    prev = json.load(open(EVAL_SNAP)) if os.path.exists(EVAL_SNAP) else None
    rb = {r["account"]: r for r in results}
    ok, msg = eval_gate(rb, prev)
    print(f"eval gate: {'PASS' if ok else 'FAIL'} — {msg}", file=sys.stderr)
    if not ok:
        # Quarantine: strip every judgment-derived point, ship baseline only.
        for r in results:
            r["final_score"] = r["baseline_score"]
            r["shed"] = r["baseline_shed"]
            r["lifted"] = False
            r["disposition"] = "quarantined_fallback"
            r["note"] = "eval_gate_fail:" + r["note"]

    engine_n = sum(1 for r in results if r.get("source") == "engine")
    mock_n = sum(1 for r in results if r.get("source") == "mock")
    legacy_n = sum(1 for r in results if r.get("source") == "live")
    print(f"joined judgments: {engine_n} engine/Kev, {mock_n} mock, "
          f"{legacy_n} legacy-hosted (frozen), "
          f"{sum(1 for r in results if not r['judged'])} missing", file=sys.stderr)

    # --- triage CSV ------------------------------------------------------
    cols = ["account", "baseline_score", "final_score", "delta", "baseline_shed", "shed",
            "lifted", "disposition", "agreement", "regex_buffer", "jev_buffer_top", "jev_p_top",
            "continuous_p_yes", "regulated_p_yes", "confirm_candidate", "review_flag",
            "source", "note", "rules_version", "model_version", "prompt_version",
            "request_hash", "response_hash", "qualification_basis"]
    with open(TRIAGE_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for r in results:
            r["delta"] = r["final_score"] - r["baseline_score"]
            w.writerow([json.dumps(r[c]) if isinstance(r.get(c), (dict, list)) else r.get(c, "")
                        for c in cols])
    print(f"wrote {TRIAGE_CSV} ({len(results)} rows)", file=sys.stderr)

    # --- snapshot for next run's gate ------------------------------------
    snap = {
        "taken_at": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()),
        "rules_version": SCORING_RULES_VERSION,
        "prompt_version": J.PROMPT_VERSION,
        "eval_set_note": "top-50-by-baseline standing in for hand labels until Ndustrial provides them",
        "labeled_scores": {r["account"]: r["final_score"] for r in results},
    }
    json.dump(snap, open(EVAL_SNAP, "w"), indent=1)
    print(f"wrote {EVAL_SNAP}", file=sys.stderr)

    # --- console summary (the pitch table) --------------------------------
    lifts = [r for r in results if r.get("lifted")]
    demos = [r for r in results if r.get("disposition") in ("demote", "human-review")]
    cands = [r for r in results if r.get("confirm_candidate")]
    print(f"\nrules {SCORING_RULES_VERSION}: {len(lifts)} lifted (+{LIFTED_CAP-15} pts path), "
          f"{len(demos)} demoted/review, {len(cands)} confirm-candidates")
    for r in sorted(results, key=lambda x: -x["final_score"])[:12]:
        print(f"  {r['final_score']:>3} (was {r['baseline_score']:>3})  "
              f"{r['disposition']:<18} {r['account'][:52]}")


if __name__ == "__main__":
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 50
    main(limit=limit)
