"""Process bootstrap: environment, sys.path hygiene, server/app stubs and comfy import.

Everything here must run before ``torch`` or any ``comfy`` module is imported.
"""
from __future__ import annotations

import logging
import os
import sys
import types

log = logging.getLogger("studio.bootstrap")

ROCM_ENV = {
    "TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL": "1",
    "OCL_SET_SVM_SIZE": "4194304",
    "MIMALLOC_PURGE_DELAY": "0",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "DO_NOT_TRACK": "1",
}

# Modules of the ComfyUI *application* that must never be loaded by the engine.
FORBIDDEN_MODULES = ("main", "execution", "comfy_api_nodes", "api_server", "middleware", "comfyui_manager")


def set_environment() -> None:
    for k, v in ROCM_ENV.items():
        os.environ[k] = v


def _norm(p: str) -> str:
    try:
        return os.path.normcase(os.path.realpath(p))
    except OSError:
        return os.path.normcase(os.path.abspath(p))


def configure_sys_path(engine_dir: str, comfy_dir: str) -> None:
    """Put the engine and ``comfy_dir`` first and drop any *other* directory that
    provides a ``comfy`` package (the embedded interpreter's ``._pth`` lists
    ``..\\ComfyUI`` by default), so the vendored copy is the only one importable."""
    keep_first = [_norm(engine_dir), _norm(comfy_dir)]
    cleaned = []
    for p in sys.path:
        if not p:
            continue
        np_ = _norm(p)
        if np_ in keep_first:
            continue
        if os.path.isdir(os.path.join(p, "comfy")) and os.path.isfile(os.path.join(p, "folder_paths.py")):
            log.info("removing foreign comfy root from sys.path: %s", p)
            continue
        cleaned.append(p)
    sys.path[:] = [engine_dir, comfy_dir] + cleaned


class _Noop:
    """Accepts any attribute access / call and does nothing."""

    def __getattr__(self, name):
        return _Noop()

    def __call__(self, *a, **k):
        return None

    def __bool__(self):
        return False


class _StubPromptServer:
    instance: "_StubPromptServer"

    def __init__(self):
        self.client_id = None
        self.last_node_id = None
        self.last_prompt_id = None
        self.asset_manager = types.SimpleNamespace(enabled=False)
        self.node_replace_manager = _Noop()
        self.routes = _Noop()
        self.supports = set()

    def send_progress_text(self, *a, **k):
        return None

    def send_sync(self, *a, **k):
        return None

    def send(self, *a, **k):
        return None

    def __getattr__(self, name):
        return _Noop()


def install_stubs() -> None:
    """Provide the two application modules the headless libraries reference:

    * ``server.PromptServer`` - only ``send_progress_text`` (guarded by a node
      unique_id, which is always None here), ``asset_manager.enabled`` and
      ``node_replace_manager`` are touched.
    * ``app.governance`` - only used by ``nodes.load_custom_node``, which the
      engine never calls.
    """
    if "server" not in sys.modules:
        server_mod = types.ModuleType("server")
        server_mod.__studio_stub__ = True
        server_mod.PromptServer = _StubPromptServer
        _StubPromptServer.instance = _StubPromptServer()
        server_mod.BinaryEventTypes = types.SimpleNamespace(PREVIEW_IMAGE=1, UNENCODED_PREVIEW_IMAGE=2, TEXT=3,
                                                             PREVIEW_IMAGE_WITH_METADATA=4)
        sys.modules["server"] = server_mod
    if "app" not in sys.modules:
        app_mod = types.ModuleType("app")
        app_mod.__path__ = []  # namespace-ish so ``from app import x`` resolves to attributes only
        app_mod.__studio_stub__ = True
        gov = types.ModuleType("app.governance")

        def _refuse(*a, **k):
            raise RuntimeError("custom nodes are disabled in the Studio engine")

        gov.pack_module_spec = _refuse
        gov.pack_refusal = lambda *a, **k: "custom nodes are disabled in the Studio engine"
        app_mod.governance = gov
        sys.modules["app"] = app_mod
        sys.modules["app.governance"] = gov


def import_comfy(models_dir: str, outputs_dir: str, temp_dir: str):
    """Import the headless comfy stack and point ``folder_paths`` at ``models_dir``.

    Returns the ``folder_paths`` module.
    """
    import comfy.options  # noqa: F401  (args_parsing stays False -> defaults)
    from comfy.cli_args import args, LatentPreviewMethod

    args.models_directory = models_dir
    args.output_directory = outputs_dir
    args.temp_directory = temp_dir
    args.preview_method = LatentPreviewMethod.TAESD
    args.preview_size = 512
    args.disable_all_custom_nodes = True
    args.disable_api_nodes = True
    args.enable_manager = False

    # Same start-up as run_amd_gpu.bat -> main.py: aimdo control init when the
    # default dynamic-vram policy asks for it (it is not *enabled* on ROCm < 7.14).
    try:
        from comfy.cli_args import enables_dynamic_vram
        if enables_dynamic_vram():
            import comfy_aimdo.control
            headroom = None if args.reserve_vram is None else int(args.reserve_vram * 1024 ** 3)
            comfy_aimdo.control.init(simple_vram_headroom=headroom, nvml_pressure=not args.disable_nvml_pressure)
    except Exception as e:  # pragma: no cover - optional dependency
        log.info("comfy_aimdo not initialised: %s", e)

    import folder_paths

    folder_paths.set_output_directory(outputs_dir)
    folder_paths.set_temp_directory(temp_dir)
    folder_paths.set_input_directory(temp_dir)

    # Hard guarantee: every model folder points strictly inside models_dir.
    md = _norm(models_dir)
    for name, (paths, exts) in list(folder_paths.folder_names_and_paths.items()):
        if name in ("custom_nodes", "datasets", "configs"):
            folder_paths.folder_names_and_paths[name] = ([], exts) if name != "configs" else (paths, exts)
            continue
        bad = [p for p in paths if not _norm(p).startswith(md)]
        if bad:
            raise RuntimeError(f"folder_paths[{name}] escapes models dir: {bad}")
    folder_paths.models_dir = models_dir

    import comfy.model_management  # noqa: F401  (initialises the torch device)
    import comfy.utils
    comfy.utils.PROGRESS_BAR_ENABLED = False

    import nodes  # noqa: F401
    import latent_preview  # noqa: F401
    import node_helpers  # noqa: F401
    import comfy_extras.nodes_qwen  # noqa: F401
    import comfy_extras.nodes_bg_removal  # noqa: F401
    import comfy_extras.nodes_moge  # noqa: F401
    import comfy_extras.nodes_trellis2  # noqa: F401
    import comfy_extras.nodes_mesh_postprocess  # noqa: F401
    import comfy_extras.nodes_model_advanced  # noqa: F401
    import comfy_extras.nodes_custom_sampler  # noqa: F401
    import comfy_extras.nodes_images  # noqa: F401
    import comfy_extras.nodes_save_3d  # noqa: F401

    for m in FORBIDDEN_MODULES:
        if m in sys.modules:
            raise RuntimeError(f"forbidden module imported: {m}")
    return folder_paths


def comfy_dir_valid(comfy_dir: str) -> bool:
    return all(os.path.isdir(os.path.join(comfy_dir, d)) for d in ("comfy", "comfy_extras")) and \
        all(os.path.isfile(os.path.join(comfy_dir, f)) for f in ("nodes.py", "folder_paths.py", "latent_preview.py"))
