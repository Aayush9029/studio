"""Runtime adjustments for ROCm (gfx1151 / Radeon 8060S) applied after comfy is imported.

Nothing under ``vendor/`` is edited; module attributes are adjusted in memory.

UV unwrap (``UnwrapMesh`` -> ``mesh3d.uv_unwrap.parameterize``): the batched LSCM
solve runs dense fp64 ``torch.linalg.solve`` on the GPU. On this GPU hipBLAS
``dgetrfBatched`` fails with ``HIPBLAS_STATUS_ALLOC_FAILED`` for matrices of
256+ unknowns (charts of up to ``LSCM_BATCH_MAX_VERTS`` = 256 vertices make
512x512 systems) and RDNA fp64 throughput makes smaller batches crawl. So on
ROCm:

* the dense batch takes the function's own CPU (numpy) branch, and
* only charts of <= 48 vertices are batched; larger ones use the existing
  per-chart sparse solver (``lscm_chart``, scipy ``spsolve``).

Results are the same least-squares conformal maps; only the solver changes.
"""
from __future__ import annotations

import logging

log = logging.getLogger("studio.rocm")

ROCM_LSCM_BATCH_MAX_VERTS = 48


def apply() -> None:
    import torch
    if not getattr(torch.version, "hip", None):
        return
    from comfy_extras.mesh3d.uv_unwrap import parameterize as p
    if getattr(p.lscm_charts_batch, "__studio_cpu__", False):
        return
    original = p.lscm_charts_batch

    def lscm_charts_batch_cpu(*args, device=None, **kwargs):
        return original(*args, device=None, **kwargs)

    lscm_charts_batch_cpu.__studio_cpu__ = True
    p.lscm_charts_batch = lscm_charts_batch_cpu
    p.LSCM_BATCH_MAX_VERTS = min(p.LSCM_BATCH_MAX_VERTS, ROCM_LSCM_BATCH_MAX_VERTS)
    log.info("ROCm: LSCM batch solve on CPU, batch charts <= %d verts", p.LSCM_BATCH_MAX_VERTS)
