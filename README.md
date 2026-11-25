# Studio

A native Windows 11 desktop creative suite built with Electron, React, TypeScript, WebGL2, Canvas2D, Three.js, Rust, and a standalone Python ROCm inference daemon with Blender 5.3 integration.

## Workspaces

- **Generate** — Text-to-image with Z-Image Turbo and Qwen-Image 2.1, featuring Step-1 binary JPEG latent previews composited through a WebGL2 Reynolds Boids murmuration + curl-noise reveal shader.
- **Edit** — Layered Canvas2D editor (`Paintbrush`, `Mask brush`, `Eraser`, Undo/Redo, before/after split wipe), 1-click BiRefNet background removal, Inpaint, Img2Img, and Qwen-Image 2.1 multi-reference editing.
- **3D** — Text-to-3D and Image-to-3D via Pixal3D and TRELLIS.2 with 7-stage milestone previews, lazy-loaded Three.js PBR viewport (orbit/presets/shading/lighting), multi-format mesh export (`.glb`, `.obj`, `.stl`, `.fbx`, `.blend`), and a live bidirectional Blender 5.3 add-on (`127.0.0.1:48215`).
- **Library** — Virtualized masonry gallery with search/filtering, slide-over metadata Inspector, Recycle Bin deletion via `studio-core`, and on-demand model warm/unload & GPU/RAM memory management.

## Repository Layout

- [`app/`](./app/) — Electron 35 shell (`app/electron/`), React 19 + Tailwind CSS + WebGL2 + Three.js renderer (`app/src/`), and icons (`app/assets/`).
- [`engine/`](./engine/) — Standalone Python 3.12 + ROCm HTTP/WebSocket daemon (`studio_engine` on `127.0.0.1:48210`).
- [`core/`](./core/) — Stateless Rust CLI (`studio-core`) handling model scanning, 512 px WebP thumbnail generation, Recycle Bin deletion, and system/GPU telemetry.
- [`blender/`](./blender/) — Live Blender 5.3 add-on (`studio_bridge.py`) and headless multi-format mesh converter (`export_mesh.py`).
- [`docs/`](./docs/) — [`DESIGN_SPEC.md`](./docs/DESIGN_SPEC.md) and [`API_CONTRACT.md`](./docs/API_CONTRACT.md).

## Excluded Local Directories

The following heavy runtime and asset directories are excluded from version control via `.gitignore`:

- `models/` — Local diffusion, VLM, BiRefNet, and 3D safetensors/checkpoints.
- `runtime/` — Embedded Windows Python 3.12 + PyTorch ROCm environment.
- `engine/vendor/` — Vendored inference backend modules.
- `outputs/` — Generated images, `.studio.json` sidecars, 3D assets, and `.cache/thumbs/`.

## Build & Run

```powershell
# 1. Build the Rust native core CLI
cd core
cargo build --release

# 2. Install JS dependencies and build Electron + renderer
cd ..\app
bun install
bun run build

# 3. Launch Studio (clearing ELECTRON_RUN_AS_NODE if set in parent shell)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\node_modules\electron\dist\electron.exe .
```
