"""Model families: warm-up, unload, LRU memory budget, shared components.

All loading / unloading runs on the engine's single GPU thread (see engine.py),
so the manager itself only needs a lock to protect the state that HTTP handlers
read concurrently.
"""
from __future__ import annotations

import gc
import logging
import math
import os
import stat
import threading
import time

from .errors import ApiError
from .families import FAMILIES, FAMILY_ORDER, CURATED_SAMPLERS, CURATED_SCHEDULERS, shared_with, files_of
from .util import MIB, iso_utc

log = logging.getLogger("studio.models")

HEADROOM_MB = 8192


class ModelManager:
    def __init__(self, models_dir: str, emit_status):
        self.models_dir = models_dir
        self._emit_status = emit_status  # callable() -> None, broadcasts models.status
        self._lock = threading.RLock()
        self.state: dict[str, str] = {fid: "cold" for fid in FAMILY_ORDER}
        self.last_used_iso: dict[str, str | None] = {fid: None for fid in FAMILY_ORDER}
        self.last_used_mono: dict[str, float] = {fid: 0.0 for fid in FAMILY_ORDER}
        self.file_info: dict[str, tuple[bool, int]] = {}
        self.components: dict[str, object] = {}      # relPath -> loaded object
        self.objects: dict[str, dict] = {}           # family -> assembled objects
        self.samplers: list[str] = list(CURATED_SAMPLERS)
        self.schedulers: list[str] = list(CURATED_SCHEDULERS)
        self.measure_files()

    # ------------------------------------------------------------ disk / status
    def abs_path(self, rel: str) -> str:
        return os.path.join(self.models_dir, *rel.split("/"))

    def measure_files(self, family: str | None = None) -> None:
        fams = [family] if family else FAMILY_ORDER
        measured: dict[str, tuple[bool, int]] = {}
        for fid in fams:
            for _, rp in FAMILIES[fid]["files"]:
                if rp in measured:
                    continue
                p = self.abs_path(rp)
                try:
                    st = os.stat(p)
                    measured[rp] = (stat.S_ISREG(st.st_mode), int(st.st_size))
                except OSError:
                    measured[rp] = (False, 0)
        # stat outside the lock, publish under it (HTTP handlers read file_info concurrently)
        with self._lock:
            self.file_info.update(measured)

    def set_comfy_lists(self) -> None:
        import comfy.samplers
        avail_s = set(comfy.samplers.KSampler.SAMPLERS)
        avail_c = set(comfy.samplers.KSampler.SCHEDULERS)
        self.samplers = [s for s in CURATED_SAMPLERS if s in avail_s]
        self.schedulers = [s for s in CURATED_SCHEDULERS if s in avail_c]

    def disk_bytes(self, fid: str) -> int:
        return sum(self.file_info.get(rp, (False, 0))[1] for _, rp in FAMILIES[fid]["files"]
                   if self.file_info.get(rp, (False, 0))[0])

    def vram_estimate_mb(self, fid: str) -> int:
        return int(math.ceil(self.disk_bytes(fid) / MIB * 1.10))

    def missing(self, fid: str) -> list[str]:
        return [rp for _, rp in FAMILIES[fid]["files"] if not self.file_info.get(rp, (False, 0))[0]]

    def family_status(self, fid: str) -> dict:
        f = FAMILIES[fid]
        files = []
        for role, rp in f["files"]:
            exists, size = self.file_info.get(rp, (False, 0))
            files.append({"role": role, "relPath": rp, "path": self.abs_path(rp),
                          "bytes": size if exists else 0, "exists": exists,
                          "sharedWith": shared_with(fid, rp)})
        has_lists = f["defaults"] is not None
        return {
            "id": fid,
            "label": f["label"],
            "state": self.state[fid],
            "vramEstimateMb": self.vram_estimate_mb(fid),
            "diskBytes": self.disk_bytes(fid),
            "complete": all(x["exists"] for x in files),
            "lastUsedAt": self.last_used_iso[fid],
            "files": files,
            "defaults": dict(f["defaults"]) if has_lists else None,
            "samplers": list(self.samplers) if has_lists else None,
            "schedulers": list(self.schedulers) if has_lists else None,
        }

    def status(self) -> list[dict]:
        with self._lock:
            return [self.family_status(fid) for fid in FAMILY_ORDER]

    def touch(self, fid: str) -> None:
        self.last_used_iso[fid] = iso_utc()
        self.last_used_mono[fid] = time.monotonic()

    def _set_state(self, fid: str, state: str) -> None:
        with self._lock:
            changed = self.state[fid] != state
            self.state[fid] = state
        if changed:
            self._emit_status()

    def warm_families(self) -> list[str]:
        return [fid for fid in FAMILY_ORDER if self.state[fid] == "warm"]

    # ------------------------------------------------------------ memory
    @staticmethod
    def vram_free_mb() -> int:
        """Device free memory plus PyTorch's inactive cached segments.

        ``mem_get_info`` counts blocks the caching allocator reserved but no tensor
        uses as "used"; they are reusable by this process without any eviction, so
        counting them avoids LRU-unloading a warm family (or raising OUT_OF_MEMORY)
        only because the allocator has not returned its pool to the driver yet.
        """
        import torch
        free, _total = torch.cuda.mem_get_info()
        try:
            cached = max(0, int(torch.cuda.memory_reserved()) - int(torch.cuda.memory_allocated()))
        except Exception:
            cached = 0
        return int((free + cached) // MIB)

    def _needed_mb(self, fid: str) -> int:
        pending = sum(self.file_info.get(rp, (False, 0))[1] for rp in set(files_of(fid)) if rp not in self.components)
        return int(math.ceil(pending / MIB * 1.10))

    def ensure_budget(self, required_mb: int, protect: tuple[str, ...] = ()) -> None:
        """Unload warm families (LRU first, never ``protect``) until free >= required.

        Before the first eviction (and before giving up with OUT_OF_MEMORY) the
        allocator cache is flushed once: dead tensors / comfy's cleaned-up models may
        still pin memory that a ``gc`` + ``soft_empty_cache`` returns for free.
        """
        flushed = False
        while True:
            free = self.vram_free_mb()
            if free >= required_mb:
                return
            if not flushed:
                flushed = True
                self._free_cache()
                continue
            candidates = [f for f in FAMILY_ORDER if self.state[f] == "warm" and f not in protect]
            if not candidates:
                raise ApiError("OUT_OF_MEMORY", f"need {required_mb} Mb free, have {free} Mb",
                               {"requiredMb": required_mb, "vramFreeMb": free})
            victim = min(candidates, key=lambda f: self.last_used_mono[f])
            log.info("memory budget: unloading %s (free %d < %d Mb)", victim, free, required_mb)
            self.unload(victim)  # _release() flushes the allocator cache itself

    # ------------------------------------------------------------ loading
    def _load_component(self, rel: str, fid: str):
        if rel in self.components:
            return self.components[rel]
        import nodes
        import comfy.model_management as mm
        folder, name = rel.split("/", 1)
        t = time.time()
        if folder == "diffusion_models":
            obj = nodes.UNETLoader().load_unet(name, "default")[0]
        elif folder == "text_encoders":
            clip_type = {"z_image": "lumina2", "qwen_image": "qwen_image"}[fid]
            obj = nodes.CLIPLoader().load_clip(name, clip_type, "default")[0]
        elif folder == "vae":
            obj = nodes.VAELoader().load_vae(name)[0]
        elif folder == "vae_approx":
            from comfy.taesd.taesd import TAESD
            import torch
            # fp16: ~100 ms per 1024x768 preview on the 8060S vs ~260 ms in fp32
            obj = TAESD(None, self.abs_path(rel), latent_channels=16).to(mm.get_torch_device(), torch.float16)
            obj.eval()
            try:  # first-call kernel selection happens here, not on the step-1 preview
                with torch.inference_mode():
                    obj.decode(torch.zeros((1, 16, 128, 128), device=mm.get_torch_device(), dtype=torch.float16))
                torch.cuda.synchronize()
            except Exception as e:
                log.debug("taesd warm decode: %s", e)
        elif folder == "clip_vision":
            obj = nodes.CLIPVisionLoader().load_clip(name)[0]
        elif folder == "geometry_estimation":
            from comfy_extras.nodes_moge import LoadMoGeModel
            from .pipelines.common import run_node
            obj = run_node(LoadMoGeModel, model_name=name)[0]
        elif folder == "background_removal":
            from comfy_extras.nodes_bg_removal import LoadBackgroundRemovalModel
            from .pipelines.common import run_node
            obj = run_node(LoadBackgroundRemovalModel, bg_removal_name=name)[0]
        elif folder == "loras":
            obj = None  # applied while assembling qwen_image
        else:
            raise RuntimeError(f"no loader for {rel}")
        log.info("loaded %s in %.1fs", rel, time.time() - t)
        self.components[rel] = obj
        return obj

    @staticmethod
    def _patchers(obj) -> list:
        out = []
        p = getattr(obj, "patcher", None)
        if p is not None:
            out.append(p)
        if hasattr(obj, "model_options") and hasattr(obj, "clone_base_uuid"):
            out.append(obj)  # a ModelPatcher itself
        return out

    def _assemble(self, fid: str) -> dict:
        c = {rp: self.components.get(rp) for rp in files_of(fid)}
        f = FAMILIES[fid]["files"]
        by_role = {}
        for role, rp in f:
            by_role.setdefault(role, []).append(c[rp])
        if fid == "z_image":
            return {"model": by_role["diffusion"][0], "clip": by_role["text_encoder"][0],
                    "vae": by_role["vae"][0], "taesd": by_role["preview_decoder"][0]}
        if fid == "qwen_image":
            import nodes
            lora_name = [rp for r, rp in f if r == "lora"][0].split("/", 1)[1]
            model = nodes.LoraLoaderModelOnly().load_lora_model_only(by_role["diffusion"][0], lora_name, 1.0)[0]
            return {"model": model, "clip": by_role["text_encoder"][0], "vae": by_role["vae"][0]}
        if fid in ("pixal3d", "trellis2"):
            out = {"model": by_role["diffusion"][0], "shape_vae": by_role["vae"][0],
                   "texture_vae": by_role["vae"][1], "clip_vision": by_role["vision_encoder"][0]}
            if fid == "pixal3d":
                out["moge"] = by_role["geometry"][0]
            return out
        if fid == "birefnet":
            return {"bg": by_role["matting"][0]}
        raise KeyError(fid)

    def warm(self, fid: str, protect: tuple[str, ...] = (), to_gpu: bool = True) -> dict:
        """Load every component of ``fid`` (GPU thread only). Returns assembled objects."""
        if self.state[fid] == "warm" and fid in self.objects:
            self.touch(fid)
            return self.objects[fid]
        self.measure_files(fid)
        missing = self.missing(fid)
        if missing:
            raise ApiError("MODEL_FILES_MISSING", f"{fid} is missing files", {"missing": missing})
        self._set_state(fid, "warming")
        ok = False
        try:
            self.ensure_budget(self._needed_mb(fid) + HEADROOM_MB, protect=protect + (fid,))
            for rp in files_of(fid):
                self._load_component(rp, fid)
            objs = self._assemble(fid)
            if to_gpu:
                self._to_gpu(objs)
            self.objects[fid] = objs
            self.touch(fid)
            self._set_state(fid, "warm")
            ok = True
            return objs
        finally:
            if not ok:
                # roll back anything this family alone holds; the original exception propagates
                # unchanged, and the family can never stay stranded in "warming"
                try:
                    self._release(fid)
                except Exception as re:
                    log.warning("rollback of %s failed: %s", fid, re)
                finally:
                    self._set_state(fid, "cold")

    def _to_gpu(self, objs: dict) -> None:
        import comfy.model_management as mm
        patchers = []
        for k, o in objs.items():
            if k == "taesd":
                continue
            patchers.extend(self._patchers(o))
        if patchers:
            try:
                mm.load_models_gpu(patchers)
            except Exception as e:  # loading to GPU is an optimisation; sampling loads on demand
                log.warning("warm-up GPU load failed (%s); models stay in RAM", e)

    # ------------------------------------------------------------ unloading
    def _survivors(self, fid: str) -> list[str]:
        """Families (other than ``fid``) whose components must stay resident."""
        return [f for f in FAMILY_ORDER if f != fid and self.state[f] in ("warm", "warming")]

    def _kept_patchers(self, survivors: list[str]) -> tuple[set, set]:
        """ids and clone_base_uuids of every patcher a surviving family still uses."""
        ids, uuids = set(), set()
        for f in survivors:
            holders = list((self.objects.get(f) or {}).values())
            holders += [self.components.get(rp) for rp in files_of(f)]
            for o in holders:
                if o is None:
                    continue
                for p in self._patchers(o):
                    ids.add(id(p))
                    u = getattr(p, "clone_base_uuid", None)
                    if u is not None:
                        uuids.add(u)
        return ids, uuids

    def _release(self, fid: str) -> None:
        """Drop ``fid``'s objects and the components no surviving family shares.

        The survivors' patchers (and their clone ids) are computed *before* anything is
        unloaded: ``unload_model_and_clones`` evicts every clone of a patcher, so unloading
        e.g. the TRELLIS.2 VAEs / DINOv3 encoder on behalf of Pixal3D would also evict them
        from a still-warm TRELLIS.2. Each exclusively owned patcher is unloaded once.
        """
        import comfy.model_management as mm
        survivors = self._survivors(fid)
        keep_files = {rp for f in survivors for rp in files_of(f)}
        keep_ids, keep_uuids = self._kept_patchers(survivors)

        objs = self.objects.pop(fid, None) or {}
        owned_rel = [rp for rp in files_of(fid) if rp in self.components and rp not in keep_files]
        owned = [self.components.pop(rp) for rp in owned_rel]

        to_unload, seen = [], set()
        for o in list(objs.values()) + owned:
            if o is None:
                continue
            for p in self._patchers(o):
                if id(p) in seen or id(p) in keep_ids:
                    continue
                seen.add(id(p))
                if getattr(p, "clone_base_uuid", None) in keep_uuids:
                    continue  # a clone of something a survivor uses
                to_unload.append(p)
        # drop local refs (never mutate the popped dict: a running pipeline may still hold it)
        objs = None
        owned.clear()
        o = p = None  # loop variables would otherwise pin the last object through the flush
        try:
            for p in to_unload:
                try:
                    extra = [getattr(a, "clone_base_uuid", None) for a in p.get_nested_additional_models()]
                except Exception:
                    extra = []
                try:
                    mm.unload_model_and_clones(p, unload_additional_models=not (set(extra) & keep_uuids),
                                               all_devices=True)
                except Exception as e:
                    log.debug("unload_model_and_clones: %s", e)
        finally:
            to_unload.clear()  # drop the last local refs before the allocator flush
            p = None
            self._free_cache()
        if owned_rel:
            log.info("released %s: %s", fid, ", ".join(owned_rel))

    @staticmethod
    def _free_cache() -> None:
        import comfy.model_management as mm
        mm.cleanup_models()
        gc.collect()
        mm.soft_empty_cache(force=True)  # already calls torch.cuda.empty_cache() on CUDA / ROCm

    def unload(self, fid: str) -> bool:
        if self.state[fid] == "cold" and fid not in self.objects:
            return False
        self._set_state(fid, "unloading")
        try:
            self._release(fid)
        finally:
            self._set_state(fid, "cold")
        return True

    def unload_all(self) -> list[str]:
        import comfy.model_management as mm
        changed = []
        try:
            for fid in FAMILY_ORDER:
                if self.state[fid] != "cold" or fid in self.objects:
                    changed.append(fid)
                    self._set_state(fid, "unloading")
            self.objects.clear()
            self.components.clear()
            try:
                mm.unload_all_models()
            except Exception as e:
                log.warning("unload_all_models: %s", e)
            self._free_cache()
        finally:
            # never leave a family stranded in "unloading" (or "warming"), even if cleanup raised
            for fid in changed:
                self._set_state(fid, "cold")
        return changed
