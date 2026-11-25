"""Image/text -> 3D (Pixal3D / TRELLIS.2), stage ids per API_CONTRACT.md section 4.4.

Wiring follows the working reference graphs (``image_to_3d.json`` / ``text_to_3d.json``):

    structure: CFGOverride(cfg 1, 0.667..1) -> RescaleCFG(0.7) -> ModelSamplingSD3(shift 5)
               KSampler 12 steps, cfg 7.5, euler / normal on EmptyTrellis2LatentStructure
               VaeDecodeStructureTrellis2(resolution "32")
    shape:     Trellis2ShapeStage -> CFGOverride(cfg 1, 0.769..1) -> RescaleCFG(0.5)
               KSampler 20 steps, cfg 7.5, euler / normal
               Trellis2UpsampleStage(1536) -> KSampler 12 steps, cfg 7.5, euler / simple
               VaeDecodeShapeTrellis
    texture:   Trellis2TextureStage -> KSampler (raw model) 12 steps, cfg 1, euler / normal
               VaeDecodeTextureTrellis
    mesh:      RemeshMesh(solid, fill 20, smooth 20) -> DecimateMesh(midpoint) -> UnwrapMesh
               -> BakeTextureFromVoxel(2048) -> ApplyTextureToMesh -> normalise -> GLB
"""
from __future__ import annotations

import copy
import logging
import math
import os
import shutil
import time

import numpy as np
from PIL import Image

from ..events import Hub
from ..families import FAMILIES, files_of
from ..outputs import make_inputs, make_params, make_sidecar
from ..util import (MIB, atomic_write_bytes, atomic_write_json, fit_square, hex16, iso_utc, jpeg_bytes, png_bytes,
                    stem_for, webp_bytes)
from .common import pil_to_tensor, run_node, sample, step_callback, tensor_to_pil
from .render import render_mesh, voxel_mesh
from .t2i import sample_and_decode, zimage_encode

log = logging.getLogger("studio.mesh3d")

S_SOURCE, S_CUTOUT, S_DEPTH, S_STRUCTURE, S_SHAPE, S_TEXTURE, S_MESH = range(7)
STAGE_IDS = ("source", "cutout", "depth", "structure", "shape", "texture", "mesh")
STAGE_LABELS = ("Source", "Cutout", "Depth", "Structure", "Shape", "Texture", "Mesh")

STRUCTURE_STEPS = 12
SHAPE_STEPS = (20, 12)
TEXTURE_STEPS = 12
SOURCE_STEPS = 9
TEXTURE_SIZE = 2048
UPSAMPLE_RESOLUTION = 1536

SOURCE_TEMPLATE = ("{prompt}. A single object shown whole and centered, neutral three-quarter view, "
                   "on a plain white background, soft even studio lighting, no cropping, no other objects, "
                   "no ground shadow.")

# cumulative progress at the *start* of each stage
_BOUNDS_I = (0.0, 0.03, 0.06, 0.10, 0.24, 0.52, 0.70, 1.0)
_BOUNDS_T = (0.0, 0.10, 0.13, 0.16, 0.28, 0.54, 0.70, 1.0)


def stage_steps() -> dict:
    return {"structure": STRUCTURE_STEPS, "shape": sum(SHAPE_STEPS), "texture": TEXTURE_STEPS}


class _Stages:
    def __init__(self, job, asset_dir: str, t23d: bool):
        self.job = job
        self.asset_dir = asset_dir
        self.bounds = _BOUNDS_T if t23d else _BOUNDS_I
        self.records = []
        self.t = time.monotonic()

    def p(self, stage: int, f: float) -> float:
        a, b = self.bounds[stage], self.bounds[stage + 1]
        return a + (b - a) * max(0.0, min(1.0, f))

    def of(self, stage: int):
        return lambda f: self.p(stage, f)

    def progress(self, stage: int, phase: str, f: float, **kw):
        self.job.progress(stage, phase, stage_progress=f, progress=self.p(stage, f), **kw)

    def finish(self, stage: int, thumb: Image.Image | None, skipped: bool = False):
        elapsed = int((time.monotonic() - self.t) * 1000)
        rel = None
        path = None
        if thumb is not None and not skipped:
            rel = f"stages/{stage:02d}_{STAGE_IDS[stage]}.webp"
            path = os.path.join(self.asset_dir, "stages", f"{stage:02d}_{STAGE_IDS[stage]}.webp")
            atomic_write_bytes(path, webp_bytes(fit_square(thumb, 512)))
        status = "skipped" if skipped else "done"
        self.records.append({"id": STAGE_IDS[stage], "label": STAGE_LABELS[stage], "status": status,
                             "file": rel, "elapsedMs": elapsed})
        self.job.stage_preview(stage, status, path, elapsed)
        self.t = time.monotonic()


