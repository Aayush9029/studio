# Studio — API Contract

| | |
|---|---|
| Version | 1.0 (2026-11-25) · `apiVersion: 1` |
| Audience | Three implementation teams: **Engine+Blender** (Python daemon, Blender add-on), **Rust+Electron** (`studio-core.exe`, Electron main + preload), **React Frontend** (`app/src`) |
| Companion | `DESIGN_SPEC.md` (appearance and behaviour) |
| Rule | This file is the single source of truth for every byte that crosses a process boundary. If an implementation needs something not written here, change this file first. |

Contents: 1 Topology and conventions · 2 Filesystem and process launch · 3 Engine HTTP API · 4 Engine WebSocket · 5 Output files and `.studio.json` · 6 `studio-core.exe` CLI · 7 Electron IPC · 8 Shared TypeScript contract (`contract.ts`) · 9 Blender add-on and `export_mesh.py` · 10 Ownership and integration checks · Appendices A–C

---

## 1. Topology and conventions

```
┌──────────────────────────── Electron ────────────────────────────┐
│  renderer (React)  ──fetch / WebSocket──────────────►  Engine daemon  127.0.0.1:48210
│      │  window.studio (preload, IPC)                              │   (Python 3.12 + ROCm, comfy / comfy_extras)
│      ▼                                                            │        │ optional
│  main process ──spawn──► studio-core.exe (one-shot CLI, JSON stdout)       ▼
│      │         ──spawn──► blender.exe --background export_mesh.py     Inkling LLM  127.0.0.1:8080/v1
│      └────────HTTP──────► Blender add-on studio_bridge  127.0.0.1:48215
└───────────────────────────────────────────────────────────────────┘
```

| Link | Who talks | Why this way |
|---|---|---|
| Renderer → Engine (HTTP + WS) | Direct, no IPC hop | Binary preview frames reach WebGL without being copied through the main process |
| Renderer → main (`window.studio`) | IPC | Anything touching the filesystem, the shell, child processes or Blender |
| Main → `studio-core.exe` | Child process per call | Fast native file work; no long-lived native state |
| Main → Blender add-on | HTTP | Avoids CORS; main owns connection polling |
| Blender add-on → Engine | HTTP `GET /api/outputs` | "Sync latest" inside Blender |

### 1.1 Conventions (apply everywhere unless a section says otherwise)

| Topic | Rule |
|---|---|
| JSON keys | `camelCase`. Unknown keys are ignored by readers; writers never omit a documented non-optional key. `null` means "not applicable"; a missing optional key means "use the default". |
| Encoding | UTF-8, no BOM. |
| Time | Timestamps on events: `ts` = integer Unix milliseconds. Persisted dates: ISO-8601 UTC with milliseconds, e.g. `"2026-11-25T14:30:22.481Z"`. Durations: integer milliseconds, suffix `Ms`. |
| Sizes | Disk: integer bytes, suffix `Bytes`. Memory: integer mebibytes, suffix `Mb` (1 Mb = 1,048,576 bytes). |
| Paths | Absolute paths use native Windows form (`C:\\…` in JSON). Fields named `relPath` are relative and use forward slashes. |
| IDs | `jobId` = `"job_"` + 16 lowercase hex. Output `id` = 16 lowercase hex. Upload `id` = `"up_"` + 16 lowercase hex. All random. |
| Seeds | Integer `0 … 4294967295`. In requests `-1` means "engine picks"; the engine reports the seed it used. |
| Images in JSON | `…Base64` fields carry PNG, JPEG or WebP bytes as standard base64, **with or without** a `data:image/…;base64,` prefix. |
| Concurrency | The engine runs **one job at a time**. There is no queue. A second job request gets `409 BUSY`. |
| Versioning | `apiVersion` is `1`. Additive changes (new optional fields, new event types, new error codes) do not bump it; readers must ignore what they don't know. Anything else bumps it. |

### 1.2 Fields added beyond the original brief

These additions are optional for senders and are called out so nobody treats them as drift: `sampler`, `scheduler`, `sourceId` on generation requests; `defaults`, `samplers`, `schedulers`, `complete` on model families; `apiVersion`, `engineVersion` on health; `limit`, `offset` on `GET /api/outputs`; `job.progress.output` and `job.progress.enhancedPrompt`.

---

## 2. Filesystem and process launch

### 2.1 Install tree

```
C:\Users\winbloat\Studio\
  studio.config.json        optional install-level overrides (2.2)
  docs\                     this file, DESIGN_SPEC.md
  engine\                   run_engine.py, studio_engine\ (package)
  core\                     Cargo project; release binary at core\target\release\studio-core.exe
  app\                      Electron + React app; assets\studio.ico
  blender\                  studio_bridge.py (add-on), export_mesh.py
  models\                   model files (see 2.3)
  outputs\                  everything Studio creates (section 5)
  logs\                     engine.log, app.log, core.log, blender-export.log
```

User-level state lives in Electron's `userData` directory, `%APPDATA%\Studio\`: `settings.json` (app preferences, section 7.4) and `engine.json` (engine settings, section 3.6).

### 2.2 `studio.config.json`

Read by Electron main at startup. Every key is optional.

| Key | Default | Meaning |
|---|---|---|
| `pythonExe` | `C:\Users\winbloat\ComfyUI_windows_portable\python_embeded\python.exe` | Interpreter for the engine |
| `comfyDir` | `C:\Users\winbloat\ComfyUI_windows_portable\ComfyUI` | Directory that contains the `comfy\` and `comfy_extras\` packages |
| `modelsDir` | see 2.3 | Models root |
| `outputsDir` | `C:\Users\winbloat\Studio\outputs` | Outputs root |
| `blenderExe` | `C:\Program Files\Blender Foundation\Blender 5.3\blender.exe` | Blender executable |
| `inklingUrl` | `http://127.0.0.1:8080/v1` | OpenAI-compatible base URL |
| `inklingModel` | `inkling-2-mini-uncensored` | Model name sent to Inkling |

Ports are fixed and not configurable in v1: engine `48210`, Blender bridge `48215`.

### 2.3 Models directory — state observed on disk (2026-11-25)

`C:\Users\winbloat\Studio\models` **does not exist yet**. The 74.3 GB model set described in the brief is at `C:\Users\winbloat\ComfyUI_windows_portable\ComfyUI\models`. Resolution order used by Electron main:

1. `studio.config.json` → `modelsDir`, if set.
2. `C:\Users\winbloat\Studio\models`, if it exists (a real folder or a directory junction).
3. `<comfyDir>\models`.

The resolved absolute path is passed to the engine and to `studio-core`; nothing else in the system guesses. Also observed: the interpreter at the default `pythonExe` is Python 3.12.10 with `torch 2.9.1+rocm7.2.1` and `torch.cuda.is_available() == True`; Blender 5.3 is installed at the default `blenderExe`; `bun` is on `PATH`; `cargo` is **not** on `PATH`.

The expected layout under `modelsDir` and the family → file mapping are in Appendix A.

### 2.4 Engine launch contract

Electron main starts the daemon (or adopts one that already answers `GET /api/health` with `apiVersion: 1`):

```
<pythonExe> -s C:\Users\winbloat\Studio\engine\run_engine.py
    --host 127.0.0.1 --port 48210
    --comfy-dir   <comfyDir>
    --models-dir  <modelsDir>
    --outputs-dir <outputsDir>
    --state-dir   %APPDATA%\Studio
    --log-file    C:\Users\winbloat\Studio\logs\engine.log
    --inkling-url <inklingUrl> --inkling-model <inklingModel>
    --parent-pid  <electron main pid>
    [--allow-origin <origin>]...        (repeatable; adds to the default allow-list in 3.1)
```

- The entry point is a **script path**, not `-m`: the default interpreter is an embedded distribution whose `._pth` file ignores the working directory and `PYTHONPATH`. `run_engine.py` inserts its own directory and `--comfy-dir` at the front of `sys.path`, then starts `studio_engine`.
- The daemon must not import or start ComfyUI's `server.py`, `main.py` or the frontend package. It imports `comfy`, `comfy_extras`, `folder_paths`, `nodes`, `latent_preview` and points `folder_paths` at `--models-dir`.
- **Ready** means `GET /api/health` returns `200` with `status: "ok"`. The daemon must reach that within 30 s without loading any model weights.
- **Parent watchdog**: if `--parent-pid` is given and that process no longer exists, the daemon cancels any job, unloads models and exits within 5 s. This prevents an orphan holding tens of gigabytes of GPU memory.
- **Shutdown**: on app quit main sends `POST /api/shutdown`, waits up to 5 s for the process to exit, then kills the process tree.
- **Exit codes**: `0` clean shutdown · `1` fatal error · `2` bad arguments · `3` port already in use · `4` `comfyDir` or `modelsDir` invalid.
- Logging: everything goes to `--log-file` (rotated at 10 MB, 3 files). stdout/stderr carry only fatal start-up errors.

---

## 3. Engine HTTP API — `http://127.0.0.1:48210`

### 3.1 Common rules

- Binds `127.0.0.1` only.
- **Request bodies** are `application/json` unless stated (`/api/upload` also accepts `multipart/form-data`). A `POST` with any other content type → `415`.
- **Origin check** (HTTP and the WebSocket upgrade): if the request has an `Origin` header, it must be in the allow-list — `studio://app`, `http://localhost:5173`, `http://127.0.0.1:5173`, plus any `--allow-origin` — otherwise `403 FORBIDDEN_ORIGIN`. Requests **without** an `Origin` header (Electron main, the Blender add-on, curl) are accepted. The `Host` header must be `127.0.0.1:48210` or `localhost:48210`.
- **CORS**: for allowed origins respond with `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`, `Access-Control-Max-Age: 600`; answer `OPTIONS` preflight with `204`.
- Every response carries `X-Studio-Api: 1`.
- Maximum request body: 96 MB.

**Error body** (any non-2xx):

```json
{ "error": { "code": "BUSY", "message": "A job is already running.", "details": { "activeJobId": "job_3f9a1c0e7b2d4a68" } } }
```

`message` is for logs, not for display (the UI maps `code` to its own copy). Codes and statuses are in Appendix C.

### 3.2 `GET /api/health`

```json
{
  "status": "ok",
  "apiVersion": 1,
  "engineVersion": "1.0.0",
  "pid": 18244,
  "device": "AMD Radeon(TM) 8060S Graphics",
  "vramTotalMb": 104448,
  "vramUsedMb": 20112,
  "vramFreeMb": 84336,
  "ramTotalMb": 65536,
  "ramUsedMb": 31744,
  "modelsDir": "C:\\Users\\winbloat\\ComfyUI_windows_portable\\ComfyUI\\models",
  "outputsDir": "C:\\Users\\winbloat\\Studio\\outputs",
  "inklingAvailable": true,
  "activeJobId": null
}
```

| Field | Notes |
|---|---|
| `status` | `"ok"` · `"starting"` (HTTP is up, comfy still importing) · `"shutting_down"` |
| `device` | Human-readable name from `torch.cuda.get_device_name(0)` |
| `vram*Mb` | From `torch.cuda.mem_get_info()`: device-wide total and free; `used = total − free` |
| `ram*Mb` | System physical memory |
| `inklingAvailable` | Result of `GET <inklingUrl>/models` with a 400 ms timeout, cached for 10 s. Never blocks this endpoint for longer than 400 ms. |
| `activeJobId` | `string` or `null` |

Must respond in under 50 ms when Inkling's cached status is fresh.

### 3.3 `GET /api/models`

Returns `ModelFamilyStatus[]`, always all five families in this order: `z_image`, `qwen_image`, `pixal3d`, `trellis2`, `birefnet`.

```json
[
  {
    "id": "z_image",
    "label": "Z-Image Turbo",
    "state": "warm",
    "vramEstimateMb": 21977,
    "diskBytes": 20948784834,
    "complete": true,
    "lastUsedAt": "2026-11-25T14:28:03.120Z",
    "files": [
      { "role": "diffusion",       "relPath": "diffusion_models/z_image_turbo_bf16_nsfw_v2.safetensors",
        "path": "C:\\…\\models\\diffusion_models\\z_image_turbo_bf16_nsfw_v2.safetensors",
        "bytes": 12566033952, "exists": true, "sharedWith": [] },
      { "role": "text_encoder",    "relPath": "text_encoders/qwen3_4b_z_image_abliterated.safetensors", "path": "…", "bytes": 8044982080, "exists": true, "sharedWith": [] },
      { "role": "vae",             "relPath": "vae/z_image_ae.safetensors",                              "path": "…", "bytes": 335304388,  "exists": true, "sharedWith": [] },
      { "role": "preview_decoder", "relPath": "vae_approx/taef1_decoder.safetensors",                    "path": "…", "bytes": 2464414,    "exists": true, "sharedWith": [] }
    ],
    "defaults": { "steps": 9, "cfg": 1.0, "sampler": "euler", "scheduler": "simple",
                  "sizeMultiple": 16, "minSize": 256, "maxSize": 2048, "maxReferenceImages": 0 },
    "samplers": ["euler", "euler_ancestral", "dpmpp_2m", "res_multistep"],
    "schedulers": ["simple", "beta", "sgm_uniform", "normal"]
  }
]
```

