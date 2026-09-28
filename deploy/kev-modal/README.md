# Kev judgment server on Modal — Option B serving side

**Why this folder exists.** TypeSafe/Jev API billing was declined, so per the
agreed fallback we self-host **Kev** (open-source Jev-family judge, Apache-2.0,
github.com/jaredpalmer/kev) behind a Modal GPU endpoint. `phase1/connectors/jev.py`
already points at it via `KEV_BASE_URL` / `KEV_API_KEY` and uses the same
System One protocol (`POST /v1/systemone`, `Authorization: Bearer <key>`), so
the triage runner needs no changes to go live.

**We deploy the upstream script, not our own.** `kev_serve_upstream.py` is
verbatim from the Kev repo's official deploy skill (pinned package commit
`f2bb629`). Do NOT hand-roll a vLLM wrapper: Kev checkpoints ship fitted
calibration temperatures that only the kev serve stack applies, and Option B's
lift rules depend on calibrated p-values (§5.3 drift defenses). A substitute
server silently breaks the eval gate.

## Runbook

```bash
# 0. one-time: sign in (opens a browser; you must click Authorize)
pip install modal && modal setup

# 1. generate + store the shared key ONCE — reuse the same value everywhere
openssl rand -hex 24          # -> call it $KEY

# 2. deploy Kev-4B on an L40S (cheapest GPU that answers the 4B quickly)
KEV_API_KEY=<key> KEV_APP_NAME=coldpath-kev \
  modal deploy deploy/kev-modal/kev_serve_upstream.py
# URL: https://<workspace>--coldpath-kev-api.modal.run   (printed by deploy)

# 3. smoke test (first request waits ~35 s cold start; -L follows the 303)
curl -L --max-time 900 https://<workspace>--coldpath-kev-api.modal.run/v1/models \
     -H "authorization: Bearer <key>"

# 4. run the real triage (top 50 accounts; sidecar rows get source='engine')
export KEV_BASE_URL=https://<workspace>--coldpath-kev-api.modal.run
export KEV_API_KEY=<key>
python phase1/jev_triage.py --limit 50        # live path; NO --mock flag

# 5. score with lifts applied + eval gate
python phase1/jev_score.py                    # writes scored CSV + audit labels

# 6. when done: stop the app so GPU billing cannot accrue
modal app stop coldpath-kev
```

Notes
- Scales to zero after 5 idle min by default (`KEV_MIN_CONTAINERS=0`); an
  unused endpoint costs nothing. First request after idle pays the cold start.
- Model choice: stay on **kev-4b** for the pilot. `KEV_MODEL=jaredpalmer/kev-9b`
  is the upgrade path if the §3 success metric shows ranking but weak margin.
  Record whichever serves in sidecar `model_version` (the server reports it).
- The key is a bearer token in transit over TLS; treat it like a password.
  Never commit it. It lives in your shell env + Modal secret only.
- Calibrate before trusting lifts: Kev's confidence *ranking* is measurably
  worse than Jev's (README "What to Expect": 0.45–0.57 automated vs Jev
  0.70 at a 5% error budget). P_LIFT thresholds in `jev_score.py` MUST be
  re-checked against the labeled eval set (gate #2 of §5.3) before any lift
  reaches the exported list. C10 still applies regardless: judged-but-
  unconfirmed never exports.
