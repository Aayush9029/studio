"""Small shared helpers: ids, time, atomic writes, image I/O, PNG iTXt."""
from __future__ import annotations

import base64
import binascii
import datetime as _dt
import io
import json
import os
import re
import secrets
import struct
import threading
import time
import zlib

from PIL import Image, ImageOps

from .errors import ApiError

MIB = 1024 * 1024
SEED_MAX = 4294967295
Image.MAX_IMAGE_PIXELS = 8192 * 8192 + 1


# ---------------------------------------------------------------- ids / time

def hex16() -> str:
    return secrets.token_hex(8)


def job_id() -> str:
    return "job_" + hex16()


def upload_id() -> str:
    return "up_" + hex16()


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_utc(ts: float | None = None) -> str:
    d = _dt.datetime.fromtimestamp(time.time() if ts is None else ts, tz=_dt.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def stem_for(output_id: str, ts: float | None = None) -> tuple[str, str]:
    """Returns (stem, local date folder) - ``<yyyyMMdd>_<HHmmss>_<8hex>`` in local time."""
    lt = _dt.datetime.fromtimestamp(time.time() if ts is None else ts)
    return f"{lt:%Y%m%d}_{lt:%H%M%S}_{output_id[:8]}", f"{lt:%Y-%m-%d}"


def resolve_seed(seed: int) -> int:
    if seed == -1:
        return secrets.randbelow(SEED_MAX + 1)
    return int(seed)


# ---------------------------------------------------------------- files

def atomic_write_bytes(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # unique per writer: two threads / processes writing the same target never share a temp file
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path: str, obj) -> None:
    atomic_write_bytes(path, json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8"))


# ---------------------------------------------------------------- images

_DATA_URL = re.compile(r"^data:image/[a-zA-Z0-9.+-]+;base64,", re.I)


def b64_to_bytes(s: str, field: str) -> bytes:
    if not isinstance(s, str) or not s:
        raise ApiError("BAD_REQUEST", f"{field} must be a non-empty base64 string", {"field": field})
    s = _DATA_URL.sub("", s.strip(), count=1)
    try:
        return base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError):
        raise ApiError("IMAGE_DECODE_FAILED", f"{field} is not valid base64", {"field": field})


def _to_srgb(img: Image.Image) -> Image.Image:
    icc = img.info.get("icc_profile")
    if not icc:
        return img
    try:
        from PIL import ImageCms
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        dst = ImageCms.createProfile("sRGB")
        mode = "RGBA" if img.mode in ("RGBA", "LA", "PA") else "RGB"
        if img.mode != mode:
            img = img.convert(mode)
        return ImageCms.profileToProfile(img, src, dst, outputMode=mode)
    except Exception:
        return img


def decode_image(data: bytes, *, max_side: int = 8192, field: str = "image", keep_alpha: bool = True) -> Image.Image:
    """Decode bytes -> PIL image, EXIF-oriented, sRGB 8-bit, ``RGB`` or ``RGBA``."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Image.DecompressionBombError:
        raise ApiError("IMAGE_TOO_LARGE", "image exceeds the pixel limit", {"field": field})
    except Exception as e:
        raise ApiError("IMAGE_DECODE_FAILED", f"could not decode {field}: {e}", {"field": field})
    if img.width > max_side or img.height > max_side:
        raise ApiError("IMAGE_TOO_LARGE", f"{field} is {img.width}x{img.height}; limit is {max_side} px per side",
                       {"field": field, "width": img.width, "height": img.height})
    try:
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    has_alpha = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
    if img.mode in ("I;16", "I;16B", "I;16L", "I"):
        img = img.point(lambda v: v * (1 / 257)).convert("L")
    img = _to_srgb(img)
    if has_alpha and keep_alpha:
        img = img.convert("RGBA")
    else:
        img = img.convert("RGB")
    return img


def load_image_path(path: str, field: str = "imagePath", max_side: int = 8192) -> Image.Image:
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ApiError("BAD_REQUEST", f"{field} must be an absolute path", {"field": field})
    if not os.path.isfile(path):
        raise ApiError("NOT_FOUND", f"{field} does not exist: {path}", {"field": field, "path": path})
    with open(path, "rb") as f:
        data = f.read()
    return decode_image(data, max_side=max_side, field=field)


def image_has_alpha(img: Image.Image) -> bool:
    if img.mode != "RGBA":
        return False
    lo, _hi = img.getchannel("A").getextrema()
    return lo < 255


def png_bytes(img: Image.Image, compress_level: int = 6) -> bytes:
    """PNG bytes. Use ``compress_level=1`` for transient / intermediate files (uploads, 3D
    ``source.png`` / ``cutout.png``): ~4-6x less CPU than level 6 for a modestly larger file."""
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=compress_level)
    return buf.getvalue()


def png_insert_itxt(png: bytes, keyword: str, text: str) -> bytes:
    """Insert an uncompressed iTXt chunk just before IEND."""
    data = keyword.encode("latin-1") + b"\x00" + b"\x00" + b"\x00" + b"" + b"\x00" + b"" + b"\x00" + text.encode("utf-8")
    chunk = struct.pack(">I", len(data)) + b"iTXt" + data + struct.pack(">I", zlib.crc32(b"iTXt" + data) & 0xFFFFFFFF)
    iend = png.rfind(b"IEND")
    if iend < 4:
        raise ValueError("not a PNG")
    pos = iend - 4
    return png[:pos] + chunk + png[pos:]


def itxt_overhead(keyword: str, text: str) -> int:
    return 12 + len(keyword.encode("latin-1")) + 5 + len(text.encode("utf-8"))


def fit_square(img: Image.Image, size: int = 512, background=(0, 0, 0, 0)) -> Image.Image:
    """Letterbox ``img`` into a ``size`` x ``size`` RGBA canvas."""
    im = img.convert("RGBA")
    scale = min(size / im.width, size / im.height)
    nw, nh = max(1, round(im.width * scale)), max(1, round(im.height * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), background)
    canvas.paste(im, ((size - nw) // 2, (size - nh) // 2), im)
    return canvas


def webp_bytes(img: Image.Image, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=4)
    return buf.getvalue()


def jpeg_bytes(img: Image.Image, quality: int = 80) -> bytes:
    buf = io.BytesIO()
    if img.mode != "RGB":  # convert() always copies, even RGB -> RGB
        img = img.convert("RGB")
    img.save(buf, format="JPEG", quality=quality, optimize=False, progressive=False)
    return buf.getvalue()
