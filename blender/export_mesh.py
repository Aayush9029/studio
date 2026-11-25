# Studio headless mesh converter (API_CONTRACT.md section 9.3).
#
#   "<blender.exe>" --background --factory-startup --python export_mesh.py -- \
#       --input <abs .glb> --output <abs path> [--format glb|obj|stl|fbx|blend]
#       [--auto-ground] [--smooth-shade] [--scale <float>] [--no-textures]
#
# The last stdout line is "STUDIO_EXPORT {json}". The script always calls sys.exit(code):
# 0 ok, 2 BAD_ARGS, 3 INPUT_NOT_FOUND, 4 IMPORT_FAILED, 5 EXPORT_FAILED.

import argparse
import json
import os
import sys
import time

FORMATS = ("glb", "obj", "stl", "fbx", "blend")
_T0 = time.perf_counter()


def _flush_c_stdio():
    """Blender's own C-level prints sit in the C runtime's stdout buffer until exit;
    flush them first so the result line really is the last line."""
    try:
        import ctypes
        for lib in ("ucrtbase", "msvcrt") if os.name == "nt" else ("c",):
            try:
                crt = ctypes.CDLL(lib) if os.name == "nt" else ctypes.CDLL(None)
                crt.fflush(None)
            except OSError:
                continue
    except Exception:
        pass


def _emit(payload, code):
    sys.stdout.flush()
    _flush_c_stdio()
    print("STUDIO_EXPORT " + json.dumps(payload, separators=(",", ":")), flush=True)
    _flush_c_stdio()
    sys.exit(code)


def _norm(path):
    """Absolute, normalised path: mixed forward / back slashes collapse to one spelling."""
    return os.path.normpath(os.path.abspath(path))


def _unique_paths(paths):
    """Normalise and de-duplicate (case-insensitively on Windows), keeping first-seen order."""
    out, seen = [], set()
    for p in paths:
        if not p:
            continue
        n = _norm(p)
        k = os.path.normcase(n)
        if k in seen:
            continue
        seen.add(k)
        out.append(n)
    return out


def _fail(code_name, message, code):
    _emit({"ok": False, "error": {"code": code_name, "message": str(message)}}, code)


class _Args(argparse.ArgumentParser):
    def error(self, message):
        _fail("BAD_ARGS", message, 2)


def parse(argv):
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    p = _Args(prog="export_mesh.py", add_help=False)
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--format", choices=FORMATS)
    p.add_argument("--auto-ground", action="store_true")
    p.add_argument("--smooth-shade", action="store_true")
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--no-textures", action="store_true")
    a = p.parse_args(argv)
    if not os.path.isabs(a.input) or not os.path.isabs(a.output):
        _fail("BAD_ARGS", "--input and --output must be absolute paths", 2)
    a.input, a.output = _norm(a.input), _norm(a.output)
    if a.format is None:
        ext = os.path.splitext(a.output)[1].lower().lstrip(".")
        if ext not in FORMATS:
            _fail("BAD_ARGS", "cannot infer --format from output extension %r" % ext, 2)
        a.format = ext
    if not (a.scale > 0) or a.scale != a.scale or a.scale == float("inf"):
        _fail("BAD_ARGS", "--scale must be a positive number", 2)
    return a


def _mesh_objects(bpy):
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def _counts(objs):
    v = t = 0
    for o in objs:
        me = o.data
        v += len(me.vertices)
        t += len(me.loops) - 2 * len(me.polygons)  # sum(n - 2) per n-gon == len(loop_triangles)
    return v, t


def _bounds(bpy, objs):
    from mathutils import Vector
    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def _strip_textures(bpy, objs):
    for o in objs:
        for slot in o.material_slots:
            m = slot.material
            if m is None or not m.use_nodes:
                continue
            for n in list(m.node_tree.nodes):
                if n.type == "TEX_IMAGE":
                    m.node_tree.nodes.remove(n)
    for img in list(bpy.data.images):
        if img.users == 0:
            bpy.data.images.remove(img)


def _write_textures_next_to(bpy, out):
    """glTF textures are packed in the .blend data; write each as <name>_<image>.png beside the OBJ
    and point the image at it, so the MTL references real files."""
    import re
    folder = os.path.dirname(out)
    base = os.path.splitext(os.path.basename(out))[0]
    used = set()
    written = []
    for img in bpy.data.images:
        if img.users == 0 or img.type != "IMAGE" or img.size[0] == 0:
            continue
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", os.path.splitext(img.name)[0]) or "texture"
        name = "%s_%s.png" % (base, safe)
        i = 1
        while name in used:
            i += 1
            name = "%s_%s_%d.png" % (base, safe, i)
        used.add(name)
        path = os.path.join(folder, name)
        img.file_format = "PNG"
        try:
            img.save(filepath=path)
        except TypeError:  # older signature
            img.filepath_raw = path
            img.save()
        if not os.path.isfile(path):
            img.save_render(filepath=path)
        if os.path.isfile(path):
            written.append(_norm(path))
        if img.packed_file:
            try:
                img.unpack(method="REMOVE")
            except Exception:
                pass
        img.filepath = path
    return written


