"""Shared pipeline helpers: V3 node calls, tensors, sampling, live previews."""
from __future__ import annotations

import asyncio
import inspect
import logging
import threading
import time

import numpy as np
from PIL import Image

from ..util import jpeg_bytes

log = logging.getLogger("studio.pipeline")


# ---------------------------------------------------------------- node calls

def run_node(node_cls, **kwargs):
    """Execute a comfy V3 ``io.ComfyNode`` outside the graph executor.

    Uses the same class clone the executor makes, with an empty hidden holder
    (``unique_id`` is None, so UI-only ``PromptServer`` calls are skipped).
    Returns the output tuple.
    """
    clone = node_cls.PREPARE_CLASS_CLONE(None)
    out = clone.execute(**kwargs)
    if inspect.isawaitable(out):
        out = asyncio.run(out)
    args = getattr(out, "args", None)
    if args is None:
        args = tuple(out) if isinstance(out, (tuple, list)) else (out,)
    return args


# ---------------------------------------------------------------- tensors

def pil_to_tensor(img: Image.Image, mode: str | None = None):
    import torch
    import comfy.model_management as mm
    if mode:
        img = img.convert(mode)
    arr = np.asarray(img).astype(np.float32) / 255.0
    if arr.ndim == 2:
        arr = arr[..., None]
    return torch.from_numpy(arr)[None].to(device=mm.intermediate_device(), dtype=mm.intermediate_dtype())


def tensor_to_pil(t) -> Image.Image:
    """``[B,H,W,C]`` or ``[H,W,C]`` float 0..1 -> PIL (first item)."""
    if t.ndim == 4:
        t = t[0]
    arr = (t.float().clamp(0, 1).cpu().numpy() * 255.0 + 0.5).astype(np.uint8)
    if arr.shape[-1] == 1:
        return Image.fromarray(arr[..., 0], "L")
    if arr.shape[-1] == 4:
        return Image.fromarray(arr, "RGBA")
    return Image.fromarray(arr[..., :3], "RGB")


# ---------------------------------------------------------------- sampling

def sample(model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent: dict,
           denoise: float = 1.0, callback=None) -> dict:
    """``nodes.common_ksampler`` with a caller-supplied step callback."""
    import comfy.sample
    latent_image = latent["samples"]
    latent_image = comfy.sample.fix_empty_latent_channels(model, latent_image, latent.get("downscale_ratio_spacial", None),
                                                          latent.get("downscale_ratio_temporal", None))
    noise = comfy.sample.prepare_noise(latent_image, seed, latent.get("batch_index"))
    noise_mask = latent.get("noise_mask")
    samples = comfy.sample.sample(model, noise, steps, cfg, sampler_name, scheduler, positive, negative, latent_image,
                                  denoise=denoise, noise_mask=noise_mask, callback=callback, disable_pbar=True,
                                  seed=seed)
    out = latent.copy()
    out.pop("downscale_ratio_spacial", None)
    out.pop("downscale_ratio_temporal", None)
    out["samples"] = samples
    return out


def check_interrupt(job) -> None:
    import comfy.model_management as mm
    job.check_cancel()
    if mm.processing_interrupted():
        mm.interrupt_current_processing(False)
        raise mm.InterruptProcessingException()


def step_callback(job, stage_index, total_steps, batch_index, progress_of, step_offset=0, stage_total=None):
    """Progress-only callback (no previews) used by 3D sampling stages."""
    stage_total = stage_total or total_steps

    def cb(step, x0, x, total):
        check_interrupt(job)
        s = step_offset + step + 1
        job.progress(stage_index, "sampling", step=s, total_steps=stage_total, batch_index=batch_index,
                     stage_progress=s / stage_total, progress=progress_of(s / stage_total))
    return cb