def _mesh_item(mesh, index=0):
    from comfy_extras.nodes_save_3d import get_mesh_batch_item
    return get_mesh_batch_item(mesh, index)


def _render_mesh_thumb(mesh, voxel_colors=None, size: int = 512) -> Image.Image:
    """Render a stage thumbnail; every tensor it touches dies with this frame.

    With ``voxel_colors`` the mesh is painted first (texture stage). Only the PIL
    image escapes, so ``v0`` / ``f0`` / ``c0`` / ``vc`` and the painted mesh never
    outlive the thumbnail (they used to stay alive in ``run_3d`` up to RemeshMesh).
    """
    painted = None
    if voxel_colors is not None:
        from comfy_extras import nodes_mesh_postprocess as mp
        painted = run_node(mp.PaintMesh, mesh=mesh, voxel_colors=voxel_colors)[0]
        mesh = painted
    item = _mesh_item(mesh)
    v0, f0, c0 = item[0], item[1], (item[2] if len(item) > 2 else None)
    del item
    vc = None
    if voxel_colors is not None and c0 is not None:
        vc = c0[:, :3].float().clamp(0, 1).pow(1.0 / 2.2)
    try:
        return render_mesh(v0, f0, size=size, vertex_colors=vc)
    finally:
        del v0, f0, c0, vc, painted, mesh


def _safe_thumb(label: str, fn, *args, **kw) -> Image.Image | None:
    """``fn(*args)`` or None; the exception (and its traceback frames) is dropped here."""
    thumb = None
    try:
        thumb = fn(*args, **kw)
    except Exception as e:
        log.warning("%s thumbnail failed: %s", label, e)
    return thumb


def _structure_thumb(voxel, z_up: bool) -> Image.Image:
    occ = voxel.data[0].float().cpu().numpy() > 0.5
    vv, vf = voxel_mesh(occ, z_up=z_up)
    del occ
    return render_mesh(vv, vf, size=512)


def _rgba_on_slate(img: Image.Image, bg: tuple[int, int, int] = (26, 28, 36)) -> Image.Image:
    """Composite transparent 3D previews onto dark studio slate for crisp JPEG streaming."""
    im = img.convert("RGBA")
    canvas = Image.new("RGB", im.size, bg)
    canvas.paste(im, (0, 0), im)
    return canvas


def _structure_step_callback(job, stage_index: int, total_steps: int, progress_of, shape_vae, z_up: bool):
    """Per-step callback for Stage 3 Structure that decodes and streams voxel building blocks."""
    def cb(step, x0, x, total):
        check_interrupt(job)
        s = step + 1
        frac = s / total_steps
        ev = job.build_progress(
            stage_index, "sampling", step=s, total_steps=total_steps,
            batch_index=0, stage_progress=frac, progress=progress_of(frac),
        )
        frame = None
        if x0 is not None and job.engine.hub.client_count > 0 and not job.terminal:
            import torch
            import comfy.model_management as mm
            xs = sample_chunk = decoded = voxel_data = occ = vv = vf = rendered = comp = None
            try:
                xs = x0.tensors[0] if getattr(x0, "is_nested", False) else x0
                sample_chunk = xs[:1, :8]
                shape_vae.prepare_decode(sample_chunk.shape)
                first_stage = shape_vae.first_stage_model
                with torch.inference_mode():
                    dev = mm.get_torch_device()
                    decoded = first_stage.decode_structure(sample_chunk.to(device=dev, dtype=shape_vae.vae_dtype)) > 0
                    current_res = int(decoded.shape[2])
                    if current_res != 32 and current_res > 32:
                        ratio = current_res // 32
                        decoded = torch.nn.functional.max_pool3d(decoded.float(), ratio, ratio, 0) > 0.5
                    voxel_data = decoded.squeeze(1).float()
                    occ = voxel_data[0].cpu().numpy() > 0.5
                if occ.any():
                    vv, vf = voxel_mesh(occ, z_up=z_up)
                    if len(vv) > 0 and len(vf) > 0:
                        rendered = render_mesh(vv, vf, size=384, supersample=1)
                        comp = _rgba_on_slate(rendered)
                        frame = Hub.preview_frame(s, total_steps, stage_index, jpeg_bytes(comp, 82))
            except Exception as exc:
                log.debug("structure step %d preview skipped: %s", s, exc)
                frame = None
            finally:
                del xs, sample_chunk, decoded, voxel_data, occ, vv, vf, rendered, comp
        job.engine.emit_job_preview(
            job, job.preview_token, ev, frame, priority=(s == 1 or s == total_steps),
        )
    return cb


