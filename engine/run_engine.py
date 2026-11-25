"""Studio engine launcher.

Invoke by script path (never ``-m``): the embedded interpreter's ``._pth`` ignores
the working directory and PYTHONPATH.

    <python.exe> -s C:\\Users\\winbloat\\Studio\\engine\\run_engine.py --host 127.0.0.1 --port 48210 ...
"""
import os
import sys

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)

from studio_engine import bootstrap  # noqa: E402  (stdlib only)

# ROCm 7.2.1 / runtime environment (bootstrap.ROCM_ENV): must be set before torch or comfy is imported.
bootstrap.set_environment()

if __name__ == "__main__":
    from studio_engine.main import main
    sys.exit(main(sys.argv[1:]))
