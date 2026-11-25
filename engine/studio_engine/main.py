"""Daemon entry: CLI (API_CONTRACT.md 2.4), logging, socket bind, event loop."""
from __future__ import annotations

import argparse
import asyncio
import errno
import logging
import logging.handlers
import os
import socket
import sys
import types

EXIT_OK, EXIT_FATAL, EXIT_ARGS, EXIT_PORT, EXIT_DIRS = 0, 1, 2, 3, 4

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STUDIO_ROOT = os.path.dirname(ENGINE_DIR)
COMFY_PORTABLE = r"C:\Users\winbloat\ComfyUI_windows_portable\ComfyUI"


def _default_models_dir() -> str:
    studio_models = os.path.join(STUDIO_ROOT, "models")
    if os.path.isdir(studio_models):
        return studio_models
    return os.path.join(COMFY_PORTABLE, "models")


class _ArgParser(argparse.ArgumentParser):
    def error(self, message):  # exit code 2 with a one-line reason on stderr
        sys.stderr.write(f"studio-engine: bad arguments: {message}\n")
        raise SystemExit(EXIT_ARGS)


def parse_args(argv):
    p = _ArgParser(prog="run_engine.py", description="Studio headless engine")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=48210)
    p.add_argument("--comfy-dir", default=os.path.join(ENGINE_DIR, "vendor"))
    p.add_argument("--models-dir", default=None)
    p.add_argument("--outputs-dir", default=os.path.join(STUDIO_ROOT, "outputs"))
    p.add_argument("--state-dir", default=os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "Studio"))
    p.add_argument("--log-file", default=os.path.join(STUDIO_ROOT, "logs", "engine.log"))
    p.add_argument("--inkling-url", default="http://127.0.0.1:8080/v1")
    p.add_argument("--inkling-model", default="inkling-2-mini-uncensored")
    p.add_argument("--parent-pid", type=int, default=None)
    p.add_argument("--allow-origin", action="append", default=[])
    a = p.parse_args(argv)
    if a.host not in ("127.0.0.1", "localhost"):
        p.error("--host must be 127.0.0.1 (the engine binds loopback only)")
    a.host = "127.0.0.1"
    if not (1 <= a.port <= 65535):
        p.error("--port out of range")
    if a.models_dir is None:
        a.models_dir = _default_models_dir()
    for k in ("comfy_dir", "models_dir", "outputs_dir", "state_dir", "log_file"):
        setattr(a, k, os.path.abspath(getattr(a, k)))
    return a


class _StreamToLog:
    """Routes stray prints (comfy, tqdm, warnings) into the log file."""

    def __init__(self, logger, level):
        self.logger, self.level, self._buf = logger, level, ""

    def write(self, s):
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.strip():
                self.logger.log(self.level, line.rstrip())
        return len(s)

    def flush(self):
        pass

    def isatty(self):
        return False


def setup_logging(log_file: str) -> None:
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    h = logging.handlers.RotatingFileHandler(log_file, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s.%(msecs)03d %(levelname)-7s %(name)s: %(message)s",
                                     "%Y-%m-%d %H:%M:%S"))
    root = logging.getLogger()
    root.handlers[:] = [h]
    root.setLevel(logging.INFO)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)


def bind_socket(host: str, port: int) -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    s.bind((host, port))
    s.listen(128)
    s.setblocking(False)
    return s


def fatal(msg: str, code: int) -> int:
    sys.__stderr__.write(f"studio-engine: {msg}\n")
    sys.__stderr__.flush()
    if logging.getLogger().handlers:  # before setup_logging the last-resort handler would echo to stderr
        logging.getLogger("studio").critical(msg)
    return code