| Field | Rule |
|---|---|
| `state` | `cold` → `warming` → `warm` → `unloading` → `cold`. A family is `warm` only when every component it needs is resident. |
| `diskBytes` | Sum of `bytes` over `files` that exist, measured at daemon start (and re-measured on `POST /api/models/warmup`). |
| `vramEstimateMb` | `ceil(diskBytes / 1048576 × 1.10)`. An estimate for the budgeter and the UI; shared files are counted in every family that uses them. |
| `complete` | `true` when every file has `exists: true`. An incomplete family cannot be warmed (`MODEL_FILES_MISSING`). |
| `lastUsedAt` | Last time a job or warm-up touched the family; `null` if never in this daemon's lifetime. |
| `files[].role` | One of `diffusion`, `text_encoder`, `vae`, `lora`, `preview_decoder`, `vision_encoder`, `geometry`, `matting`. |
| `files[].sharedWith` | Other family ids that list the same `relPath`. |
| `defaults`, `samplers`, `schedulers` | Present (non-null) for `z_image` and `qwen_image`; `null` for the others. `samplers`/`schedulers` are the curated lists in Appendix B **intersected with what the loaded comfy build actually provides**. |

### 3.4 `POST /api/models/warmup`

Request `{ "family": "qwen_image" }` (`FamilyId`; `"all"` is not accepted).

| Situation | Response |
|---|---|
| Family cold | `202 { "family": "qwen_image", "state": "warming" }` — loading proceeds in the background; progress is reported by `models.status` events |
| Already warm or warming | `200 { "family": "qwen_image", "state": "warm" \| "warming" }` |
| A job is active | `409 BUSY` |
| Unknown id | `400 UNKNOWN_FAMILY` |
| Files missing | `424 MODEL_FILES_MISSING` with `details.missing: string[]` (relPaths) |

Warming loads the diffusion model, text encoder(s), VAE(s), LoRA and helper models of the family to the GPU. Warming `pixal3d`/`trellis2` does not warm `birefnet`; a 3D job warms it on demand.

**Memory budget.** Before loading a family (for warm-up or for a job) the engine ensures `vramFreeMb ≥ vramEstimateMb + 8192`; if not, it unloads warm families in least-recently-used order until it is. If that is still not enough the operation fails with `OUT_OF_MEMORY`. Mesh remeshing has its own budget (3.12).

### 3.5 `POST /api/models/unload`

Request `{ "family": "z_image" }` or `{ "family": "all" }`.

Response `200`:

```json
{ "unloaded": ["z_image"], "vramFreeMb": 103920 }
```

`unloaded` lists the families that changed state (empty if nothing was warm). Components shared with a family that remains warm stay resident. After unloading, the engine releases cached GPU memory (`comfy.model_management.soft_empty_cache()` plus `torch.cuda.empty_cache()`), so `vramFreeMb` reflects the release. With a job active → `409 BUSY`.

### 3.6 `GET /api/settings` · `POST /api/settings`

Shape (both directions): `{ "autoUnloadMinutes": 0 | 5 | 10 | 15 | 30 }` — `0` means Off. Default `10`.

`POST` accepts a partial object, validates, persists to `<state-dir>\engine.json`, and returns the full settings object. Invalid value → `400 BAD_REQUEST`.

**Auto-unload**: every 30 s, when no job is active, any warm family whose `lastUsedAt` is older than `autoUnloadMinutes` is unloaded (emitting `models.status`).

### 3.7 `GET /api/telemetry`

Returns one `Telemetry` object — the same shape as the `telemetry` WebSocket event without `type`/`seq`:

```json
{
  "ts": 1795635022481,
  "source": "engine",
  "vramTotalMb": 104448, "vramUsedMb": 20112, "vramFreeMb": 84336,
  "vramProcessMb": 19876,
  "ramTotalMb": 65536, "ramUsedMb": 31744,
  "ramProcessMb": 6120,
  "gpuUtilPct": null,
  "activeJobId": null
}
```

`vramProcessMb` = `torch.cuda.memory_reserved()`; `ramProcessMb` = daemon RSS; `gpuUtilPct` is `number | null` (null when the platform cannot report it).

### 3.8 `POST /api/enhance-prompt`

Request:

```json
{ "idea": "a heron in fog", "style": "photo" }
```

`style`: `"photo"` (text-to-image), `"3d"` (single-object, neutral background, full view), `"edit"` (clarify an edit instruction without inventing new changes). `idea`: 1–2000 characters.

Response is **always `200`** when the request is valid:

```json
{ "prompt": "A grey heron standing motionless in shallow water, dense morning fog…", "enhanced": true }
```

If Inkling is unreachable, times out (20 s) or returns nothing usable: `{ "prompt": "<idea, unchanged>", "enhanced": false, "reason": "INKLING_UNAVAILABLE" }`.

The engine calls `POST <inklingUrl>/chat/completions` with `model: <inklingModel>`, `temperature: 0.7`, `max_tokens: 320`, a system prompt per style, and the idea as the user message. The returned text is stripped of quotes, labels and reasoning tags and limited to 1200 characters. This endpoint works while a job is running. Studio exposes no other LLM functionality.

### 3.9 `POST /api/upload`

Stores an image under `outputs\uploads\` for use as a reference or source.

- `multipart/form-data` with one part named `file`, **or**
- JSON `{ "imageBase64": "…", "filename": "optional.png" }`.

Response `201`:

```json
{ "id": "up_8c2e41d09a7b3f15", "path": "C:\\Users\\winbloat\\Studio\\outputs\\uploads\\up_8c2e41d09a7b3f15.png", "width": 1536, "height": 1024 }
```

The image is decoded, EXIF orientation applied, converted to sRGB 8-bit, and saved as PNG (alpha preserved). Limits: 64 MB, 8192 px per side. Failures: `IMAGE_DECODE_FAILED` (400), `IMAGE_TOO_LARGE` (413). Uploads are not Library items (no sidecar) and are not auto-deleted in v1.

### 3.10 `POST /api/generate/t2i`

```json
{
  "prompt": "A grey heron standing in morning fog",
  "negativePrompt": "",
  "model": "z_image",
  "width": 1024,
  "height": 1024,
  "seed": -1,
  "steps": 9,
  "cfg": 1.0,
  "sampler": "euler",
  "scheduler": "simple",
  "batchSize": 1,
  "enhancePrompt": false
}
```

| Field | Type | Required | Default | Validation |
|---|---|---|---|---|
| `prompt` | string | yes | — | 1–4000 chars after trim |
| `negativePrompt` | string | no | `""` | ≤ 4000 chars. Has an effect only when `cfg > 1`. |
| `model` | `"z_image" \| "qwen_image"` | yes | — | |
| `width`, `height` | int | yes | — | 256–2048; multiple of 16 (`z_image`) or 32 (`qwen_image`); else `400 INVALID_DIMENSIONS`. The engine does not snap. |
| `seed` | int | yes | — | `-1` or 0–4294967295 |
| `steps` | int | no | 9 / 8 | 1–50 |
| `cfg` | number | no | 1.0 | 1.0–10.0 |
| `sampler`, `scheduler` | string | no | `euler` / `simple` | Must be in the family's lists |
| `batchSize` | int | no | 1 | 1–4 |
| `enhancePrompt` | bool | no | `false` | Enhances with `style: "photo"` before encoding; silently falls back to the original prompt if Inkling fails |

Response `202 { "jobId": "job_3f9a1c0e7b2d4a68" }`. Everything else arrives over the WebSocket (section 4).

**Batch semantics.** A batch is `batchSize` sequential runs, not one batched tensor. Image `i` (0-based) uses seed `(seed + i) mod 4294967296`. Each image gets its own preview stream, its own output file and its own sidecar, and is announced when saved (`job.progress` with `phase: "saved"`). The prompt is enhanced once for the whole batch.

**Qwen-Image 2.1** runs with the `chatrlabs-omni-turbo-8step` LoRA applied at strength 1.0.

### 3.11 `POST /api/generate/edit`

```json
{
  "mode": "inpaint",
  "imageBase64": "iVBORw0KGgo…",
  "maskBase64": "iVBORw0KGgo…",
  "prompt": "a small red lantern",
  "negativePrompt": "",
  "seed": -1,
  "steps": 9,
  "cfg": 1.0,
  "denoise": 0.85,
  "enhancePrompt": false,
  "sourceId": "5d0c1e7a9b3f4a21"
}
```

| Field | Type | Applies to | Rule |
|---|---|---|---|
| `mode` | `"qwen_edit" \| "inpaint" \| "img2img" \| "remove_bg"` | all | Required |
| `imageBase64` / `imagePath` | string | all | **Exactly one** is required. `imagePath` is an absolute path to a readable PNG/JPEG/WebP. The frontend sends the canvas as `imageBase64` (base layer flattened with the paint layer). |
| `maskBase64` | string | `inpaint` | Required for `inpaint`, ignored otherwise. Single-channel (or RGB) 8-bit image, **same pixel dimensions as the image**; white (255) = regenerate, black = keep. Dimension mismatch → `400 BAD_REQUEST`. An all-black mask → `400 BAD_REQUEST`. |
| `referenceImages` | string[] | `qwen_edit` | 0–3 **absolute file paths** (obtain them from `/api/upload`). The encoder sees the base image as image 1 and these as images 2–4, in order. More than 3 → `400`. |
| `prompt` | string | all but `remove_bg` | Required, 1–4000 chars |
| `negativePrompt` | string | all but `remove_bg` | Optional |
| `seed` | int | all but `remove_bg` | Required; `-1` allowed. Ignored for `remove_bg` (may be omitted). |
| `steps` | int | sampling modes | Default 8 (`qwen_edit`), 9 (`inpaint`, `img2img`); 1–50 |
| `cfg` | number | sampling modes | Default 1.0; 1.0–10.0 |
| `sampler`, `scheduler` | string | sampling modes | Default `euler` / `simple` |
| `denoise` | number | `inpaint`, `img2img` | 0.05–1.0. Default 0.85 (`inpaint`), 0.60 (`img2img`). Ignored for `qwen_edit`. |
| `resolution` | int | `qwen_edit` | Target size: output area ≈ `resolution²`, aspect ratio of the base image, both sides multiples of 32. 512–2048 in steps of 32; default 1024. |
| `enhancePrompt` | bool | sampling modes | Uses `style: "edit"` |
| `sourceId` | string | all | Optional Library item id this edit derives from; recorded in the sidecar |

Response `202 { "jobId": "…" }`.

**Model per mode**: `qwen_edit` → `qwen_image` family; `inpaint`, `img2img` → `z_image`; `remove_bg` → `birefnet`.

**Geometry guarantees**

| Mode | Output dimensions | How |
|---|---|---|
| `inpaint`, `img2img` | **Identical to the input** | Input long edge above 2048 → `413 IMAGE_TOO_LARGE`. If a side is not a multiple of 16, the engine pads with edge replication to the next multiple, runs, and crops back. |
| `inpaint` | Pixels where the mask is 0 are **bit-identical** to the input | The mask is grown by 8 px and feathered by 16 px for sampling; the result is composited over the original through the feathered mask. |
| `remove_bg` | Identical to the input, RGBA | RGB is the input unchanged; alpha is the BiRefNet matte. |
| `qwen_edit` | Determined by `resolution` and the base image's aspect ratio | May differ from the input size. |

Outputs are saved as PNG under `outputs\edits\` with `kind: "edit"`.

### 3.12 `POST /api/generate/3d`

```json
{
  "mode": "i23d",
  "engine": "pixal3d",
  "imagePath": "C:\\Users\\winbloat\\Studio\\outputs\\images\\2026-11-25\\20261125_143022_5d0c1e7a.png",
  "seed": -1,
  "removeBackground": true,
  "targetFaces": 300000,
  "remeshResolution": 512,
  "sourceId": "5d0c1e7a9b3f4a21"
}
```

| Field | Type | Rule |
|---|---|---|
| `mode` | `"t23d" \| "i23d"` | Required |
| `engine` | `"pixal3d" \| "trellis2"` | Required |
| `prompt` | string | Required for `t23d` (1–4000 chars); ignored for `i23d` |
| `imageBase64` / `imagePath` | string | Exactly one required for `i23d`; neither allowed for `t23d` |
| `seed` | int | Required; `-1` allowed. The same seed drives every sampling stage. |
| `enhancePrompt` | bool | `t23d` only; uses `style: "3d"`. Default `false`. |
| `removeBackground` | bool | Default `true`. When `false`, the source's own alpha channel is the mask if it has one, otherwise the whole frame is treated as the subject. |
| `targetFaces` | int | 100000–700000, default 300000. Final triangle count after decimation (±2 %). |
| `remeshResolution` | `512 \| 768 \| 1024` | Default 512. Narrow-band remesh grid resolution. |
| `sourceId` | string | Optional |

Response `202 { "jobId": "…" }`.

**Pipeline** (stage ids are normative, section 4.4; node ids are those present in the local `comfy_extras` and are given as the reference wiring — the Engine team verifies the exact graph):

| # | Stage id | Work | Models |
|---|---|---|---|
| 0 | `source` | `t23d`: Z-Image Turbo, 1024 × 1024, 9 steps, prompt wrapped in a fixed single-object template; emits `PREV` frames. `i23d`: decode and normalise the input (long edge ≤ 1024). | `z_image` (t23d) |
| 1 | `cutout` | BiRefNet matte (`LoadBackgroundRemovalModel`, `RemoveBackground`) → RGBA; crop to the mask (`ImageCropToMask`, pad factor 1.1 for Pixal3D, 1.0 for TRELLIS.2). Status `skipped` when `removeBackground` is `false` (the crop still happens). | `birefnet` |
| 2 | `depth` | **Pixal3D only**: MoGe-2 (`LoadMoGeModel`, `MoGeInference`, `MoGeGeometryToFOV`) estimates the horizontal FOV fed to `Pixal3DConditioning`. Status `skipped` for TRELLIS.2. | `geometry_estimation/moge_2_vitl_normal_fp16` |
| 3 | `structure` | DINOv3 conditioning (`Pixal3DConditioning` / `Trellis2Conditioning`), `EmptyTrellis2LatentStructure`, sample, `VaeDecodeStructureTrellis2` | diffusion model, `clip_vision/dino_v3_L_naf_fp32`, shape VAE |
| 4 | `shape` | `Trellis2ShapeStage`, sample (optionally `Trellis2UpsampleStage`), `VaeDecodeShapeTrellis` | diffusion model, shape VAE |
| 5 | `texture` | `Trellis2TextureStage`, sample, `VaeDecodeTextureTrellis` | diffusion model, texture VAE |
| 6 | `mesh` | `RemeshMesh(resolution = remeshResolution)` → `DecimateMesh(target_face_count = targetFaces)` → `UnwrapMesh` → `BakeTextureFromVoxel(texture_size = 2048)` → normalise → write GLB | — |

**Remesh memory.** comfy's own estimate for the remesh is `resolution³ × 64` bytes: about 8.6 GB at 512, 29 GB at 768 and 68.7 GB at 1024. Before stage `mesh` the engine applies the budget rule of 3.4 with that figure, unloading other families (including the 3D diffusion model, which is no longer needed) as required.

**Output normalisation (guaranteed).** One binary glTF 2.0 file (`.glb`): Y-up, metres, a single mesh with one PBR material and embedded 2048 px base-colour texture; scaled so the longest bounding-box edge is exactly 1.0; centred on the origin in X and Z; resting on Y = 0. Alongside it the engine writes `source.png`, `cutout.png` (unless skipped), the stage thumbnails, and `preview.webp` (768 × 768 render of the final mesh, three-quarter view, neutral background, alpha allowed). If the engine cannot render a preview it copies the `texture`-stage thumbnail, and failing that `cutout.png`.

### 3.13 `POST /api/cancel`

Request `{ "jobId": "job_…" }` or `{}` (cancels whatever is active).

| Situation | Response |
|---|---|
| Job active and matches (or no `jobId` given) | `200 { "cancelled": true, "jobId": "job_…" }` — the job stops at the next sampler step or stage boundary; the WebSocket then delivers `job.cancelled` |
| Nothing active | `200 { "cancelled": false, "jobId": null }` |
| `jobId` given but not the active job | `404 NOT_FOUND` |

Cancellation uses `comfy.model_management.interrupt_current_processing()` and must take effect within one sampler step. Models stay warm.

### 3.14 `POST /api/shutdown`

Request `{}`. Response `200 { "ok": true }`, sent before teardown. The daemon then cancels any job, emits `job.cancelled`, closes WebSocket clients with code `1001`, unloads models and exits with code `0` within 5 s.

### 3.15 `GET /api/outputs`

Query: `kind=all|image|edit|3d` (default `all`), `limit` (1–1000, default 200), `offset` (default 0).

Response `200`:

```json
{ "items": [ /* OutputItem, newest first */ ], "total": 248 }
```

`OutputItem` is the sidecar content plus resolved absolute paths (section 5.3). The engine builds the list by reading sidecars under `outputsDir`; it may cache and must invalidate the cache when it writes a new output. The Library UI normally uses `studio-core library-scan` instead (it also makes thumbnails and works with the engine down); this endpoint exists for the Blender add-on's **Sync latest** (`GET /api/outputs?kind=3d&limit=1`) and as a fallback. Both producers must emit identical `OutputItem` field names and ordering (`createdAt` descending, then `id` ascending).

---

## 4. Engine WebSocket — `ws://127.0.0.1:48210/ws`