def main():
    a = parse(sys.argv)
    if not os.path.isfile(a.input):
        _fail("INPUT_NOT_FOUND", "input not found: %s" % a.input, 3)

    import bpy

    # empty scene
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    except Exception:
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o, do_unlink=True)

    try:
        ext = os.path.splitext(a.input)[1].lower()
        if ext in (".glb", ".gltf"):
            bpy.ops.import_scene.gltf(filepath=a.input)
        elif ext == ".obj":
            bpy.ops.wm.obj_import(filepath=a.input)
        elif ext == ".fbx":
            bpy.ops.import_scene.fbx(filepath=a.input)
        elif ext == ".stl":
            bpy.ops.wm.stl_import(filepath=a.input)
        elif ext == ".ply":
            bpy.ops.wm.ply_import(filepath=a.input)
        else:
            raise ValueError("unsupported input extension %s" % ext)
        objs = _mesh_objects(bpy)
        if not objs:
            raise RuntimeError("no mesh objects in input")
    except SystemExit:
        raise
    except Exception as e:
        _fail("IMPORT_FAILED", e, 4)

    try:
        roots = [o for o in bpy.context.scene.objects if o.parent is None]
        if a.scale != 1.0:
            for o in roots:
                o.scale = [s * a.scale for s in o.scale]
                o.location = [x * a.scale for x in o.location]
            bpy.context.view_layer.update()
        if a.auto_ground:
            if a.scale == 1.0:  # matrix_world is only current after a depsgraph update
                bpy.context.view_layer.update()
            lo, hi = _bounds(bpy, objs)
            d = (-(lo.x + hi.x) / 2.0, -(lo.y + hi.y) / 2.0, -lo.z)
            for o in roots:
                o.location = (o.location.x + d[0], o.location.y + d[1], o.location.z + d[2])
            bpy.context.view_layer.update()
        if a.smooth_shade:
            for o in objs:
                try:
                    o.data.shade_smooth()
                except AttributeError:
                    for p in o.data.polygons:
                        p.use_smooth = True
        if a.no_textures:
            _strip_textures(bpy, objs)
        vertices, triangles = _counts(objs)
    except Exception as e:
        _fail("EXPORT_FAILED", "preparing scene: %s" % e, 5)

    out = a.output
    os.makedirs(os.path.dirname(out), exist_ok=True)
    stem = os.path.splitext(out)[0]
    before = {os.path.normcase(f) for f in os.listdir(os.path.dirname(out))}
    copied = []
    try:
        for o in bpy.context.scene.objects:
            o.select_set(True)
        if a.format == "glb":
            bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_yup=True,
                                      export_image_format="NONE" if a.no_textures else "AUTO")
        elif a.format == "obj":
            if not a.no_textures:
                copied = _write_textures_next_to(bpy, out)
            bpy.ops.wm.obj_export(filepath=out, up_axis="Y", forward_axis="NEGATIVE_Z",
                                  export_materials=True, path_mode="RELATIVE")
        elif a.format == "stl":
            bpy.ops.wm.stl_export(filepath=out, ascii_format=False)
        elif a.format == "fbx":
            bpy.ops.export_scene.fbx(filepath=out, path_mode="COPY", embed_textures=not a.no_textures,
                                     axis_up="Y", axis_forward="-Z")
        elif a.format == "blend":
            if not a.no_textures:
                try:
                    bpy.ops.file.pack_all()
                except Exception:
                    for img in bpy.data.images:
                        if img.source == "FILE" and not img.packed_file:
                            img.pack()
            bpy.ops.wm.save_as_mainfile(filepath=out, compress=True, copy=True)
        if not os.path.isfile(out):
            raise RuntimeError("exporter wrote no file")
    except Exception as e:
        # no half-finished result: textures written for the OBJ and a partial output file
        leftovers = list(copied)
        if os.path.normcase(os.path.basename(out)) not in before:
            leftovers.append(out)
        for p in leftovers:
            try:
                os.remove(p)
            except OSError:
                pass
        _fail("EXPORT_FAILED", e, 5)

    folder = os.path.dirname(out)
    created = sorted(os.path.join(folder, f) for f in os.listdir(folder) if os.path.normcase(f) not in before)
    extra = []
    if a.format == "obj":
        mtl = stem + ".mtl"
        if os.path.isfile(mtl):
            extra.append(mtl)
    # every path normalised; no duplicates even if --output mixed "/" and "\\" or differed in case
    files = _unique_paths([out] + extra + list(copied) + created)
    _emit({"ok": True, "input": a.input, "output": out, "format": a.format, "files": files,
           "vertices": vertices, "triangles": triangles,
           "elapsedMs": int((time.perf_counter() - _T0) * 1000)}, 0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # anything unexpected still produces a result line
        _fail("EXPORT_FAILED", "%s: %s" % (type(e).__name__, e), 5)
