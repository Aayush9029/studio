"""Output files, ``.studio.json`` sidecars and ``OutputItem`` (API_CONTRACT.md section 5)."""
from __future__ import annotations

import bisect
import json
import logging
import os
import threading

from PIL import Image

from . import __version__
from .util import (atomic_write_bytes, atomic_write_json, hex16, image_has_alpha, iso_utc, itxt_overhead,
                   png_bytes, png_insert_itxt, stem_for)

log = logging.getLogger("studio.outputs")

SIDECAR_KEYS = ("schemaVersion", "id", "jobId", "kind", "mode", "createdAt", "elapsedMs", "file", "mime", "bytes",
                "width", "height", "hasAlpha", "model", "params", "inputs", "mesh", "stages", "preview", "favorite",
                "app")
PARAM_KEYS = ("prompt", "negativePrompt", "enhanced", "enhancedPrompt", "seed", "steps", "cfg", "sampler",
              "scheduler", "denoise", "resolution", "batchIndex", "batchSize")
KIND_DIRS = {"image": "images", "edit": "edits", "3d": "3d"}


def make_params(**kw) -> dict:
    base = {"prompt": "", "negativePrompt": "", "enhanced": False, "enhancedPrompt": None, "seed": 0,
            "steps": None, "cfg": None, "sampler": None, "scheduler": None, "denoise": None,
            "resolution": None, "batchIndex": 0, "batchSize": 1}
    base.update(kw)
    return {k: base[k] for k in PARAM_KEYS}


def make_inputs(source_id=None, image_path=None, reference_paths=None) -> dict:
    return {"sourceId": source_id, "imagePath": image_path, "referencePaths": list(reference_paths or [])}


def make_sidecar(**kw) -> dict:
    base = {"schemaVersion": 1, "mesh": None, "stages": [], "preview": None, "favorite": False,
            "app": {"name": "Studio", "engineVersion": __version__, "apiVersion": 1}}
    base.update(kw)
    return {k: base[k] for k in SIDECAR_KEYS}


