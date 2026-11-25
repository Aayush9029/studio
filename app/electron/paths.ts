/**
 * Install-tree and config resolution (API_CONTRACT.md §2.1–2.3).
 * The resolved absolute paths are passed to the engine and studio-core; nothing else guesses.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import type { StudioPaths } from "../src/shared/contract";

const DEFAULT_ROOT = "C:\\Users\\winbloat\\Studio";
const PORTABLE = "C:\\Users\\winbloat\\ComfyUI_windows_portable";
const DEFAULT_BLENDER = "C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe";

export interface StudioConfigFile {
  pythonExe?: string;
  comfyDir?: string;
  modelsDir?: string;
  outputsDir?: string;
  blenderExe?: string;
  inklingUrl?: string;
  inklingModel?: string;
}

export interface ResolvedConfig {
  root: string;
  appDir: string;
  rendererDir: string;
  pythonExe: string;
  comfyDir: string;
  modelsDir: string;
  outputsDir: string;
  logsDir: string;
  userDataDir: string;
  blenderExe: string | null;
  coreExe: string;
  engineScript: string;
  blenderBridgeSrc: string;
  exportMeshScript: string;
  inklingUrl: string;
  inklingModel: string;
  iconPath: string;
  devServerUrl: string | null;
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Studio root: `STUDIO_ROOT`, else the parent of `app\` in development, else the default install path. */
function resolveRoot(): string {
  const env = str(process.env.STUDIO_ROOT);
  if (env) return path.resolve(env);
  if (!app.isPackaged) {
    const candidate = path.resolve(app.getAppPath(), "..");
    if (exists(path.join(candidate, "docs")) || exists(path.join(candidate, "engine"))) return candidate;
  }
  return DEFAULT_ROOT;
}

function configPath(root: string): string {
  return path.join(root, "studio.config.json");
}

function parseConfig(raw: string): StudioConfigFile {
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const o = parsed as Record<string, unknown>;
  return {
    pythonExe: str(o.pythonExe),
    comfyDir: str(o.comfyDir),
    modelsDir: str(o.modelsDir),
    outputsDir: str(o.outputsDir),
    blenderExe: str(o.blenderExe),
    inklingUrl: str(o.inklingUrl),
    inklingModel: str(o.inklingModel),
  };
}

function reportConfigError(file: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error(`[studio] cannot read ${file}: ${String(err)}`);
  }
}

/** Synchronous read, for startup (`resolveConfig`) only. */
export function readConfigFile(root: string): StudioConfigFile {
  const file = configPath(root);
  try {
    return parseConfig(fs.readFileSync(file, "utf8"));
  } catch (err) {
    reportConfigError(file, err);
    return {};
  }
}

let resolved: ResolvedConfig | null = null;

