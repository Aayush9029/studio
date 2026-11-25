"""Job object: stage table, progress bookkeeping, cancellation, terminal events."""
from __future__ import annotations

import logging
import threading
import time
import traceback

from .errors import ApiError, JobCancelled
from .util import job_id as new_job_id

log = logging.getLogger("studio.jobs")

STAGES = {
    "image": [("prepare", "Prepare", False), ("sample", "Sample", True), ("decode", "Decode", False)],
    "remove_bg": [("prepare", "Prepare", False), ("matte", "Matte", False)],
    "3d": [("source", "Source", False), ("cutout", "Cutout", False), ("depth", "Depth", False),
           ("structure", "Structure", False), ("shape", "Shape", False), ("texture", "Texture", False),
           ("mesh", "Mesh", False)],
}


class Job:
    def __init__(self, engine, *, kind: str, mode: str, model: str, seed: int, batch_size: int,
                 width, height, stage_key: str, stage_steps: dict | None = None, preview_stages=()):
        self.engine = engine
        self.id = new_job_id()
        self.kind, self.mode, self.model = kind, mode, model
        self.seed, self.batch_size = seed, batch_size
        self.width, self.height = width, height
        self.stages = []
        for i, (sid, label, prev) in enumerate(STAGES[stage_key]):
            steps = (stage_steps or {}).get(sid)
            self.stages.append({"index": i, "id": sid, "label": label, "steps": steps,
                                "preview": bool(prev) if stage_key != "3d" else sid in preview_stages})
        self.t0 = time.monotonic()
        self.stage_index = 0
        self.progress_value = 0.0
        self.outputs: list[dict] = []
        self.last_sent_progress: dict | None = None  # newest progress actually broadcast (replayed on reconnect)
        self.cancel_requested = threading.Event()
        self.enhanced_pending: str | None = None
        self.finished = threading.Event()
        self.on_cancel_cleanup = None  # callable for 3D asset folder removal
        self._lock = threading.Lock()
        # Terminal-state bookkeeping, only mutated under ``engine.state_lock`` (Engine.finalize_job_once).
        self.terminal = False
        self.preview_token = 0  # bumped when the job terminates: stale preview work can never emit

    # ------------------------------------------------------------ time
    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self.t0) * 1000)

    # ------------------------------------------------------------ events
    def started_event(self, replayed: bool = False) -> dict:
        st = self.stages[self.stage_index]
        return {"type": "job.started", "jobId": self.id, "kind": self.kind, "mode": self.mode, "model": self.model,
                "seed": self.seed, "batchSize": self.batch_size, "width": self.width, "height": self.height,
                "stages": [dict(s) for s in self.stages], "stageIndex": 0 if not replayed else self.stage_index,
                "stageLabel": self.stages[0]["label"] if not replayed else st["label"], "replayed": replayed}

    def completed_event(self) -> dict:
        return {"type": "job.completed", "jobId": self.id, "kind": self.kind, "mode": self.mode,
                "outputs": list(self.outputs), "elapsedMs": self.elapsed_ms()}

    def cancelled_event(self, stage_index: int | None = None) -> dict:
        return {"type": "job.cancelled", "jobId": self.id,
                "stageIndex": self.stage_index if stage_index is None else stage_index,
                "elapsedMs": self.elapsed_ms(), "outputs": list(self.outputs)}

    def error_event(self, err: dict, stage_index: int | None = None) -> dict:
        return {"type": "job.error", "jobId": self.id,
                "stageIndex": self.stage_index if stage_index is None else stage_index,
                "error": err, "outputs": list(self.outputs)}

    def build_progress(self, stage_index: int, phase: str, *, step: int = 0, total_steps: int = 0,
                       batch_index: int = 0, stage_progress: float = 0.0, progress: float | None = None,
                       output: dict | None = None) -> dict:
        with self._lock:
            self.stage_index = stage_index
            if progress is not None:
                self.progress_value = max(self.progress_value, min(0.99, float(progress)))
            p = self.progress_value
            el = self.elapsed_ms()
            eta = int(el * (1.0 - p) / p) if p >= 0.03 else None
            st = self.stages[stage_index]
            ev = {"type": "job.progress", "jobId": self.id, "stageIndex": stage_index, "stageId": st["id"],
                  "stageLabel": st["label"], "phase": phase, "step": int(step), "totalSteps": int(total_steps),
                  "batchIndex": int(batch_index), "batchSize": self.batch_size,
                  "stageProgress": round(max(0.0, min(1.0, stage_progress)), 4), "progress": round(p, 4),
                  "elapsedMs": el, "etaMs": eta}
            if self.enhanced_pending is not None:
                ev["enhancedPrompt"] = self.enhanced_pending
                self.enhanced_pending = None
            if output is not None:
                ev["output"] = output
            return ev

    def progress(self, stage_index: int, phase: str, **kw) -> None:
        self.check_cancel()
        self.engine.emit_job_event(self, self.build_progress(stage_index, phase, **kw))

    def stage_preview(self, stage_index: int, status: str, image_path: str | None, elapsed_ms: int,
                      width: int | None = 512, height: int | None = 512) -> None:
        st = self.stages[stage_index]
        self.engine.emit_job_event(self, {
            "type": "job.stage_preview", "jobId": self.id, "stageIndex": stage_index,
            "stageId": st["id"], "stageLabel": st["label"], "status": status,
            "imagePath": image_path, "width": width if image_path else None,
            "height": height if image_path else None, "elapsedMs": int(elapsed_ms)})

    # ------------------------------------------------------------ cancel
    def check_cancel(self) -> None:
        if self.cancel_requested.is_set():
            raise JobCancelled()

    def cancel(self) -> None:
        self.cancel_requested.set()
        try:
            import comfy.model_management as mm
            mm.interrupt_current_processing(True)
        except Exception:
            pass

    # ------------------------------------------------------------ run
    def _cleanup_partial(self) -> None:
        if self.on_cancel_cleanup:
            try:
                self.on_cancel_cleanup()
            except Exception as ce:
                log.warning("cancel cleanup failed: %s", ce)

    def run(self, fn) -> None:
        """Run ``fn(job)`` on the GPU thread and emit exactly one terminal event.

        The failure is classified inside the ``except`` block, but all cleanup (OOM
        unload + allocator flush, partial-asset removal) and the terminal event run
        *after* it: leaving the handler drops the exception and its traceback, whose
        frames would otherwise keep the failed sampling / VAE / remesh tensors alive.
        """
        outcome = "completed"
        err: dict | None = None
        err_stage = None
        fatal: BaseException | None = None
        try:
            try:
                import torch
                with torch.inference_mode():  # same as comfy's executor
                    fn(self)
                self.check_cancel()
            except BaseException as e:  # noqa: BLE001 - must catch InterruptProcessingException (BaseException)
                err_stage = self.stage_index
                is_interrupt = isinstance(e, JobCancelled) or type(e).__name__ == "InterruptProcessingException"
                if is_interrupt or self.cancel_requested.is_set():
                    outcome = "cancelled"
                else:
                    outcome = "error"
                    err = self._classify(e)
                    log.error("job %s failed: %s\n%s", self.id, err["message"], traceback.format_exc())
                if isinstance(e, (KeyboardInterrupt, SystemExit)):
                    fatal = e.with_traceback(None)
            # ``e`` and its traceback are released here.

            if outcome == "cancelled":
                self._cleanup_partial()
                event = self.cancelled_event(err_stage)
            elif outcome == "error":
                if err["code"] == "OUT_OF_MEMORY":
                    try:
                        self.engine.models.unload_all()  # includes gc + allocator flush
                    except Exception as ue:
                        log.warning("unload after OOM failed: %s", ue)
                if self.kind == "3d":
                    self._cleanup_partial()
                event = self.error_event(err, err_stage)
            else:
                event = self.completed_event()
            if not self.engine.finalize_job_once(self, event):
                log.info("job %s: late %s suppressed (already finalized)", self.id, event["type"])
            if fatal is not None:
                raise fatal
        finally:
            try:
                import comfy.model_management as mm
                mm.interrupt_current_processing(False)
            except Exception:
                pass
            self.finished.set()

    @staticmethod
    def _classify(e: BaseException) -> dict:
        if isinstance(e, ApiError):
            return e.as_error()
        msg = str(e) or type(e).__name__
        oom_types = ("OutOfMemoryError",)
        if type(e).__name__ in oom_types or "out of memory" in msg.lower() or "hipErrorOutOfMemory" in msg:
            return {"code": "OUT_OF_MEMORY", "message": msg[:2000], "details": {}}
        tb = traceback.format_exc()
        return {"code": "INTERNAL", "message": msg[:2000], "details": {"trace": tb[-4000:]}}
