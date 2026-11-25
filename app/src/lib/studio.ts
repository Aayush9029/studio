/* Access to `window.studio` (Electron preload, API_CONTRACT.md §7) with a browser
   fallback so the renderer also runs standalone on http://localhost:5173. */

import {
  ENGINE_HTTP,
  ENGINE_WS,
  type AppInfo,
  type AppSettings,
  type LibraryScanResult,
  type OutputsResponse,
  type StudioApi,
  type StudioError,
  type ThemeName,
} from "../shared/contract";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  sidebarCollapsed: false,
  lastWorkspace: "generate",
  windowBounds: null,
  workspaceState: {},
};

const LS_KEY = "studio.settings.v1";

function systemTheme(): ThemeName {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "zen-dark" : "zen-light";
}

function unsupported(name: string): never {
  const err: StudioError = { code: "INTERNAL", message: `${name} needs the Studio desktop app` };
  throw new Error(JSON.stringify(err));
}

function createBrowserStub(): StudioApi {
  const settingsListeners = new Set<(s: AppSettings) => void>();
  const read = (): AppSettings => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
    } catch {
      /* private mode / blocked storage */
    }
    return { ...DEFAULT_SETTINGS };
  };
  const none = () => () => {};

  const info: AppInfo = {
    name: "Studio",
    version: "dev",
    apiVersion: 1,
    platform: "win32",
    isDev: true,
    material: "none",
    systemTheme: systemTheme(),
    paths: { root: "", modelsDir: "", outputsDir: "", logsDir: "", userDataDir: "", blenderExe: null, coreExe: "" },
    engine: { httpUrl: ENGINE_HTTP, wsUrl: ENGINE_WS },
  };

  return {
    app: { getInfo: async () => info },
    window: {
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => window.close(),
      getState: async () => ({ maximized: false, focused: document.hasFocus(), fullscreen: false }),
      setTheme: async () => {},
      onState: none,
    },
    engine: {
      getStatus: async () => ({ state: "ready", pid: null, managed: false, startedAt: null, exitCode: null, lastError: null }),
      start: async () => ({ state: "ready", pid: null, managed: false, startedAt: null, exitCode: null, lastError: null }),
      restart: async () => ({ state: "ready", pid: null, managed: false, startedAt: null, exitCode: null, lastError: null }),
      stop: async () => ({ state: "stopped", pid: null, managed: false, startedAt: null, exitCode: null, lastError: null }),
      onStatus: none,
    },
    core: {
      scanModels: async () => unsupported("Model scan"),
      telemetry: async () => unsupported("Telemetry"),
    },
    library: {
      // Contract §3.15: the engine's /api/outputs is the documented fallback for library-scan.
      scan: async (opts) => {
        const kind = opts?.kind ?? "all";
        const res = await fetch(`${ENGINE_HTTP}/api/outputs?kind=${kind}&limit=${opts?.limit ?? 1000}&offset=${opts?.offset ?? 0}`);
        if (!res.ok) throw new Error(JSON.stringify({ code: "ENGINE_UNREACHABLE", message: `HTTP ${res.status}` }));
        const body = (await res.json()) as OutputsResponse;
        const out: LibraryScanResult = {
          dir: "",
          total: body.total,
          items: body.items,
          thumbs: { generated: 0, upToDate: 0, failed: [] },
          invalid: [],
          orphans: [],
        };
        return out;
      },
      delete: async () => unsupported("Delete"),
      setFavorite: async () => unsupported("Favorites"),
      onChanged: none,
    },
    files: {
      toUrl: () => "",
      pathForFile: () => "",
      reveal: async () => unsupported("Reveal in Explorer"),
      openImages: async () => [],
      saveCopy: async () => unsupported("Save a copy"),
    },
    clipboard: {
      writeImage: async () => unsupported("Copy image"),
      writeText: async (text) => {
        await navigator.clipboard.writeText(text);
      },
      readImage: async () => null,
    },
    mesh: { export: async () => unsupported("Export") },
    blender: {
      getStatus: async () => ({ connected: false, installed: false, blenderVersion: null, addonVersion: null, busy: false, checkedAt: Date.now() }),
      import: async () => unsupported("Send to Blender"),
      launch: async () => unsupported("Open Blender"),
      onStatus: none,
    },
    settings: {
      get: async () => read(),
      set: async (patch) => {
        const next = { ...read(), ...patch };
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        settingsListeners.forEach((cb) => cb(next));
        return next;
      },
      onChanged: (cb) => {
        settingsListeners.add(cb);
        return () => settingsListeners.delete(cb);
      },
    },
  };
}

export const isDesktop: boolean = typeof window !== "undefined" && "studio" in window && !!window.studio;

export const studio: StudioApi = isDesktop ? window.studio : createBrowserStub();

/** Contract §7.1: IPC rejections carry a JSON-encoded StudioError in `message`. */
export function parseIpcError(e: unknown): StudioError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const o = e as { code: unknown; message: unknown; details?: unknown };
    if (typeof o.code === "string" && typeof o.message === "string") return o as StudioError;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const start = msg.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(msg.slice(start)) as Partial<StudioError>;
      if (parsed && typeof parsed.code === "string") {
        return { code: parsed.code, message: parsed.message ?? "", details: parsed.details } as StudioError;
      }
    } catch {
      /* fall through */
    }
  }
  return { code: "INTERNAL", message: msg };
}

export function toUrl(absPath: string | null | undefined): string {
  if (!absPath) return "";
  try {
    return studio.files.toUrl(absPath);
  } catch {
    return "";
  }
}
