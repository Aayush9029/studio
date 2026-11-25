# Studio Bridge - Blender 5.3 add-on (API_CONTRACT.md section 9.1). Standard library only.
#
#   GET  http://127.0.0.1:48215/health   snapshot refreshed by a main-thread timer (< 50 ms)
#   POST http://127.0.0.1:48215/import   queued, executed on Blender's main thread
#
# Main-thread rule: HTTP handler threads never touch bpy. They put work on a
# queue.Queue and wait on a threading.Event; a persistent bpy.app.timers callback
# (0.1 s) drains the queue on the main thread.

bl_info = {
    "name": "Studio Bridge",
    "author": "Studio",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar > Studio",
    "description": "Receives meshes from Studio and sends selections / viewport renders back",
    "category": "Import-Export",
}

import json
import os
import queue
import secrets
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bpy

ADDON_VERSION = "1.0.0"
API_VERSION = 1
HOST, PORT = "127.0.0.1", 48215
ENGINE = "http://127.0.0.1:48210"
DEFAULT_OUTPUTS = r"C:\Users\winbloat\Studio\outputs"
SUPPORTED = (".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply")
IMPORT_TIMEOUT_S = 60.0
TIMER_INTERVAL_S = 0.1
RETRY_S = 5.0
COLLECTION = "Studio"
MAX_BODY = 64 * 1024        # /import bodies are a few hundred bytes of JSON
SOCKET_TIMEOUT_S = 5.0      # per socket operation; a stalled client cannot pin a handler thread
BLENDER_VERSION = ".".join(str(x) for x in bpy.app.version)  # constant for the session

_state = {
    "server": None, "thread": None, "error": "", "next_retry": 0.0, "last_snapshot": 0.0,
    "uploads_running": 0, "upload_status": "",
}
_queue: "queue.Queue[dict]" = queue.Queue()
_import_lock = threading.Lock()          # held from enqueue until the request is done or expired
# Per-request state, only changed under _jobs_lock:
#   queued  -> running -> done      (main thread)
#   queued  -> expired              (HTTP thread on TIMEOUT; the main thread then skips it)
_jobs_lock = threading.Lock()
_current = {"job": None}                 # the request that holds _import_lock
_uploads: "queue.Queue[dict]" = queue.Queue()  # finished viewport uploads, reported by _tick
_snapshot_lock = threading.Lock()
_snapshot = {
    "status": "ok", "app": "blender", "addon": "studio_bridge", "addonVersion": ADDON_VERSION,
    "apiVersion": API_VERSION, "blenderVersion": BLENDER_VERSION, "port": PORT, "busy": False, "file": "", "objectCount": 0,
}


# --------------------------------------------------------------------------- HTTP (worker threads, no bpy)