### 4.1 Connection

- Any number of clients; every event is broadcast to all.
- The client sends nothing. Text frames from clients are ignored. The server sends protocol-level pings every 20 s and drops clients that miss two.
- **On connect** the server immediately sends, in order: one `models.status`, one `telemetry`, and — if a job is active — a replayed `job.started` with `"replayed": true` followed by the latest `job.progress`.
- **Text frames** are JSON events (4.2). **Binary frames** are preview frames (4.3). There are no other frame kinds.
- Client reconnect policy: retry after 250 ms, doubling to a maximum of 5 s, forever, while the engine process is alive.

### 4.2 JSON events

Every event has `type` (string), `ts` (Unix ms) and `seq` (integer, strictly increasing per daemon process across all text events).

#### `job.started`

```json
{
  "type": "job.started", "ts": 1795635022481, "seq": 112,
  "jobId": "job_3f9a1c0e7b2d4a68",
  "kind": "image",
  "mode": "t2i",
  "model": "z_image",
  "seed": 3829104412,
  "batchSize": 1,
  "width": 1024, "height": 1024,
  "stages": [
    { "index": 0, "id": "prepare", "label": "Prepare", "steps": null, "preview": false },
    { "index": 1, "id": "sample",  "label": "Sample",  "steps": 9,    "preview": true  },
    { "index": 2, "id": "decode",  "label": "Decode",  "steps": null, "preview": false }
  ],
  "stageIndex": 0,
  "stageLabel": "Prepare",
  "replayed": false
}
```

| Field | Notes |
|---|---|
| `kind` | `"image" \| "edit" \| "3d"` |
| `model` | `FamilyId` of the principal model: `z_image`, `qwen_image`, `birefnet`, `pixal3d`, `trellis2` |
| `seed` | The resolved seed (never `-1`). `0` for `remove_bg`. |
| `width`, `height` | Expected output size in pixels, or `null` when unknown at start (`qwen_edit` before the image is measured, all 3D jobs) |
| `stages` | The complete, ordered stage list for this job (4.4). `steps` is the sampler step count for sampling stages, else `null`. `preview: true` marks stages that may emit binary `PREV` frames. |

This event **binds the active job**: from here until `job.completed`, `job.error` or `job.cancelled` for the same `jobId`, every binary frame on the socket belongs to this job.

#### `job.progress`

```json
{
  "type": "job.progress", "ts": 1795635023950, "seq": 118,
  "jobId": "job_3f9a1c0e7b2d4a68",
  "stageIndex": 1, "stageId": "sample", "stageLabel": "Sample",
  "phase": "sampling",
  "step": 4, "totalSteps": 9,
  "batchIndex": 0, "batchSize": 1,
  "stageProgress": 0.444,
  "progress": 0.47,
  "elapsedMs": 1469,
  "etaMs": 1900
}
```

| Field | Notes |
|---|---|
| `phase` | `"enhancing"` · `"loading"` · `"encoding"` · `"sampling"` · `"decoding"` · `"processing"` · `"saving"` · `"saved"` |
| `step`, `totalSteps` | 1-based sampler step within the stage during `sampling`; both `0` otherwise |
| `batchIndex` | 0-based index of the image currently being made |
| `stageProgress` | 0–1 within the current stage |
| `progress` | 0–1 for the whole job; **never decreases**; reaches 1.0 only in `job.completed` |
| `etaMs` | `number \| null` |
| `enhancedPrompt` | Optional string. Present exactly once, on the first `job.progress` after prompt enhancement succeeded. |
| `output` | Optional `OutputItem`. Present exactly once per saved image, on an event with `phase: "saved"`. |

Emitted at least on every phase change and every sampler step, and never more often than every 50 ms otherwise.

#### `job.stage_preview`

Emitted by **3D jobs only**, once per stage, when that stage finishes or is skipped.

```json
{
  "type": "job.stage_preview", "ts": 1764081101200, "seq": 161,
  "jobId": "job_9a1b2c3d4e5f6071",
  "stageIndex": 2, "stageId": "depth", "stageLabel": "Depth",
  "status": "done",
  "imagePath": "C:\\Users\\winbloat\\Studio\\outputs\\3d\\20261125_143501_7c2e9b10\\stages\\02_depth.webp",
  "width": 512, "height": 512,
  "elapsedMs": 2140
}
```

`status`: `"done" | "skipped"`. `imagePath` is `string | null` (null for skipped stages and when no thumbnail could be made); when non-null the file is fully written before the event is sent. Thumbnails are 512 × 512 WebP.

| Stage | Thumbnail content |
|---|---|
| `source` | The source image |
| `cutout` | Cut-out subject on transparency |
| `depth` | MoGe normal or depth visualisation |
| `structure` | Shaded render of the occupancy voxels |
| `shape` | Untextured (clay) render of the decoded mesh |
| `texture` | Textured render, or the base-colour atlas |
| `mesh` | The final `preview.webp`, downscaled |

#### `job.completed`

```json
{
  "type": "job.completed", "ts": 1795635026690, "seq": 131,
  "jobId": "job_3f9a1c0e7b2d4a68",
  "kind": "image", "mode": "t2i",
  "outputs": [ /* OutputItem[] — one per image; exactly one for 3D */ ],
  "elapsedMs": 4209
}
```

All files referenced by `outputs` exist and are closed before this event is sent.

#### `job.error`

```json
{
  "type": "job.error", "ts": 1795635026690, "seq": 131,
  "jobId": "job_3f9a1c0e7b2d4a68",
  "stageIndex": 1,
  "error": { "code": "OUT_OF_MEMORY", "message": "…", "details": {} },
  "outputs": []
}
```

`stageIndex` is `number | null`. `outputs` lists batch images that were saved before the failure (they are kept). After an `OUT_OF_MEMORY` the engine unloads all families and emits `models.status`.

#### `job.cancelled`

```json
{ "type": "job.cancelled", "ts": 1795635024100, "seq": 121, "jobId": "job_3f9a1c0e7b2d4a68", "stageIndex": 1, "elapsedMs": 1619, "outputs": [] }
```

`outputs` lists batch images already saved (kept). A cancelled 3D job leaves no files: its partially written asset folder is removed.

Exactly one of `job.completed`, `job.error`, `job.cancelled` terminates every job that produced a `job.started`.

### 4.3 Binary preview frame

Little-endian, 16-byte header followed by a complete JPEG file.

| Offset | Size | Type | Field | Value |
|---|---|---|---|---|
| 0 | 4 | ASCII | magic | `"PREV"` = `0x50 0x52 0x45 0x56` |
| 4 | 4 | `uint32` LE | `step` | 1-based sampler step this image shows |
| 8 | 4 | `uint32` LE | `totalSteps` | Step count of the stage |
| 12 | 4 | `uint32` LE | `stageIndex` | Index into the `stages` array of the active job's `job.started` |
| 16 | … | bytes | JPEG | Baseline JPEG, sRGB, starts with `0xFF 0xD8` |

Rules:

1. **Binding.** A frame belongs to the job named by the most recent `job.started` that has not been terminated. A frame received when no job is active must be discarded by the client.
2. **Ordering.** For each sampler step the server sends the `job.progress` text event first and the binary frame second, on the same connection, without interleaving another job's data (there is only one job). The frame's `batchIndex` is the `batchIndex` of that preceding `job.progress`.
3. **Cadence.** One frame per sampler step for stages with `preview: true`. `step` 1 is sent as soon as the first denoising step completes — this is what flips the UI from murmuration-only to live preview.
4. **Image.** Long edge ≤ 768 px, aspect ratio equal to the final output, JPEG quality 80, target ≤ 256 KB. Z-Image previews are decoded with TAEF1 (`vae_approx/taef1_decoder.safetensors`). Qwen-Image 2.1 previews use the 64-channel Latent2RGB projection (`comfy.latent_formats.QwenImage21`) upscaled bicubically to a 512 px long edge.
5. **Back-pressure.** If a client's send buffer is not drained, the server drops that client's older pending preview frames and keeps only the newest. Text events are never dropped.
6. **Tolerance.** Clients must ignore binary frames shorter than 18 bytes or with an unknown magic, and must not assume every step is delivered.

Reference encode/decode:

```python
# engine
header = struct.pack("<4sIII", b"PREV", step, total_steps, stage_index)
await ws.send_bytes(header + jpeg_bytes)
```

```ts
// renderer — socket.binaryType = "arraybuffer"
function parsePreview(buf: ArrayBuffer) {
  if (buf.byteLength < 18) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x50524556) return null;      // "PREV"
  return {
    step: dv.getUint32(4, true),
    totalSteps: dv.getUint32(8, true),
    stageIndex: dv.getUint32(12, true),
    jpeg: new Blob([new Uint8Array(buf, 16)], { type: "image/jpeg" }),
  };
}
```

### 4.4 Stage tables (normative ids and order)

| Job mode | Stages (`index: id` — label) | `preview: true` |
|---|---|---|
| `t2i` | `0: prepare` — Prepare · `1: sample` — Sample · `2: decode` — Decode | `sample` |
| `qwen_edit`, `inpaint`, `img2img` | `0: prepare` · `1: sample` · `2: decode` | `sample` |
| `remove_bg` | `0: prepare` — Prepare · `1: matte` — Matte | none |
| `t23d`, `i23d` | `0: source` — Source · `1: cutout` — Cutout · `2: depth` — Depth · `3: structure` — Structure · `4: shape` — Shape · `5: texture` — Texture · `6: mesh` — Mesh | `source` (in `t23d` only) |

- `prepare` covers prompt enhancement (`phase: "enhancing"`), model loading (`"loading"`) and text encoding (`"encoding"`).
- For `batchSize > 1`, `stageIndex` cycles `1, 2, 1, 2, …`; `batchIndex` and `progress` disambiguate.
- 3D jobs always list all seven stages; inapplicable ones are reported through `job.stage_preview` with `status: "skipped"`. Model loading inside a 3D stage is reported as `phase: "loading"` within that stage.

