"""aiohttp application - API_CONTRACT.md section 3."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import traceback

from aiohttp import web

from .errors import ApiError, bad
from .families import FAMILIES, FAMILY_ORDER
from .jobs import Job
from .util import (SEED_MAX, atomic_write_bytes, b64_to_bytes, decode_image, load_image_path, png_bytes,
                   resolve_seed, upload_id)

log = logging.getLogger("studio.http")

MAX_BODY = 96 * 1024 * 1024
MAX_UPLOAD = 64 * 1024 * 1024
DEFAULT_ORIGINS = ("studio://app", "http://localhost:5173", "http://127.0.0.1:5173")
ENGINE_KEY = web.AppKey("engine", object)


# ---------------------------------------------------------------- helpers

def _json(data, status: int = 200) -> web.Response:
    return web.Response(status=status, text=json.dumps(data, ensure_ascii=False), content_type="application/json")


def _err(e: ApiError) -> web.Response:
    return _json(e.body(), e.status)


async def _body(request: web.Request) -> dict:
    if not request.can_read_body:
        return {}
    try:
        raw = await request.read()
    except web.HTTPRequestEntityTooLarge:
        raise ApiError("IMAGE_TOO_LARGE", "request body exceeds 96 MB")
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as e:
        raise ApiError("BAD_REQUEST", f"malformed JSON: {e}")
    if not isinstance(data, dict):
        raise ApiError("BAD_REQUEST", "request body must be a JSON object")
    return data


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _get_str(d: dict, key: str, *, required: bool = False, lo: int = 0, hi: int = 4000, default: str = "",
             trim: bool = True) -> str:
    if key not in d or d[key] is None:
        if required:
            raise bad(key, f"{key} is required")
        return default
    v = d[key]
    if not isinstance(v, str):
        raise bad(key, f"{key} must be a string")
    t = v.strip() if trim else v
    if len(t) < lo or len(t) > hi:
        raise bad(key, f"{key} must be {lo}-{hi} characters")
    return t


def _get_int(d: dict, key: str, default, lo, hi, *, required: bool = False) -> int:
    if key not in d or d[key] is None:
        if required:
            raise bad(key, f"{key} is required")
        return default
    v = d[key]
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if not _is_int(v) or v < lo or v > hi:
        raise bad(key, f"{key} must be an integer in {lo}..{hi}")
    return v


def _get_num(d: dict, key: str, default, lo, hi) -> float:
    if key not in d or d[key] is None:
        return default
    v = d[key]
    if not _is_num(v) or v < lo or v > hi:
        raise bad(key, f"{key} must be a number in {lo}..{hi}")
    return float(v)


def _get_bool(d: dict, key: str, default: bool) -> bool:
    if key not in d or d[key] is None:
        return default
    if not isinstance(d[key], bool):
        raise bad(key, f"{key} must be a boolean")
    return d[key]


def _get_seed(d: dict, required: bool = True) -> int:
    if "seed" not in d or d["seed"] is None:
        if required:
            raise bad("seed", "seed is required")
        return 0
    v = d["seed"]
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if not _is_int(v) or not (v == -1 or 0 <= v <= SEED_MAX):
        raise bad("seed", "seed must be -1 or 0..4294967295")
    return v


def _sampler_sched(engine, d: dict, fam: str) -> tuple[str, str]:
    sampler = _get_str(d, "sampler", default=FAMILIES[fam]["defaults"]["sampler"], lo=1, hi=64)
    scheduler = _get_str(d, "scheduler", default=FAMILIES[fam]["defaults"]["scheduler"], lo=1, hi=64)
    if sampler not in engine.models.samplers:
        raise bad("sampler", f"sampler must be one of {engine.models.samplers}")
    if scheduler not in engine.models.schedulers:
        raise bad("scheduler", f"scheduler must be one of {engine.models.schedulers}")
    return sampler, scheduler


def _require_complete(engine, *families: str) -> None:
    missing = []
    for fam in families:
        engine.models.measure_files(fam)
        missing += [m for m in engine.models.missing(fam) if m not in missing]
    if missing:
        raise ApiError("MODEL_FILES_MISSING", "required model files are missing", {"missing": missing})


async def _in_thread(fn, *a):
    return await asyncio.get_running_loop().run_in_executor(None, fn, *a)


def _source_image(d: dict, *, max_side: int, field_b64="imageBase64", field_path="imagePath"):
    has_b64, has_path = d.get(field_b64) is not None, d.get(field_path) is not None
    if has_b64 == has_path:
        raise ApiError("BAD_REQUEST", f"exactly one of {field_b64} / {field_path} is required", {"field": field_b64})
    if has_b64:
        img = decode_image(b64_to_bytes(d[field_b64], field_b64), max_side=8192, field=field_b64)
    else:
        img = load_image_path(d[field_path], field_path)
    if max(img.size) > max_side:
        raise ApiError("IMAGE_TOO_LARGE", f"image long edge {max(img.size)} exceeds {max_side}",
                       {"width": img.width, "height": img.height, "limit": max_side})
    return img


# ---------------------------------------------------------------- middleware

def make_middleware(engine, allowed_origins: set[str], port: int):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    @web.middleware
    async def mw(request: web.Request, handler):
        origin = request.headers.get("Origin")
        cors = {}
        if origin is not None:
            if origin not in allowed_origins:
                return _finish(_err(ApiError("FORBIDDEN_ORIGIN", f"origin {origin!r} not allowed")), {})
            cors = {"Access-Control-Allow-Origin": origin, "Vary": "Origin",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600"}
        if request.host not in hosts:
            return _finish(_err(ApiError("FORBIDDEN_ORIGIN", f"host {request.host!r} not allowed")), cors)
        if request.method == "OPTIONS":
            return _finish(web.Response(status=204), cors)
        if request.method == "POST" and request.path != "/ws":
            ctype = request.content_type
            has_body = request.can_read_body and (request.content_length or 0) != 0
            ok = ctype == "application/json" or (request.path == "/api/upload" and ctype == "multipart/form-data")
            if has_body and not ok:
                return _finish(_err(ApiError("UNSUPPORTED_MEDIA_TYPE", f"Content-Type {ctype!r} not accepted")),
                               cors)
            if request.content_length and request.content_length > MAX_BODY:
                return _finish(_err(ApiError("IMAGE_TOO_LARGE", "request body exceeds 96 MB")), cors)
        try:
            resp = await handler(request)
        except ApiError as e:
            resp = _err(e)
        except web.HTTPRequestEntityTooLarge:
            resp = _err(ApiError("IMAGE_TOO_LARGE", "request body exceeds 96 MB"))
        except web.HTTPNotFound:
            resp = _err(ApiError("NOT_FOUND", f"no route {request.method} {request.path}"))
        except web.HTTPMethodNotAllowed:
            resp = _json({"error": {"code": "NOT_FOUND", "message": f"{request.method} not allowed on {request.path}"}},
                         405)
        except web.HTTPException as e:
            resp = _json({"error": {"code": "BAD_REQUEST", "message": e.reason}}, e.status)
        except Exception as e:  # noqa: BLE001
            log.error("unhandled error on %s %s\n%s", request.method, request.path, traceback.format_exc())
            resp = _err(ApiError("INTERNAL", str(e) or type(e).__name__, {"trace": traceback.format_exc()[-4000:]}))
        if isinstance(resp, web.WebSocketResponse):
            return resp
        return _finish(resp, cors)

    def _finish(resp, cors):
        resp.headers["X-Studio-Api"] = "1"
        for k, v in cors.items():
            resp.headers[k] = v
        return resp

    return mw


# ---------------------------------------------------------------- handlers

class Api:
    def __init__(self, engine):
        self.e = engine

    async def _ready(self):
        if not self.e.ready.is_set():
            try:
                await asyncio.wait_for(self.e.ready.wait(), timeout=60)
            except asyncio.TimeoutError:
                raise ApiError("INTERNAL", "engine is still starting")
        if self.e.comfy_error:
            raise ApiError("INTERNAL", f"comfy failed to load: {self.e.comfy_error}")

    # --- status
    async def health(self, request):
        return _json(await self.e.health())

    async def models(self, request):
        await self._ready()
        return _json(self.e.models.status())

    async def warmup(self, request):
        d = await _body(request)
        fam = d.get("family")
        if not isinstance(fam, str) or fam not in FAMILY_ORDER:
            raise ApiError("UNKNOWN_FAMILY", f"unknown family {fam!r}", {"field": "family"})
        await self._ready()
        status, body = await self.e.warmup(fam)
        return _json(body, status)

    async def unload(self, request):
        d = await _body(request)
        fam = d.get("family")
        if not isinstance(fam, str) or (fam != "all" and fam not in FAMILY_ORDER):
            raise ApiError("UNKNOWN_FAMILY", f"unknown family {fam!r}", {"field": "family"})
        await self._ready()
        return _json(await self.e.unload(fam))

    async def get_settings(self, request):
        return _json(dict(self.e.settings))

    async def post_settings(self, request):
        d = await _body(request)
        return _json(self.e.update_settings(d))

    async def telemetry(self, request):
        return _json(self.e.telemetry(await self.e.memory_async()))

    async def enhance(self, request):
        d = await _body(request)
        idea = _get_str(d, "idea", required=True, lo=1, hi=2000)
        style = d.get("style")
        if style not in ("photo", "3d", "edit"):
            raise bad("style", "style must be photo, 3d or edit")
        text, ok = await self.e.inkling.enhance_async(self.e.http, idea, style)
        if ok:
            return _json({"prompt": text, "enhanced": True})
        return _json({"prompt": idea, "enhanced": False, "reason": "INKLING_UNAVAILABLE"})

    async def upload(self, request):
        data = None
        if request.content_type == "multipart/form-data":
            reader = await request.multipart()
            async for part in reader:
                if part.name == "file":
                    buf = bytearray()
                    while True:
                        chunk = await part.read_chunk(1 << 20)
                        if not chunk:
                            break
                        buf.extend(chunk)
                        if len(buf) > MAX_UPLOAD:
                            raise ApiError("IMAGE_TOO_LARGE", "upload exceeds 64 MB")
                    data = bytes(buf)
                    break
            if data is None:
                raise bad("file", "multipart body needs a part named 'file'")
        else:
            d = await _body(request)
            if not isinstance(d.get("imageBase64"), str):
                raise bad("imageBase64", "imageBase64 is required")
            data = b64_to_bytes(d["imageBase64"], "imageBase64")
        if len(data) > MAX_UPLOAD:
            raise ApiError("IMAGE_TOO_LARGE", "upload exceeds 64 MB")
        img = await _in_thread(lambda: decode_image(data, max_side=8192, field="file"))
        uid = upload_id()
        path = os.path.join(self.e.cfg.outputs_dir, "uploads", uid + ".png")
        # transient file (re-read by the next request): fast zlib level
        await _in_thread(lambda: atomic_write_bytes(path, png_bytes(img, compress_level=1)))
        return _json({"id": uid, "path": path, "width": img.width, "height": img.height}, 201)

    # --- generation
    async def t2i(self, request):
        d = await _body(request)
        await self._ready()
        self.e.ensure_idle()
        prompt = _get_str(d, "prompt", required=True, lo=1, hi=4000)
        negative = _get_str(d, "negativePrompt", hi=4000)
        fam = d.get("model")
        if fam not in ("z_image", "qwen_image"):
            raise ApiError("UNKNOWN_FAMILY", f"unknown image model {fam!r}", {"field": "model"})
        mult = FAMILIES[fam]["defaults"]["sizeMultiple"]
        dims = {}
        for k in ("width", "height"):
            v = d.get(k)
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            if not _is_int(v) or not (256 <= v <= 2048) or v % mult:
                raise ApiError("INVALID_DIMENSIONS", f"{k} must be 256-2048 and a multiple of {mult}",
                               {"field": k, "multiple": mult})
            dims[k] = v
        seed = _get_seed(d)
        req = {
            "prompt": prompt, "negativePrompt": negative, "model": fam, "width": dims["width"],
            "height": dims["height"], "steps": _get_int(d, "steps", FAMILIES[fam]["defaults"]["steps"], 1, 50),
            "cfg": _get_num(d, "cfg", 1.0, 1.0, 10.0), "batchSize": _get_int(d, "batchSize", 1, 1, 4),
            "enhancePrompt": _get_bool(d, "enhancePrompt", False),
        }
        req["sampler"], req["scheduler"] = _sampler_sched(self.e, d, fam)
        _require_complete(self.e, fam)
        from .pipelines.t2i import run_t2i
        job = Job(self.e, kind="image", mode="t2i", model=fam, seed=resolve_seed(seed), batch_size=req["batchSize"],
                  width=req["width"], height=req["height"], stage_key="image", stage_steps={"sample": req["steps"]})
        jid = self.e.start_job(job, lambda j: run_t2i(j, req), req)
        return _json({"jobId": jid}, 202)

    async def edit(self, request):
        d = await _body(request)
        await self._ready()
        self.e.ensure_idle()
        mode = d.get("mode")
        if mode not in ("qwen_edit", "inpaint", "img2img", "remove_bg"):
            raise bad("mode", "mode must be qwen_edit, inpaint, img2img or remove_bg")
        fam = {"qwen_edit": "qwen_image", "inpaint": "z_image", "img2img": "z_image", "remove_bg": "birefnet"}[mode]
        req: dict = {"mode": mode, "sourceId": _get_str(d, "sourceId", hi=64) or None,
                     "imagePath": d.get("imagePath") if d.get("imagePath") is not None else None}
        sampling = mode != "remove_bg"
        if sampling:
            req["prompt"] = _get_str(d, "prompt", required=True, lo=1, hi=4000)
            req["negativePrompt"] = _get_str(d, "negativePrompt", hi=4000)
            seed = _get_seed(d)
            req["steps"] = _get_int(d, "steps", 8 if mode == "qwen_edit" else 9, 1, 50)
            req["cfg"] = _get_num(d, "cfg", 1.0, 1.0, 10.0)
            req["sampler"], req["scheduler"] = _sampler_sched(self.e, d, "qwen_image" if mode == "qwen_edit" else "z_image")
            req["enhancePrompt"] = _get_bool(d, "enhancePrompt", False)
        else:
            seed = 0
        if mode in ("inpaint", "img2img"):
            req["denoise"] = _get_num(d, "denoise", 0.85 if mode == "inpaint" else 0.60, 0.05, 1.0)
        if mode == "qwen_edit":
            r = _get_int(d, "resolution", 1024, 512, 2048)
            if r % 32:
                raise bad("resolution", "resolution must be a multiple of 32")
            req["resolution"] = r
            refs = d.get("referenceImages") or []
            if not isinstance(refs, list) or not all(isinstance(x, str) for x in refs):
                raise bad("referenceImages", "referenceImages must be an array of absolute paths")
            if len(refs) > 3:
                raise bad("referenceImages", "at most 3 reference images")
            req["referenceImages"] = list(refs)
        max_side = 2048 if mode in ("inpaint", "img2img") else 8192
        img = await _in_thread(lambda: _source_image(d, max_side=max_side))
        req["_image"] = img
        if mode == "inpaint":
            if d.get("maskBase64") is None:
                raise bad("maskBase64", "maskBase64 is required for inpaint")
            mask = await _in_thread(lambda: decode_image(b64_to_bytes(d["maskBase64"], "maskBase64"),
                                                         field="maskBase64", keep_alpha=False).convert("L"))
            if mask.size != img.size:
                raise bad("maskBase64", f"mask is {mask.size[0]}x{mask.size[1]}, image is {img.width}x{img.height}")
            if mask.getextrema()[1] == 0:
                raise bad("maskBase64", "mask is entirely black")
            req["_mask"] = mask
        if mode == "qwen_edit":
            req["_references"] = list(await asyncio.gather(
                *(_in_thread(load_image_path, p, "referenceImages") for p in req["referenceImages"])))
        _require_complete(self.e, fam)
        from .pipelines import edit as ed
        fn = {"qwen_edit": ed.run_qwen_edit, "inpaint": ed.run_zimage_edit, "img2img": ed.run_zimage_edit,
              "remove_bg": ed.run_remove_bg}[mode]
        if mode == "remove_bg":
            job = Job(self.e, kind="edit", mode=mode, model=fam, seed=0, batch_size=1, width=img.width,
                      height=img.height, stage_key="remove_bg")
        else:
            w, h = (img.width, img.height) if mode != "qwen_edit" else (None, None)
            job = Job(self.e, kind="edit", mode=mode, model=fam, seed=resolve_seed(seed), batch_size=1, width=w,
                      height=h, stage_key="image", stage_steps={"sample": req["steps"]})
        jid = self.e.start_job(job, lambda j: fn(j, req), req)
        return _json({"jobId": jid}, 202)

    async def gen3d(self, request):
        d = await _body(request)
        await self._ready()
        self.e.ensure_idle()
        mode = d.get("mode")
        if mode not in ("t23d", "i23d"):
            raise bad("mode", "mode must be t23d or i23d")
        eng3d = d.get("engine")
        if eng3d not in ("pixal3d", "trellis2"):
            raise ApiError("UNKNOWN_FAMILY", f"unknown 3D engine {eng3d!r}", {"field": "engine"})
        seed = _get_seed(d)
        req = {"mode": mode, "engine": eng3d, "sourceId": _get_str(d, "sourceId", hi=64) or None,
               "removeBackground": _get_bool(d, "removeBackground", True),
               "targetFaces": _get_int(d, "targetFaces", 300000, 100000, 700000),
               "enhancePrompt": _get_bool(d, "enhancePrompt", False) if mode == "t23d" else False,
               "imagePath": None}
        rr = _get_int(d, "remeshResolution", 512, 512, 1024)
        if rr not in (512, 768, 1024):
            raise bad("remeshResolution", "remeshResolution must be 512, 768 or 1024")
        req["remeshResolution"] = rr
        if mode == "t23d":
            req["prompt"] = _get_str(d, "prompt", required=True, lo=1, hi=4000)
            if d.get("imageBase64") is not None or d.get("imagePath") is not None:
                raise bad("imageBase64", "t23d takes no image")
        else:
            req["prompt"] = ""
            req["_image"] = await _in_thread(lambda: _source_image(d, max_side=8192))
            req["imagePath"] = d.get("imagePath")
        need = [eng3d] + (["birefnet"] if req["removeBackground"] else []) + (["z_image"] if mode == "t23d" else [])
        _require_complete(self.e, *need)
        from .pipelines.mesh3d import run_3d, stage_steps
        steps = stage_steps()
        preview_stages = ()
        if mode == "t23d":
            steps["source"] = 9
            preview_stages = ("source",)
        job = Job(self.e, kind="3d", mode=mode, model=eng3d, seed=resolve_seed(seed), batch_size=1, width=None,
                  height=None, stage_key="3d", stage_steps=steps, preview_stages=preview_stages)
        jid = self.e.start_job(job, lambda j: run_3d(j, req), req)
        return _json({"jobId": jid}, 202)

    async def cancel(self, request):
        d = await _body(request)
        jid = d.get("jobId")
        if jid is not None and not isinstance(jid, str):
            raise bad("jobId", "jobId must be a string")
        return _json(self.e.cancel(jid))

    async def shutdown(self, request):
        # the response is flushed before teardown starts
        asyncio.get_running_loop().call_later(0.05, lambda: asyncio.ensure_future(self.e.shutdown(0, "api")))
        return _json({"ok": True})

    async def outputs(self, request):
        q = request.query
        kind = q.get("kind", "all")
        if kind not in ("all", "image", "edit", "3d"):
            raise bad("kind", "kind must be all, image, edit or 3d")
        try:
            limit = int(q.get("limit", "200"))
            offset = int(q.get("offset", "0"))
        except ValueError:
            raise bad("limit", "limit/offset must be integers")
        if not (1 <= limit <= 1000):
            raise bad("limit", "limit must be 1..1000")
        if offset < 0:
            raise bad("offset", "offset must be >= 0")
        items, total = await _in_thread(self.e.outputs.list, kind, limit, offset)
        return _json({"items": items, "total": total})

    async def ws(self, request):
        return await self.e.hub.handle(request)

    async def not_found(self, request):
        raise ApiError("NOT_FOUND", f"no route {request.method} {request.path}")


def build_app(engine, extra_origins=()) -> web.Application:
    allowed = set(DEFAULT_ORIGINS) | set(extra_origins)
    app = web.Application(client_max_size=MAX_BODY, middlewares=[make_middleware(engine, allowed, engine.cfg.port)])
    app[ENGINE_KEY] = engine
    a = Api(engine)
    r = app.router
    r.add_get("/api/health", a.health)
    r.add_get("/api/models", a.models)
    r.add_post("/api/models/warmup", a.warmup)
    r.add_post("/api/models/unload", a.unload)
    r.add_get("/api/settings", a.get_settings)
    r.add_post("/api/settings", a.post_settings)
    r.add_get("/api/telemetry", a.telemetry)
    r.add_post("/api/enhance-prompt", a.enhance)
    r.add_post("/api/upload", a.upload)
    r.add_post("/api/generate/t2i", a.t2i)
    r.add_post("/api/generate/edit", a.edit)
    r.add_post("/api/generate/3d", a.gen3d)
    r.add_post("/api/cancel", a.cancel)
    r.add_post("/api/shutdown", a.shutdown)
    r.add_get("/api/outputs", a.outputs)
    r.add_get("/ws", a.ws)
    r.add_route("*", "/{tail:.*}", a.not_found)
    return app