def _cutout_rgba(src: Image.Image, mask_l: Image.Image) -> Image.Image:
    rgba = src.convert("RGBA")  # putalpha replaces any source alpha
    rgba.putalpha(mask_l)
    return rgba


def _crop_alpha(img: Image.Image, pad: float = 1.08) -> Image.Image:
    bbox = img.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = max(x1 - x0, y1 - y0) * pad / 2
    return img.crop((int(cx - half), int(cy - half), int(math.ceil(cx + half)), int(math.ceil(cy + half))))


def normalise_vertices(v: np.ndarray) -> np.ndarray:
    """Y-up metres: longest bbox edge = 1, centred in X/Z, resting on Y = 0."""
    v = v.astype(np.float64)
    lo, hi = v.min(0), v.max(0)
    ext = float((hi - lo).max())
    s = 1.0 / ext if ext > 0 else 1.0
    off = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    out = (v - off) * s
    return out.astype(np.float32)


def run_3d(job, req: dict) -> None:
    import torch
    from comfy_extras import nodes_trellis2 as t2
    from comfy_extras.nodes_bg_removal import RemoveBackground
    from comfy_extras.nodes_images import ImageCropToMask
    from comfy_extras.nodes_moge import MoGeInference, MoGeGeometryToFOV, MoGeRender
    from comfy_extras.nodes_custom_sampler import CFGOverride
    from comfy_extras.nodes_model_advanced import ModelSamplingSD3, RescaleCFG
    from comfy_extras import nodes_mesh_postprocess as mp
    from comfy_extras.nodes_save_3d import mesh_item_to_glb_bytes
    from comfy_extras.nodes_mesh_postprocess import _smooth_vertex_normals

    eng = job.engine
    models = eng.models
    fam = req["engine"]
    t23d = req["mode"] == "t23d"
    seed = job.seed

    oid = hex16()
    ts = time.time()
    stem, _day = stem_for(oid, ts)
    asset_dir = os.path.join(eng.outputs.dir, "3d", stem)
    os.makedirs(os.path.join(asset_dir, "stages"), exist_ok=True)
    job.on_cancel_cleanup = lambda: shutil.rmtree(asset_dir, ignore_errors=True)
    st = _Stages(job, asset_dir, t23d)
    model_files: list[str] = []
    prompt = req.get("prompt") or ""
    encoded, enhanced = prompt, False

    # ------------------------------------------------------------ 0 source
    if t23d:
        if req.get("enhancePrompt"):
            st.progress(S_SOURCE, "enhancing", 0.02)
            text, ok = eng.inkling.enhance_sync(prompt, "3d")
            if ok:
                encoded, enhanced = text, True
                job.enhanced_pending = text
        if models.state["qwen_image"] != "cold":
            models.unload("qwen_image")
        st.progress(S_SOURCE, "loading", 0.05)
        zobjs = models.warm("z_image", protect=(fam, "birefnet"))
        st.progress(S_SOURCE, "encoding", 0.1)
        pos, neg = zimage_encode(zobjs, SOURCE_TEMPLATE.format(prompt=encoded.rstrip(". ")), "", 1.0)
        from .t2i import zimage_empty_latent
        image = sample_and_decode(job, "z_image", zobjs, zobjs["model"], pos, neg, zimage_empty_latent(1024, 1024),
                                  seed=seed, steps=SOURCE_STEPS, cfg=1.0, sampler="euler", scheduler="simple",
                                  denoise=1.0, width=1024, height=1024, batch_index=0, sample_stage=S_SOURCE,
                                  decode_stage=S_SOURCE, progress_of=lambda f: st.p(S_SOURCE, 0.12 + 0.8 * min(f, 1)))
        src = tensor_to_pil(image)
        if src.mode != "RGB":
            src = src.convert("RGB")
        model_files += [f for f in files_of("z_image") if not f.startswith("vae_approx/")]
        del zobjs, pos, neg, image
    else:
        st.progress(S_SOURCE, "processing", 0.3)
        src = req["_image"]
        if max(src.size) > 1024:
            sc = 1024 / max(src.size)
            src = src.resize((max(1, round(src.width * sc)), max(1, round(src.height * sc))), Image.LANCZOS)
    # intermediate asset: fast zlib level (written once, read rarely)
    atomic_write_bytes(os.path.join(asset_dir, "source.png"), png_bytes(src, compress_level=1))
    st.finish(S_SOURCE, src)

    # Qwen-Image is not needed for 3D. Z-Image stays warm: on the 102 GB unified GPU the
    # LRU budget (ModelManager.ensure_budget) evicts it only when VRAM is actually short,
    # so consecutive t23d jobs skip a 5-10 s reload.
    if models.state["qwen_image"] != "cold":
        models.unload("qwen_image")

    # ------------------------------------------------------------ 1 cutout
    rgb_t = pil_to_tensor(src, "RGB")
    if req["removeBackground"]:
        st.progress(S_CUTOUT, "loading", 0.1)
        bg = models.warm("birefnet", protect=(fam,))["bg"]
        st.progress(S_CUTOUT, "processing", 0.4)
        mask = run_node(RemoveBackground, bg_removal_model=bg, image=rgb_t)[0]
        model_files += files_of("birefnet")
        del bg
    else:
        st.progress(S_CUTOUT, "processing", 0.4)
        if src.mode == "RGBA":
            mask = pil_to_tensor(src.getchannel("A"), "L")[..., 0]
        else:
            mask = torch.ones((1, src.height, src.width), dtype=torch.float32)
    mask_l = None
    if req["removeBackground"]:  # only the cutout stage uses the 8-bit mask
        mask_l = Image.fromarray((mask[0].float().clamp(0, 1).cpu().numpy() * 255 + 0.5).astype(np.uint8), "L")
    pad_factor = 1.1 if fam == "pixal3d" else 1.0
    crop = run_node(ImageCropToMask, images=rgb_t, masks=mask.to(rgb_t.device), width=1024, height=1024,
                    pad_factor=pad_factor, grow_mask=0, background="#000000")[0]
    del rgb_t, mask  # only the 1024 crop is needed from here on
    if req["removeBackground"]:
        cut = _cutout_rgba(src, mask_l)
        atomic_write_bytes(os.path.join(asset_dir, "cutout.png"), png_bytes(cut, compress_level=1))
        st.finish(S_CUTOUT, _crop_alpha(cut))
        del cut, mask_l
    else:
        st.finish(S_CUTOUT, None, skipped=True)

    # ------------------------------------------------------------ 3D family
    if models.state[fam] != "warm":
        st.progress(S_DEPTH if fam == "pixal3d" else S_STRUCTURE, "loading", 0.05)
    # the cutout is done: BiRefNet is no longer protected, so the LRU budget may reclaim it
    objs = models.warm(fam)
    model_files = files_of(fam) + model_files
    diffusion = objs["model"]
    shape_vae, tex_vae, clip_vision = objs["shape_vae"], objs["texture_vae"], objs["clip_vision"]

    # ------------------------------------------------------------ 2 depth (Pixal3D only)
    fov = 49.13
    if fam == "pixal3d":
        st.progress(S_DEPTH, "processing", 0.3)
        geom = run_node(MoGeInference, moge_model=objs["moge"], image=crop, resolution_level=9, fov_x_degrees=0.0,
                        batch_size=4, force_projection=True, apply_mask=True, refine_steps=3)[0]
        fov = float(run_node(MoGeGeometryToFOV, moge_geometry=geom, axis="horizontal", unit="degrees")[0])
        if not math.isfinite(fov):
            fov = 49.13
        fov = max(1.0, min(170.0, fov))
        thumb = None
        try:
            thumb = tensor_to_pil(run_node(MoGeRender, moge_geometry=geom, output="normal_opengl")[0])
        except Exception as e:
            log.warning("depth thumbnail failed: %s", e)
        del geom
        st.finish(S_DEPTH, thumb)
    else:
        st.finish(S_DEPTH, None, skipped=True)

    # ------------------------------------------------------------ 3 structure
    st.progress(S_STRUCTURE, "encoding", 0.05)
    if fam == "pixal3d":
        pos, neg = run_node(t2.Pixal3DConditioning, clip_vision_model=clip_vision, image=crop, camera_angle_x=fov)
    else:
        pos, neg = run_node(t2.Trellis2Conditioning, clip_vision_model=clip_vision, image=crop)
    m = run_node(CFGOverride, model=diffusion, cfg=1.0, start_percent=0.667, end_percent=1.0)[0]
    m = RescaleCFG().patch(m, 0.7)[0]
    m_struct = ModelSamplingSD3().patch(m, 5.0)[0]
    latent = run_node(t2.EmptyTrellis2LatentStructure, batch_size=1)[0]
    s1 = sample(m_struct, seed, STRUCTURE_STEPS, 7.5, "euler", "normal", pos, neg, latent,
                callback=_structure_step_callback(
                    job, S_STRUCTURE, STRUCTURE_STEPS,
                    lambda f: st.p(S_STRUCTURE, 0.1 + 0.8 * f),
                    shape_vae, fam == "trellis2",
                ))
    st.progress(S_STRUCTURE, "decoding", 0.92)
    voxel = run_node(t2.VaeDecodeStructureTrellis2, samples=s1, vae=shape_vae, resolution="32")[0]
    del s1, m_struct, latent
    thumb = _safe_thumb("structure", _structure_thumb, voxel, fam == "trellis2")
    st.finish(S_STRUCTURE, thumb)

    # ------------------------------------------------------------ 4 shape
    total_shape = sum(SHAPE_STEPS)
    pos2, neg2, lat2 = run_node(t2.Trellis2ShapeStage, positive=pos, negative=neg, voxel=voxel)
    m = run_node(CFGOverride, model=diffusion, cfg=1.0, start_percent=0.769, end_percent=1.0)[0]
    m_shape = RescaleCFG().patch(m, 0.5)[0]
    s2 = sample(m_shape, seed, SHAPE_STEPS[0], 7.5, "euler", "normal", pos2, neg2, lat2,
                callback=step_callback(job, S_SHAPE, SHAPE_STEPS[0], 0, lambda f: st.p(S_SHAPE, 0.85 * f),
                                       step_offset=0, stage_total=total_shape))
    st.progress(S_SHAPE, "processing", SHAPE_STEPS[0] / total_shape * 0.85)
    if eng.hub.client_count > 0 and not job.terminal:
        mesh_coarse = _subs_c = item_c = v0_c = f0_c = rendered_c = comp_c = None
        try:
            mesh_coarse, _subs_c = run_node(t2.VaeDecodeShapeTrellis, samples=s2, vae=shape_vae)
            item_c = _mesh_item(mesh_coarse)
            v0_c, f0_c = item_c[0], item_c[1]
            rendered_c = render_mesh(v0_c, f0_c, size=384, supersample=1)
            comp_c = _rgba_on_slate(rendered_c)
            ev_c = job.build_progress(
                S_SHAPE, "processing", step=SHAPE_STEPS[0], total_steps=total_shape,
                batch_index=0, stage_progress=SHAPE_STEPS[0] / total_shape * 0.85,
                progress=st.p(S_SHAPE, SHAPE_STEPS[0] / total_shape * 0.85),
            )
            eng.emit_job_preview(
                job, job.preview_token, ev_c,
                Hub.preview_frame(SHAPE_STEPS[0], total_shape, S_SHAPE, jpeg_bytes(comp_c, 82)),
                priority=True,
            )
        except Exception as exc:
            log.debug("coarse shape preview skipped: %s", exc)
        finally:
            del mesh_coarse, _subs_c, item_c, v0_c, f0_c, rendered_c, comp_c
    pos3, neg3, lat3 = run_node(t2.Trellis2UpsampleStage, positive=pos2, negative=neg2, shape_latent=s2,
                                vae=shape_vae, target_resolution=UPSAMPLE_RESOLUTION)
    s3 = sample(m_shape, seed, SHAPE_STEPS[1], 7.5, "euler", "simple", pos3, neg3, lat3,
                callback=step_callback(job, S_SHAPE, SHAPE_STEPS[1], 0, lambda f: st.p(S_SHAPE, 0.85 * f),
                                       step_offset=SHAPE_STEPS[0], stage_total=total_shape))
    st.progress(S_SHAPE, "decoding", 0.88)
    mesh, subs = run_node(t2.VaeDecodeShapeTrellis, samples=s3, vae=shape_vae)
    del s2, lat2, pos2, neg2, voxel
    thumb = _safe_thumb("shape", _render_mesh_thumb, mesh)
    st.finish(S_SHAPE, thumb)

    # ------------------------------------------------------------ 5 texture
    pos4, neg4, lat4 = run_node(t2.Trellis2TextureStage, positive=pos3, negative=neg3, shape_latent=s3)
    s4 = sample(diffusion, seed, TEXTURE_STEPS, 1.0, "euler", "normal", pos4, neg4, lat4,
                callback=step_callback(job, S_TEXTURE, TEXTURE_STEPS, 0, lambda f: st.p(S_TEXTURE, 0.85 * f)))
    st.progress(S_TEXTURE, "decoding", 0.9)
    voxel_colors = run_node(t2.VaeDecodeTextureTrellis, samples=s4, vae=tex_vae, shape_subdivides=subs)[0]
    del pos, neg, pos3, neg3, pos4, neg4, lat3, lat4, s3, s4, subs, m, m_shape, diffusion, objs, clip_vision
    del shape_vae, tex_vae, crop
    thumb = _safe_thumb("texture", _render_mesh_thumb, mesh, voxel_colors)
    st.finish(S_TEXTURE, thumb)
    del thumb

    # ------------------------------------------------------------ 6 mesh
    res = int(req["remeshResolution"])
    remesh_mb = int(math.ceil(res ** 3 * 64 / MIB))
    st.progress(S_MESH, "processing", 0.02)
    models.ensure_budget(remesh_mb + 8192)
    remeshed = run_node(mp.RemeshMesh, mesh=mesh, resolution=res,
                        sign_mode={"sign_mode": "solid", "fill": 20.0, "qef": False}, band=1.0, project_back=0.0,
                        fix_poles=False, smooth_iters=20, drop_small_components=0.01,
                        precluster_max_verts=20_000_000)[0]
    del mesh
    st.progress(S_MESH, "processing", 0.35)
    decimated = run_node(mp.DecimateMesh, mesh=remeshed, target_face_count=int(req["targetFaces"]),
                         placement_mode={"placement_mode": "midpoint"})[0]
    st.progress(S_MESH, "processing", 0.5)
    unwrapped = run_node(mp.UnwrapMesh, mesh=decimated, segmenter="pec", resolution=TEXTURE_SIZE, padding=2,
                         weld_distance=0.0)[0]
    del decimated
    st.progress(S_MESH, "processing", 0.65)
    base_color, metallic, roughness = run_node(mp.BakeTextureFromVoxel, mesh=unwrapped, voxel_colors=voxel_colors,
                                               texture_size=TEXTURE_SIZE, reference_mesh=remeshed)
    textured = run_node(mp.ApplyTextureToMesh, mesh=unwrapped, base_color=base_color, metallic=metallic,
                        roughness=roughness)[0]
    del remeshed, voxel_colors, base_color, metallic, roughness, unwrapped

    st.progress(S_MESH, "saving", 0.8)
    v_i, f_i, _c, uv_i, _n = _mesh_item(textured)
    v_np = normalise_vertices(v_i.float().cpu().numpy())
    f_np = f_i.cpu().numpy().astype(np.int64)
    n_np = _smooth_vertex_normals(v_np, f_np, weld=True)
    out_mesh = copy.copy(textured)
    out_mesh.vertices = torch.from_numpy(v_np)[None]
    out_mesh.faces = torch.from_numpy(f_np.astype(np.int32))[None]
    out_mesh.uvs = uv_i.float().cpu()[None] if uv_i is not None else None
    out_mesh.normals = torch.from_numpy(n_np)[None]
    out_mesh.vertex_colors = None
    out_mesh.tangents = None
    out_mesh.vertex_counts = None
    out_mesh.face_counts = None
    glb = mesh_item_to_glb_bytes(out_mesh, 0, metadata={"generator": "Studio", "engine": fam})
    glb_name = stem + ".glb"
    glb_path = os.path.join(asset_dir, glb_name)
    atomic_write_bytes(glb_path, glb)
    # the GLB bytes and the device-side textured mesh are on disk now (50-150 MB+)
    del glb, textured, v_i, f_i, uv_i, _c, _n

    # preview render of the final mesh
    preview_name = "preview.webp"
    preview_img = None
    try:
        tex = out_mesh.texture[0] if out_mesh.texture is not None else None
        uvt = out_mesh.uvs[0] if out_mesh.uvs is not None else None
        preview_img = render_mesh(v_np, f_np, size=768, uv=uvt, texture_hwc=tex)
    except Exception as e:
        log.warning("preview render failed: %s", e)
    if preview_img is None:
        fallback = None
        for rec in reversed(st.records):
            if rec["id"] == "texture" and rec["file"]:
                fallback = Image.open(os.path.join(asset_dir, rec["file"]))
        if fallback is None and os.path.isfile(os.path.join(asset_dir, "cutout.png")):
            fallback = Image.open(os.path.join(asset_dir, "cutout.png"))
        preview_img = fit_square(fallback, 768) if fallback is not None else Image.new("RGBA", (768, 768))
    atomic_write_bytes(os.path.join(asset_dir, preview_name), webp_bytes(preview_img, 88))
    st.finish(S_MESH, preview_img)

    lo, hi = v_np.min(0).astype(float), v_np.max(0).astype(float)
    r6 = lambda a: [round(float(x), 6) for x in a]  # noqa: E731
    mesh_info = {
        "engine": fam, "format": "glb", "vertices": int(v_np.shape[0]), "triangles": int(f_np.shape[0]),
        "bounds": {"min": r6(lo), "max": r6(hi)}, "size": r6(hi - lo), "upAxis": "Y", "unit": "m",
        "targetFaces": int(req["targetFaces"]), "remeshResolution": res, "textureSize": TEXTURE_SIZE,
        "removeBackground": bool(req["removeBackground"]), "hasTexture": out_mesh.texture is not None,
    }
    seen = set()
    files_used = [f for f in model_files if not (f in seen or seen.add(f))]
    params = make_params(prompt=prompt if t23d else "", enhanced=enhanced,
                         enhancedPrompt=encoded if enhanced else None, seed=seed)
    sidecar = make_sidecar(id=oid, jobId=job.id, kind="3d", mode=req["mode"], createdAt=iso_utc(ts),
                           elapsedMs=job.elapsed_ms(), file=glb_name, mime="model/gltf-binary",
                           bytes=os.path.getsize(glb_path), width=None, height=None, hasAlpha=False,
                           model={"family": fam, "label": FAMILIES[fam]["label"], "files": files_used},
                           params=params, inputs=make_inputs(req.get("sourceId"), req.get("imagePath")),
                           mesh=mesh_info, stages=st.records, preview=preview_name)
    sidecar_path = os.path.join(asset_dir, stem + ".studio.json")
    atomic_write_json(sidecar_path, sidecar)
    item = eng.outputs.commit(sidecar, sidecar_path, dir_created=True)  # inserted into the outputs index right away
    job.outputs.append(item)
    job.on_cancel_cleanup = None  # the asset is complete
    job.progress(S_MESH, "saved", stage_progress=1.0, progress=0.99, output=item)
    models.touch(fam)