class PreviewStreamer:
    """Step-1 live previews (API_CONTRACT.md 4.3, DESIGN_SPEC.md 7.6).

    For every sampler step the callback snapshots ``x0`` and turns it into an
    RGB image - TAEF1 (``TAESDPreviewerImpl`` path) for Z-Image, the 64-channel
    ``QwenImage21`` Latent2RGB projection for Qwen-Image 2.1. Resizing, JPEG
    encoding and the ``job.progress`` -> binary ``PREV`` emission run on the
    engine's single background worker, so the sampler never waits for CPU work
    or the socket.

    Where the GPU half of the decode runs is ``STUDIO_PREVIEW_DECODE``:

    * ``inline`` (default) - on the sampler thread right after the step. On the
      Radeon 8060S a decode that runs concurrently with sampling is starved
      (~1.3 s instead of ~0.19 s for 1024x768 TAEF1) and slows the sampler by
      the same amount, so inline decoding delivers step 1 ~1.4 s sooner at an
      unchanged total job time (measured 28.08 s vs 28.19 s).
    * ``background`` - the worker waits on a CUDA event for the step's x0 and
      decodes on its own high-priority stream; the sampler never blocks.

    If the worker falls behind, a stale step only sends its text event (step 1
    and the last step always carry a frame). At most ``MAX_PENDING_PAYLOADS``
    decoded images / latent snapshots wait for the worker at any time (step 1 and
    the final step bypass the bound); with no WebSocket client connected no pixels
    are decoded or encoded at all.

    Every emission goes through ``Engine.emit_job_preview`` with the job's preview
    token: once the job is finalized (token bumped) or the stream is closed, a late
    or timed-out future can never publish a ``job.progress`` or ``PREV`` frame.
    """

    _streams: dict = {}
    MAX_PENDING_PAYLOADS = 2

    def __init__(self, job, executor, *, stage_index: int, total_steps: int, batch_index: int, kind: str,
                 decoder, progress_of, out_w: int, out_h: int):
        import os
        self.job = job
        self.executor = executor
        self.stage_index = stage_index
        self.total_steps = total_steps
        self.batch_index = batch_index
        self.kind = kind            # "taesd" | "latent2rgb"
        self.decoder = decoder
        self.progress_of = progress_of
        self.out_w, self.out_h = out_w, out_h
        self.inline = os.environ.get("STUDIO_PREVIEW_DECODE", "inline") != "background"
        self.token = job.preview_token
        self._latest = 0
        self._pending = 0     # payload-carrying work items not yet finished by the worker
        self._closed = False  # only set under engine.state_lock (see close())
        self._futures = []
        self._lock = threading.Lock()
        self._proj = None     # latent2rgb: (device, dtype, weight, bias) on the latent's device

    # ---------------------------------------------------------------- liveness
    def _priority(self, s: int) -> bool:
        return s == 1 or s == self.total_steps

    def _alive(self) -> bool:
        return not self._closed and not self.job.terminal and self.job.preview_token == self.token

    def _has_clients(self) -> bool:
        return self.job.engine.hub.client_count > 0

    # ---------------------------------------------------------------- sampler thread
    def __call__(self, step, x0, x, total):
        check_interrupt(self.job)
        s = step + 1
        ev = self.job.build_progress(self.stage_index, "sampling", step=s, total_steps=self.total_steps,
                                     batch_index=self.batch_index, stage_progress=s / self.total_steps,
                                     progress=self.progress_of(s / self.total_steps))
        prio = self._priority(s)
        with self._lock:
            self._latest = s
            want = (self.decoder is not None and x0 is not None and self._alive() and self._has_clients()
                    and (prio or self._pending < self.MAX_PENDING_PAYLOADS))
            if want:
                self._pending += 1
        snap = ready = img = None
        t0 = time.monotonic()
        if want:
            try:
                import torch
                xs = x0.tensors[0] if getattr(x0, "is_nested", False) else x0
                if self.inline:  # fastest step-1 on the Radeon 8060S (see class docstring)
                    with torch.inference_mode():
                        img = self._decode_image(xs[:1])
                else:
                    snap = xs[:1].detach().clone()
                    if snap.is_cuda:
                        ready = torch.cuda.Event()
                        ready.record()  # on the sampler's stream, after the snapshot copy
            except Exception as e:
                log.warning("preview decode failed at step %d: %s", s, e)
                snap = img = None
        if s == 1 and img is not None:
            log.info("preview step 1/%d decoded inline in %.0f ms", self.total_steps, (time.monotonic() - t0) * 1000)
        try:
            self._futures.append(self.executor.submit(self._work, s, ev, img, snap, ready, want))
        except RuntimeError:  # preview executor shut down (engine exiting)
            with self._lock:
                if want:
                    self._pending -= 1

    # ---------------------------------------------------------------- decoding
    def _stream(self, device):
        import torch
        key = str(device)
        st = PreviewStreamer._streams.get(key)
        if st is None:
            try:
                lo, hi = torch.cuda.Stream.priority_range()
                st = torch.cuda.Stream(device=device, priority=min(lo, hi))
            except Exception:
                st = torch.cuda.Stream(device=device)
            PreviewStreamer._streams[key] = st
        return st

    def _target_size(self, w: int, h: int) -> tuple[int, int]:
        """Final preview size for a ``w`` x ``h`` decode: TAEF1 long edge <= 768, Latent2RGB
        (1/16 scale) up to a 512 px long edge, then the final output's aspect ratio (only
        when it differs by more than a pixel) - one resize instead of two."""
        if self.kind == "taesd":
            sc = min(1.0, 768 / max(w, h))
        else:
            sc = 512 / max(w, h)
        tw, th = max(1, round(w * sc)), max(1, round(h * sc))
        target_h = max(1, round(tw * self.out_h / self.out_w))  # aspect ratio of the final output
        if abs(target_h - th) > 1:
            th = target_h
        return tw, th

    @staticmethod
    def _to_pil(x, do_scale: bool, chw: bool = False) -> Image.Image:
        # latent_preview.preview_to_image with a synchronous device->host copy
        # (its non_blocking copy is not safe to read immediately off the default stream).
        # Quantised to uint8 on the device first: 4x fewer bytes cross to the host.
        import torch
        x = ((x + 1.0) / 2.0) if do_scale else x
        x = x.clamp(0, 1).mul(0xFF).to(dtype=torch.uint8)
        if chw:
            x = x.movedim(0, 2)
        return Image.fromarray(x.contiguous().to("cpu", non_blocking=False).numpy())

    def _projection(self, device, dtype):
        """Latent2RGB ``(weight, bias)`` copied to the latent's device once per stream."""
        c = self._proj
        if c is None or c[0] != device or c[1] != dtype:
            d = self.decoder
            w = d.latent_rgb_factors.to(dtype=dtype, device=device)
            b = d.latent_rgb_factors_bias.to(dtype=dtype, device=device) \
                if d.latent_rgb_factors_bias is not None else None
            c = self._proj = (device, dtype, w, b)
        return c[2], c[3]

    def _decode_image(self, x0) -> Image.Image:
        import torch
        if self.kind == "taesd":
            # == TAESDPreviewerImpl.decode_latent_to_preview with the TAEF1 decoder
            p = next(self.decoder.parameters())
            x_sample = self.decoder.decode(x0.to(device=p.device, dtype=p.dtype)[:1])[0, :3]  # [3,H,W]
            H, W = int(x_sample.shape[-2]), int(x_sample.shape[-1])
            tw, th = self._target_size(W, H)
            if (tw, th) != (W, H):
                # resize on the device: a 2048^2 decode would otherwise cross as 12 MB and be
                # resized on the CPU
                x = x_sample[None]
                try:
                    x = torch.nn.functional.interpolate(x, size=(th, tw), mode="bilinear", align_corners=False,
                                                        antialias=True)
                except (RuntimeError, NotImplementedError):  # no anti-aliased kernel on this device
                    x = torch.nn.functional.interpolate(x, size=(th, tw), mode="bilinear", align_corners=False)
                x_sample = x[0]
            return self._to_pil(x_sample, True, chw=True)
        # == Latent2RGBPreviewer.decode_latent_to_preview with comfy.latent_formats.QwenImage21 factors
        d = self.decoder
        if d.latent_rgb_factors_reshape is not None:
            x0 = d.latent_rgb_factors_reshape(x0)
        w, b = self._projection(x0.device, x0.dtype)
        x0 = x0[0, :, 0] if x0.ndim == 5 else x0[0]
        return self._to_pil(torch.nn.functional.linear(x0.movedim(0, -1), w, bias=b), True)

    def _decode_background(self, snap, ready) -> Image.Image:
        import contextlib
        import torch
        ctx = contextlib.nullcontext()
        if snap.is_cuda:
            if ready is not None:
                ready.synchronize()
            ctx = torch.cuda.stream(self._stream(snap.device))
        with torch.inference_mode(), ctx:
            return self._decode_image(snap)

    def _encode(self, img: Image.Image) -> bytes:
        tw, th = self._target_size(img.width, img.height)
        if (tw, th) != img.size:  # TAEF1 frames normally arrive pre-sized from the device
            img = img.resize((tw, th), Image.BILINEAR if self.kind == "taesd" else Image.BICUBIC)
        data = jpeg_bytes(img, 80)
        if len(data) > 256 * 1024:
            data = jpeg_bytes(img, 65)
        return data

    # ---------------------------------------------------------------- worker thread
    def _work(self, s: int, ev: dict, img, snap=None, ready=None, counted: bool = False) -> None:
        frame = None
        prio = self._priority(s)
        try:
            if not self._alive():
                return  # job finalized / stream closed: publish nothing, not even text
            if (img is not None or snap is not None) and self._has_clients():
                with self._lock:
                    stale = s < self._latest and not prio
                if not stale:
                    if img is None:
                        img = self._decode_background(snap, ready)
                    from ..events import Hub
                    frame = Hub.preview_frame(s, self.total_steps, self.stage_index, self._encode(img))
        except Exception as e:
            log.warning("preview encode failed at step %d: %s", s, e)
            frame = None
        finally:
            img = snap = ready = None
            if counted:
                with self._lock:
                    self._pending -= 1
        self.job.engine.emit_job_preview(self.job, self.token, ev, frame, priority=prio, alive=self._alive)

    def close(self) -> None:
        """Invalidate the stream: queued / running / timed-out work can no longer publish."""
        with self.job.engine.state_lock:
            self._closed = True
        for f in self._futures:
            f.cancel()
        self._futures.clear()

    def flush(self, timeout: float = 30.0) -> None:
        """Wait (bounded, in total) for queued preview events, then close the stream."""
        import concurrent.futures
        deadline = time.monotonic() + timeout
        try:
            for f in self._futures:
                try:
                    f.result(timeout=max(0.0, deadline - time.monotonic()))
                except concurrent.futures.TimeoutError:
                    log.warning("preview worker still busy after %.0f s; dropping remaining frames", timeout)
                    break
                except Exception as e:
                    log.debug("preview future: %s", e)
        finally:
            self.close()
