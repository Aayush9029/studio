/**
 * Preload: exposes exactly one global, `window.studio` (API_CONTRACT.md §7.1).
 * Runs sandboxed: only `electron` is importable, so path logic here is hand-written.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

import type {
  AppInfo,
  AppSettings,
  BlenderImportRequest,
  BlenderImportResult,
  BlenderStatus,
  CoreTelemetry,
  EngineProcessStatus,
  LibraryChange,
  LibraryDeleteResult,
  LibraryScanOptions,
  LibraryScanResult,
  MeshExportRequest,
  MeshExportResult,
  ModelScan,
  OutputItem,
  StudioApi,
  ThemeName,
  Unsubscribe,
  WindowState,
} from "../src/shared/contract";

/* ───────── bootstrap config ───────── */

function readBootConfig(): { outputsDir: string } {
  const arg = process.argv.find((a) => a.startsWith("--studio-preload="));
  if (arg) {
    try {
      const b64 = arg.slice("--studio-preload=".length).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes)) as { outputsDir: string };
    } catch {
      /* fall back to sync IPC */
    }
  }
  return ipcRenderer.sendSync("studio:preload:config") as { outputsDir: string };
}

const boot = readBootConfig();

/* ───────── pure Windows path helpers ───────── */

function normalize(p: string): string {
  let s = p.replace(/\//g, "\\");
  const unc = s.startsWith("\\\\");
  s = s.replace(/\\{2,}/g, "\\");
  if (unc) s = "\\" + s;
  const parts: string[] = [];
  const segs = s.split("\\");
  const head = segs.shift() ?? "";
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return [head, ...parts].join("\\");
}

const OUTPUTS = normalize(boot.outputsDir).replace(/\\+$/, "");
const THUMBS = OUTPUTS + "\\.cache\\thumbs";

/** `child` relative to `root` as forward-slash segments, or null when not inside. */
function relInside(root: string, child: string): string[] | null {
  const r = root.toLowerCase() + "\\";
  if (!child.toLowerCase().startsWith(r)) return null;
  const rest = child.slice(r.length);
  return rest === "" ? null : rest.split("\\");
}

function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Thumbnail mtimes (by file name) learnt from `library.scan`, for `?v=` cache busting. */
const thumbVersions = new Map<string, number>();

function toUrl(absPath: string): string {
  if (typeof absPath !== "string" || absPath === "") return "";
  const p = normalize(absPath);
  const thumb = relInside(THUMBS, p);
  if (thumb && thumb.length === 1) {
    const v = thumbVersions.get(thumb[0]);
    return `studio://thumbs/${encodeURIComponent(thumb[0])}${v !== undefined ? `?v=${v}` : ""}`;
  }
  const rel = relInside(OUTPUTS, p);
  if (rel) return `studio://outputs/${rel.map(encodeURIComponent).join("/")}`;
  return `studio://file/${base64Url(p)}`;
}

/* ───────── IPC plumbing ───────── */

/** Electron prefixes invoke rejections ("Error invoking remote method …: Error: {json}"); restore the bare JSON. */
function cleanError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const i = msg.indexOf("{");
  if (i >= 0) {
    const candidate = msg.slice(i);
    try {
      JSON.parse(candidate);
      return new Error(candidate);
    } catch {
      /* not JSON */
    }
  }
  return new Error(JSON.stringify({ code: "INTERNAL", message: msg, details: {} }));
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as T;
  } catch (err) {
    throw cleanError(err);
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  if (typeof cb !== "function") return () => undefined;
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/* ───────── window.studio ───────── */

const api: StudioApi = {
  app: {
    getInfo: () => invoke<AppInfo>("studio:app:get-info"),
  },
  window: {
    minimize: () => invoke<void>("studio:window:minimize"),
    toggleMaximize: () => invoke<void>("studio:window:toggle-maximize"),
    close: () => invoke<void>("studio:window:close"),
    getState: () => invoke<WindowState>("studio:window:get-state"),
    setTheme: (theme: ThemeName) => invoke<void>("studio:window:set-theme", theme),
    onState: (cb) => subscribe<WindowState>("studio:evt:window-state", cb),
  },
  engine: {
    getStatus: () => invoke<EngineProcessStatus>("studio:engine:get-status"),
    start: () => invoke<EngineProcessStatus>("studio:engine:start"),
    restart: () => invoke<EngineProcessStatus>("studio:engine:restart"),
    stop: () => invoke<EngineProcessStatus>("studio:engine:stop"),
    onStatus: (cb) => subscribe<EngineProcessStatus>("studio:evt:engine-status", cb),
  },
  core: {
    scanModels: () => invoke<ModelScan>("studio:core:scan-models"),
    telemetry: () => invoke<CoreTelemetry>("studio:core:telemetry"),
  },
  library: {
    scan: async (opts?: LibraryScanOptions) => {
      const raw = await invoke<LibraryScanResult & { __thumbVersions?: Record<string, number> }>("studio:library:scan", opts);
      const { __thumbVersions, ...result } = raw;
      if (__thumbVersions) for (const [name, v] of Object.entries(__thumbVersions)) thumbVersions.set(name, v);
      return result;
    },
    delete: (sidecarPaths: string[]) => invoke<LibraryDeleteResult>("studio:library:delete", sidecarPaths),
    setFavorite: (sidecarPath: string, favorite: boolean) =>
      invoke<OutputItem>("studio:library:set-favorite", { sidecarPath, favorite }),
    onChanged: (cb) => subscribe<LibraryChange>("studio:evt:library-changed", cb),
  },
  files: {
    toUrl,
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    reveal: (path: string) => invoke<void>("studio:files:reveal", path),
    openImages: (opts?: { multiple?: boolean }) => invoke<string[]>("studio:files:open-images", opts ?? {}),
    saveCopy: (path: string, suggestedName?: string) =>
      invoke<string | null>("studio:files:save-copy", suggestedName === undefined ? { path } : { path, suggestedName }),
  },
  clipboard: {
    writeImage: (path: string) => invoke<void>("studio:clipboard:write-image", path),
    writeText: (text: string) => invoke<void>("studio:clipboard:write-text", text),
    readImage: () => invoke<string | null>("studio:clipboard:read-image"),
  },
  mesh: {
    export: (req: MeshExportRequest) => invoke<MeshExportResult | null>("studio:mesh:export", req),
  },
  blender: {
    getStatus: () => invoke<BlenderStatus>("studio:blender:get-status"),
    import: (req: BlenderImportRequest) => invoke<BlenderImportResult>("studio:blender:import", req),
    launch: () => invoke<BlenderStatus>("studio:blender:launch"),
    onStatus: (cb) => subscribe<BlenderStatus>("studio:evt:blender-status", cb),
  },
  settings: {
    get: () => invoke<AppSettings>("studio:settings:get"),
    set: (patch: Partial<AppSettings>) => invoke<AppSettings>("studio:settings:set", patch),
    onChanged: (cb) => subscribe<AppSettings>("studio:evt:settings-changed", cb),
  },
};

contextBridge.exposeInMainWorld("studio", api);
