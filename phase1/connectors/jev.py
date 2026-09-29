"""JUDGMENT ENGINE integration layer for the water-vertical expansion prototype.

Backend decision (2026-09-29): Ndustrial does not have permission for
TypeSafe/Jev API billing, so the project runs on **Kev** — the open-source
(Apache-2.0) Jev-family decision model at
github.com/jaredpalmer/kev. Kev's HTTP API matches TypeSafe's System One
endpoint (`POST /v1/systemone`) and the same `typesafe_sdk` Python client
works against a local/self-hosted Kev server unchanged (verified against
the Kev README and SDK 0.7.2, whose `TypeSafeClient.__init__` accepts
`base_url`). This module is the ONLY place in the repo allowed to talk to
the judgment server. It implements the Option-B contract from JEVS-PLAN.md
§5.3 step 1: every judgment is stored with full provenance (model version,
prompt version, request hash, response hash) in a JSONL sidecar, and
scoring reads the sidecar — never the live server. Ingestion must not block
on an LLM call; this module is run asynchronously *after* `water_rmp.py`
finishes.

Design rules enforced here (see JEVS-PLAN.md §1/§5, INGESTION-GATES.md C10):
  * The engine returns RAW typed judgments only. No score arithmetic lives
    in this file. Composition happens in `jev_score.py`.
  * Questions are narrow and independent, asked over shared state in ONE
    request per account (parallel-question pattern from the skill).
  * UC-1 flagship questions: buffer_class (Score), process_continuous (Noul,
    the exclusion-pass tripwire = UC-4), operator_is_regulated_utility (Noul).
  * Server URL/key come from the environment only (KEV_BASE_URL,
    KEV_API_KEY, with legacy TYPESAFE_API_KEY accepted as fallback); nothing
    here logs or persists the key.

Primitives chosen per Kev README + docs.typesafe.ai (read 2026-09-29):
  - Score for buffer_class: ordered descriptive levels that stand on their
    own; answer carries probability-weighted position + legend.
  - Noul for the two yes/no conditions: probability of yes, no separate
    confidence field (near 0.5 == genuinely uncertain, which is exactly the
    signal we route to review).

CALIBRATION WARNING (Kev README "What to Expect"): Kev ships fitted
temperatures, but its confidence *ranking* is measurably worse than Jev's
(at a 5% error budget Kev automates 0.45-0.57 of decisions vs Jev 0.70).
The P_LIFT threshold in jev_score.py MUST be re-checked on our labeled eval
set before any lift rule is trusted in production. Do not assume Jev's
thresholds transfer.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from typing import Any

# Prompt version: bump whenever ANY instructions/criteria string below changes.
# It participates in request_hash so a prompt edit invalidates cached sidecar
# rows instead of silently mixing old and new judgments (drift defense #1).
PROMPT_VERSION = "uc1-water-v1"
# Backend: Kev (open-source, Apache-2.0) — self-hosted or Modal endpoint.
# KEV_MODEL selects the checkpoint; default kev-4b per README's "Start with
# Kev-4B" guidance (~9 GB VRAM in bf16; CPU fallback is slow but works for a
# 50-account batch). Pinned explicitly; do NOT rely on server-side default.
MODEL = os.environ.get("KEV_MODEL", "kev-latest").strip() or "kev-latest"
MAX_SITE_NAMES = 8     # state budget: cap evidence, never truncate mid-name


def _q(text: str) -> str:
    """Normalise whitespace in question strings without touching meaning."""
    return re.sub(r"\s+", " ", text).strip()


# ---------------------------------------------------------------------------
# Question definitions (UC-1 + UC-4 tripwire). Kept as plain data so the
# offline mock and the live path judge exactly the same semantics.
# ---------------------------------------------------------------------------

BUFFER_LEVELS = [
    # level 0 — weakest inertia for our purpose
    "The sites are primarily treatment works whose capacity sits in wet wells "
    "or inflow detention: hours of buffering at best, and stopping inflow "
    "handling quickly becomes an environmental permit problem.",
    "The site names give no clue about storage or buffering at all; they could "
    "be anything from a wellfield to an industrial resale point.",
    "The portfolio mixes elevated-storage plants with treatment works, so any "
    "curtailment plan needs a per-station audit before it can be trusted.",
    "Most sites read as water treatment or supply plants whose names indicate "
    "they feed pressurised networks served by elevated storage towers.",
    # level 4 — strongest inertia: gravity battery, cold-store analogue
    "The account operates pumping stations or distribution systems feeding "
    "large elevated storage networks: pumps can stop during a peak window "
    "while gravity-fed tanks hold system pressure, like a thermal battery.",
]

Q_BUFFER = {
    "kind": "score",
    "instructions": _q(
        "Judge the SHEDDABILITY of this water utility's load for grid-peak "
        "curtailment. The physical test: does the system possess an inventory "
        "buffer (elevated potable storage above demand) that lets big pumps "
        "stop for 15-60 minutes without damaging service? Treatment-only "
        "sites with wet-well detention have far less usable inertia because "
        "stopping inflow handling risks permit violations. Judge only from "
        "the evidence given; absence of evidence is not evidence of absence."
    ),
    "criteria": BUFFER_LEVELS,
}

Q_CONTINUOUS = {
    "kind": "noul",
    "instructions": _q(
        "Could ANY listed site plausibly be a continuous thermal or chemical "
        "process that must never be curtailed — a kiln, furnace, paper "
        "machine, distillation train, or fertilizer/chemical manufacturing "
        "train — even though the registry lists it under water NAICS codes? "
        "(Misfiled industrial sites do exist in this dataset.)"
    ),
}

Q_REGULATED = {
    "kind": "noul",
    "instructions": _q(
        "Does the account name and site list look like a regulated public "
        "water/wastewater utility, district, authority, or municipal water "
        "works — rather than an industrial self-supplier or private "
        "bottling/resale business?"
    ),
}

QUESTIONS = {"buffer_class": Q_BUFFER,
             "process_continuous": Q_CONTINUOUS,
             "regulated_utility": Q_REGULATED}


# ---------------------------------------------------------------------------
# State assembly — deterministic, code-owned (§1 guardrail: exact fields stay
# in code; Jev only sees what we choose to show it).
# ---------------------------------------------------------------------------

def build_state(account: dict, sites_for_account: list[dict]) -> dict:
    """One account + its site evidence, trimmed to a token budget.

    Site names are the actual judgment surface (that's why the regex layer was
    weak), so they go in verbatim, deduped, capped at MAX_SITE_NAMES with an
    explicit overflow count — the model must know it is seeing a sample, not
    the census (skill: 'check candidate coverage').
    """
    names: list[str] = []
    seen: set[str] = set()
    for s in sites_for_account:
        n = (s.get("name") or "").strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            names.append(f"{n} ({s.get('city', '?')}, {s.get('state', '?')})")
    overflow = max(0, len(names) - MAX_SITE_NAMES)
    return {
        "account": account["account"],
        "vertical_naics": account.get("primary_naics"),
        "states": account.get("state_list"),
        "site_count": account.get("sites"),
        "total_chlorine_lb": account.get("chlorine_lb"),
        "site_names_sample": names[:MAX_SITE_NAMES],
        "additional_sites_not_listed": overflow,
    }


# ---------------------------------------------------------------------------
# Hashing helpers (provenance primitives)
# ---------------------------------------------------------------------------

def _canonical(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()

def request_hash(state: dict) -> str:
    h = hashlib.sha256()
    h.update(PROMPT_VERSION.encode())
    h.update(b"\x00")
    h.update(_canonical({"state": state, "questions": QUESTIONS}))
    return h.hexdigest()[:16]

def response_hash(answers: dict) -> str:
    return hashlib.sha256(_canonical(answers)).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Answer normalisation — one canonical row shape regardless of live/mock
# ---------------------------------------------------------------------------

def normalize_answers(resp: dict) -> dict:
    """resp: {'model': str, 'answers': {qid: {'type','score'/'choice'/'noul',
    'probabilities', ...}}} -> flat judgment dict + selected probability."""
    out: dict[str, Any] = {}
    a = resp["answers"]

    b = a["buffer_class"]
    probs = {int(k): v for k, v in b["probabilities"].items()}
    sel = int(b["score"])                      # probability-weighted position
    # p = mass on the TOP level, not mass on the weighted mean: the lift rule
    # (§5.3 step 3) demands calibrated-high agreement with a concrete class.
    top = max(probs, key=probs.get)
    out["buffer_level_selected"] = sel
    out["buffer_level_top"] = top
    out["buffer_p_top"] = round(probs[top], 4)
    out["buffer_probabilities"] = {k: round(v, 4) for k, v in sorted(probs.items())}

    c = a["process_continuous"]
    out["continuous_p_yes"] = round(c["noul"], 4)

    r = a["regulated_utility"]
    out["regulated_p_yes"] = round(r["noul"], 4)

    out["model_version"] = resp.get("model", MODEL)
    return out


# ---------------------------------------------------------------------------
# Sidecar store (JSONL, append-only, keyed by request_hash)
# ---------------------------------------------------------------------------

SIDECAR_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "jev_judgments.jsonl")

def load_sidecar(path: str = SIDECAR_PATH) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    row = json.loads(line)
                    rows[row["request_hash"]] = row
    return rows

def append_sidecar(rows: list[dict], path: str = SIDECAR_PATH) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, sort_keys=True) + "\n")


# ---------------------------------------------------------------------------
# Engine client (Kev — local `kev.serve` or self-hosted Modal endpoint)
# ---------------------------------------------------------------------------

def make_client():
    """Point the TypeSafe SDK at a Kev server (drop-in; same System One API).

    Env vars:
      KEV_BASE_URL   default http://127.0.0.1:8009  (local `python -m kev.serve`)
      KEV_API_KEY    bearer key if the server sets KEV_API_KEY; 'local' otherwise
      KEV_MODEL      checkpoint name, e.g. kev-latest / kev-4b
    Legacy TYPESAFE_API_KEY is accepted as a credential fallback only —
    base_url ALWAYS targets Kev now, so a stale hosted-Jev key can never be
    used to silently bill the TypeSafe plan we are not allowed to use.
    """
    from typesafe_sdk import TypeSafeClient   # lazy: offline/mock runs need no SDK
    base_url = os.environ.get("KEV_BASE_URL", "http://127.0.0.1:8009").strip()
    key = (os.environ.get("KEV_API_KEY", "").strip()
           or os.environ.get("TYPESAFE_API_KEY", "").strip()
           or "local")                        # unauthenticated local server
    return TypeSafeClient(api_key=key, base_url=base_url, model=MODEL)


def ask_engine(client, state: dict) -> tuple[dict, dict]:
    """One system_one call per account. Returns (answers_dict, usage).

    Named 'engine' rather than 'live' because the backend is our own Kev
    server; rows written by this path carry source='engine'. jev_score.py
    treats 'engine' as the ONLY lift-eligible source (hosted-Jev-era rows
    keep their 'live' label but are frozen history, never re-trusted for
    lifts after the billing-permission decision of 2026-09-29)."""
    from typesafe_sdk import Noul, Score, Choice  # noqa: F401 (Choice reserved for UC-2)
    q_objs = {}
    for qid, spec in QUESTIONS.items():
        if spec["kind"] == "score":
            q_objs[qid] = Score(instructions=spec["instructions"], criteria=spec["criteria"])
        else:
            q_objs[qid] = Noul(instructions=spec["instructions"])
    resp = client.system_one(state=state, questions=q_objs, model=MODEL)
    answers = {
        "buffer_class": {
            "type": "score", "score": resp.scores["buffer_class"].score,
            "probabilities": {str(k): v for k, v in resp.scores["buffer_class"].probabilities.items()},
        },
        "process_continuous": {"type": "noul", "noul": resp.nouls["process_continuous"].noul},
        "regulated_utility": {"type": "noul", "noul": resp.nouls["regulated_utility"].noul},
    }
    usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
    return answers, usage


# ---------------------------------------------------------------------------
# Offline deterministic judge (--mock). NOT a substitute for the real API:
# it exists so the plumbing (hashing, sidecar, mapping rules, eval gate, CSV)
# can be tested and demoed without a key. Its answers are labelled
# source='mock' everywhere they surface, and the success metric in §3 may
# ONLY be evaluated against a live run.
# ---------------------------------------------------------------------------

_ELEV_RX = re.compile(r"elevat|storage tank|pumping station|pump station|distribution|"
                      r"reservoir|standpipe|boost", re.I)
_TREAT_RX = re.compile(r"treatment|plant|wwtp|reclamation|resource recovery", re.I)
_SEWER_RX = re.compile(r"sewer|wastewater|waste water|pollution control", re.I)
_INDUST_RX = re.compile(r"fertilizer|chemical|refinery|mill|plant site \d", re.I)

def ask_mock(state: dict) -> tuple[dict, dict]:
    names = " | ".join(state["site_names_sample"]).lower()
    has_elev = bool(_ELEV_RX.search(names))
    has_treat = bool(_TREAT_RX.search(names))
    has_sewer = bool(_SEWER_RX.search(names))
    if has_elev and not has_sewer:
        lvl, spread = 4, (0.02, 0.03, 0.08, 0.22, 0.65)
    elif has_elev and has_sewer:
        lvl, spread = 3, (0.10, 0.10, 0.55, 0.18, 0.07)
    elif has_sewer:
        lvl, spread = 0, (0.72, 0.08, 0.10, 0.07, 0.03)
    elif has_treat:
        lvl, spread = 3, (0.08, 0.12, 0.15, 0.60, 0.05)
    else:
        lvl, spread = 1, (0.20, 0.55, 0.18, 0.05, 0.02)
    cont = 0.85 if _INDUST_RX.search(names) else 0.06
    reg = 0.9 if not _INDUST_RX.search(names) else 0.3
    probs = {str(i): p for i, p in enumerate(spread)}
    answers = {
        "buffer_class": {"type": "score", "score": float(lvl), "probabilities": probs},
        "process_continuous": {"type": "noul", "noul": cont},
        "regulated_utility": {"type": "noul", "noul": reg},
    }
    return answers, {"input_tokens": None, "output_tokens": None}


# ---------------------------------------------------------------------------
# Batch runner
# ---------------------------------------------------------------------------

def run_batch(accounts: list[dict], sites_by_account: dict[str, list[dict]],
              limit: int, mock: bool, sleep_s: float = 0.0) -> list[dict]:
    client = None if mock else make_client()
    cached = load_sidecar()
    todo, done = [], []
    for acc in accounts[:limit]:
        state = build_state(acc, sites_by_account.get(acc["account"], []))
        rh = request_hash(state)
        row = cached.get(rh)
        if row:                                   # provenance hit: no re-call
            done.append(row)
            continue
        todo.append((acc, state, rh))

    print(f"jev batch: {len(done)} cached, {len(todo)} to judge "
          f"({'mock' if mock else 'engine/Kev'} mode)", file=sys.stderr)
    for i, (acc, state, rh) in enumerate(todo, 1):
        t0 = time.time()
        if mock:
            answers, usage = ask_mock(state)
        else:
            answers, usage = ask_engine(client, state)
        judged = normalize_answers({"model": MODEL, "answers": answers})
        row = {
            "request_hash": rh,
            "response_hash": response_hash(answers),
            "prompt_version": PROMPT_VERSION,
            "model_version": judged.pop("model_version"),
            "source": "mock" if mock else "engine",
            "account": acc["account"],
            "state": state,
            "answers": answers,
            "judgments": judged,
            "usage": usage,
            "wall_ms": round((time.time() - t0) * 1000),
            "judged_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        done.append(row)
        if i % 10 == 0:
            print(f"  judged {i}/{len(todo)}", file=sys.stderr)
        if not mock and sleep_s:
            time.sleep(sleep_s)
    return done