def _key(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


class _SortKey:
    """Newest first (``createdAt`` descending), then ``id`` ascending."""
    __slots__ = ("c", "i")

    def __init__(self, item: dict):
        self.c = str(item.get("createdAt") or "")
        self.i = str(item.get("id") or "")

    def __lt__(self, other: "_SortKey") -> bool:
        return self.c > other.c or (self.c == other.c and self.i < other.i)


class Outputs:
    """Incremental index of ``.studio.json`` sidecars.

    * Engine writes are inserted immediately (``commit``) into the index and into any
      cached per-kind sorted list (bisect insert, copy-on-write).
    * External changes (Electron favourites / deletes, Blender "Send Selected") are
      reconciled per request by comparing directory mtimes: only directories whose
      mtime changed are listed again, and only sidecars whose (mtime, size) changed
      are re-parsed. ``GET /api/outputs?kind=3d&limit=1`` therefore costs one
      ``scandir`` of ``3d/`` plus a ``stat`` per asset folder, not a JSON parse each.
    * Filesystem work and sorting run outside ``_lock``; results are committed under
      it with a generation check so a concurrent ``commit`` is never lost.
    """

    def __init__(self, outputs_dir: str):
        self.dir = outputs_dir
        self._thumbs_dir = os.path.join(outputs_dir, ".cache", "thumbs")
        # (thumbs dir mtime_ns | None, normcased file names): replaced atomically, read lock-free
        self._thumbs: tuple[int | None, frozenset] = (None, frozenset())
        self._lock = threading.Lock()            # guards the index below
        self._reconcile_lock = threading.Lock()  # one filesystem reconcile at a time
        self._reset()

    def _reset(self) -> None:
        self._gen = 0
        # sidecar key -> {"item": listed OutputItem | None, "parsed": OutputItem from the sidecar | None,
        #                 "sig": (mtime_ns, size) | None, "dir": dkey, "sub": str, "gen": int}
        self._entries: dict[str, dict] = {}
        self._dir_entries: dict[str, set] = {}   # dir key -> sidecar keys
        self._dirs: dict[str, dict] = {}         # dir key -> {"mtime": ns, "sub": str}
        self._sorted: dict[str, tuple[int, list]] = {}  # kind -> (gen, items sorted by _SortKey)

    def invalidate(self) -> None:
        """Forget everything; the next ``list`` rescans the disk."""
        with self._lock:
            self._reset()

    def _sub_of(self, path: str) -> str:
        try:
            rel = os.path.relpath(path, self.dir)
        except ValueError:
            return ""
        return rel.replace("\\", "/").split("/", 1)[0]

    # ------------------------------------------------------------ thumbnails
    def _thumb_names(self) -> frozenset:
        """Names in ``.cache/thumbs``, re-listed only when that folder's mtime changes
        (one ``stat`` per request instead of an ``isfile`` per listed item)."""
        try:
            mt = os.stat(self._thumbs_dir).st_mtime_ns
        except OSError:
            self._thumbs = (None, frozenset())
            return self._thumbs[1]
        cached_mt, names = self._thumbs
        if cached_mt == mt:
            return names
        try:
            with os.scandir(self._thumbs_dir) as it:
                names = frozenset(os.path.normcase(de.name) for de in it)
        except OSError:
            names = frozenset()
        self._thumbs = (mt, names)
        return names

    def _thumb_path(self, oid, names: frozenset | None = None) -> str | None:
        fname = f"{oid or ''}.webp"
        if names is None:
            names = self._thumb_names()
        return os.path.join(self._thumbs_dir, fname) if os.path.normcase(fname) in names else None

    # ------------------------------------------------------------ engine writes
    def commit(self, sidecar: dict, sidecar_path: str, *, pre_dir_mtime: int | None = None,
               dir_created: bool = False) -> dict:
        """Insert a freshly written sidecar into the index; returns its OutputItem.

        ``dir_created``: the engine created the sidecar's folder for this output (3D asset
        folders, a new day folder). ``pre_dir_mtime``: the folder's mtime_ns right before the
        engine wrote into it. When the index was in sync with the folder before the write
        (or has never seen the brand-new folder), the folder's post-write mtime is recorded,
        so the next ``list`` does not treat it as changed, re-scan it and drop every cached
        sorted list.
        """
        item = self.to_item(sidecar, sidecar_path)
        d = os.path.dirname(sidecar_path)
        skey, dkey = _key(sidecar_path), _key(d)
        try:
            st = os.stat(sidecar_path)
            sig = (st.st_mtime_ns, st.st_size)
        except OSError:
            sig = None
        post_mtime = None
        if dir_created or pre_dir_mtime is not None:
            try:
                post_mtime = os.stat(d).st_mtime_ns
            except OSError:
                post_mtime = None
        cached = dict(item)
        kind = cached.get("kind")
        sub = self._sub_of(d)
        with self._lock:
            replaced = skey in self._entries
            prev_gen = self._gen
            self._gen += 1
            self._entries[skey] = {"item": cached, "parsed": cached, "sig": sig, "dir": dkey,
                                   "sub": sub, "gen": self._gen}
            self._dir_entries.setdefault(dkey, set()).add(skey)
            if post_mtime is not None and sub in KIND_DIRS.values():
                known = self._dirs.get(dkey)
                if (dir_created and known is None) or (known is not None and known["mtime"] == pre_dir_mtime):
                    self._dirs[dkey] = {"mtime": post_mtime, "sub": sub}
            for k in ("all", kind):
                hit = self._sorted.get(k)
                if hit is None:
                    continue
                if hit[0] != prev_gen or replaced:
                    self._sorted.pop(k, None)
                    continue
                lst = list(hit[1])  # copy-on-write: readers may hold the old list
                bisect.insort(lst, cached, key=_SortKey)
                self._sorted[k] = (self._gen, lst)
        return item

    # ------------------------------------------------------------ OutputItem
    def to_item(self, sidecar: dict, sidecar_path: str) -> dict:
        d = os.path.dirname(sidecar_path)
        item = dict(sidecar)
        item["path"] = os.path.join(d, sidecar.get("file", ""))
        item["dir"] = d
        item["sidecarPath"] = sidecar_path
        item["previewPath"] = os.path.join(d, sidecar["preview"]) if sidecar.get("kind") == "3d" and sidecar.get("preview") else None
        item["thumbPath"] = self._thumb_path(sidecar.get("id"))
        item["assetDir"] = d if sidecar.get("kind") == "3d" else None
        return item

    # ------------------------------------------------------------ images
    def new_image_target(self, kind: str) -> tuple[str, str, str, float]:
        import time
        oid = hex16()
        ts = time.time()
        stem, day = stem_for(oid, ts)
        d = os.path.join(self.dir, KIND_DIRS[kind], day)
        return oid, stem, d, ts

    def save_image(self, img: Image.Image, *, kind: str, mode: str, job_id: str, family: str, label: str,
                   model_files: list[str], params: dict, inputs: dict, elapsed_ms: int) -> dict:
        oid, stem, d, ts = self.new_image_target(kind)
        try:
            pre_dir_mtime, created = os.stat(d).st_mtime_ns, False
        except OSError:
            pre_dir_mtime, created = None, True
        os.makedirs(d, exist_ok=True)
        fname = stem + ".png"
        has_alpha = image_has_alpha(img)
        if img.mode == "RGBA" and not has_alpha and mode != "remove_bg":
            img = img.convert("RGB")
        if mode == "remove_bg" and img.mode != "RGBA":
            img = img.convert("RGBA")
        base = png_bytes(img)
        sidecar = make_sidecar(id=oid, jobId=job_id, kind=kind, mode=mode, createdAt=iso_utc(ts),
                               elapsedMs=int(elapsed_ms), file=fname, mime="image/png", bytes=0,
                               width=img.width, height=img.height, hasAlpha=has_alpha,
                               model={"family": family, "label": label, "files": list(model_files)},
                               params=params, inputs=inputs)
        # fixed point: the embedded sidecar records the PNG's own size
        total = len(base)
        text = ""
        for _ in range(8):
            sidecar["bytes"] = total
            text = json.dumps(sidecar, ensure_ascii=False)  # always matches the sidecar's current state
            new_total = len(base) + itxt_overhead("studio", text)
            if new_total == total:
                break
            total = new_total
        data = png_insert_itxt(base, "studio", text)
        if len(data) != sidecar["bytes"]:  # pragma: no cover - digit-count oscillation
            log.warning("embedded sidecar size mismatch (%d != %d)", len(data), sidecar["bytes"])
        primary = os.path.join(d, fname)
        atomic_write_bytes(primary, data)
        sidecar["bytes"] = os.path.getsize(primary)
        sidecar_path = os.path.join(d, stem + ".studio.json")
        atomic_write_json(sidecar_path, sidecar)
        return self.commit(sidecar, sidecar_path, pre_dir_mtime=pre_dir_mtime, dir_created=created)

    # ------------------------------------------------------------ reconcile with the disk
    def _scan_dir(self, dpath: str, dkey: str) -> dict:
        """Sidecars of one asset / day folder: {skey: (sig, item | None)}; unchanged ones are not re-parsed."""
        files = {}
        try:
            with os.scandir(dpath) as it:
                for de in it:
                    try:
                        if de.is_file():
                            files[de.name] = de
                    except OSError:
                        continue
        except OSError:
            return {}
        present = {os.path.normcase(n) for n in files}
        with self._lock:
            old = {s: (self._entries[s]["sig"], self._entries[s].get("parsed"))
                   for s in self._dir_entries.get(dkey, ()) if s in self._entries}
        out = {}
        for name, de in files.items():
            if not name.lower().endswith(".studio.json"):
                continue
            try:
                st = de.stat()
            except OSError:
                continue
            sig = (st.st_mtime_ns, st.st_size)
            skey = _key(de.path)
            prev = old.get(skey)
            if prev is not None and prev[0] == sig:
                item = prev[1]
            else:
                item = None
                try:
                    with open(de.path, "r", encoding="utf-8") as f:
                        sc = json.load(f)
                    if isinstance(sc, dict) and "id" in sc and "file" in sc:
                        item = self.to_item(sc, de.path)
                except Exception as e:
                    log.debug("skip sidecar %s: %s", de.path, e)
            # the primary file must exist (deleting it changes this folder's mtime)
            if item is not None and os.path.normcase(str(item.get("file", ""))) not in present:
                if not os.path.isfile(os.path.join(dpath, str(item.get("file", "")))):
                    out[skey] = (sig, None, item)  # keep the parsed sidecar: the file may come back
                    continue
            out[skey] = (sig, item, item)
        return out

    def _reconcile(self, subs) -> None:
        with self._reconcile_lock:
            with self._lock:
                g0 = self._gen
                known = {k: v["mtime"] for k, v in self._dirs.items() if v["sub"] in subs}
            changed: dict[str, tuple] = {}
            live: set = set()
            for sub in subs:
                root = os.path.join(self.dir, sub)
                try:
                    it = os.scandir(root)
                except OSError:
                    continue
                with it:
                    for de in it:
                        if de.name.startswith("."):
                            continue
                        try:
                            if not de.is_dir():
                                continue
                            # os.stat (not the cached DirEntry data): NTFS keeps a sub-folder's
                            # timestamp in the parent index lazily
                            mt = os.stat(de.path).st_mtime_ns
                        except OSError:
                            continue
                        dkey = _key(de.path)
                        live.add(dkey)
                        if known.get(dkey) == mt:
                            continue
                        changed[dkey] = (sub, mt, self._scan_dir(de.path, dkey))
            removed = [k for k in known if k not in live]
            if not changed and not removed:
                return
            with self._lock:
                self._gen += 1
                g = self._gen
                for dkey, (sub, mt, result) in changed.items():
                    keys = set()
                    for skey in self._dir_entries.get(dkey, set()):
                        e = self._entries.get(skey)
                        if skey not in result and e is not None and e["gen"] > g0:
                            keys.add(skey)  # committed by the engine after this scan started
                        elif skey not in result:
                            self._entries.pop(skey, None)
                    for skey, (sig, item, _parsed) in result.items():
                        e = self._entries.get(skey)
                        if e is not None and e["gen"] > g0:
                            keys.add(skey)
                            continue
                        self._entries[skey] = {"item": item, "parsed": _parsed, "sig": sig, "dir": dkey, "sub": sub,
                                               "gen": g}
                        keys.add(skey)
                    self._dir_entries[dkey] = keys
                    self._dirs[dkey] = {"mtime": mt, "sub": sub}
                for dkey in removed:
                    keys = set()
                    for skey in self._dir_entries.get(dkey, set()):
                        e = self._entries.get(skey)
                        if e is not None and e["gen"] > g0:
                            keys.add(skey)
                        else:
                            self._entries.pop(skey, None)
                    if keys:
                        self._dir_entries[dkey] = keys
                    else:
                        self._dir_entries.pop(dkey, None)
                    self._dirs.pop(dkey, None)
                self._sorted.clear()

    def _sorted_items(self, kind: str) -> list[dict]:
        with self._lock:
            hit = self._sorted.get(kind)
            if hit is not None and hit[0] == self._gen:
                return hit[1]
            g = self._gen
            entries = list(self._entries.values())
        # snapshot construction outside the lock
        items = [e["item"] for e in entries
                 if e["item"] is not None and (kind == "all" or e["item"].get("kind") == kind)]
        items.sort(key=_SortKey)
        with self._lock:
            if self._gen == g:
                self._sorted[kind] = (g, items)
        return items

    # ------------------------------------------------------------ listing
    def list(self, kind: str = "all", limit: int = 200, offset: int = 0) -> tuple[list[dict], int]:
        subs = tuple(KIND_DIRS.values()) if kind == "all" else (KIND_DIRS[kind],)
        self._reconcile(subs)
        items = self._sorted_items(kind)
        total = len(items)
        page = []
        names = self._thumb_names()  # one stat (+ a scandir only when the thumbs folder changed)
        # copies: the cached items are shared; thumbPath must reflect the file system right now
        for it in items[offset:offset + limit]:
            it = dict(it)
            it["thumbPath"] = self._thumb_path(it.get("id"), names)
            page.append(it)
        return page, total
