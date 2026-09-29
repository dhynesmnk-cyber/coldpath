"""CPU-only dry-run variant of kev_serve_upstream.py — NOT for serving traffic.

Why this file exists (observed 2026-09-29): Modal rejects GPU deploys entirely
("Please add a payment method to use L40S GPU functions") until a card is
attached to the workspace, and the upstream script cannot be zero-GPU'd via
KEV_GPU="" (empty string falls back to the model's default list) or KEV_GPU=none
(Modal: "NONE is not a valid GPU type"). This wrapper patches the two
GPU-dependent spots at import time so we can validate the *plumbing* without
spend: image build, /v1/systemone wire format, sidecar provenance rows, lift
rules, eval gate. Judgments from CPU inference are real Kev outputs but slow
and uncalibrated-for-throughput; they are for pipeline testing only and MUST
NOT feed the §3 success metric — that requires the GPU endpoint (step 2b in
README.md after adding a payment method).

Two deviations from upstream, both forced by hardware reality:
  1. device "cpu": LoadOptions(dtype=bfloat16, cuda_graphs=True, fused=True)
     would fail — fused triton kernels and CUDA graphs need an NVIDIA GPU. We
     pass plain LoadOptions() (fp32 on CPU, eager). The checkpoint's fitted
     calibration temperature still applies (it lives in head weights), so p-
     values are formally valid; only latency differs.
  2. no WARMUP loop: warm-up exists to capture CUDA graphs before traffic; on
     CPU it would just burn minutes per deploy.

Deploy (needs no payment method — pure CPU):
    KEV_API_KEY=<key> KEV_APP_NAME=coldpath-kev-dryrun \
      modal deploy deploy/kev-modal/kev_serve_cpu.py

Stop it right after testing: `modal app stop coldpath-kev-dryrun`.
"""
import os

import modal

# Import the upstream module as the single source of truth for app/image/QUESTIONS.
# It reads SETTINGS from env at import; nothing GPU-specific happens there.
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location("kev_serve_upstream", os.path.join(os.path.dirname(__file__), "kev_serve_upstream.py"))
up = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(up)

app = up.app  # same App object; deploy registers one app named by KEV_APP_NAME


def cpu_only(cls):
    """Replace upstream's GPU-oriented concurrency decorator with a plain web endpoint."""
    return modal.concurrent(max_inputs=4)(cls)


# CPU image: same layers as upstream but python 3.12 to match this sandbox's
# interpreter (Modal serializes the function definition locally; a serialized
# function must not run on a newer Python than defined — observed error:
# "defined with Python 3.12, but its Image has 3.13"). Upstream uses 3.13 for
# its triton/fla GPU kernels; neither is exercised on the CPU path. Env vars
# are re-set explicitly because SETTINGS must reach the container unchanged.
# NOTE: the base layer CANNOT be rebuilt here — Modal resolves debian_slim's
# base digest client-side and caches it by tag, so a local rebuild silently
# reuses the 3.13 base (observed). Instead we overlay a system-python symlink
# swap: uv installs 3.12 into /usr/local, then /usr/local/bin/python* points at
# /usr/bin/python3.11 (>=3.11 satisfies kev/fla version floors; defining on
# 3.12 and running on 3.11 is the direction Modal allows).
cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .uv_pip_install(f"kev[serve] @ git+https://github.com/jaredpalmer/kev.git@{up.KEV_REF}")
    .run_commands(
        # fail loudly if the swap target is missing instead of deploying a broken endpoint
        'test -x /usr/bin/python3.11 || { echo "no system python3.11 in base image"; exit 1; }',
        'rm -f /usr/local/bin/python /usr/local/bin/python3 /usr/local/bin/python3.13 && '
        'ln -s /usr/bin/python3.11 /usr/local/bin/python && '
        'ln -s /usr/bin/python3.11 /usr/local/bin/python3',
    )
    .env({"HF_HOME": "/hf", "HF_HUB_DISABLE_PROGRESS_BARS": "1", "TOKENIZERS_PARALLELISM": "false",
          "PYTHONUNBUFFERED": "1", "TRITON_CACHE_DIR": "/hf/triton-cache", **up.SETTINGS})
)

# Re-declare the class against the same app, minus CUDA. We subclass-free copy
# the enter() body here because the device strings are baked into it upstream.
@app.cls(image=cpu_image, gpu=None, cpu=4, memory=(16384, 65536),
         volumes={"/hf": up.cache},
         secrets=[modal.Secret.from_dict(up.SECRET)] if up.SECRET else [],
         min_containers=0, scaledown_window=300, timeout=1800, startup_timeout=2400)
@cpu_only
class KevCPU:
    @modal.enter()
    def load(self):
        import time
        started = time.time()
        from kev.checkpoint import Checkpoint, LoadOptions
        from kev.serve import Server, app as api
        ck = Checkpoint(up.MODEL)
        tok, model = ck.load("cpu", LoadOptions())          # fp32 eager; fitted temperature still applied
        server = Server(ck, tok, model, "cpu")
        api.state.server = server
        print(f"serving {up.MODEL} on CPU (no graphs, no fused kernels), ready in {time.time()-started:.0f}s", flush=True)
        self.api = api

    @modal.asgi_app(label=f"{up.SETTINGS['KEV_APP_NAME']}-api")
    def web(self):
        return self.api