### 4.5 `models.status` and `telemetry`

#### `models.status`

```json
{ "type": "models.status", "ts": 1795635030000, "seq": 140, "models": [ /* ModelFamilyStatus[] — all five, same shape and order as GET /api/models */ ] }
```

Sent on connect and whenever any family's `state` changes.

#### `telemetry`

```json
{
  "type": "telemetry", "ts": 1795635030000, "seq": 141,
  "source": "engine",
  "vramTotalMb": 104448, "vramUsedMb": 20112, "vramFreeMb": 84336, "vramProcessMb": 19876,
  "ramTotalMb": 65536, "ramUsedMb": 31744, "ramProcessMb": 6120,
  "gpuUtilPct": null,
  "activeJobId": null
}
```

Sent on connect, then every **2000 ms** while idle and every **500 ms** while a job is active, only while at least one client is connected.

### 4.6 Event sequences

**Text-to-image, one image**

```
POST /api/generate/t2i                              → 202 { jobId }
job.started      stages [prepare, sample, decode]
job.progress     prepare  phase=enhancing           (only if enhancePrompt)
job.progress     prepare  phase=loading   + models.status (warming → warm)
job.progress     prepare  phase=encoding  [enhancedPrompt once]
job.progress     sample   phase=sampling  step 1/9
<binary PREV step=1 totalSteps=9 stageIndex=1>
…                                                   (steps 2–9, each: progress then PREV)
job.progress     decode   phase=decoding
job.progress     decode   phase=saving
job.progress     decode   phase=saved     output={OutputItem}
job.completed    outputs=[OutputItem]
```

**Image-to-3D with Pixal3D**

```
POST /api/generate/3d                               → 202 { jobId }
job.started      stages [source … mesh]
job.stage_preview  source     done   imagePath=…\stages\00_source.webp
job.progress       cutout     phase=loading / processing
job.stage_preview  cutout     done
job.progress       depth      phase=loading / processing
job.stage_preview  depth      done
job.progress       structure  phase=sampling step n/N …
job.stage_preview  structure  done
job.progress       shape      phase=sampling … / decoding
job.stage_preview  shape      done
job.progress       texture    phase=sampling … / decoding
job.stage_preview  texture    done
job.progress       mesh       phase=processing / saving
job.stage_preview  mesh       done
job.progress       mesh       phase=saved  output={OutputItem}
job.completed      outputs=[OutputItem]
```

---

## 5. Output files and the `.studio.json` sidecar

### 5.1 Directory layout under `outputsDir`

```
outputs\
  images\<yyyy-MM-dd>\<stem>.png                 text-to-image results
  images\<yyyy-MM-dd>\<stem>.studio.json
  edits\<yyyy-MM-dd>\<stem>.png                  edit results (RGBA for remove_bg)
  edits\<yyyy-MM-dd>\<stem>.studio.json
  3d\<stem>\<stem>.glb                           one folder per 3D asset
  3d\<stem>\<stem>.studio.json
  3d\<stem>\source.png
  3d\<stem>\cutout.png                           absent when the cutout stage was skipped
  3d\<stem>\preview.webp
  3d\<stem>\stages\00_source.webp … 06_mesh.webp one per stage that produced a thumbnail
  uploads\up_<16hex>.png                         reference/source uploads (no sidecar)
  .cache\thumbs\<id>.webp                        Library thumbnails (written by studio-core)
```

- `<stem>` = `<yyyyMMdd>_<HHmmss>_<first 8 hex of id>` in **local time**, e.g. `20261125_143022_5d0c1e7a`. The date folder is the local date.
- The sidecar always sits next to its primary file and shares its stem: `<stem>.studio.json`.
- For `kind: "3d"`, the sidecar's directory is the **asset directory** and belongs entirely to that item.
- Write order (engine): primary file and all auxiliary files first, sidecar last, each written to `<name>.tmp` then atomically renamed. A primary file without a sidecar is an incomplete item and is ignored by scanners (reported as an orphan).
- PNG outputs additionally embed the sidecar JSON in an `iTXt` chunk (UTF-8) with keyword `studio`, so metadata survives a copy.

### 5.2 Sidecar schema (`schemaVersion: 1`)

Every field is always present; use `null`, `""` or `[]` where not applicable.

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | |
| `id` | string | 16 hex, unique per output |
| `jobId` | string | Job that produced it (shared by a batch) |
| `kind` | `"image" \| "edit" \| "3d"` | Library category |
| `mode` | `"t2i" \| "qwen_edit" \| "inpaint" \| "img2img" \| "remove_bg" \| "t23d" \| "i23d"` | |
| `createdAt` | string | ISO-8601 UTC |
| `elapsedMs` | int | Wall time attributable to this output |
| `file` | string | Primary file name (no directory) |
| `mime` | `"image/png" \| "model/gltf-binary"` | |
| `bytes` | int | Size of the primary file |
| `width`, `height` | int \| null | Pixel size of an image output; `null` for 3D |
| `hasAlpha` | bool | `true` when the PNG has a non-opaque alpha channel |
| `model.family` | `FamilyId` | Principal model family |
| `model.label` | string | Display label at creation time |
| `model.files` | string[] | `relPath`s of the model files actually loaded |
| `params.prompt` | string | The user's prompt as typed (`""` for `remove_bg` and `i23d`) |
| `params.negativePrompt` | string | |
| `params.enhanced` | bool | Whether an enhanced prompt was used |
| `params.enhancedPrompt` | string \| null | The text actually encoded when `enhanced` is true |
| `params.seed` | int | Seed of **this** output (`seed + batchIndex`) |
| `params.steps`, `params.cfg` | number \| null | |
| `params.sampler`, `params.scheduler` | string \| null | |
| `params.denoise` | number \| null | `inpaint` / `img2img` only |
| `params.resolution` | int \| null | `qwen_edit` only |
| `params.batchIndex`, `params.batchSize` | int | `0` and `1` when not a batch |
| `inputs.sourceId` | string \| null | Library item this was derived from |
| `inputs.imagePath` | string \| null | Absolute path given as input, if the request used a path |
| `inputs.referencePaths` | string[] | `qwen_edit` references, in order |
| `mesh` | object \| null | 3D only, see below |
| `stages` | array | 3D only (else `[]`), see below |
| `preview` | string \| null | 3D only: file name of the preview render (`"preview.webp"`) |
| `favorite` | bool | Written as `false`; toggled later by Electron main |
| `app` | object | `{ "name": "Studio", "engineVersion": "1.0.0", "apiVersion": 1 }` |

`mesh` object:

| Field | Type | Meaning |
|---|---|---|
| `engine` | `"pixal3d" \| "trellis2"` | |
| `format` | `"glb"` | |
| `vertices`, `triangles` | int | Of the written file |
| `bounds` | `{ "min": [x,y,z], "max": [x,y,z] }` | In metres, Y-up, after normalisation |
| `size` | `[x, y, z]` | `max − min` |
| `upAxis` | `"Y"` | |
| `unit` | `"m"` | |
| `targetFaces`, `remeshResolution`, `textureSize` | int | Settings used (`textureSize` is 2048) |
| `removeBackground` | bool | |
| `hasTexture` | bool | |

`stages[]` entries: `{ "id": "depth", "label": "Depth", "status": "done" | "skipped", "file": "stages/02_depth.webp" | null, "elapsedMs": 2140 }` — always seven entries in pipeline order; `file` is relative to the asset directory with forward slashes.

**Example — image**

```json
{
  "schemaVersion": 1,
  "id": "5d0c1e7a9b3f4a21",
  "jobId": "job_3f9a1c0e7b2d4a68",
  "kind": "image",
  "mode": "t2i",
  "createdAt": "2026-11-25T19:30:22.481Z",
  "elapsedMs": 4209,
  "file": "20261125_143022_5d0c1e7a.png",
  "mime": "image/png",
  "bytes": 1482113,
  "width": 1024,
  "height": 1024,
  "hasAlpha": false,
  "model": {
    "family": "z_image",
    "label": "Z-Image Turbo",
    "files": [
      "diffusion_models/z_image_turbo_bf16_nsfw_v2.safetensors",
      "text_encoders/qwen3_4b_z_image_abliterated.safetensors",
      "vae/z_image_ae.safetensors"
    ]
  },
  "params": {
    "prompt": "A grey heron standing in morning fog",
    "negativePrompt": "",
    "enhanced": false,
    "enhancedPrompt": null,
    "seed": 3829104412,
    "steps": 9,
    "cfg": 1.0,
    "sampler": "euler",
    "scheduler": "simple",
    "denoise": null,
    "resolution": null,
    "batchIndex": 0,
    "batchSize": 1
  },
  "inputs": { "sourceId": null, "imagePath": null, "referencePaths": [] },
  "mesh": null,
  "stages": [],
  "preview": null,
  "favorite": false,
  "app": { "name": "Studio", "engineVersion": "1.0.0", "apiVersion": 1 }
}
```

**Example — 3D (fields that differ)**

```json
{
  "kind": "3d",
  "mode": "i23d",
  "file": "20261125_143501_7c2e9b10.glb",
  "mime": "model/gltf-binary",
  "bytes": 28411904,
  "width": null, "height": null, "hasAlpha": false,
  "model": { "family": "pixal3d", "label": "3D · Pixal3D", "files": ["diffusion_models/pixal3d_bf16.safetensors", "vae/trellis_2_shape_vae_bf16.safetensors", "vae/trellis_2_texture_vae_bf16.safetensors", "clip_vision/dino_v3_L_naf_fp32.safetensors", "geometry_estimation/moge_2_vitl_normal_fp16.safetensors", "background_removal/birefnet.safetensors"] },
  "params": { "prompt": "", "negativePrompt": "", "enhanced": false, "enhancedPrompt": null, "seed": 771204, "steps": null, "cfg": null, "sampler": null, "scheduler": null, "denoise": null, "resolution": null, "batchIndex": 0, "batchSize": 1 },
  "inputs": { "sourceId": "5d0c1e7a9b3f4a21", "imagePath": "C:\\Users\\winbloat\\Studio\\outputs\\images\\2026-11-25\\20261125_143022_5d0c1e7a.png", "referencePaths": [] },
  "mesh": {
    "engine": "pixal3d", "format": "glb",
    "vertices": 152340, "triangles": 300000,
    "bounds": { "min": [-0.41, 0.0, -0.32], "max": [0.41, 1.0, 0.32] },
    "size": [0.82, 1.0, 0.64],
    "upAxis": "Y", "unit": "m",
    "targetFaces": 300000, "remeshResolution": 512, "textureSize": 2048,
    "removeBackground": true, "hasTexture": true
  },
  "stages": [
    { "id": "source",    "label": "Source",    "status": "done", "file": "stages/00_source.webp",    "elapsedMs": 12 },
    { "id": "cutout",    "label": "Cutout",    "status": "done", "file": "stages/01_cutout.webp",    "elapsedMs": 890 },
    { "id": "depth",     "label": "Depth",     "status": "done", "file": "stages/02_depth.webp",     "elapsedMs": 2140 },
    { "id": "structure", "label": "Structure", "status": "done", "file": "stages/03_structure.webp", "elapsedMs": 9800 },
    { "id": "shape",     "label": "Shape",     "status": "done", "file": "stages/04_shape.webp",     "elapsedMs": 31200 },
    { "id": "texture",   "label": "Texture",   "status": "done", "file": "stages/05_texture.webp",   "elapsedMs": 27400 },
    { "id": "mesh",      "label": "Mesh",      "status": "done", "file": "stages/06_mesh.webp",      "elapsedMs": 18900 }
  ],
  "preview": "preview.webp"
}
```

### 5.3 `OutputItem` (the in-flight form)

`OutputItem` = every sidecar field **plus** these resolved, absolute fields. It is the shape used in `job.completed`, `job.progress.output`, `GET /api/outputs`, `studio-core library-scan` and `window.studio.library.scan()`.

| Field | Type | Value |
|---|---|---|
| `path` | string | Absolute path of the primary file |
| `dir` | string | Absolute directory containing the sidecar |
| `sidecarPath` | string | Absolute path of the `.studio.json` |
| `previewPath` | string \| null | Absolute path of `preview` (3D), else `null` |
| `thumbPath` | string \| null | `<outputsDir>\.cache\thumbs\<id>.webp` **if that file exists**, else `null` |
| `assetDir` | string \| null | Equal to `dir` for `kind: "3d"`, else `null` |

Stage `file` values stay relative; resolve them against `dir`.

### 5.4 Who writes what

| File | Created by | Later modified by |
|---|---|---|
| Primary output, auxiliary files, sidecar | Engine | Sidecar `favorite` only, by Electron main (read–modify–write to a temp file, atomic rename) |
| `.cache\thumbs\*.webp` | `studio-core library-scan --thumbs` | Removed by `studio-core delete` |
| `uploads\*` | Engine | Nobody |
| Deletion of any output | `studio-core delete` (Recycle Bin) only | — |

---

## 6. `studio-core.exe` CLI

Binary: `C:\Users\winbloat\Studio\core\target\release\studio-core.exe` (packaged next to the app as `resources\studio-core.exe`). Stateless, one invocation per call, no network access.

### 6.1 Global behaviour

```
studio-core <command> [flags]
studio-core --version          prints "studio-core 1.0.0" and exits 0
```

