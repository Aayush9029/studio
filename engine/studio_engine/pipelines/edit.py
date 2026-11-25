"""Edit modes: qwen_edit, inpaint, img2img (Z-Image), remove_bg (BiRefNet)."""
from __future__ import annotations

import logging

import numpy as np
from PIL import Image

from ..families import FAMILIES
from ..outputs import make_inputs, make_params
from ..util import image_has_alpha
from .common import pil_to_tensor, run_node, tensor_to_pil
from .t2i import qwen_encode, qwen_model, sample_and_decode, used_files, zimage_encode

log = logging.getLogger("studio.edit")

GROW_PX = 8
FEATHER_PX = 16


def _pad16(arr: np.ndarray, mode: str = "edge") -> np.ndarray:
    h, w = arr.shape[:2]
    ph, pw = (-h) % 16, (-w) % 16
    if not ph and not pw:
        return arr
    pad = ((0, ph), (0, pw)) + (((0, 0),) if arr.ndim == 3 else ())
    if mode == "edge":
        return np.pad(arr, pad, mode="edge")
    return np.pad(arr, pad, mode="constant", constant_values=0)


def _disk(radius: int) -> np.ndarray:
    y, x = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    return (x * x + y * y) <= radius * radius


def process_mask(mask01: np.ndarray) -> np.ndarray:
    """Grow by 8 px, feather by 16 px. Returns float32 0..1, never below the input mask."""
    import scipy.ndimage as ndi
    grown = ndi.grey_dilation(mask01, footprint=_disk(GROW_PX))
    feathered = ndi.gaussian_filter(grown, sigma=FEATHER_PX / 3.0, truncate=3.0)
    return np.clip(np.maximum(feathered, mask01), 0.0, 1.0).astype(np.float32)


def composite_alpha(mask01: np.ndarray, feathered: np.ndarray) -> np.ndarray:
    """Alpha used to composite the sampled result over the source.

    Zero wherever the request mask is 0 (those pixels stay bit-identical); inside
    the mask the feathered sampling mask is faded in over up to ``FEATHER_PX``
    from the mask edge (smoothstep), so the regenerated area blends without a seam.
    """
    import scipy.ndimage as ndi
    inside = mask01 > 0
    if not inside.any():
        return np.zeros_like(mask01, dtype=np.float32)
    dist = ndi.distance_transform_edt(inside)
    width = float(min(FEATHER_PX, max(1.0, dist.max() / 2.0)))
    t = np.clip(dist / width, 0.0, 1.0)
    ramp = t * t * (3.0 - 2.0 * t)
    a = np.minimum(feathered, mask01) * ramp
    return np.where(inside, a, 0.0).astype(np.float32)


def _progress(f: float) -> float:
    return 0.08 + 0.77 * min(f, 1.0) + (0.05 if f > 1.0 else 0.0)


def _enhance(job, prompt: str) -> tuple[str, bool]:
    if not job.request.get("enhancePrompt"):
        return prompt, False
    job.progress(0, "enhancing", stage_progress=0.1, progress=0.01)
    text, ok = job.engine.inkling.enhance_sync(prompt, "edit")
    if ok:
        job.enhanced_pending = text
        return text, True
    return prompt, False


def _save(job, img: Image.Image, family: str, params: dict, refs=()) -> None:
    req = job.request
    item = job.engine.outputs.save_image(
        img, kind="edit", mode=job.mode, job_id=job.id, family=family, label=FAMILIES[family]["label"],
        model_files=[f for f in used_files(family) if not f.startswith("vae_approx/")], params=params,
        inputs=make_inputs(req.get("sourceId"), req.get("imagePath"), list(refs)), elapsed_ms=job.elapsed_ms())
    job.outputs.append(item)
    last = len(job.stages) - 1
    job.progress(last, "saved", stage_progress=1.0, progress=0.99, output=item)
    job.engine.models.touch(family)


# ---------------------------------------------------------------- qwen_edit

def run_qwen_edit(job, req: dict) -> None:
    eng = job.engine
    prompt, negative = req["prompt"], req["negativePrompt"]
    encoded, enhanced = _enhance(job, prompt)
    job.progress(0, "loading", stage_progress=0.3, progress=0.03)
    objs = eng.models.warm("qwen_image")
    job.progress(0, "encoding", stage_progress=0.7, progress=0.06)
    images = {"image_1": pil_to_tensor(req["_image"], "RGBA")}
    for i, ref in enumerate(req["_references"]):
        images[f"image_{i + 2}"] = pil_to_tensor(ref, "RGBA")
    pos, neg, latent = qwen_encode(objs, encoded, negative, images, resolution=req["resolution"],
                                   encode_negative=req["cfg"] > 1.0)
    images.clear()  # source / reference pixel tensors are VAE + vision encoded: release them now
    del images
    H, W = int(latent["samples"].shape[-2]) * 16, int(latent["samples"].shape[-1]) * 16
    job.width, job.height = W, H
    model = qwen_model(objs, W, H)
    image = sample_and_decode(job, "qwen_image", objs, model, pos, neg, latent, seed=job.seed, steps=req["steps"],
                              cfg=req["cfg"], sampler=req["sampler"], scheduler=req["scheduler"], denoise=1.0,
                              width=W, height=H, batch_index=0, sample_stage=1, decode_stage=2,
                              progress_of=_progress)
    del latent, pos, neg, model
    job.progress(2, "saving", stage_progress=0.6, progress=0.95)
    img = tensor_to_pil(image)
    del image  # decoded tensor: not needed once it is a PIL image
    if img.mode == "RGBA" and not image_has_alpha(req["_image"]):
        img = img.convert("RGB")  # the 2.1 VAE decodes RGBA; keep alpha only when the source had transparency
    params = make_params(prompt=prompt, negativePrompt=negative, enhanced=enhanced,
                         enhancedPrompt=encoded if enhanced else None, seed=job.seed, steps=req["steps"],
                         cfg=req["cfg"], sampler=req["sampler"], scheduler=req["scheduler"],
                         resolution=req["resolution"])
    _save(job, img, "qwen_image", params, refs=req.get("referenceImages") or [])


