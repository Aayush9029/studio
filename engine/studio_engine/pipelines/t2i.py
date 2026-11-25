"""Text-to-image: Z-Image Turbo and Qwen-Image 2.1 (+ shared image sampling helpers)."""
from __future__ import annotations

import logging

from ..families import FAMILIES, files_of
from ..outputs import make_inputs, make_params
from .common import PreviewStreamer, run_node, sample, tensor_to_pil

log = logging.getLogger("studio.t2i")

QWEN_MAX_SHIFT = 0.6935483870967742
QWEN_BASE_SHIFT = 0.5


def used_files(family: str) -> list[str]:
    return list(files_of(family))


# ---------------------------------------------------------------- Z-Image

def zimage_encode(objs: dict, prompt: str, negative: str, cfg: float):
    import nodes
    pos = nodes.CLIPTextEncode().encode(objs["clip"], prompt)[0]
    if cfg > 1.0 and negative.strip():
        neg = nodes.CLIPTextEncode().encode(objs["clip"], negative)[0]
    else:
        neg = nodes.ConditioningZeroOut().zero_out(pos)[0]
    return pos, neg


def zimage_empty_latent(width: int, height: int) -> dict:
    import torch
    import comfy.model_management as mm
    return {"samples": torch.zeros([1, 16, height // 8, width // 8], device=mm.intermediate_device(),
                                   dtype=mm.intermediate_dtype()),
            "downscale_ratio_spacial": 8}


# ---------------------------------------------------------------- Qwen-Image 2.1

def qwen_model(objs: dict, width: int, height: int):
    from comfy_extras.nodes_qwen import QwenImage21Cache
    from comfy_extras.nodes_model_advanced import ModelSamplingFlux
    m = run_node(QwenImage21Cache, model=objs["model"], device="auto", dtype="default")[0]
    return ModelSamplingFlux().patch(m, QWEN_MAX_SHIFT, QWEN_BASE_SHIFT, width, height)[0]


def qwen_encode(objs: dict, prompt: str, negative: str, images: dict | None, resolution: int = 1024,
                encode_negative: bool = True):
    """``TextEncodeQwenImage21`` (vendor/comfy_extras/nodes_qwen.py).

    With ``encode_negative=False`` (used at cfg == 1, where comfy never evaluates
    the uncond branch) the negative is ``ConditioningZeroOut(positive)`` instead
    of a second full Qwen3-VL pass over every reference image - that pass costs
    ~45 s for base + one reference at 1024 on the 8060S.
    """
    from comfy_extras.nodes_qwen import TextEncodeQwenImage21
    if encode_negative:
        pos, neg, latent = run_node(TextEncodeQwenImage21, clip=objs["clip"], prompt=prompt, negative_prompt=negative,
                                    vae=objs["vae"], resolution=resolution, images=images or {})
        return pos, neg, latent
    import math
    import torch
    import comfy.utils
    import comfy.model_management
    import node_helpers
    import nodes
    clip, vae = objs["clip"], objs["vae"]
    ref_latents, images_vl = [], []
    images = images or {}
    latent_w = latent_h = resolution or 1024
    for name in sorted(images, key=lambda n: int(n.rsplit("_", 1)[-1])):
        image = images[name]
        if image is None:
            continue
        samples = image[:1].movedim(-1, 1)
        if resolution > 0:
            ratio = samples.shape[3] / samples.shape[2]
            width = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
            height = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
        else:
            width, height = round(samples.shape[3] / 32) * 32, round(samples.shape[2] / 32) * 32
        width, height = max(32, width), max(32, height)
        if (width, height) == (samples.shape[3], samples.shape[2]):
            s = image[:1]
        else:
            s = comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)
        if not images_vl:
            latent_w, latent_h = width, height
        rgb = s[:, :, :, :3]
        if s.shape[-1] > 3:
            rgb = rgb * s[:, :, :, 3:] + (1.0 - s[:, :, :, 3:])
        images_vl.append(rgb)
        if vae is not None:
            ref_latents.append(vae.encode(s))
    keep_vision = len(ref_latents) == 0
    image = samples = s = rgb = None  # source pixel tensors are VAE-encoded already
    pos = clip.encode_from_tokens_scheduled(clip.tokenize(prompt, images=images_vl, keep_vision=keep_vision,
                                                          prevent_empty_text=True))
    images_vl.clear()  # vision-encoded: release the resized source pixels
    if ref_latents:
        pos = node_helpers.conditioning_set_values(pos, {"reference_latents": ref_latents}, append=True)
    neg = nodes.ConditioningZeroOut().zero_out(pos)[0]
    latent = torch.zeros([1, 64, latent_h // 16, latent_w // 16], device=comfy.model_management.intermediate_device())
    return pos, neg, {"samples": latent}


def qwen_empty_latent(width: int, height: int) -> dict:
    import torch
    import comfy.model_management as mm
    return {"samples": torch.zeros([1, 64, height // 16, width // 16], device=mm.intermediate_device())}


# ---------------------------------------------------------------- shared

_QWEN_PREVIEWER = None


def _qwen_previewer():
    """The QwenImage21 Latent2RGB factors are constants: build the previewer once."""
    global _QWEN_PREVIEWER
    if _QWEN_PREVIEWER is None:
        import comfy.latent_formats
        import latent_preview
        lf = comfy.latent_formats.QwenImage21()
        _QWEN_PREVIEWER = latent_preview.Latent2RGBPreviewer(lf.latent_rgb_factors, lf.latent_rgb_factors_bias,
                                                             lf.latent_rgb_factors_reshape)
    return _QWEN_PREVIEWER


def make_streamer(job, family: str, objs: dict, *, stage_index: int, steps: int, batch_index: int,
                  progress_of, width: int, height: int) -> PreviewStreamer:
    if family == "z_image":
        kind, decoder = "taesd", objs.get("taesd")
    else:
        kind, decoder = "latent2rgb", _qwen_previewer()
    return PreviewStreamer(job, job.engine.preview_executor, stage_index=stage_index, total_steps=steps,
                           batch_index=batch_index, kind=kind, decoder=decoder, progress_of=progress_of,
                           out_w=width, out_h=height)


def sample_and_decode(job, family: str, objs: dict, model, pos, neg, latent: dict, *, seed: int, steps: int,
                      cfg: float, sampler: str, scheduler: str, denoise: float, width: int, height: int,
                      batch_index: int, sample_stage: int, decode_stage: int, progress_of, previews: bool = True):
    """Sample with live previews, then VAE-decode. Returns an ``[1,H,W,C]`` image tensor."""
    import nodes
    streamer = None
    if previews:
        streamer = make_streamer(job, family, objs, stage_index=sample_stage, steps=steps, batch_index=batch_index,
                                 progress_of=progress_of, width=width, height=height)
    sampled = False
    try:
        out = sample(model, seed, steps, cfg, sampler, scheduler, pos, neg, latent, denoise=denoise, callback=streamer)
        sampled = True
    finally:
        if streamer is not None:
            if sampled:
                streamer.flush()   # deliver the remaining step events in order, then close
            else:
                streamer.close()   # failed / cancelled: invalidate without waiting on the worker
    job.progress(decode_stage, "decoding", batch_index=batch_index, stage_progress=0.0, progress=progress_of(1.02))
    image = nodes.VAEDecode().decode(objs["vae"], out)[0]
    del out
    return image


def run_t2i(job, req: dict) -> None:
    eng = job.engine
    fam = req["model"]
    B = req["batchSize"]
    W, H = req["width"], req["height"]
    steps, cfg = req["steps"], req["cfg"]
    prompt, negative = req["prompt"], req["negativePrompt"]

    encoded, enhanced = prompt, False
    if req["enhancePrompt"]:
        job.progress(0, "enhancing", stage_progress=0.1, progress=0.01)
        text, ok = eng.inkling.enhance_sync(prompt, "photo")
        if ok:
            encoded, enhanced = text, True
            job.enhanced_pending = text

    job.progress(0, "loading", stage_progress=0.3, progress=0.03)
    objs = eng.models.warm(fam)
    job.progress(0, "encoding", stage_progress=0.7, progress=0.06)
    if fam == "z_image":
        pos, neg = zimage_encode(objs, encoded, negative, cfg)
        model = objs["model"]
    else:
        pos, neg, _ = qwen_encode(objs, encoded, negative, None, encode_negative=cfg > 1.0)
        model = qwen_model(objs, W, H)

    base = 0.08
    for i in range(B):
        seed_i = (job.seed + i) % 4294967296

        def progress_of(f, i=i):
            return base + (1 - base) * (i + 0.85 * min(f, 1.0) + (0.05 if f > 1.0 else 0.0)) / B

        latent = zimage_empty_latent(W, H) if fam == "z_image" else qwen_empty_latent(W, H)
        image = sample_and_decode(job, fam, objs, model, pos, neg, latent, seed=seed_i, steps=steps, cfg=cfg,
                                  sampler=req["sampler"], scheduler=req["scheduler"], denoise=1.0, width=W, height=H,
                                  batch_index=i, sample_stage=1, decode_stage=2, progress_of=progress_of)
        del latent
        job.progress(2, "saving", batch_index=i, stage_progress=0.6, progress=base + (1 - base) * (i + 0.95) / B)
        img = tensor_to_pil(image)
        del image  # decoded batch tensor: not needed once it is a PIL image
        if img.mode == "RGBA":
            img = img.convert("RGB")
        params = make_params(prompt=prompt, negativePrompt=negative, enhanced=enhanced,
                             enhancedPrompt=encoded if enhanced else None, seed=seed_i, steps=steps, cfg=cfg,
                             sampler=req["sampler"], scheduler=req["scheduler"], batchIndex=i, batchSize=B)
        item = eng.outputs.save_image(img, kind="image", mode="t2i", job_id=job.id, family=fam,
                                      label=FAMILIES[fam]["label"],
                                      model_files=[f for f in used_files(fam) if not f.startswith("vae_approx/")],
                                      params=params, inputs=make_inputs(), elapsed_ms=job.elapsed_ms())
        job.outputs.append(item)
        job.progress(2, "saved", batch_index=i, stage_progress=1.0, progress=base + (1 - base) * (i + 1) / B,
                     output=item)
        eng.models.touch(fam)