def main(argv) -> int:
    from . import bootstrap
    a = parse_args(argv)
    from .bootstrap import comfy_dir_valid
    if not comfy_dir_valid(a.comfy_dir):
        return fatal(f"--comfy-dir is not a comfy library root: {a.comfy_dir}", EXIT_DIRS)
    if not os.path.isdir(a.models_dir):
        return fatal(f"--models-dir does not exist: {a.models_dir}", EXIT_DIRS)
    try:
        os.makedirs(a.outputs_dir, exist_ok=True)
        os.makedirs(a.state_dir, exist_ok=True)
        setup_logging(a.log_file)
    except OSError as e:
        return fatal(f"cannot create directories: {e}", EXIT_FATAL)
    log = logging.getLogger("studio")
    log.info("starting engine pid=%d args=%s", os.getpid(), vars(a))

    try:
        sock = bind_socket(a.host, a.port)
    except OSError as e:
        if e.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1)) or getattr(e, "winerror", 0) in (10048, 10013):
            return fatal(f"port {a.port} is already in use", EXIT_PORT)
        return fatal(f"cannot bind {a.host}:{a.port}: {e}", EXIT_FATAL)

    bootstrap.configure_sys_path(ENGINE_DIR, a.comfy_dir)
    bootstrap.install_stubs()
    sys.stdout = _StreamToLog(logging.getLogger("stdout"), logging.INFO)
    sys.stderr = _StreamToLog(logging.getLogger("stderr"), logging.WARNING)

    from aiohttp import web, ClientSession
    from .engine import Engine
    from .http_api import build_app

    cfg = types.SimpleNamespace(host=a.host, port=a.port, comfy_dir=a.comfy_dir, models_dir=a.models_dir,
                                outputs_dir=a.outputs_dir, state_dir=a.state_dir, inkling_url=a.inkling_url,
                                inkling_model=a.inkling_model)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    engine = Engine(cfg, loop)
    app = build_app(engine, a.allow_origin)
    runner = web.AppRunner(app, access_log=None, handle_signals=False, shutdown_timeout=1.0)

    async def start():
        engine.http = ClientSession()
        await runner.setup()
        await web.SockSite(runner, sock).start()
        log.info("listening on http://%s:%d", a.host, a.port)
        fut = engine.gpu.submit(engine.import_comfy)

        def done(f):
            exc = f.exception()
            if exc is not None:
                import traceback
                engine.comfy_error = f"{type(exc).__name__}: {exc}"
                log.critical("comfy import failed:\n%s", "".join(traceback.format_exception(exc)))
                loop.call_soon_threadsafe(lambda: asyncio.ensure_future(engine.shutdown(EXIT_FATAL, "comfy failed")))
            else:
                loop.call_soon_threadsafe(_ready)
        fut.add_done_callback(done)
        for coro in (engine.telemetry_loop(), engine.auto_unload_loop(), engine.inkling_loop()):
            asyncio.ensure_future(coro)
        if a.parent_pid:
            engine.start_parent_watchdog(a.parent_pid)

    def _ready():
        engine.status = "ok" if engine.status == "starting" else engine.status
        engine.ready.set()
        engine.emit_models_status()

    async def run():
        await start()
        await engine.stopped.wait()
        # engine.shutdown() already finalized the active job and drained the hub; this is an
        # idempotent safety net so no queued terminal event is cut off by runner.cleanup()
        try:
            await asyncio.wait_for(engine.hub.close_all(1001), timeout=2.5)
        except Exception:
            pass
        try:
            await asyncio.wait_for(runner.cleanup(), timeout=0.8)
        except Exception:
            pass
        try:
            await engine.http.close()
        except Exception:
            pass

    try:
        loop.run_until_complete(run())
    except Exception as e:  # noqa: BLE001
        log.exception("fatal error")
        code = fatal(f"fatal: {e}", EXIT_FATAL)
        logging.shutdown()
        os._exit(code)
    code = engine.exit_code
    if engine.comfy_error and code == 0:
        code = EXIT_FATAL
    if code == EXIT_FATAL and engine.comfy_error:
        sys.__stderr__.write(f"studio-engine: comfy failed to load: {engine.comfy_error}\n")
    log.info("exit %d", code)
    logging.shutdown()
    # GPU / preview threads may still hold the interpreter; exit hard and fast. Any late
    # emission from them was already suppressed by Engine.finalize_job_once().
    os._exit(code)