class _Handler(BaseHTTPRequestHandler):
    server_version = "StudioBridge/" + ADDON_VERSION
    protocol_version = "HTTP/1.1"
    timeout = SOCKET_TIMEOUT_S  # StreamRequestHandler applies it to the connection socket
    close_connection = True     # one request per connection (no idle keep-alive threads)

    def log_message(self, fmt, *args):  # keep Blender's console quiet
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")  # also sets self.close_connection
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _fail(self, status, code, message, details=None):
        err = {"code": code, "message": message}
        if details is not None:
            err["details"] = details
        self._send(status, {"ok": False, "error": err})

    def _forbidden(self):
        if self.headers.get("Origin") is not None:
            self._fail(403, "FORBIDDEN_ORIGIN", "requests with an Origin header are not accepted")
            return True
        return False

    def do_GET(self):
        if self._forbidden():
            return
        if self.path.split("?", 1)[0] != "/health":
            return self._fail(404, "NOT_FOUND", "no such route")
        with _snapshot_lock:
            snap = dict(_snapshot)
        snap["busy"] = _import_lock.locked()
        self._send(200, snap)

    def do_POST(self):
        if self._forbidden():
            return
        if self.path.split("?", 1)[0] != "/import":
            return self._fail(404, "NOT_FOUND", "no such route")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._fail(400, "BAD_REQUEST", "invalid Content-Length")
        if n < 0:
            return self._fail(400, "BAD_REQUEST", "invalid Content-Length")
        if n > MAX_BODY:  # the connection closes after the reply, so the unread body is dropped
            return self._fail(413, "PAYLOAD_TOO_LARGE", "request body exceeds %d bytes" % MAX_BODY)
        try:
            raw = self.rfile.read(n) if n > 0 else b""
            req = json.loads(raw.decode("utf-8")) if raw else None
        except (ValueError, UnicodeDecodeError) as e:
            return self._fail(400, "BAD_REQUEST", "invalid JSON: %s" % e)
        if not isinstance(req, dict):
            return self._fail(400, "BAD_REQUEST", "body must be a JSON object")
        path = req.get("path")
        if not isinstance(path, str) or not path:
            return self._fail(400, "BAD_REQUEST", "path is required")
        if not os.path.isabs(path):
            return self._fail(400, "BAD_REQUEST", "path must be absolute")
        name = req.get("name")
        if name is not None and not isinstance(name, str):
            return self._fail(400, "BAD_REQUEST", "name must be a string")
        for key in ("autoGround", "smoothShade"):
            if key in req and req[key] is not None and not isinstance(req[key], bool):
                return self._fail(400, "BAD_REQUEST", "%s must be a boolean" % key)
        if not os.path.isfile(path):
            return self._fail(404, "FILE_NOT_FOUND", "file not found: %s" % path)
        if os.path.splitext(path)[1].lower() not in SUPPORTED:
            return self._fail(415, "UNSUPPORTED_FORMAT", "supported: %s" % ", ".join(SUPPORTED))
        if not _import_lock.acquire(blocking=False):
            with _jobs_lock:
                cur = _current["job"]
                state = cur["state"] if cur is not None else "queued"
            if state == "running":
                return self._fail(409, "BUSY", "an import is already running on Blender's main thread",
                                  {"state": "running"})
            return self._fail(409, "BUSY", "another import is queued for Blender's main thread",
                              {"state": "queued"})
        job = {
            "path": path,
            "name": name or None,
            "autoGround": req.get("autoGround", True) is not False,
            "smoothShade": req.get("smoothShade", True) is not False,
            "event": threading.Event(),
            "result": None,
            "state": "queued",
        }
        with _jobs_lock:
            _current["job"] = job
        _queue.put(job)
        if not job["event"].wait(IMPORT_TIMEOUT_S):
            with _jobs_lock:
                state = job["state"]
                if state == "queued":
                    # never started: expire it so the main-thread timer skips it instead of
                    # importing late (and duplicating objects on a client retry)
                    job["state"] = "expired"
                    if _current["job"] is job:
                        _current["job"] = None
                    try:
                        _import_lock.release()
                    except RuntimeError:
                        pass
            if state == "queued":
                return self._fail(504, "TIMEOUT", "Blender's main thread did not start the import within "
                                  "60 s; the request was discarded", {"state": "expired"})
            if state == "running":
                return self._fail(504, "TIMEOUT", "the import is still running on Blender's main thread "
                                  "after 60 s; its objects will appear when it finishes", {"state": "running"})
            # state == "done": finished right at the deadline - fall through and report it
        status, payload = job["result"]
        self._send(status, payload)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def _start_server():
    if _state["server"] is not None:
        return True
    try:
        srv = _Server((HOST, PORT), _Handler)
    except OSError as e:
        _state["error"] = "Port %d unavailable: %s" % (PORT, e.strerror or e)
        _state["next_retry"] = time.monotonic() + RETRY_S
        return False
    th = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.25},
                          name="studio-bridge-http", daemon=True)
    th.start()
    _state.update(server=srv, thread=th, error="")
    return True


def _stop_server():
    srv = _state.get("server")
    if srv is not None:
        try:
            srv.shutdown()
            srv.server_close()
        except Exception:
            pass
    _state.update(server=None, thread=None)


