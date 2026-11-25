"""Engine state shared by the HTTP API, the WebSocket hub and the GPU thread."""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import os
import threading
import time

import psutil

from . import __version__, API_VERSION
from .errors import ApiError
from .events import Hub
from .families import FAMILY_ORDER
from .inkling import Inkling
from .jobs import Job
from .model_manager import ModelManager
from .outputs import Outputs
from .util import MIB, atomic_write_json, now_ms

log = logging.getLogger("studio.engine")

AUTO_UNLOAD_CHOICES = (0, 5, 10, 15, 30)
DEFAULT_SETTINGS = {"autoUnloadMinutes": 10}
MEMORY_CACHE_S = 0.25  # hipMemGetInfo can stall under allocator contention: share one reading


class Engine:
    def __init__(self, cfg, loop: asyncio.AbstractEventLoop):
        self.cfg = cfg
        self.loop = loop
        self.hub = Hub(loop)
        self.hub.on_connect = self.on_connect
        # One serialisation boundary for: job start, every job-scoped emission, the terminal
        # transition (+ clearing ``active_job``), models.status / telemetry broadcasts and the
        # WebSocket reconnect snapshot + subscription. Lock order: state_lock -> hub._lock.
        self.state_lock = threading.RLock()
        self._job_lock = self.state_lock  # backwards-compatible alias
        self.outputs = Outputs(cfg.outputs_dir)
        self.inkling = Inkling(cfg.inkling_url, cfg.inkling_model)
        self.models = ModelManager(cfg.models_dir, self.emit_models_status)
        self.gpu = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="studio-gpu")
        self.preview_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="studio-preview")
        self.status = "starting"
        self.ready = asyncio.Event()
        self.comfy_error: str | None = None
        self.active_job: Job | None = None
        self.device_name = ""
        self.exit_code = 0
        self.stopped = asyncio.Event()
        self._proc = psutil.Process(os.getpid())
        try:
            psutil.cpu_percent(interval=None)
        except Exception:
            pass
        self._cuda = False
        self.settings_path = os.path.join(cfg.state_dir, "engine.json")
        self.settings = self._load_settings()
        self.http = None  # aiohttp.ClientSession, created in start()
        self._mem_cache: tuple[float, dict] | None = None  # (monotonic, memory()) - replaced atomically
        self.hub.connect_context = self.memory_async  # awaited by Hub.handle, result -> on_connect

    # ------------------------------------------------------------ comfy import (GPU thread)
    def import_comfy(self) -> None:
        from . import bootstrap
        temp_dir = os.path.join(self.cfg.outputs_dir, ".cache", "engine-temp")
        os.makedirs(temp_dir, exist_ok=True)
        bootstrap.import_comfy(self.cfg.models_dir, self.cfg.outputs_dir, temp_dir)
        import torch
        import comfy.utils
        import comfy.model_management as mm
        self._cuda = torch.cuda.is_available()
        self.device_name = torch.cuda.get_device_name(0) if self._cuda else "cpu"

        def _interrupt_hook(value, total, preview, node_id=None):
            mm.throw_exception_if_processing_interrupted()
        comfy.utils.set_progress_bar_global_hook(_interrupt_hook)
        from . import rocm_compat
        rocm_compat.apply()
        self.models.set_comfy_lists()
        log.info("comfy ready: device=%s torch=%s", self.device_name, torch.__version__)

    # ------------------------------------------------------------ settings
    def _load_settings(self) -> dict:
        s = dict(DEFAULT_SETTINGS)
        try:
            with open(self.settings_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("autoUnloadMinutes") in AUTO_UNLOAD_CHOICES:
                s["autoUnloadMinutes"] = data["autoUnloadMinutes"]
        except (OSError, ValueError):
            pass
        return s

    def update_settings(self, patch: dict) -> dict:
        if not isinstance(patch, dict):
            raise ApiError("BAD_REQUEST", "settings must be an object")
        changes = {}
        if "autoUnloadMinutes" in patch:
            v = patch["autoUnloadMinutes"]
            if isinstance(v, bool) or not isinstance(v, int) or v not in AUTO_UNLOAD_CHOICES:
                raise ApiError("BAD_REQUEST", "autoUnloadMinutes must be one of 0, 5, 10, 15, 30",
                               {"field": "autoUnloadMinutes"})
            changes["autoUnloadMinutes"] = v
        # serialise concurrent POST /api/settings (read-modify-write of self.settings + the file)
        with self.state_lock:
            new = dict(self.settings, **changes)
            os.makedirs(self.cfg.state_dir, exist_ok=True)
            atomic_write_json(self.settings_path, new)
            self.settings = new
            return dict(new)

    # ------------------------------------------------------------ telemetry / health
    def memory(self) -> dict:
        """Fresh device / OS memory reading (blocking: never call it on the event loop)."""
        vt = vf = vp = 0
        if self._cuda:
            try:
                import torch
                free, total = torch.cuda.mem_get_info()
                vt, vf = int(total // MIB), int(free // MIB)
                vp = int(torch.cuda.memory_reserved() // MIB)
            except Exception:
                pass
        vm = psutil.virtual_memory()
        try:
            rss = int(self._proc.memory_info().rss // MIB)
        except Exception:
            rss = 0
        try:
            cpu_pct = round(float(psutil.cpu_percent(interval=None)), 1)
        except Exception:
            cpu_pct = None
        m = {"vramTotalMb": vt, "vramUsedMb": max(0, vt - vf), "vramFreeMb": vf, "vramProcessMb": vp,
             "ramTotalMb": int(vm.total // MIB), "ramUsedMb": int((vm.total - vm.available) // MIB),
             "ramProcessMb": rss, "cpuUtilPct": cpu_pct}
        self._mem_cache = (time.monotonic(), m)
        return m

    def memory_cached(self, max_age: float = MEMORY_CACHE_S) -> dict | None:
        c = self._mem_cache
        if c is not None and time.monotonic() - c[0] <= max_age:
            return c[1]
        return None

    async def memory_async(self, max_age: float = MEMORY_CACHE_S) -> dict:
        """``memory()`` off the event loop thread, shared for ``max_age`` seconds, so a slow
        ``hipMemGetInfo`` never stalls ``/api/cancel``, WebSocket pings or ``PREV`` frames."""
        m = self.memory_cached(max_age)
        if m is not None:
            return m
        return await asyncio.get_running_loop().run_in_executor(None, self.memory)

    def telemetry(self, mem: dict | None = None) -> dict:
        m = mem if mem is not None else self.memory()
        return {"ts": now_ms(), "source": "engine",
                "vramTotalMb": m["vramTotalMb"], "vramUsedMb": m["vramUsedMb"], "vramFreeMb": m["vramFreeMb"],
                "vramProcessMb": m["vramProcessMb"],
                "ramTotalMb": m["ramTotalMb"], "ramUsedMb": m["ramUsedMb"], "ramProcessMb": m["ramProcessMb"],
                "cpuUtilPct": m.get("cpuUtilPct"),
                "gpuUtilPct": None, "activeJobId": self.active_job.id if self.active_job else None}

    async def health(self) -> dict:
        m = await self.memory_async()
        avail = await self.inkling.available(self.http) if self.http else False
        return {"status": self.status, "apiVersion": API_VERSION, "engineVersion": __version__, "pid": os.getpid(),
                "device": self.device_name, "vramTotalMb": m["vramTotalMb"], "vramUsedMb": m["vramUsedMb"],
                "vramFreeMb": m["vramFreeMb"], "ramTotalMb": m["ramTotalMb"], "ramUsedMb": m["ramUsedMb"],
                "modelsDir": self.cfg.models_dir, "outputsDir": self.cfg.outputs_dir,
                "inklingAvailable": bool(avail), "activeJobId": self.active_job.id if self.active_job else None}

    # ------------------------------------------------------------ events
    def emit_models_status(self) -> None:
        # no subscriber: skip the lock and the status build (a connecting client's snapshot,
        # built under state_lock in on_connect, already reflects the new state)
        if not self.hub.client_count:
            return
        with self.state_lock:
            self.hub.emit({"type": "models.status", "models": self.models.status()})

    def emit_telemetry(self, mem: dict | None = None) -> None:
        if mem is None:
            mem = self.memory()  # device / OS queries stay outside the lock
        with self.state_lock:
            self.hub.emit(dict({"type": "telemetry"}, **self.telemetry(mem)))

    def on_connect(self, register, mem: dict | None = None) -> None:
        """WS reconnect: build the snapshot and subscribe atomically w.r.t. job transitions.

        ``mem`` is the snapshot ``Hub.handle`` awaited off the loop (``memory_async``)."""
        if mem is None:
            mem = self.memory_cached(max_age=5.0) or self.memory()
        with self.state_lock:
            evs = [{"type": "models.status", "models": self.models.status()},
                   dict({"type": "telemetry"}, **self.telemetry(mem))]
            job = self.active_job
            if job is not None and not job.terminal:
                evs.append(job.started_event(replayed=True))
                if job.last_sent_progress is not None:
                    evs.append(dict(job.last_sent_progress))
            register(evs)

    def emit_job_event(self, job: Job, event: dict) -> bool:
        """Broadcast a job-scoped event unless the job already reached its terminal state."""
        with self.state_lock:
            if job.terminal:
                return False
            self.hub.emit(event)
            if event.get("type") == "job.progress":
                job.last_sent_progress = event
            return True

    def emit_job_preview(self, job: Job, token: int, event: dict, frame: bytes | None,
                         priority: bool = False, alive=None) -> bool:
        """``job.progress`` + optional ``PREV`` frame from a preview stream.

        Dropped when the job is terminal or the stream's ``token`` was invalidated, or
        when ``alive()`` (the stream's own liveness check) is false - all evaluated under
        the state lock, so nothing can slip out after the terminal event.
        """
        with self.state_lock:
            if job.terminal or job.preview_token != token or (alive is not None and not alive()):
                return False
            self.hub.emit_with_preview(event, frame, priority=priority)
            job.last_sent_progress = event
            return True

    def finalize_job_once(self, job: Job, event: dict) -> bool:
        """The single, idempotent terminal transition shared by the worker and shutdown.

        Under the state lock: invalidate the job's preview streams, publish the terminal
        event and clear ``active_job``. Returns False (and emits nothing) if the job was
        already finalized - e.g. the worker finishing after shutdown gave up waiting.
        """
        with self.state_lock:
            if job.terminal:
                return False
            job.terminal = True
            job.preview_token += 1
            self.hub.emit(event)
            if self.active_job is job:
                self.active_job = None
            return True

    # ------------------------------------------------------------ jobs
    def ensure_idle(self) -> None:
        if self.status == "shutting_down":
            raise ApiError("SHUTTING_DOWN", "the engine is shutting down")
        if self.active_job is not None:
            raise ApiError("BUSY", "A job is already running.", {"activeJobId": self.active_job.id})

    def start_job(self, job: Job, fn, request: dict) -> str:
        with self.state_lock:
            self.ensure_idle()
            job.request = request
            self.active_job = job
            self.hub.emit(job.started_event())
            try:
                self.gpu.submit(self._run_job, job, fn)
            except RuntimeError as e:  # executor already shut down
                self.finalize_job_once(job, job.error_event(
                    {"code": "SHUTTING_DOWN", "message": f"cannot start job: {e}", "details": {}}))
                raise ApiError("SHUTTING_DOWN", "the engine is shutting down")
        return job.id

    def _run_job(self, job: Job, fn) -> None:
        try:
            job.run(fn)
        finally:
            if not job.terminal:  # defensive: run() must always finalize
                self.finalize_job_once(job, job.error_event(
                    {"code": "INTERNAL", "message": "job ended without a terminal event", "details": {}}))
            with self.state_lock:
                if self.active_job is job:
                    self.active_job = None

    def cancel(self, job_id: str | None) -> dict:
        job = self.active_job
        if job is None:
            if job_id:
                raise ApiError("NOT_FOUND", f"no active job {job_id}", {"jobId": job_id})
            return {"cancelled": False, "jobId": None}
        if job_id and job_id != job.id:
            raise ApiError("NOT_FOUND", f"{job_id} is not the active job", {"jobId": job_id,
                                                                            "activeJobId": job.id})
        job.cancel()
        return {"cancelled": True, "jobId": job.id}

    # ------------------------------------------------------------ models
    async def warmup(self, family: str) -> tuple[int, dict]:
        if family not in FAMILY_ORDER:
            raise ApiError("UNKNOWN_FAMILY", f"unknown family {family!r}", {"field": "family"})
        self.ensure_idle()
        self.models.measure_files(family)
        missing = self.models.missing(family)
        if missing:
            raise ApiError("MODEL_FILES_MISSING", f"{family} is missing files", {"missing": missing})
        state = self.models.state[family]
        if state in ("warm", "warming"):
            return 200, {"family": family, "state": state}
        self.models._set_state(family, "warming")

        def _do():
            try:
                if self.active_job is not None and self.models.state[family] == "warm":
                    return
                import torch
                with torch.inference_mode():
                    self.models.warm(family)
            except BaseException as e:  # noqa: BLE001
                log.warning("warm-up of %s failed: %s", family, e)
            finally:
                # never leave the family stranded in "warming" (e.g. files vanished before warm())
                if self.models.state[family] == "warming":
                    self.models._set_state(family, "cold")
        try:
            self.gpu.submit(_do)
        except RuntimeError:
            self.models._set_state(family, "cold")
            raise ApiError("SHUTTING_DOWN", "the engine is shutting down")
        return 202, {"family": family, "state": "warming"}

    async def unload(self, family: str) -> dict:
        if family != "all" and family not in FAMILY_ORDER:
            raise ApiError("UNKNOWN_FAMILY", f"unknown family {family!r}", {"field": "family"})
        self.ensure_idle()

        def _do():
            if family == "all":
                return self.models.unload_all()
            return [family] if self.models.unload(family) else []
        unloaded = await asyncio.wrap_future(self.gpu.submit(_do))
        mem = await self.memory_async(max_age=0.0)  # fresh: the unload just changed it
        return {"unloaded": unloaded, "vramFreeMb": mem["vramFreeMb"]}

    # ------------------------------------------------------------ background loops
    async def telemetry_loop(self) -> None:
        while not self.stopped.is_set():
            interval = 0.5 if self.active_job is not None else 2.0
            await asyncio.sleep(interval)
            if self.hub.client_count and self.status not in ("starting", "shutting_down"):
                self.emit_telemetry(await self.memory_async())

    def _idle_expired(self, fam: str) -> tuple[bool, int]:
        """Re-read the setting and the family's last use *now* (not when the check was queued)."""
        minutes = self.settings.get("autoUnloadMinutes", 10)
        if not minutes or self.active_job is not None or self.status != "ok":
            return False, minutes
        if self.models.state[fam] != "warm":
            return False, minutes
        return self.models.last_used_mono[fam] < time.monotonic() - minutes * 60, minutes

    async def auto_unload_loop(self) -> None:
        while not self.stopped.is_set():
            await asyncio.sleep(30.0)
            stale = [f for f in self.models.warm_families() if self._idle_expired(f)[0]]
            for fam in stale:
                def _do(fam=fam):
                    # the GPU thread may run this long after it was queued (behind a job or a
                    # warm-up that touched the family, or after the setting changed): recheck
                    expired, minutes = self._idle_expired(fam)
                    if expired:
                        log.info("auto-unload %s after %d min idle", fam, minutes)
                        self.models.unload(fam)
                try:
                    self.gpu.submit(_do)
                except RuntimeError:
                    return

    async def inkling_loop(self) -> None:
        while not self.stopped.is_set():
            try:
                await self.inkling.refresh(self.http)
            except Exception:
                pass
            await asyncio.sleep(10.0)

    def start_parent_watchdog(self, ppid: int) -> None:
        def watch():
            try:
                parent = psutil.Process(ppid)
                created = parent.create_time()
            except psutil.Error:
                parent, created = None, None
            while not self.stopped.is_set():
                alive = psutil.pid_exists(ppid)
                if alive and parent is not None:
                    try:
                        alive = parent.is_running() and parent.create_time() == created
                    except psutil.Error:
                        alive = False
                if not alive:
                    log.warning("parent process %d is gone; shutting down", ppid)
                    self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.shutdown(0, "parent exited")))
                    return
                time.sleep(1.0)
        threading.Thread(target=watch, name="studio-parent-watchdog", daemon=True).start()

    # ------------------------------------------------------------ shutdown
    async def shutdown(self, code: int = 0, reason: str = "") -> None:
        with self.state_lock:
            if self.status == "shutting_down":
                return
            self.status = "shutting_down"  # under the lock: no job can start after this
            job = self.active_job
        log.info("shutdown requested (%s)", reason or "api")
        self.exit_code = code
        try:
            if job is not None:
                job.cancel()
                done = await asyncio.get_running_loop().run_in_executor(None, job.finished.wait, 2.5)
                if not done:
                    log.warning("job %s did not stop within 2.5 s; finalizing it as cancelled", job.id)
                # Exactly one terminal event: a no-op if the worker already finalized the job,
                # otherwise job.cancelled now, and any later emission by the worker is dropped.
                self.finalize_job_once(job, job.cancelled_event())
            # deliver queued events (incl. the terminal one) before the sockets close
            await self.hub.close_all(1001)

            def _unload():
                try:
                    if self.status_ready():
                        self.models.unload_all()
                except Exception as e:
                    log.warning("unload on shutdown: %s", e)
            try:
                fut = self.gpu.submit(_unload)
                await asyncio.wait_for(asyncio.wrap_future(fut), timeout=1.2)
            except (asyncio.TimeoutError, Exception):
                log.warning("model unload did not finish before exit")
        finally:
            self.stopped.set()

    def status_ready(self) -> bool:
        return self.ready.is_set() and self.comfy_error is None