# ---------------------------------------------------------------- inpaint / img2img

def run_zimage_edit(job, req: dict) -> None:
    import torch
    import nodes
    import comfy.model_management as mm
    eng = job.engine
    src: Image.Image = req["_image"]
    W, H = src.size
    rgb = np.asarray(src.convert("RGB"))
    prompt, negative = req["prompt"], req["negativePrompt"]
    encoded, enhanced = _enhance(job, prompt)

    job.progress(0, "loading", stage_progress=0.3, progress=0.03)
    objs = eng.models.warm("z_image")
    job.progress(0, "encoding", stage_progress=0.7, progress=0.06)
    pos, neg = zimage_encode(objs, encoded, negative, req["cfg"])

    padded = _pad16(rgb, "edge")
    pixels = torch.from_numpy(padded.astype(np.float32) / 255.0)[None].to(mm.intermediate_device())
    latent = nodes.VAEEncode().encode(objs["vae"], pixels)[0]
    del pixels  # source pixels are VAE-encoded: release them before sampling
    latent = dict(latent)

    mask01 = feathered = None
    if job.mode == "inpaint":
        mask01 = np.asarray(req["_mask"]).astype(np.float32) / 255.0
        feathered = process_mask(_pad16(mask01, "zero"))
        latent["noise_mask"] = torch.from_numpy(feathered)[None, None].to(mm.intermediate_device())

    image = sample_and_decode(job, "z_image", objs, objs["model"], pos, neg, latent, seed=job.seed,
                              steps=req["steps"], cfg=req["cfg"], sampler=req["sampler"],
                              scheduler=req["scheduler"], denoise=req["denoise"], width=W, height=H,
                              batch_index=0, sample_stage=1, decode_stage=2, progress_of=_progress)
    del latent, pos, neg
    job.progress(2, "processing", stage_progress=0.4, progress=0.93)
    gen = (image[0, :, :, :3].float().clamp(0, 1).cpu().numpy() * 255.0 + 0.5).astype(np.uint8)
    del image  # decoded tensor: not needed once it is a uint8 array
    gen = gen[:H, :W]
    if gen.shape[:2] != (H, W):  # decoder rounding safety net
        gen = np.asarray(Image.fromarray(gen).resize((W, H), Image.LANCZOS))

    if job.mode == "inpaint":
        a = composite_alpha(mask01, feathered[:H, :W])[..., None]
        blended = (rgb.astype(np.float32) * (1.0 - a) + gen.astype(np.float32) * a + 0.5).astype(np.uint8)
        out = np.where(a > 0, blended, rgb)  # mask == 0 -> bit-identical source pixels
    else:
        out = gen
    out_img = Image.fromarray(out, "RGB")
    if src.mode == "RGBA":
        out_img = out_img.convert("RGBA")
        out_img.putalpha(src.getchannel("A"))
    job.progress(2, "saving", stage_progress=0.6, progress=0.95)
    params = make_params(prompt=prompt, negativePrompt=negative, enhanced=enhanced,
                         enhancedPrompt=encoded if enhanced else None, seed=job.seed, steps=req["steps"],
                         cfg=req["cfg"], sampler=req["sampler"], scheduler=req["scheduler"], denoise=req["denoise"])
    _save(job, out_img, "z_image", params)


# ---------------------------------------------------------------- remove_bg

def run_remove_bg(job, req: dict) -> None:
    from comfy_extras.nodes_bg_removal import RemoveBackground
    eng = job.engine
    src: Image.Image = req["_image"]
    job.progress(0, "loading", stage_progress=0.3, progress=0.05)
    objs = eng.models.warm("birefnet")
    job.progress(1, "processing", stage_progress=0.1, progress=0.3)
    t = pil_to_tensor(src, "RGB")
    mask = run_node(RemoveBackground, bg_removal_model=objs["bg"], image=t)[0]
    del t
    alpha = (mask[0].float().clamp(0, 1).cpu().numpy() * 255.0 + 0.5).astype(np.uint8)
    del mask
    if alpha.shape != (src.height, src.width):
        alpha = np.asarray(Image.fromarray(alpha, "L").resize(src.size, Image.BICUBIC))
    out = src.convert("RGB").convert("RGBA")  # RGB channels byte-identical to the input
    out.putalpha(Image.fromarray(alpha, "L"))
    job.progress(1, "saving", stage_progress=0.8, progress=0.9)
    params = make_params(seed=0)
    _save(job, out, "birefnet", params)