# --------------------------------------------------------------------------- main thread

def _refresh_snapshot():
    snap = {
        "file": bpy.data.filepath or "",
        "objectCount": len(bpy.data.objects),
    }
    with _snapshot_lock:
        _snapshot.update(snap)


def _studio_collection():
    scene = bpy.context.scene
    coll = bpy.data.collections.get(COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(COLLECTION)
    if coll.name not in scene.collection.children:
        try:
            scene.collection.children.link(coll)
        except RuntimeError:
            pass
    return coll


def _run_importer(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    else:
        raise ValueError("unsupported extension " + ext)


def _world_bounds(objs):
    from mathutils import Vector
    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    found = False
    deps = bpy.context.evaluated_depsgraph_get()
    for ob in objs:
        if ob.type not in ("MESH", "CURVE", "SURFACE", "META", "FONT", "POINTCLOUD", "VOLUME"):
            continue
        ev = ob.evaluated_get(deps)
        for c in ev.bound_box:
            w = ob.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
            found = True
    if not found:
        return None
    return lo, hi


def _mesh_counts(objs):
    verts = tris = 0
    for ob in objs:
        if ob.type == "MESH" and ob.data is not None:
            me = ob.data
            verts += len(me.vertices)
            tris += len(me.loops) - 2 * len(me.polygons)  # sum(n - 2) per n-gon == len(loop_triangles)
    return verts, tris


def _evaluated_mesh_counts(objs, depsgraph):
    """Vertex / triangle counts with modifiers applied (what ``export_apply=True`` writes)."""
    verts = tris = 0
    for ob in objs:
        if ob.type != "MESH":
            continue
        ev = ob.evaluated_get(depsgraph)
        try:
            me = ev.to_mesh()
            if me is None:
                continue
            verts += len(me.vertices)
            tris += len(me.loops) - 2 * len(me.polygons)
            me = None
        finally:
            ev.to_mesh_clear()
    return verts, tris


def _frame_selected():
    wm = bpy.context.window_manager
    for window in wm.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region is None:
                    continue
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.view3d.view_selected()
                return


def do_import(path, name=None, auto_ground=True, smooth_shade=True, push_undo=True):
    """Import ``path`` into the ``Studio`` collection. Main thread only. Returns the result dict."""
    t0 = time.perf_counter()
    before = set(bpy.data.objects)
    _run_importer(path)
    new = [ob for ob in bpy.data.objects if ob not in before]
    if not new:
        raise RuntimeError("the importer created no objects")

    coll = _studio_collection()
    for ob in new:
        for c in list(ob.users_collection):
            if c is not coll:
                c.objects.unlink(ob)
        if ob.name not in coll.objects:
            coll.objects.link(ob)

    roots = [ob for ob in new if ob.parent is None or ob.parent not in new]
    root = roots[0]
    root.name = name or os.path.splitext(os.path.basename(path))[0]
    bpy.context.view_layer.update()

    if smooth_shade:
        for ob in new:
            if ob.type == "MESH" and ob.data is not None:
                try:
                    ob.data.shade_smooth()
                except AttributeError:
                    for p in ob.data.polygons:
                        p.use_smooth = True

    # translation (auto-ground) and smooth shading leave the extent unchanged: measure once
    b = _world_bounds(new)
    if auto_ground:
        if b is not None:
            lo, hi = b
            dx, dy, dz = -(lo.x + hi.x) / 2.0, -(lo.y + hi.y) / 2.0, -lo.z
            for ob in roots:
                ob.location.x += dx
                ob.location.y += dy
                ob.location.z += dz
            bpy.context.view_layer.update()

    vl = bpy.context.view_layer
    for ob in vl.objects:
        if ob.select_get():
            ob.select_set(False)
    for ob in new:
        try:
            ob.select_set(True)
        except RuntimeError:
            pass
    vl.objects.active = root
    try:
        _frame_selected()
    except Exception:
        pass

    dims = [0.0, 0.0, 0.0] if b is None else [round(b[1][i] - b[0][i], 6) for i in range(3)]
    verts, tris = _mesh_counts(new)
    if push_undo and bpy.context.window is not None:
        try:
            bpy.ops.ed.undo_push(message="Studio import")
        except Exception:
            pass
    return {"ok": True, "name": root.name, "objects": [ob.name for ob in new], "collection": coll.name,
            "vertices": verts, "triangles": tris, "dimensions": dims,
            "elapsedMs": int((time.perf_counter() - t0) * 1000)}


def _finish_job(job, result):
    with _jobs_lock:
        job["result"] = result
        job["state"] = "done"
        if _current["job"] is job:
            _current["job"] = None
        try:
            _import_lock.release()
        except RuntimeError:
            pass
    job["event"].set()


def _process(job):
    """Main thread. Returns False when the request had expired and was skipped."""
    with _jobs_lock:
        if job["state"] != "queued":
            return False  # TIMEOUT-abandoned (lock already released by the HTTP thread)
        job["state"] = "running"
    result = None
    try:
        result = (200, do_import(job["path"], job["name"], job["autoGround"], job["smoothShade"]))
    except Exception as e:  # importer raised
        result = (500, {"ok": False, "error": {"code": "IMPORT_FAILED", "message": str(e) or type(e).__name__}})
    finally:
        if result is None:
            result = (500, {"ok": False, "error": {"code": "IMPORT_FAILED", "message": "import aborted"}})
        _finish_job(job, result)
    return True


def _report_uploads():
    """Main thread: report finished background viewport uploads."""
    while True:
        try:
            up = _uploads.get_nowait()
        except queue.Empty:
            return
        _state["uploads_running"] = max(0, _state.get("uploads_running", 0) - 1)
        path = up.get("tmp")
        if path and os.path.exists(path):  # the worker could not remove it
            try:
                os.remove(path)
            except OSError:
                pass
        if up.get("ok"):
            res = up["result"]
            try:
                bpy.context.window_manager.clipboard = res.get("path", "")
            except Exception:
                pass
            msg = "Uploaded to Studio (%dx%d); path copied" % (res.get("width", 0), res.get("height", 0))
            icon = "INFO"
        else:
            msg = "Upload failed: %s" % up.get("error", "unknown error")
            icon = "ERROR"
        _state["upload_status"] = msg
        print("studio_bridge:", msg)
        _notify(msg, icon)


def _notify(msg, icon):
    """Best-effort status popup + panel redraw (no-op in --background)."""
    try:
        wm = bpy.context.window_manager
        if wm is None or not wm.windows:
            return

        def draw(menu, _context):
            menu.layout.label(text=msg)
        with bpy.context.temp_override(window=wm.windows[0]):
            wm.popup_menu(draw, title="Studio", icon=icon)
    except Exception:
        pass
    try:
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()
    except Exception:
        pass


def _tick():
    """Persistent timer: drain the import queue, report uploads, refresh /health, retry the port."""
    try:
        now = time.monotonic()
        if _state["server"] is None and now >= _state["next_retry"]:
            _start_server()
        while True:
            try:
                job = _queue.get_nowait()
            except queue.Empty:
                break
            if _process(job):
                _refresh_snapshot()
        _report_uploads()
        if now - _state["last_snapshot"] >= 1.0:
            _refresh_snapshot()
            _state["last_snapshot"] = now
    except Exception as e:  # never let the timer die
        print("studio_bridge: timer error:", e)
    return TIMER_INTERVAL_S


# --------------------------------------------------------------------------- Studio engine helpers (main thread)

def _engine_get(path, timeout=3.0):
    with urllib.request.urlopen(ENGINE + path, timeout=timeout) as r:
        return json.load(r)


def _outputs_dir():
    try:
        d = _engine_get("/api/health", timeout=1.0).get("outputsDir")
        if d:
            return d
    except Exception:
        pass
    return DEFAULT_OUTPUTS


def _iso_utc(ts):
    d = datetime.fromtimestamp(ts, tz=timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (d.microsecond // 1000)


def _atomic_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _multipart(field, filename, data, ctype):
    boundary = "----studio" + secrets.token_hex(12)
    head = ('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: %s\r\n\r\n'
            % (boundary, field, filename, ctype)).encode("utf-8")
    body = head + data + ("\r\n--%s--\r\n" % boundary).encode("utf-8")
    return body, "multipart/form-data; boundary=" + boundary


def _view3d_override(context):
    for window in context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region is not None:
                    return {"window": window, "area": area, "region": region}
    return None


def _viewport_png(context, path):
    ov = _view3d_override(context)
    if ov is None:
        raise RuntimeError("no 3D viewport to render")
    with context.temp_override(**ov):
        bpy.ops.render.opengl(write_still=False, view_context=True)
    img = bpy.data.images.get("Render Result")
    if img is None:
        raise RuntimeError("viewport render produced no image")
    _save_render_png(context.scene, img, path)


def _save_render_png(scene, img, path):
    """``save_render`` uses the scene's output format: force PNG, restore the user's settings."""
    settings = scene.render.image_settings
    saved = []
    for attr, value in (("media_type", "IMAGE"), ("file_format", "PNG")):  # media_type: Blender 5.x
        if hasattr(settings, attr):
            saved.append((attr, getattr(settings, attr)))
            setattr(settings, attr, value)
    try:
        img.save_render(filepath=path)
    finally:
        for attr, value in reversed(saved):
            try:
                setattr(settings, attr, value)
            except (TypeError, ValueError, AttributeError):
                pass


def _upload_worker(path):
    """Background thread (no bpy): multipart-upload ``path`` to the engine, then delete it.
    The outcome is handed to the main thread through ``_uploads`` (drained by ``_tick``)."""
    out = {"tmp": path, "ok": False}
    try:
        with open(path, "rb") as f:
            body, ctype = _multipart("file", os.path.basename(path), f.read(), "image/png")
        req = urllib.request.Request(ENGINE + "/api/upload", data=body, method="POST",
                                     headers={"Content-Type": ctype})
        with urllib.request.urlopen(req, timeout=30) as r:
            out["result"] = json.load(r)
        out["ok"] = True
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", {}).get("message") or str(e)
        except Exception:
            detail = str(e)
        out["error"] = detail
    except Exception as e:
        out["error"] = str(e) or type(e).__name__
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
        _uploads.put(out)  # uploads_running is only touched on the main thread (_report_uploads)


# --------------------------------------------------------------------------- operators and panel

class STUDIO_OT_sync_latest(bpy.types.Operator):
    """Import the newest 3D asset from Studio"""
    bl_idname = "studio.sync_latest"
    bl_label = "Sync latest"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            items = _engine_get("/api/outputs?kind=3d&limit=1").get("items") or []
        except Exception as e:
            self.report({"ERROR"}, "Studio engine unreachable: %s" % e)
            return {"CANCELLED"}
        if not items:
            self.report({"WARNING"}, "Studio has no 3D assets yet")
            return {"CANCELLED"}
        try:
            res = do_import(items[0]["path"], push_undo=False)
        except Exception as e:
            self.report({"ERROR"}, "Import failed: %s" % e)
            return {"CANCELLED"}
        self.report({"INFO"}, "Imported %s (%d triangles)" % (res["name"], res["triangles"]))
        return {"FINISHED"}


class STUDIO_OT_send_selected(bpy.types.Operator):
    """Export the selected meshes as a GLB asset into Studio's library"""
    bl_idname = "studio.send_selected"
    bl_label = "Send Selected to Studio"

    @classmethod
    def poll(cls, context):
        return any(o.type == "MESH" for o in context.selected_objects)

    def execute(self, context):
        ts = time.time()
        oid = secrets.token_hex(8)
        lt = datetime.fromtimestamp(ts)
        stem = "%s_%s_%s" % (lt.strftime("%Y%m%d"), lt.strftime("%H%M%S"), oid[:8])
        asset = os.path.join(_outputs_dir(), "3d", stem)
        os.makedirs(asset, exist_ok=True)
        glb = os.path.join(asset, stem + ".glb")
        tmp = os.path.join(asset, stem + ".tmp.glb")
        sel = [o for o in context.selected_objects if o.type == "MESH"]
        try:
            bpy.ops.export_scene.gltf(filepath=tmp, export_format="GLB", use_selection=True, export_yup=True,
                                      export_apply=True)
            os.replace(tmp, glb)
        except Exception as e:
            # leave nothing behind: no partial .tmp.glb, no empty asset folder in Studio's library
            try:
                os.remove(tmp)
            except OSError:
                pass
            try:
                os.rmdir(asset)  # only succeeds when empty
            except OSError:
                pass
            self.report({"ERROR"}, "GLB export failed: %s" % e)
            return {"CANCELLED"}
        preview = None
        png = os.path.join(asset, "preview.png")
        webp = os.path.join(asset, "preview.webp")
        img = None
        try:
            _viewport_png(context, png)
            img = bpy.data.images.load(png)
            img.scale(768, max(1, int(768 * img.size[1] / max(1, img.size[0]))))
            img.file_format = "WEBP"
            img.filepath_raw = webp
            img.save()
            preview = "preview.webp"
        except Exception:
            preview = None
        finally:
            if img is not None:
                try:
                    bpy.data.images.remove(img)
                except Exception:
                    pass
                img = None
            for leftover in (png,) if preview else (png, webp):
                try:
                    os.remove(leftover)
                except OSError:
                    pass
        b = _world_bounds(sel)
        # counts of the evaluated (modifier-applied) meshes, matching export_apply=True
        verts, tris = _evaluated_mesh_counts(sel, context.evaluated_depsgraph_get())
        if b is not None:  # Blender Z-up -> glTF Y-up: (x, y, z) -> (x, z, -y)
            lo, hi = b
            mn = [lo.x, lo.z, -hi.y]
            mx = [hi.x, hi.z, -lo.y]
        else:
            mn = mx = [0.0, 0.0, 0.0]
        r6 = lambda v: [round(float(x), 6) for x in v]  # noqa: E731
        stage_ids = ("source", "cutout", "depth", "structure", "shape", "texture", "mesh")
        stages = [{"id": s, "label": s.capitalize(), "status": "skipped", "file": None, "elapsedMs": 0}
                  for s in stage_ids]
        stages[-1].update(status="done")
        has_tex = any(n.type == "TEX_IMAGE" for o in sel for slot in o.material_slots
                      if slot.material and slot.material.use_nodes for n in slot.material.node_tree.nodes)
        sidecar = {
            "schemaVersion": 1, "id": oid, "jobId": "job_" + secrets.token_hex(8), "kind": "3d", "mode": "i23d",
            "createdAt": _iso_utc(ts), "elapsedMs": int((time.time() - ts) * 1000), "file": stem + ".glb",
            "mime": "model/gltf-binary", "bytes": os.path.getsize(glb), "width": None, "height": None,
            "hasAlpha": False,
            "model": {"family": "trellis2", "label": "Blender %s" % BLENDER_VERSION,
                      "files": []},
            "params": {"prompt": "", "negativePrompt": "", "enhanced": False, "enhancedPrompt": None, "seed": 0,
                       "steps": None, "cfg": None, "sampler": None, "scheduler": None, "denoise": None,
                       "resolution": None, "batchIndex": 0, "batchSize": 1},
            "inputs": {"sourceId": None, "imagePath": bpy.data.filepath or None, "referencePaths": []},
            "mesh": {"engine": "trellis2", "format": "glb", "vertices": verts, "triangles": tris,
                     "bounds": {"min": r6(mn), "max": r6(mx)}, "size": r6([mx[i] - mn[i] for i in range(3)]),
                     "upAxis": "Y", "unit": "m", "targetFaces": tris, "remeshResolution": 512,
                     "textureSize": 2048, "removeBackground": False, "hasTexture": bool(has_tex)},
            "stages": stages, "preview": preview, "favorite": False,
            "app": {"name": "Studio", "engineVersion": "1.0.0", "apiVersion": 1},
            "source": "blender",
        }
        _atomic_json(os.path.join(asset, stem + ".studio.json"), sidecar)
        self.report({"INFO"}, "Sent to Studio: %s" % glb)
        return {"FINISHED"}


class STUDIO_OT_render_viewport(bpy.types.Operator):
    """Render the 3D viewport and upload it to Studio as a reference image"""
    bl_idname = "studio.render_viewport"
    bl_label = "Render Viewport \u2192 Studio"

    def execute(self, context):
        path = os.path.join(tempfile.gettempdir(), "studio_viewport_%s.png" % secrets.token_hex(4))
        try:
            _viewport_png(context, path)  # bpy: main thread only
        except Exception as e:
            try:
                os.remove(path)
            except OSError:
                pass
            self.report({"ERROR"}, "Viewport render failed: %s" % e)
            return {"CANCELLED"}
        # network I/O on a worker thread; _tick reports the result and copies the path
        _state["uploads_running"] = _state.get("uploads_running", 0) + 1
        _state["upload_status"] = "Uploading viewport render…"
        try:
            threading.Thread(target=_upload_worker, args=(path,), name="studio-bridge-upload",
                             daemon=True).start()
        except Exception as e:
            _state["uploads_running"] = max(0, _state["uploads_running"] - 1)
            try:
                os.remove(path)
            except OSError:
                pass
            self.report({"ERROR"}, "Upload failed: %s" % e)
            return {"CANCELLED"}
        self.report({"INFO"}, "Uploading viewport render to Studio…")
        return {"FINISHED"}


class STUDIO_PT_panel(bpy.types.Panel):
    bl_label = "Studio"
    bl_idname = "STUDIO_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Studio"

    def draw(self, context):
        col = self.layout.column(align=True)
        if _state["server"] is not None:
            col.label(text="Listening on %s:%d" % (HOST, PORT), icon="CHECKMARK")
        else:
            col.label(text=_state["error"] or "Not listening", icon="ERROR")
            col.label(text="Retrying every %d s" % RETRY_S)
        if _import_lock.locked():
            col.label(text="Importing\u2026", icon="TIME")
        if _state.get("uploads_running"):
            col.label(text="Uploading\u2026", icon="TIME")
        elif _state.get("upload_status"):
            col.label(text=_state["upload_status"])
        self.layout.separator()
        col = self.layout.column(align=True)
        col.operator(STUDIO_OT_sync_latest.bl_idname, icon="IMPORT")
        col.operator(STUDIO_OT_send_selected.bl_idname, icon="EXPORT")
        col.operator(STUDIO_OT_render_viewport.bl_idname, icon="RENDER_STILL")


_CLASSES = (STUDIO_OT_sync_latest, STUDIO_OT_send_selected, STUDIO_OT_render_viewport, STUDIO_PT_panel)


def register():
    for c in _CLASSES:
        bpy.utils.register_class(c)
    _state["next_retry"] = 0.0
    _start_server()
    try:
        _refresh_snapshot()
    except Exception:
        pass  # bpy.data may be restricted during registration
    if not bpy.app.timers.is_registered(_tick):
        bpy.app.timers.register(_tick, first_interval=TIMER_INTERVAL_S, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    _stop_server()
    # fail anything still waiting so no HTTP thread hangs
    while True:
        try:
            job = _queue.get_nowait()
        except queue.Empty:
            break
        with _jobs_lock:
            pending = job["state"] == "queued"
            if pending:
                job["state"] = "running"  # claim it so it is finished exactly once
        if pending:
            _finish_job(job, (500, {"ok": False, "error": {"code": "IMPORT_FAILED", "message": "add-on disabled"}}))
    for c in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(c)
        except RuntimeError:
            pass


if __name__ == "__main__":
    register()