| Aspect | Rule |
|---|---|
| stdout | Exactly **one JSON object followed by `\n`** (compact). With `telemetry --watch`, one JSON object per line (NDJSON) until killed. Nothing else is ever written to stdout. |
| stderr | Human-readable diagnostics; also appended to `logs\core.log` when `STUDIO_LOG_DIR` is set. Never parsed. |
| Global flag | `--pretty` — indent the JSON (debugging only). |
| Envelope (success) | `{ "ok": true, "command": "<name>", "version": "1.0.0", "elapsedMs": 0.84, "data": { … } }` |
| Envelope (failure) | `{ "ok": false, "command": "<name>", "version": "1.0.0", "elapsedMs": 0.2, "error": { "code": "DIR_NOT_FOUND", "message": "…", "path": "…" } }` |
| Paths | Absolute, native separators; `relPath` values use `/`. Input paths may use either separator. |

| Exit code | Meaning | stdout |
|---|---|---|
| `0` | Success | `ok: true` |
| `1` | Runtime failure (I/O, parse, OS API) | `ok: false` |
| `2` | Usage error (unknown command/flag, missing required flag) | `ok: false`, `error.code: "USAGE"` |
| `3` | Partial success — some items failed | `ok: true`, with a non-empty `failed` array in `data` |
| `4` | A required directory or file does not exist | `ok: false`, `error.code: "DIR_NOT_FOUND"` or `"FILE_NOT_FOUND"` |

Error codes: `USAGE`, `DIR_NOT_FOUND`, `FILE_NOT_FOUND`, `IO`, `PARSE`, `OUTSIDE_ROOT`, `TRASH_FAILED`, `OS_API`.

### 6.2 `scan-models`

```
studio-core scan-models --dir <modelsDir> [--max-metadata-bytes 4096]
```

Recursively lists model files (`.safetensors`, `.gguf`, `.pt`, `.pth`, `.ckpt`, `.bin`), skipping directories whose name starts with `.`. For `.safetensors` it reads only the header (8-byte little-endian length, then that many bytes of JSON) — never tensor data. Target: under 1 ms per file on a warm cache.

`data`:

```json
{
  "dir": "C:\\Users\\winbloat\\ComfyUI_windows_portable\\ComfyUI\\models",
  "fileCount": 20,
  "totalBytes": 79782000000,
  "files": [
    {
      "relPath": "diffusion_models/z_image_turbo_bf16_nsfw_v2.safetensors",
      "path": "C:\\…\\models\\diffusion_models\\z_image_turbo_bf16_nsfw_v2.safetensors",
      "category": "diffusion_models",
      "name": "z_image_turbo_bf16_nsfw_v2.safetensors",
      "ext": "safetensors",
      "bytes": 12566033952,
      "modifiedAt": "2026-10-02T08:14:55.000Z",
      "header": {
        "headerBytes": 184320,
        "tensorCount": 1204,
        "parameterCount": 6150000000,
        "dtypes": { "BF16": 1204 },
        "primaryDtype": "BF16",
        "metadata": { "modelspec.architecture": "z-image-turbo", "format": "pt" },
        "metadataTruncated": false
      },
      "headerError": null
    }
  ]
}
```

| Field | Rule |
|---|---|
| `category` | First path segment of `relPath` (`""` for files directly in `dir`) |
| `header` | `null` for non-safetensors files and when the header cannot be read (then `headerError` is a short string) |
| `parameterCount` | Σ over tensors of the product of `shape` |
| `dtypes` | Tensor count per dtype string as written in the header; `primaryDtype` is the dtype with the most **parameters** |
| `metadata` | The header's `__metadata__` map (string → string). Each value is cut to `--max-metadata-bytes`; `metadataTruncated` says whether any was cut. |

Files are sorted by `relPath`. A per-file header failure does not change the exit code. The numbers in the example are illustrative; `bytes` is real.

### 6.3 `library-scan`

```
studio-core library-scan --dir <outputsDir>
    [--kind all|image|edit|3d]     default all
    [--thumbs]                     create missing or stale thumbnails
    [--thumb-size 512]             long edge in px (64–1024)
    [--limit <n>] [--offset <n>]   applied after sorting; default: everything
    [--since <ISO-8601>]           only items with createdAt >= this
```

Walks `images\`, `edits\`, `3d\` for `*.studio.json`, parses each, checks that the primary file exists, and emits `OutputItem`s sorted by `createdAt` descending then `id` ascending.

With `--thumbs`, for every listed item whose thumbnail is missing or older than its source, it writes `<outputsDir>\.cache\thumbs\<id>.webp` in parallel (all cores): WebP quality 82, long edge `--thumb-size`, aspect preserved, alpha preserved. Thumbnail source: the primary PNG for images and edits; `preview` for 3D (no thumbnail if the item has no preview).

`data`:

```json
{
  "dir": "C:\\Users\\winbloat\\Studio\\outputs",
  "total": 248,
  "items": [ /* OutputItem[] */ ],
  "thumbs": { "generated": 3, "upToDate": 245, "failed": [] },
  "invalid": [ { "sidecarPath": "C:\\…\\x.studio.json", "code": "PARSE", "message": "…" } ],
  "orphans": [ "C:\\…\\images\\2026-11-25\\20261125_150000_ab12cd34.png" ]
}
```

`total` counts items matching `--kind`/`--since` before `--limit`/`--offset`. `invalid` lists sidecars that failed to parse or whose primary file is missing (`code: "FILE_NOT_FOUND"`). `orphans` lists primary-looking files (`.png`, `.glb`) without a sidecar. Exit code `3` when `thumbs.failed` is non-empty; `invalid` and `orphans` do not affect the exit code. An `outputsDir` with none of the three subfolders yields `total: 0` and exit `0`.

### 6.4 `delete`

```
studio-core delete --dir <outputsDir> --sidecar <path> [--sidecar <path> …] [--permanent]
studio-core delete --dir <outputsDir> --stdin [--permanent]        stdin: { "sidecars": ["…", "…"] }
```

For each sidecar:

1. Reject it (`OUTSIDE_ROOT`) unless its canonical path is inside `--dir`.
2. Read it to learn `id`, `kind` and `file`.
3. Send to the **Windows Recycle Bin**: for `kind: "3d"` the whole asset directory; otherwise the primary file and the sidecar. All paths of one invocation go to the shell in a single operation where the API allows.
4. Permanently remove `.cache\thumbs\<id>.webp` (it is a cache).
5. Remove the date folder if it is now empty.

`--permanent` deletes instead of recycling (not used by the UI). If the sidecar is unreadable but inside `--dir`, the sidecar and a same-stem `.png`/`.glb` next to it are recycled.

`data`:

```json
{
  "deleted": [
    { "id": "5d0c1e7a9b3f4a21", "sidecarPath": "C:\\…\\20261125_143022_5d0c1e7a.studio.json",
      "trashed": ["C:\\…\\20261125_143022_5d0c1e7a.png", "C:\\…\\20261125_143022_5d0c1e7a.studio.json"] }
  ],
  "failed": [
    { "sidecarPath": "C:\\…\\other.studio.json", "code": "TRASH_FAILED", "message": "…" }
  ],
  "recycleBin": true
}
```

Exit `0` when `failed` is empty, `3` when some succeeded and some failed, `1` when all failed.

### 6.5 `telemetry`

```
studio-core telemetry [--pid <pid> …] [--watch <ms>]
```

One sample, or with `--watch` one NDJSON envelope every `<ms>` (minimum 250) until the process is killed or stdout closes.

`data`:

```json
{
  "ts": 1795635030000,
  "source": "core",
  "vramTotalMb": 104448, "vramUsedMb": 20112, "vramFreeMb": 84336,
  "ramTotalMb": 65536, "ramUsedMb": 31744, "ramFreeMb": 33792,
  "cpuUtilPct": 6.5,
  "gpu": {
    "name": "AMD Radeon(TM) 8060S Graphics",
    "dedicatedTotalMb": 512, "dedicatedUsedMb": 480,
    "sharedTotalMb": 103936, "sharedUsedMb": 19632,
    "utilPct": 3.0
  },
  "processes": [
    { "pid": 18244, "name": "python.exe", "alive": true, "rssMb": 6120, "privateMb": 7010,
      "gpuDedicatedMb": 410, "gpuSharedMb": 19466 }
  ]
}
```

- `vram*Mb` are the normalised figures the UI uses: `vramTotalMb = dedicatedTotalMb + sharedTotalMb`, `vramUsedMb = dedicatedUsedMb + sharedUsedMb`, `vramFreeMb = total − used`. On this unified-memory system almost all of it is shared memory.
- GPU figures come from DXGI adapter memory info and the Windows `GPU Adapter Memory` / `GPU Process Memory` / `GPU Engine` performance counters. Any figure the OS cannot provide is `null` (never `0`).
- A `--pid` that does not exist yields `{ "pid": n, "alive": false }` with the other fields `null`.
- **Precedence in the UI**: while the engine WebSocket is connected, engine `telemetry` events are authoritative; `studio-core telemetry` is used only when the engine is not running.

---

## 7. Electron: `window.studio` and IPC

### 7.1 Rules

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload exposes exactly one global through `contextBridge.exposeInMainWorld("studio", api)`.
- The TypeScript interface is `StudioApi` in section 8. `app/electron/preload.ts` and `app/src/**` both import it from `app/src/shared/contract.ts`; neither redeclares it.
- Request/response uses `ipcRenderer.invoke(channel, payload)` ↔ `ipcMain.handle`. Every invoke takes **one** argument (an object or primitive, or nothing) and resolves to the documented value.
- Events use `webContents.send(channel, payload)`; the preload wraps them as `onX(cb): () => void` (returns an unsubscribe function) and never exposes `ipcRenderer` or the event object.
- **Errors**: a failed invoke rejects with an `Error` whose `message` is a JSON string `{"code":"…","message":"…","details":{…}}`. The renderer helper `parseIpcError(e)` turns it into a `StudioError`. Codes are in Appendix C.
- Main validates every path argument: it must be absolute, and for destructive or write operations it must resolve inside `outputsDir`.

### 7.2 Custom protocol `studio://`

Registered as privileged (`standard`, `secure`, `supportFetchAPI`, `stream`) before `app.ready`.

| URL | Serves |
|---|---|
| `studio://app/…` | The built renderer (production). In development the renderer is `http://localhost:5173`. |
| `studio://outputs/<relPath>` | A file under `outputsDir`; `<relPath>` is percent-encoded with forward slashes, e.g. `studio://outputs/images/2026-11-25/20261125_143022_5d0c1e7a.png` |
| `studio://thumbs/<id>.webp` | `<outputsDir>\.cache\thumbs\<id>.webp` |
| `studio://file/<base64url(absolute path)>` | A file outside `outputsDir` (dropped references, model previews). Allowed extensions only: `.png .jpg .jpeg .webp .glb .gltf`. |

Path traversal outside the mapped root → `403`. Missing file → `404`. Responses carry `Cache-Control: no-cache` for `outputs`/`file` and `max-age=31536000, immutable` for `thumbs` with a `?v=<mtimeMs>` query added by `toUrl`.

`window.studio.files.toUrl(absPath)` is synchronous and pure (the preload caches `outputsDir` at load): inside `outputsDir\.cache\thumbs` → `studio://thumbs/…`; inside `outputsDir` → `studio://outputs/…`; otherwise → `studio://file/…`.

Renderer CSP:
`default-src 'self' studio:; img-src 'self' studio: blob: data:; connect-src 'self' studio: http://127.0.0.1:48210 ws://127.0.0.1:48210; style-src 'self' 'unsafe-inline'; font-src 'self' studio: data:; worker-src 'self' blob:; script-src 'self'` (development adds `http://localhost:5173 ws://localhost:5173`).

### 7.3 Channels

**Invoke channels** (`renderer → main`)

| `window.studio` method | Channel | Payload | Resolves to |
|---|---|---|---|
| `app.getInfo()` | `studio:app:get-info` | — | `AppInfo` |
| `window.minimize()` | `studio:window:minimize` | — | `void` |
| `window.toggleMaximize()` | `studio:window:toggle-maximize` | — | `void` |
| `window.close()` | `studio:window:close` | — | `void` |
| `window.getState()` | `studio:window:get-state` | — | `WindowState` |
| `window.setTheme(theme)` | `studio:window:set-theme` | `ThemeName` | `void` |
| `engine.getStatus()` | `studio:engine:get-status` | — | `EngineProcessStatus` |
| `engine.start()` | `studio:engine:start` | — | `EngineProcessStatus` |
| `engine.restart()` | `studio:engine:restart` | — | `EngineProcessStatus` |
| `engine.stop()` | `studio:engine:stop` | — | `EngineProcessStatus` |
| `core.scanModels()` | `studio:core:scan-models` | — | `ModelScan` |
| `core.telemetry()` | `studio:core:telemetry` | — | `CoreTelemetry` |
| `library.scan(opts?)` | `studio:library:scan` | `LibraryScanOptions \| undefined` | `LibraryScanResult` |
| `library.delete(sidecarPaths)` | `studio:library:delete` | `string[]` | `LibraryDeleteResult` |
| `library.setFavorite(sidecarPath, favorite)` | `studio:library:set-favorite` | `{ sidecarPath, favorite }` | `OutputItem` |
| `files.reveal(path)` | `studio:files:reveal` | `string` | `void` |
| `files.openImages(opts?)` | `studio:files:open-images` | `{ multiple?: boolean }` | `string[]` (absolute paths; `[]` if cancelled) |
| `files.saveCopy(path, suggestedName?)` | `studio:files:save-copy` | `{ path, suggestedName? }` | `string \| null` (destination, or `null` if cancelled) |
| `clipboard.writeImage(path)` | `studio:clipboard:write-image` | `string` | `void` |
| `clipboard.writeText(text)` | `studio:clipboard:write-text` | `string` | `void` |
| `clipboard.readImage()` | `studio:clipboard:read-image` | — | `string \| null` (PNG data URL) |
| `mesh.export(req)` | `studio:mesh:export` | `MeshExportRequest` | `MeshExportResult \| null` (`null` if the save dialog was cancelled) |
| `blender.getStatus()` | `studio:blender:get-status` | — | `BlenderStatus` |
| `blender.import(req)` | `studio:blender:import` | `BlenderImportRequest` | `BlenderImportResult` |
| `blender.launch()` | `studio:blender:launch` | — | `BlenderStatus` |
| `settings.get()` | `studio:settings:get` | — | `AppSettings` |
| `settings.set(patch)` | `studio:settings:set` | `Partial<AppSettings>` | `AppSettings` |

`files.toUrl` and `files.pathForFile(file)` (wrapping `webUtils.getPathForFile` for drag-and-drop) are synchronous preload functions with no channel.

**Event channels** (`main → renderer`)

| `window.studio` subscription | Channel | Payload | Fired |
|---|---|---|---|
| `window.onState(cb)` | `studio:evt:window-state` | `WindowState` | Maximize, unmaximize, focus, blur, fullscreen changes |
| `engine.onStatus(cb)` | `studio:evt:engine-status` | `EngineProcessStatus` | Every engine process state change |
| `blender.onStatus(cb)` | `studio:evt:blender-status` | `BlenderStatus` | When connectivity or version changes |
| `library.onChanged(cb)` | `studio:evt:library-changed` | `LibraryChange` | After delete / set-favorite complete |
| `settings.onChanged(cb)` | `studio:evt:settings-changed` | `AppSettings` | After any `settings.set` |

### 7.4 Main-process behaviour behind the channels

| Area | Behaviour |
|---|---|
| Engine lifecycle | On app ready: probe `GET /api/health` (500 ms). If healthy with `apiVersion: 1`, adopt it (`managed: false`); else spawn per 2.4 (`managed: true`). States: `stopped → starting → ready → stopping → stopped`, or `crashed` on unexpected exit. While `starting`, poll health every 250 ms up to 60 s. On crash, auto-restart once after 1 s; a second crash within 60 s stays `crashed` until `engine.restart()`. |
| `core.*` | Spawn `studio-core.exe` with the resolved directories, parse the envelope, return `data`. `core.telemetry()` passes `--pid` of the engine when known. Timeouts: 10 s (`scan-models`, `telemetry`), 120 s (`library-scan --thumbs`), 60 s (`delete`). |
| `library.scan` | `studio-core library-scan --dir <outputsDir> --thumbs` plus the given options. |
| `library.delete` | `studio-core delete --dir <outputsDir> --stdin`. Exit `3` resolves normally (inspect `failed`); exit `1` rejects with `DELETE_FAILED`. Emits `library-changed`. |
| `library.setFavorite` | Read–modify–write of the sidecar's `favorite` field, atomic rename; returns the updated `OutputItem`. |
| `files.saveCopy` | Native save dialog (default directory: last used, else Pictures / 3D Objects), then copy. |
| `files.reveal` | `shell.showItemInFolder`. |
| `clipboard.writeImage` | `nativeImage.createFromPath` → `clipboard.writeImage`. For a `.glb` item pass its `previewPath`. |
| `mesh.export` | Native save dialog (default name `<stem>.<format>`). `glb`: file copy. Others: run `export_mesh.py` (9.3) into the chosen path with a 180 s timeout, log to `logs\blender-export.log`. Rejects with `BLENDER_NOT_INSTALLED` when `blenderExe` is missing, `EXPORT_FAILED` otherwise. |
| Blender status | Poll `GET http://127.0.0.1:48215/health` (timeout 400 ms) every 3 s while the window is focused, every 15 s otherwise. Emit `blender-status` only on change. |
| `blender.import` | `POST http://127.0.0.1:48215/import`, timeout 90 s. Unreachable → reject `BLENDER_UNREACHABLE`. |
| `blender.launch` | If the add-on file is missing or older than `blender\studio_bridge.py`, copy it to `%APPDATA%\Blender Foundation\Blender\5.3\scripts\addons\studio_bridge.py`; start `<blenderExe> --addons studio_bridge` detached; resolve with the current status (connection arrives later via `blender-status`). Missing executable → `BLENDER_NOT_INSTALLED`. |
| Settings | `%APPDATA%\Studio\settings.json`, written atomically, debounced 300 ms. |
| `window.setTheme` | `nativeTheme.themeSource`, `win.setTitleBarOverlay({ symbolColor })`, opaque `backgroundColor` when `material` is `"none"`. |

---

## 8. Shared TypeScript contract — `app/src/shared/contract.ts`

Copy this block verbatim. The Engine team mirrors the wire types in Python (pydantic models or `TypedDict`s with the same field names); the Rust team mirrors `OutputItem`, `ModelScan`, `CoreTelemetry` and the envelope with `serde(rename_all = "camelCase")`.

```ts
/* Studio shared contract — apiVersion 1. Do not edit without changing docs/API_CONTRACT.md. */

