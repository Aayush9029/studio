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