/** Must be called after `app.setPath("userData", …)`. */
export function resolveConfig(): ResolvedConfig {
  if (resolved) return resolved;
  const root = resolveRoot();
  const cfg = readConfigFile(root);
  const appDir = app.getAppPath();

  const pythonExe =
    cfg.pythonExe ??
    [path.join(root, "runtime", "python_embeded", "python.exe")].find(exists) ??
    path.join(PORTABLE, "python_embeded", "python.exe");
  const comfyDir =
    cfg.comfyDir ?? [path.join(root, "engine", "vendor")].find(isDir) ?? path.join(PORTABLE, "ComfyUI");
  const modelsDir =
    cfg.modelsDir ?? [path.join(root, "models")].find(isDir) ?? path.join(PORTABLE, "ComfyUI", "models");
  const outputsDir = cfg.outputsDir ?? path.join(root, "outputs");
  const blenderCandidate = cfg.blenderExe ?? DEFAULT_BLENDER;
  const coreExe = app.isPackaged
    ? path.join(process.resourcesPath, "studio-core.exe")
    : path.join(root, "core", "target", "release", "studio-core.exe");

  const devServerUrl =
    str(process.env.STUDIO_DEV_SERVER_URL) ??
    str(process.env.VITE_DEV_SERVER_URL) ??
    (process.argv.includes("--dev") ? "http://localhost:5173" : null);

  resolved = {
    root,
    appDir,
    rendererDir: str(process.env.STUDIO_RENDERER_DIR) ? path.resolve(process.env.STUDIO_RENDERER_DIR as string) : path.join(appDir, "dist"),
    pythonExe: path.resolve(pythonExe),
    comfyDir: path.resolve(comfyDir),
    modelsDir: path.resolve(modelsDir),
    outputsDir: path.resolve(outputsDir),
    logsDir: path.join(root, "logs"),
    userDataDir: app.getPath("userData"),
    blenderExe: exists(blenderCandidate) ? path.resolve(blenderCandidate) : null,
    coreExe,
    engineScript: path.join(root, "engine", "run_engine.py"),
    blenderBridgeSrc: path.join(root, "blender", "studio_bridge.py"),
    exportMeshScript: path.join(root, "blender", "export_mesh.py"),
    inklingUrl: cfg.inklingUrl ?? "http://127.0.0.1:8080/v1",
    inklingModel: cfg.inklingModel ?? "inkling-2-mini-uncensored",
    iconPath: path.join(appDir, "assets", "studio.ico"),
    devServerUrl,
  };
  try {
    fs.mkdirSync(resolved.logsDir, { recursive: true });
    fs.mkdirSync(resolved.outputsDir, { recursive: true });
  } catch {
    /* reported later by the features that need them */
  }
  return resolved;
}

export function studioPaths(c: ResolvedConfig): StudioPaths {
  return {
    root: c.root,
    modelsDir: c.modelsDir,
    outputsDir: c.outputsDir,
    logsDir: c.logsDir,
    userDataDir: c.userDataDir,
    blenderExe: c.blenderExe,
    coreExe: c.coreExe,
  };
}

/** How long a Blender executable check stays fresh for background callers (status polling). */
export const BLENDER_RECHECK_MS = 30_000;

/** `studio.config.json` as last parsed, keyed by its mtime so an unchanged file is never re-read. */
let configCache: { root: string; mtimeMs: number | null; cfg: StudioConfigFile } | null = null;
let blenderCheckedAt = 0;
let blenderCheck: Promise<string | null> | null = null;

async function readConfigFileCached(root: string): Promise<StudioConfigFile> {
  const file = configPath(root);
  let mtimeMs: number | null;
  try {
    mtimeMs = (await fs.promises.stat(file)).mtimeMs;
  } catch (err) {
    reportConfigError(file, err);
    mtimeMs = null;
  }
  if (configCache && configCache.root === root && configCache.mtimeMs === mtimeMs) return configCache.cfg;
  let cfg: StudioConfigFile = {};
  if (mtimeMs !== null) {
    try {
      cfg = parseConfig(await fs.promises.readFile(file, "utf8"));
    } catch (err) {
      reportConfigError(file, err);
    }
  }
  configCache = { root, mtimeMs, cfg };
  return cfg;
}

async function existsAsync(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-checks the Blender executable (it may be installed while Studio runs), asynchronously.
 * Background callers get the cached answer for up to `BLENDER_RECHECK_MS`; `force` (launch,
 * mesh export) always re-checks. Concurrent callers share one check.
 */
export function refreshBlenderExe(c: ResolvedConfig, force = false): Promise<string | null> {
  if (blenderCheck) return blenderCheck;
  if (!force && Date.now() - blenderCheckedAt < BLENDER_RECHECK_MS) return Promise.resolve(c.blenderExe);
  const p = (async () => {
    const cfg = await readConfigFileCached(c.root);
    const candidate = cfg.blenderExe ?? DEFAULT_BLENDER;
    c.blenderExe = (await existsAsync(candidate)) ? path.resolve(candidate) : null;
    blenderCheckedAt = Date.now();
    return c.blenderExe;
  })().finally(() => {
    blenderCheck = null;
  });
  blenderCheck = p;
  return p;
}