export const API_VERSION = 1 as const;
export const ENGINE_HTTP = "http://127.0.0.1:48210";
export const ENGINE_WS = "ws://127.0.0.1:48210/ws";
export const BLENDER_HTTP = "http://127.0.0.1:48215";
export const SEED_MAX = 4294967295;
export const PREVIEW_MAGIC = 0x50524556; // "PREV" read as big-endian uint32
export const PREVIEW_HEADER_BYTES = 16;

/* ───────── Enumerations ───────── */

export type FamilyId = "z_image" | "qwen_image" | "pixal3d" | "trellis2" | "birefnet";
export type ModelState = "cold" | "warming" | "warm" | "unloading";
export type ImageModel = "z_image" | "qwen_image";
export type Engine3D = "pixal3d" | "trellis2";
export type OutputKind = "image" | "edit" | "3d";
export type EditMode = "qwen_edit" | "inpaint" | "img2img" | "remove_bg";
export type Mode3D = "t23d" | "i23d";
export type JobMode = "t2i" | EditMode | Mode3D;
export type EnhanceStyle = "photo" | "3d" | "edit";
export type AutoUnloadMinutes = 0 | 5 | 10 | 15 | 30;
export type RemeshResolution = 512 | 768 | 1024;
export type ModelFileRole =
  | "diffusion" | "text_encoder" | "vae" | "lora"
  | "preview_decoder" | "vision_encoder" | "geometry" | "matting";
export type JobPhase =
  | "enhancing" | "loading" | "encoding" | "sampling"
  | "decoding" | "processing" | "saving" | "saved";
export type ImageStageId = "prepare" | "sample" | "decode" | "matte";
export type Stage3DId = "source" | "cutout" | "depth" | "structure" | "shape" | "texture" | "mesh";
export type StageId = ImageStageId | Stage3DId;

export type ErrorCode =
  | "BAD_REQUEST" | "INVALID_DIMENSIONS" | "UNKNOWN_FAMILY" | "MODEL_FILES_MISSING"
  | "BUSY" | "NOT_FOUND" | "IMAGE_DECODE_FAILED" | "IMAGE_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE" | "FORBIDDEN_ORIGIN" | "OUT_OF_MEMORY"
  | "INKLING_UNAVAILABLE" | "SHUTTING_DOWN" | "INTERNAL"
  // client / Electron side
  | "ENGINE_UNREACHABLE" | "CORE_FAILED" | "DELETE_FAILED" | "INVALID_PATH"
  | "BLENDER_UNREACHABLE" | "BLENDER_NOT_INSTALLED" | "BLENDER_IMPORT_FAILED" | "EXPORT_FAILED";

export interface StudioError { code: ErrorCode; message: string; details?: Record<string, unknown>; }
export interface ErrorResponse { error: StudioError; }

/* ───────── Engine: health, models, settings, telemetry ───────── */

export interface Health {
  status: "ok" | "starting" | "shutting_down";
  apiVersion: 1;
  engineVersion: string;
  pid: number;
  device: string;
  vramTotalMb: number; vramUsedMb: number; vramFreeMb: number;
  ramTotalMb: number; ramUsedMb: number;
  modelsDir: string;
  outputsDir: string;
  inklingAvailable: boolean;
  activeJobId: string | null;
}

export interface ModelFile {
  role: ModelFileRole;
  relPath: string;        // forward slashes, relative to modelsDir
  path: string;           // absolute
  bytes: number;          // 0 when missing
  exists: boolean;
  sharedWith: FamilyId[];
}

export interface FamilyDefaults {
  steps: number; cfg: number; sampler: string; scheduler: string;
  sizeMultiple: 16 | 32; minSize: number; maxSize: number;
  maxReferenceImages: number;
}

export interface ModelFamilyStatus {
  id: FamilyId;
  label: string;
  state: ModelState;
  vramEstimateMb: number;
  diskBytes: number;
  complete: boolean;
  lastUsedAt: string | null;
  files: ModelFile[];
  defaults: FamilyDefaults | null;
  samplers: string[] | null;
  schedulers: string[] | null;
}

export interface WarmupRequest { family: FamilyId; }
export interface WarmupResponse { family: FamilyId; state: ModelState; }
export interface UnloadRequest { family: FamilyId | "all"; }
export interface UnloadResponse { unloaded: FamilyId[]; vramFreeMb: number; }

export interface EngineSettings { autoUnloadMinutes: AutoUnloadMinutes; }

export interface Telemetry {
  ts: number;
  source: "engine" | "core";
  vramTotalMb: number; vramUsedMb: number; vramFreeMb: number;
  ramTotalMb: number; ramUsedMb: number;
}
export interface EngineTelemetry extends Telemetry {
  source: "engine";
  vramProcessMb: number;
  ramProcessMb: number;
  gpuUtilPct: number | null;
  activeJobId: string | null;
}

/* ───────── Engine: requests ───────── */

export interface EnhanceRequest { idea: string; style: EnhanceStyle; }
export interface EnhanceResponse { prompt: string; enhanced: boolean; reason?: "INKLING_UNAVAILABLE"; }

export interface UploadJsonRequest { imageBase64: string; filename?: string; }
export interface UploadResponse { id: string; path: string; width: number; height: number; }

export interface T2IRequest {
  prompt: string;
  negativePrompt?: string;
  model: ImageModel;
  width: number;
  height: number;
  seed: number;             // -1 = random
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  batchSize?: number;       // 1..4
  enhancePrompt?: boolean;
}

export interface EditRequest {
  mode: EditMode;
  imageBase64?: string;     // exactly one of imageBase64 / imagePath
  imagePath?: string;
  maskBase64?: string;      // inpaint only; white = regenerate
  referenceImages?: string[]; // qwen_edit only; 0..3 absolute paths
  prompt?: string;          // required except remove_bg
  negativePrompt?: string;
  seed?: number;            // required except remove_bg; -1 = random
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  denoise?: number;         // inpaint, img2img
  resolution?: number;      // qwen_edit
  enhancePrompt?: boolean;
  sourceId?: string;
}

export interface ThreeDRequest {
  mode: Mode3D;
  engine: Engine3D;
  prompt?: string;          // t23d
  imageBase64?: string;     // i23d: exactly one of imageBase64 / imagePath
  imagePath?: string;
  seed: number;             // -1 = random
  enhancePrompt?: boolean;
  removeBackground?: boolean;
  targetFaces?: number;     // 100000..700000
  remeshResolution?: RemeshResolution;
  sourceId?: string;
}

export interface JobAccepted { jobId: string; }
export interface CancelRequest { jobId?: string; }
export interface CancelResponse { cancelled: boolean; jobId: string | null; }
export interface OutputsResponse { items: OutputItem[]; total: number; }

/* ───────── Outputs and sidecar ───────── */

export interface SidecarParams {
  prompt: string;
  negativePrompt: string;
  enhanced: boolean;
  enhancedPrompt: string | null;
  seed: number;
  steps: number | null;
  cfg: number | null;
  sampler: string | null;
  scheduler: string | null;
  denoise: number | null;
  resolution: number | null;
  batchIndex: number;
  batchSize: number;
}

export interface MeshInfo {
  engine: Engine3D;
  format: "glb";
  vertices: number;
  triangles: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  size: [number, number, number];
  upAxis: "Y";
  unit: "m";
  targetFaces: number;
  remeshResolution: RemeshResolution;
  textureSize: number;
  removeBackground: boolean;
  hasTexture: boolean;
}

export interface StageRecord {
  id: Stage3DId;
  label: string;
  status: "done" | "skipped";
  file: string | null;      // relative to the asset directory, forward slashes
  elapsedMs: number;
}

export interface StudioSidecar {
  schemaVersion: 1;
  id: string;
  jobId: string;
  kind: OutputKind;
  mode: JobMode;
  createdAt: string;
  elapsedMs: number;
  file: string;
  mime: "image/png" | "model/gltf-binary";
  bytes: number;
  width: number | null;
  height: number | null;
  hasAlpha: boolean;
  model: { family: FamilyId; label: string; files: string[] };
  params: SidecarParams;
  inputs: { sourceId: string | null; imagePath: string | null; referencePaths: string[] };
  mesh: MeshInfo | null;
  stages: StageRecord[];
  preview: string | null;
  favorite: boolean;
  app: { name: "Studio"; engineVersion: string; apiVersion: 1 };
}

