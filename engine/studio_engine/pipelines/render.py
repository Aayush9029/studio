"""Off-screen mesh renders for 3D stage thumbnails and ``preview.webp``.

Uses comfy's GPU ray-casting helpers (``nodes_mesh_postprocess`` triangle BVH +
closest-hit traversal), so no extra dependency is needed.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image


def _basis(eye, target):
    import torch
    f = torch.nn.functional.normalize(target - eye, dim=0)
    up = torch.tensor([0.0, 1.0, 0.0], device=eye.device)
    r = torch.cross(f, up, dim=0)
    if float(r.norm()) < 1e-6:
        r = torch.tensor([1.0, 0.0, 0.0], device=eye.device)
    r = torch.nn.functional.normalize(r, dim=0)
    u = torch.cross(r, f, dim=0)
    return f, r, u


def render_mesh(vertices, faces, *, size: int = 512, uv=None, texture_hwc=None, vertex_colors=None,
                azimuth_deg: float = 35.0, elevation_deg: float = 22.0, fov_deg: float = 30.0,
                supersample: int = 2, shade: bool = True, ray_chunk: int = 1 << 22) -> Image.Image:
    """Three-quarter view of a Y-up mesh on a transparent background. Returns RGBA PIL.

    One BVH trace per view: the ``|n·view|`` headlight term and the texture / vertex-colour
    albedo both come from the same ``face`` / ``hit`` / barycentric pass (equivalent to
    comfy's ``_render_view`` clay + albedo renders, which traced every ray twice). The
    supersampled image is area-downsampled (premultiplied alpha) and quantised on the GPU,
    so only ``size x size x 4`` uint8 bytes cross to the host.
    """
    import torch
    import torch.nn.functional as F
    import comfy.model_management as mm
    from comfy_extras.nodes_mesh_postprocess import (_barycentric, _build_triangle_bvh, _closest_hit_rays_bvh,
                                                     _sample_image01, _view_rays)

    dev = mm.get_torch_device()
    v = torch.as_tensor(vertices, dtype=torch.float32).to(dev)
    f_ = torch.as_tensor(faces).to(dev).long()
    if v.shape[0] == 0 or f_.shape[0] == 0:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tri = v[f_]
    bvh = _build_triangle_bvh(tri)
    lo, hi = v.amin(0), v.amax(0)
    center = (lo + hi) * 0.5
    radius = float((hi - lo).norm() * 0.5) or 1.0
    fov = math.radians(fov_deg)
    dist = radius / math.sin(fov * 0.5) * 1.02
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    direction = torch.tensor([math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el)], device=dev)
    eye = center + direction * dist
    fw, r, u = _basis(eye, center)
    S = size * supersample

    tex = texture_hwc.to(dev).float() if texture_hwc is not None else None
    uvt = uv.to(dev).float() if uv is not None else None
    vc = vertex_colors.to(dev).float() if vertex_colors is not None else None
    colored = tex is not None or vc is not None

    o, d = _view_rays(eye, fw, r, u, fov, S, S)
    n = S * S
    light = torch.zeros(n, device=dev)                 # |n·view| in [0.15, 1] on hits, 0 elsewhere
    albedo = torch.zeros((n, 3), device=dev) if colored else None
    hit_all = torch.zeros(n, dtype=torch.bool, device=dev)
    for s in range(0, n, ray_chunk):
        e = min(s + ray_chunk, n)
        os_, ds = o[s:e], d[s:e]
        t_hit, face, hit = _closest_hit_rays_bvh(os_, ds, tri, bvh, tmin=1e-5, tmax=1e30)
        hit_all[s:e] = hit
        if not bool(hit.any()):
            continue
        fh = face[hit].clamp_min(0)
        th = tri[fh]
        dh = ds[hit]
        fn = F.normalize(torch.cross(th[:, 1] - th[:, 0], th[:, 2] - th[:, 0], dim=-1), dim=-1, eps=1e-6)
        ndl = (fn * -dh).sum(-1).abs().clamp(0.15, 1.0)
        loc = torch.zeros(e - s, device=dev)
        loc[hit] = ndl
        light[s:e] = loc
        if colored:
            bary = _barycentric(os_[hit] + t_hit[hit, None] * dh, th)
            if tex is not None and uvt is not None:
                col = _sample_image01(tex, (bary[:, :, None] * uvt[f_[fh]]).sum(1))[:, :3]
            elif vc is not None:
                col = (bary[:, :, None] * vc[f_[fh]]).sum(1)[:, :3]
            else:  # texture without UVs: comfy's clay fallback
                col = (0.72 * ndl)[:, None].expand(-1, 3)
            cl = torch.zeros((e - s, 3), device=dev)
            cl[hit] = col
            albedo[s:e] = cl
    del o, d
    light = light.reshape(S, S, 1)
    if colored:
        albedo = albedo.reshape(S, S, 3)
        img = albedo * (0.72 + 0.28 * light) if shade else albedo  # gentle headlight
    else:  # clay: light grey, headlight shaded
        img = (0.30 + 0.62 * light).expand(-1, -1, 3)
    alpha = hit_all.reshape(S, S, 1).float()
    rgb = img.clamp(0, 1)
    if supersample > 1:
        # premultiplied area filter: no grey / black fringe from the transparent background
        x = torch.cat([rgb * alpha, alpha], dim=-1).permute(2, 0, 1)[None]
        x = F.interpolate(x, size=(size, size), mode="area")[0].permute(1, 2, 0)
        alpha = x[..., 3:]
        rgb = torch.where(alpha > 1e-6, x[..., :3] / alpha.clamp_min(1e-6), torch.zeros_like(x[..., :3]))
    rgba = torch.cat([rgb.clamp(0, 1), alpha.clamp(0, 1)], dim=-1)
    arr = (rgba * 255.0 + 0.5).to(torch.uint8).contiguous().cpu().numpy()
    return Image.fromarray(arr, "RGBA")


def voxel_mesh(occupancy: np.ndarray, z_up: bool):
    """Exposed cube faces of a dense ``[R,R,R]`` occupancy grid -> (vertices Y-up, faces)."""
    occ = occupancy.astype(bool)
    R = occ.shape[0]
    pad = np.pad(occ, 1)
    verts, tris = [], []
    # (axis, sign) -> 4 corner offsets of that cube face, counter-clockwise seen from outside
    quads = {
        (0, 1): [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)],
        (0, -1): [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)],
        (1, 1): [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)],
        (1, -1): [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)],
        (2, 1): [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)],
        (2, -1): [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)],
    }
    idx = np.argwhere(occ)
    if idx.shape[0] == 0:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int64)
    base = 0
    for (axis, sign), corners in quads.items():
        nb = idx.copy()
        nb[:, axis] += sign
        exposed = ~pad[nb[:, 0] + 1, nb[:, 1] + 1, nb[:, 2] + 1]
        cells = idx[exposed]
        if cells.shape[0] == 0:
            continue
        c = np.array(corners, dtype=np.float32)
        quad_v = cells[:, None, :].astype(np.float32) + c[None]
        n = cells.shape[0]
        verts.append(quad_v.reshape(-1, 3))
        q = base + np.arange(n)[:, None] * 4
        tris.append(np.concatenate([q + np.array([0, 1, 2]), q + np.array([0, 2, 3])], axis=0))
        base += n * 4
    v = np.concatenate(verts) / R - 0.5
    f = np.concatenate(tris)
    if z_up:
        v = np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=-1)
    return v.astype(np.float32), f.astype(np.int64)
