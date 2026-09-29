#!/usr/bin/env python3
"""Regression tests for the Option-B mapping rules (§5.3) and the C10/Q2=NO
invariants. Plain asserts, no framework — run:  python phase1/test_jev_rules.py

Every test uses synthetic judgment rows (never the mock judge's outputs) so
the RULES are under test, not the plumbing. The live-path success metric from
§3 can only be evaluated against real Jev responses; that is deliberately NOT
tested here.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "connectors"))
sys.path.insert(0, HERE)
import jev as J
import jev_score as S

seed = json.load(open(os.path.join(HERE, "data", "water_rmp_seed.json"), encoding="utf-8"))
accs = {a["account"]: a for a in seed["accounts"]}


def fake_row(acct, top, p, cont=0.05, reg=0.9, source="engine"):
    """Synthesize a sidecar-shaped row through the REAL normalize path.

    Default source='engine' = our own Kev server (the only lift-eligible
    backend since 2026-09-29; see jev_score.py hard rules)."""
    probs = {str(i): 0.0 for i in range(5)}
    probs[str(top)] = p
    probs[str(max(0, top - 1))] = round(1 - p, 4)
    answers = {
        "buffer_class": {"type": "score", "score": float(top), "probabilities": probs},
        "process_continuous": {"type": "noul", "noul": cont},
        "regulated_utility": {"type": "noul", "noul": reg},
    }
    j = J.normalize_answers({"model": "jev-testfixture", "answers": answers})
    return {"request_hash": "x", "response_hash": "y", "prompt_version": J.PROMPT_VERSION,
            "model_version": "jev-testfixture", "source": source, "account": acct,
            "judgments": j, "judged_at": "2026-09-29T00:00:00Z"}


AW = accs["American Water Utilities Holdings"]          # regex: elevated_any, shed 12
DALLAS = accs["Dallas Water Utilities"]                 # regex: elevated_any, shed 12
WETWELL = next(a for a in seed["accounts"] if a["buffer_class"].startswith("wet-well"))


def t1_lift():
    r = S.apply_rules(AW, fake_row("t1", 4, 0.9))
    assert r["lifted"] and r["shed"] == S.LIFTED_CAP == 20
    assert r["final_score"] == min(100, r["baseline_score"] + (20 - r["baseline_shed"]))
    assert r["note"] == "calibrated_high_lift"


def t2_contradiction_demotes():
    r = S.apply_rules(WETWELL, fake_row("t2", 4, 0.9))
    assert r["agreement"] == "no" and r["disposition"] == "demote"
    assert r["shed"] == min(r["baseline_shed"], S.DEMOTE_CAP)


def t3_physics_floor():
    """Jev high-confidence wet-well => cap 9 even when regex said elevated."""
    r = S.apply_rules(DALLAS, fake_row("t3", 0, 0.9))
    assert r["shed"] == min(r["baseline_shed"], 9) and not r["lifted"]
    assert r["note"] == "wet_well_physics_floor"


def t4_tripwire_asymmetric():
    """Continuous-process suspicion can only lower trust + tag review; it
    never auto-drops (row still produced, account still visible)."""
    r = S.apply_rules(DALLAS, fake_row("t4", 4, 0.9, cont=0.7))
    assert r["review_flag"] == "continuous_suspect"
    assert r["disposition"] == "human-review" and r["shed"] <= S.DEMOTE_CAP


def t5_mock_never_moves_points():
    r = S.apply_rules(AW, fake_row("t5", 4, 0.9, source="mock"))
    assert not r["lifted"] and r["shed"] == r["baseline_shed"]
    assert r["note"] == "mock_source_no_lift"


def t5b_legacy_hosted_live_frozen():
    """Rows from the discontinued hosted TypeSafe/Jev API (source='live')
    must NOT lift caps post-decision — frozen history, display-only."""
    r = S.apply_rules(AW, fake_row("t5b", 4, 0.9, source="live"))
    assert not r["lifted"] and r["shed"] == r["baseline_shed"]
    assert r["note"] == "legacy_live_frozen_no_lift"
    # ...and they cannot earn confirm-candidate tags either (§5.3 rule: tag
    # requires engine provenance)
    assert not r["confirm_candidate"]


def t6_candidate_tag_only():
    """Agreement at level 3 (elevated_weak): tag confirm-candidate, zero points."""
    r = S.apply_rules(AW, fake_row("t6", 3, 0.9))
    assert r["shed"] == r["baseline_shed"] and r["confirm_candidate"]
    assert r["disposition"] == "confirm-candidate"


def t7_c10_invariants():
    """Q2=NO: composition cannot touch qualification_basis or confirm buffers."""
    r = S.apply_rules(AW, fake_row("t7", 4, 0.9))     # lifted row...
    assert r["qualification_basis"] == AW.get("qualification_basis", "deterministic")
    assert "buffer_confirmed" not in r                # we never emit that field
    assert AW["buffer_confirmed"] is False            # source dict untouched


def t8_eval_gate():
    prev = {"rules_version": "optb-v0", "prompt_version": "uc1-water-v1",
            "labeled_scores": {"A": 69, "B": 76, "C": 69}}
    ok, _ = S.eval_gate({"A": {"final_score": 77}, "B": {"final_score": 76},
                         "C": {"final_score": 69}}, prev)                       # within budget
    assert ok
    bad = {"A": {"final_score": 77}, "B": {"final_score": 80}, "C": {"final_score": 74}}
    ok2, msg2 = S.eval_gate(bad, prev)                                          # 3 shifts > N? no, N=5 -> pass
    assert ok2, msg2
    prev5 = {"rules_version": "optb-v0", "prompt_version": "uc1-water-v1",
             "labeled_scores": {c: 60 for c in "ABCDEF"}}
    res6 = {c: {"final_score": 75} for c in "ABCDEF"}
    ok3, msg3 = S.eval_gate(res6, prev5)                                        # 6 > 5 -> FAIL
    assert not ok3 and "quarantine" in msg3
    # prompt-only change must ALSO arm the gate (same 6 shifts, but this time
    # only the PROMPT version differs from the snapshot):
    prev_p = dict(prev5)
    prev_p["prompt_version"] = "uc1-water-v0"   # different from current J.PROMPT_VERSION
    ok4, msg4 = S.eval_gate(res6, prev_p)
    assert not ok4 and "quarantine" in msg4


def t9_sidecar_roundtrip_determinism():
    """Same state -> same request_hash; cached row replay changes nothing."""
    st = J.build_state(AW, [s for s in seed["sites"] if s["account"] == AW["account"]])
    h1, h2 = J.request_hash(st), J.request_hash(json.loads(json.dumps(st)))
    assert h1 == h2
    rows = J.load_sidecar()
    hit = [r for r in rows.values() if r["account"] == AW["account"]]
    if hit:                                     # skip gracefully if sidecar absent
        assert hit[0]["request_hash"] in rows


if __name__ == "__main__":
    tests = [t1_lift, t2_contradiction_demotes, t3_physics_floor, t4_tripwire_asymmetric,
             t5_mock_never_moves_points, t5b_legacy_hosted_live_frozen,
             t6_candidate_tag_only, t7_c10_invariants,
             t8_eval_gate, t9_sidecar_roundtrip_determinism]
    for t in tests:
        t()
        print(f"PASS {t.__name__}")
    print(f"\n{len(tests)} rule tests pass (SCORING_RULES_VERSION={S.SCORING_RULES_VERSION})")