export interface OutputItem extends StudioSidecar {
  path: string;
  dir: string;
  sidecarPath: string;
  previewPath: string | null;
  thumbPath: string | null;
  assetDir: string | null;
}

/* ───────── Engine: WebSocket events ───────── */

interface EventBase { ts: number; seq: number; }

export interface StageInfo {
  index: number;
  id: StageId;
  label: string;
  steps: number | null;
  preview: boolean;
}

export interface JobStartedEvent extends EventBase {
  type: "job.started";
  jobId: string;
  kind: OutputKind;
  mode: JobMode;
  model: FamilyId;
  seed: number;
  batchSize: number;
  width: number | null;
  height: number | null;
  stages: StageInfo[];
  stageIndex: number;
  stageLabel: string;
  replayed: boolean;
}

export interface JobProgressEvent extends EventBase {
  type: "job.progress";
  jobId: string;
  stageIndex: number;
  stageId: StageId;
  stageLabel: string;
  phase: JobPhase;
  step: number;
  totalSteps: number;
  batchIndex: number;
  batchSize: number;
  stageProgress: number;
  progress: number;
  elapsedMs: number;
  etaMs: number | null;
  enhancedPrompt?: string;
  output?: OutputItem;
}

export interface JobStagePreviewEvent extends EventBase {
  type: "job.stage_preview";
  jobId: string;
  stageIndex: number;
  stageId: Stage3DId;
  stageLabel: string;
  status: "done" | "skipped";
  imagePath: string | null;
  width: number | null;
  height: number | null;
  elapsedMs: number;
}

export interface JobCompletedEvent extends EventBase {
  type: "job.completed";
  jobId: string;
  kind: OutputKind;
  mode: JobMode;
  outputs: OutputItem[];
  elapsedMs: number;
}

export interface JobErrorEvent extends EventBase {
  type: "job.error";
  jobId: string;
  stageIndex: number | null;
  error: StudioError;
  outputs: OutputItem[];
}

export interface JobCancelledEvent extends EventBase {
  type: "job.cancelled";
  jobId: string;
  stageIndex: number | null;
  elapsedMs: number;
  outputs: OutputItem[];
}

export interface ModelsStatusEvent extends EventBase { type: "models.status"; models: ModelFamilyStatus[]; }
export type TelemetryEvent = EventBase & EngineTelemetry & { type: "telemetry" };

export type EngineEvent =
  | JobStartedEvent | JobProgressEvent | JobStagePreviewEvent
  | JobCompletedEvent | JobErrorEvent | JobCancelledEvent
  | ModelsStatusEvent | TelemetryEvent;

export interface PreviewFrame { step: number; totalSteps: number; stageIndex: number; jpeg: Blob; }

/* ───────── studio-core ───────── */

export interface CoreEnvelope<T> {
  ok: boolean;
  command: "scan-models" | "library-scan" | "delete" | "telemetry";
  version: string;
  elapsedMs: number;
  data?: T;
  error?: { code: string; message: string; path?: string };
}

export interface SafetensorsHeader {
  headerBytes: number;
  tensorCount: number;
  parameterCount: number;
  dtypes: Record<string, number>;
  primaryDtype: string;
  metadata: Record<string, string>;
  metadataTruncated: boolean;
}

export interface ScannedModelFile {
  relPath: string;
  path: string;
  category: string;
  name: string;
  ext: string;
  bytes: number;
  modifiedAt: string;
  header: SafetensorsHeader | null;
  headerError: string | null;
}

export interface ModelScan { dir: string; fileCount: number; totalBytes: number; files: ScannedModelFile[]; }

export interface LibraryScanOptions { kind?: "all" | OutputKind; limit?: number; offset?: number; since?: string; }
export interface LibraryScanResult {
  dir: string;
  total: number;
  items: OutputItem[];
  thumbs: { generated: number; upToDate: number; failed: { id: string; message: string }[] };
  invalid: { sidecarPath: string; code: string; message: string }[];
  orphans: string[];
}

export interface LibraryDeleteResult {
  deleted: { id: string; sidecarPath: string; trashed: string[] }[];
  failed: { sidecarPath: string; code: string; message: string }[];
  recycleBin: boolean;
}

export interface CoreTelemetry extends Telemetry {
  source: "core";
  ramFreeMb: number;
  cpuUtilPct: number | null;
  gpu: {
    name: string;
    dedicatedTotalMb: number | null; dedicatedUsedMb: number | null;
    sharedTotalMb: number | null; sharedUsedMb: number | null;
    utilPct: number | null;
  };
  processes: {
    pid: number; alive: boolean; name: string | null;
    rssMb: number | null; privateMb: number | null;
    gpuDedicatedMb: number | null; gpuSharedMb: number | null;
  }[];
}

/* ───────── Electron ───────── */

export type ThemeName = "zen-light" | "zen-dark";
export type WorkspaceId = "generate" | "edit" | "three" | "library";

export interface StudioPaths {
  root: string; modelsDir: string; outputsDir: string; logsDir: string;
  userDataDir: string; blenderExe: string | null; coreExe: string;
}

export interface AppInfo {
  name: "Studio";
  version: string;
  apiVersion: 1;
  platform: "win32";
  isDev: boolean;
  material: "mica" | "none";
  systemTheme: ThemeName;
  paths: StudioPaths;
  engine: { httpUrl: string; wsUrl: string };
}

export interface WindowState { maximized: boolean; focused: boolean; fullscreen: boolean; }

export interface EngineProcessStatus {
  state: "stopped" | "starting" | "ready" | "stopping" | "crashed";
  pid: number | null;
  managed: boolean;            // false when Studio adopted an already-running daemon
  startedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
}

export interface BlenderStatus {
  connected: boolean;
  installed: boolean;
  blenderVersion: string | null;
  addonVersion: string | null;
  busy: boolean;
  checkedAt: number;           // Unix ms
}

export interface BlenderImportRequest { path: string; name?: string; autoGround?: boolean; smoothShade?: boolean; }
export interface BlenderImportResult {
  ok: true;
  name: string;
  objects: string[];
  collection: string;
  vertices: number;
  triangles: number;
  dimensions: [number, number, number];
  elapsedMs: number;
}

export type MeshExportFormat = "glb" | "obj" | "stl" | "fbx" | "blend";
export interface MeshExportRequest { path: string; format: MeshExportFormat; suggestedName?: string; }
export interface MeshExportResult { format: MeshExportFormat; output: string; files: string[]; elapsedMs: number; }

export interface LibraryChange { reason: "deleted" | "favorite"; ids: string[]; }

export interface AppSettings {
  theme: ThemeName | "system";
  sidebarCollapsed: boolean;
  lastWorkspace: WorkspaceId;
  windowBounds: { x: number; y: number; width: number; height: number; maximized: boolean } | null;
  /** Opaque per-workspace UI state owned by the renderer (prompts, pills, viewport prefs). */
  workspaceState: Record<string, unknown>;
}

export type Unsubscribe = () => void;

export interface StudioApi {
  app: { getInfo(): Promise<AppInfo> };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    getState(): Promise<WindowState>;
    setTheme(theme: ThemeName): Promise<void>;
    onState(cb: (s: WindowState) => void): Unsubscribe;
  };
  engine: {
    getStatus(): Promise<EngineProcessStatus>;
    start(): Promise<EngineProcessStatus>;
    restart(): Promise<EngineProcessStatus>;
    stop(): Promise<EngineProcessStatus>;
    onStatus(cb: (s: EngineProcessStatus) => void): Unsubscribe;
  };
  core: {
    scanModels(): Promise<ModelScan>;
    telemetry(): Promise<CoreTelemetry>;
  };
  library: {
    scan(opts?: LibraryScanOptions): Promise<LibraryScanResult>;
    delete(sidecarPaths: string[]): Promise<LibraryDeleteResult>;
    setFavorite(sidecarPath: string, favorite: boolean): Promise<OutputItem>;
    onChanged(cb: (c: LibraryChange) => void): Unsubscribe;
  };
  files: {
    toUrl(absPath: string): string;
    pathForFile(file: File): string;
    reveal(path: string): Promise<void>;
    openImages(opts?: { multiple?: boolean }): Promise<string[]>;
    saveCopy(path: string, suggestedName?: string): Promise<string | null>;
  };
  clipboard: {
    writeImage(path: string): Promise<void>;
    writeText(text: string): Promise<void>;
    readImage(): Promise<string | null>;
  };
  mesh: { export(req: MeshExportRequest): Promise<MeshExportResult | null> };
  blender: {
    getStatus(): Promise<BlenderStatus>;
    import(req: BlenderImportRequest): Promise<BlenderImportResult>;
    launch(): Promise<BlenderStatus>;
    onStatus(cb: (s: BlenderStatus) => void): Unsubscribe;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
    onChanged(cb: (s: AppSettings) => void): Unsubscribe;
  };
}

declare global {
  interface Window { studio: StudioApi; }
}
```

---

## 9. Blender add-on and `export_mesh.py`

### 9.1 `blender\studio_bridge.py` — add-on

- Single-file add-on, module name `studio_bridge`, Blender 5.3 (Python 3.13), standard library only.
- On `register()`: start an HTTP server on `127.0.0.1:48215` in a daemon thread and register a `bpy.app.timers` callback (interval 0.1 s, persistent). On `unregister()`: stop both. If the port is taken, the add-on stays enabled, reports the error in its panel and retries every 5 s.
- **Main-thread rule.** HTTP handler threads never touch `bpy`. `POST /import` puts a request on a `queue.Queue` and waits on a `threading.Event` (up to 60 s); the timer callback pops requests and runs them on Blender's main thread, then sets the event. `GET /health` answers from a snapshot dict that the timer callback refreshes once per second.
- No CORS headers (only Electron main and local tools call it). Requests carrying an `Origin` header are rejected with `403`.
- UI: a `Studio` tab in the 3D viewport sidebar with a connection line (`Listening on 127.0.0.1:48215`) and one operator, **Sync latest** (`studio.sync_latest`), which calls `GET http://127.0.0.1:48210/api/outputs?kind=3d&limit=1` and imports `items[0].path` with default options.

#### `GET /health`

`200`:

```json
{
  "status": "ok",
  "app": "blender",
  "addon": "studio_bridge",
  "addonVersion": "1.0.0",
  "apiVersion": 1,
  "blenderVersion": "5.3.0",
  "port": 48215,
  "busy": false,
  "file": "C:\\Users\\winbloat\\Documents\\scene.blend",
  "objectCount": 12
}
```

`file` is `""` for an unsaved scene. `busy` is `true` while an import is running. Responds in under 50 ms regardless of what Blender is doing.

#### `POST /import`

Request (`Content-Type: application/json`):

```json
{ "path": "C:\\Users\\winbloat\\Studio\\outputs\\3d\\20261125_143501_7c2e9b10\\20261125_143501_7c2e9b10.glb",
  "name": "fox", "autoGround": true, "smoothShade": true }
```

| Field | Type | Default | Behaviour |
|---|---|---|---|
| `path` | string | — (required) | Absolute path. Supported: `.glb`, `.gltf`, `.obj`, `.fbx`, `.stl`, `.ply`. |
| `name` | string | file stem | Name given to the imported root object (Blender may suffix `.001`); the returned `name` is the final one. |
| `autoGround` | bool | `true` | After import, translate so the combined bounding box rests on Z = 0 and is centred on the world origin in X and Y. |
| `smoothShade` | bool | `true` | Set smooth shading on every imported mesh. |

Behaviour: import with Blender's importer for the extension (glTF's Y-up is converted to Blender's Z-up by the importer); link the new objects into a collection named `Studio` (created under the scene collection if absent); deselect everything else, select the new objects and make the root active; frame them in the first 3D viewport if one exists (best effort). One undo step named `Studio import`.

`200`:

```json
{ "ok": true, "name": "fox", "objects": ["fox"], "collection": "Studio",
  "vertices": 152340, "triangles": 300000, "dimensions": [0.82, 0.64, 1.0], "elapsedMs": 1840 }
```

`dimensions` are Blender world units, X/Y/Z (Z-up).

Errors — body `{ "ok": false, "error": { "code": "…", "message": "…" } }`:

| Status | `code` | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Invalid JSON, missing `path`, wrong types |
| 403 | `FORBIDDEN_ORIGIN` | Request has an `Origin` header |
| 404 | `FILE_NOT_FOUND` | `path` does not exist |
| 409 | `BUSY` | Another import is in progress |
| 415 | `UNSUPPORTED_FORMAT` | Extension not supported |
| 500 | `IMPORT_FAILED` | The importer raised; `message` carries the exception text |
| 504 | `TIMEOUT` | Main thread did not finish within 60 s |

Electron main maps `FILE_NOT_FOUND`/`UNSUPPORTED_FORMAT`/`IMPORT_FAILED`/`TIMEOUT`/`BUSY` to `BLENDER_IMPORT_FAILED` (original code in `details.blenderCode`).

### 9.2 Add-on installation

Electron main installs it (7.4, `blender.launch`): copy `blender\studio_bridge.py` to `%APPDATA%\Blender Foundation\Blender\5.3\scripts\addons\` and start Blender with `--addons studio_bridge`. The Engine+Blender team confirms on Blender 5.3 that a single-file add-on in that folder is enabled by `--addons`; if 5.3 requires the extensions format, they ship `blender\studio_bridge\` with a `blender_manifest.toml` instead and update 7.4 accordingly — the HTTP contract above does not change.

### 9.3 `blender\export_mesh.py` — headless converter

```
"<blenderExe>" --background --factory-startup --python "C:\Users\winbloat\Studio\blender\export_mesh.py" --
    --input  <absolute .glb path>
    --output <absolute output path>
    [--format glb|obj|stl|fbx|blend]     default: from the --output extension
    [--auto-ground]                      rest on Z=0, centre in X/Y before export
    [--smooth-shade]                     shade smooth before export
    [--scale <float>]                    uniform scale, default 1.0
    [--no-textures]                      geometry and materials only
```

Arguments after the bare `--` belong to the script. The script starts from an empty scene, imports the GLB, applies options, and exports:

| Format | Exporter | Texture handling | Files written |
|---|---|---|---|
| `glb` | glTF binary | Embedded | `<name>.glb` |
| `obj` | Wavefront OBJ, Y-up, −Z forward | Copied next to the OBJ | `<name>.obj`, `<name>.mtl`, texture PNG(s) |
| `stl` | STL binary | None (geometry only) | `<name>.stl` |
| `fbx` | FBX binary, `path_mode="COPY"`, `embed_textures=True` | Embedded | `<name>.fbx` |
| `blend` | Save `.blend` with images packed | Packed | `<name>.blend` |

**Result line.** The last line the script prints to stdout is `STUDIO_EXPORT ` followed by one JSON object:

```
STUDIO_EXPORT {"ok":true,"input":"C:\\…\\x.glb","output":"C:\\…\\x.fbx","format":"fbx","files":["C:\\…\\x.fbx"],"vertices":152340,"triangles":300000,"elapsedMs":3120}
STUDIO_EXPORT {"ok":false,"error":{"code":"IMPORT_FAILED","message":"…"}}
```

Blender prints its own lines to stdout; callers find the result by the `STUDIO_EXPORT ` prefix. The script must call `sys.exit(code)` explicitly — Blender otherwise exits `0` even when a script raises.

| Exit code | Meaning | `error.code` |
|---|---|---|
| `0` | Success | — |
| `2` | Bad or missing arguments | `BAD_ARGS` |
| `3` | `--input` not found | `INPUT_NOT_FOUND` |
| `4` | Import failed | `IMPORT_FAILED` |
| `5` | Export failed | `EXPORT_FAILED` |

---

## 10. Ownership and integration checks

### 10.1 Ownership

| Artifact | Owner | Consumers |
|---|---|---|
| Engine daemon: HTTP (3), WebSocket (4), output files and sidecars (5) | Engine+Blender | Frontend, Electron main, Blender add-on |
| `studio_bridge.py`, `export_mesh.py` (9) | Engine+Blender | Electron main |
| `studio-core.exe` (6) | Rust+Electron | Electron main |
| Electron main, preload, `studio://` protocol, IPC (7) | Rust+Electron | Frontend |
| `app/src/shared/contract.ts` (8) — created first, by copying section 8 | Rust+Electron | Frontend, preload |
| `app/src/**` except `shared/contract.ts` | Frontend | — |

### 10.2 Contract checks each team runs before integration

**Engine+Blender**
1. `GET /api/health` returns every field of 3.2 with the right types within 30 s of process start, with no model loaded.
2. A t2i job produces, in order: `job.started` → `job.progress`… → for each sampler step a `job.progress` then a binary frame whose first four bytes are `50 52 45 56` and whose bytes 16–17 are `FF D8` → `job.progress` with `phase: "saved"` and `output` → `job.completed`. `seq` strictly increases.
3. `batchSize: 3` yields three PNGs, three sidecars, seeds `s`, `s+1`, `s+2`.
4. `inpaint`: pixels outside the mask are bit-identical to the input; output size equals input size for a 1000 × 750 image.
5. `remove_bg` returns an RGBA PNG of the input's size with `hasAlpha: true`.
6. A 3D job emits exactly seven `job.stage_preview` events in index order and one GLB satisfying the normalisation in 3.12; the sidecar validates against section 5.2.
7. A second generate request during a job returns `409 BUSY`; `POST /api/cancel` ends the job with `job.cancelled` within one sampler step.
8. Killing the parent process makes the daemon exit within 5 s.
9. `POST /import` to the add-on from a non-main thread never raises a Blender threading error under ten rapid consecutive imports.

**Rust+Electron**
1. Each `studio-core` command writes exactly one JSON line to stdout that parses into `CoreEnvelope<T>`; exit codes follow 6.1.
2. `scan-models` on the resolved models directory lists all 20 `.safetensors` files (the 15 distinct files of Appendix A plus the 5 unused `vae_approx` extras) with correct `bytes`.
3. `delete` moves files to the Recycle Bin (verify they can be restored) and refuses a sidecar outside `--dir` with `OUTSIDE_ROOT`.
4. `library-scan --thumbs` on the engine's sample outputs returns `OutputItem`s field-for-field equal to `GET /api/outputs` for the same folder (ignoring `thumbPath`).
5. Every method of `StudioApi` exists on `window.studio`; `ipcRenderer` is not reachable from the renderer.
6. `studio://outputs/../..` style traversal returns `403`.

**Frontend**
1. Type-checks against `contract.ts` with no `any` on wire types and no local redeclarations.
2. Ignores unknown event `type`s and unknown fields without warnings.
3. Discards binary frames when no job is active and frames with a bad magic.
4. Works with the engine stopped: Library (via `studio-core`), the canvas, the 3D viewer for existing assets, and the Models drawer in its offline form.

---

## Appendix A — Model families (normative mapping)

`relPath`s are relative to `modelsDir`. Byte sizes are those measured on disk on 2026-11-25. The Engine holds this table as `engine\studio_engine\families.py`; the Frontend holds the same table as `app\src\shared\families.ts` for the engine-offline view. `diskBytes` and `vramEstimateMb` in the API are always computed from the real files at run time, not copied from here.

### `z_image` — "Z-Image Turbo"

16-channel Flux/Lumina2-style latent, downscale 8, sizes in multiples of 16.

| Role | relPath | Bytes |
|---|---|---|
| `diffusion` | `diffusion_models/z_image_turbo_bf16_nsfw_v2.safetensors` | 12,566,033,952 |
| `text_encoder` | `text_encoders/qwen3_4b_z_image_abliterated.safetensors` | 8,044,982,080 |
| `vae` | `vae/z_image_ae.safetensors` | 335,304,388 |
| `preview_decoder` | `vae_approx/taef1_decoder.safetensors` | 2,464,414 |
| | **Total** | **20,948,784,834** (≈ 19.51 GiB) |

### `qwen_image` — "Qwen-Image 2.1"

64-channel `QwenImage21` latent, downscale 16, sizes in multiples of 32, 1–4 images into the encoder. No TAESD decoder for this latent is present on disk (`taeqi2_1_decoder` is absent), so previews use Latent2RGB.

| Role | relPath | Bytes |
|---|---|---|
| `diffusion` | `diffusion_models/chatrlabs_qwen_image21_step90000_bf16.safetensors` | 14,230,284,680 |
| `lora` | `loras/chatrlabs-omni-turbo-8step-fp32.safetensors` | 671,148,320 |
| `text_encoder` | `text_encoders/qwen3vl_8b_bf16.safetensors` | 17,534,334,616 |
| `vae` | `vae/qwen_image_2.1_vae_bf16.safetensors` | 675,509,688 |
| | **Total** | **33,111,277,304** (≈ 30.84 GiB) |

### `pixal3d` — "3D · Pixal3D"

| Role | relPath | Bytes | Shared with |
|---|---|---|---|
| `diffusion` | `diffusion_models/pixal3d_bf16.safetensors` | 10,999,317,704 | — |
| `vae` | `vae/trellis_2_shape_vae_bf16.safetensors` | 1,095,844,024 | `trellis2` |
| `vae` | `vae/trellis_2_texture_vae_bf16.safetensors` | 948,461,364 | `trellis2` |
| `vision_encoder` | `clip_vision/dino_v3_L_naf_fp32.safetensors` | 1,215,214,176 | `trellis2` |
| `geometry` | `geometry_estimation/moge_2_vitl_normal_fp16.safetensors` | 661,859,924 | — |
| | **Total** | **14,920,697,192** (≈ 13.90 GiB) | |

### `trellis2` — "3D · TRELLIS.2"

| Role | relPath | Bytes | Shared with |
|---|---|---|---|
| `diffusion` | `diffusion_models/trellis_2_bf16.safetensors` | 10,338,297,616 | — |
| `vae` | `vae/trellis_2_shape_vae_bf16.safetensors` | 1,095,844,024 | `pixal3d` |
| `vae` | `vae/trellis_2_texture_vae_bf16.safetensors` | 948,461,364 | `pixal3d` |
| `vision_encoder` | `clip_vision/dino_v3_L_naf_fp32.safetensors` | 1,215,214,176 | `pixal3d` |
| | **Total** | **13,597,817,180** (≈ 12.66 GiB) | |

### `birefnet` — "BiRefNet"

| Role | relPath | Bytes |
|---|---|---|
| `matting` | `background_removal/birefnet.safetensors` | 444,473,596 (≈ 0.41 GiB) |

Other files present in the models directory and not used by Studio: `vae_approx/taef1_encoder`, `taesd_*`, `taesdxl_*` (`.safetensors`). `scan-models` lists them; no family references them.

---

## Appendix B — Defaults and limits

| Setting | Z-Image Turbo | Qwen-Image 2.1 |
|---|---|---|
| Steps (default / range) | 9 / 1–50 | 8 / 1–50 |
| CFG (default / range) | 1.0 / 1.0–10.0 | 1.0 / 1.0–10.0 |
| Sampler / scheduler | `euler` / `simple` | `euler` / `simple` |
| Size multiple | 16 | 32 |
| Size range per side | 256–2048 | 256–2048 |
| Reference images | — | Base + up to 3 |
| Preview | TAEF1, ≤ 768 px | Latent2RGB, 512 px |

Curated sampler list (the engine reports the subset its comfy build provides): `euler`, `euler_ancestral`, `dpmpp_2m`, `res_multistep`. Curated scheduler list: `simple`, `beta`, `sgm_uniform`, `normal`.

Aspect presets used by the UI (valid for both models): `1:1` 1024 × 1024 · `2:3` 832 × 1248 · `3:2` 1248 × 832 · `9:16` 768 × 1344 · `16:9` 1344 × 768.

| Other | Value |
|---|---|
| Batch size | 1–4 |
| Seed | 0–4294967295 (`-1` = random in requests) |
| Denoise | 0.05–1.0; default 0.85 inpaint, 0.60 img2img |
| Qwen edit `resolution` | 512–2048 step 32; default 1024 |
| Inpaint mask processing | grow 8 px, feather 16 px |
| 3D target faces | 100000–700000; default 300000 |
| 3D remesh resolution | 512 (default), 768, 1024 |
| 3D texture size | 2048 (fixed) |
| 3D source image for `t23d` | Z-Image Turbo, 1024 × 1024, 9 steps |
| Auto-unload | Off, 5, 10 (default), 15, 30 minutes |
| Memory headroom when loading | 8192 Mb |
| Upload limits | 64 MB, 8192 px per side |
| Request body limit | 96 MB |
| Telemetry cadence | 2000 ms idle, 500 ms during a job |

---

## Appendix C — Error codes

### Engine HTTP and `job.error`

| Code | HTTP status | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Malformed JSON, missing or mistyped field, value out of range; `details.field` names the offender |
| `INVALID_DIMENSIONS` | 400 | Width/height outside range or not a multiple of the model's grid |
| `UNKNOWN_FAMILY` | 400 | Unknown model family or engine id |
| `IMAGE_DECODE_FAILED` | 400 | Image bytes or file could not be decoded |
| `FORBIDDEN_ORIGIN` | 403 | `Origin` or `Host` not allowed |
| `NOT_FOUND` | 404 | Unknown route, unknown `jobId`, or `imagePath` does not exist |
| `BUSY` | 409 | A job is active; `details.activeJobId` |
| `IMAGE_TOO_LARGE` | 413 | Image or request body over the limits |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Wrong `Content-Type` |
| `MODEL_FILES_MISSING` | 424 | Required model file(s) absent; `details.missing: string[]` |
| `OUT_OF_MEMORY` | 507 (HTTP) / `job.error` | Not enough GPU or system memory even after unloading other families |
| `SHUTTING_DOWN` | 503 | Daemon is exiting |
| `INKLING_UNAVAILABLE` | — | Only as `reason` in the enhance response; never an HTTP error |
| `INTERNAL` | 500 / `job.error` | Anything else; `details.trace` holds a truncated traceback |

### Electron IPC (rejections from `window.studio`)

| Code | Raised by |
|---|---|
| `ENGINE_UNREACHABLE` | Renderer HTTP client when `fetch` to the engine fails (not an IPC error, same shape) |
| `CORE_FAILED` | `studio-core` exited `1`/`2`/`4` or printed unparseable output; `details.coreCode` |
| `DELETE_FAILED` | `library.delete` when every item failed |
| `INVALID_PATH` | A path argument was relative, or outside `outputsDir` for a write/delete |
| `BLENDER_UNREACHABLE` | `blender.import` could not connect to `127.0.0.1:48215` |
| `BLENDER_NOT_INSTALLED` | `blenderExe` not found (`blender.launch`, `mesh.export`) |
| `BLENDER_IMPORT_FAILED` | The add-on returned an error; `details.blenderCode` |
| `EXPORT_FAILED` | `export_mesh.py` exited non-zero or timed out; `details.exitCode`, `details.exportCode` |
