/** `ipcMain.handle` for every `StudioApi` invoke channel (API_CONTRACT.md §7.3, §7.4). */
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  API_VERSION,
  ENGINE_HTTP,
  ENGINE_WS,
  type AppInfo,
  type LibraryChange,
  type MeshExportFormat,
  type MeshExportRequest,
  type MeshExportResult,
  type OutputItem,
  type StudioSidecar,
  type ThemeName,
} from "../src/shared/contract";
import { BlenderBridge, exportWithBlender } from "./blenderBridge";
import * as core from "./coreBridge";
import type { EngineManager } from "./engineManager";
import { fail, requireAbsolute, requireInside, toIpcError } from "./errors";
import { log } from "./log";
import { refreshBlenderExe, studioPaths, type ResolvedConfig } from "./paths";
import type { SettingsStore } from "./settings";
import { systemTheme, type MainWindow } from "./window";

export const CH = {
  appGetInfo: "studio:app:get-info",
  winMinimize: "studio:window:minimize",
  winToggleMaximize: "studio:window:toggle-maximize",
  winClose: "studio:window:close",
  winGetState: "studio:window:get-state",
  winSetTheme: "studio:window:set-theme",
  engineGetStatus: "studio:engine:get-status",
  engineStart: "studio:engine:start",
  engineRestart: "studio:engine:restart",
  engineStop: "studio:engine:stop",
  coreScanModels: "studio:core:scan-models",
  coreTelemetry: "studio:core:telemetry",
  libraryScan: "studio:library:scan",
  libraryDelete: "studio:library:delete",
  librarySetFavorite: "studio:library:set-favorite",
  filesReveal: "studio:files:reveal",
  filesOpenImages: "studio:files:open-images",
  filesSaveCopy: "studio:files:save-copy",
  clipWriteImage: "studio:clipboard:write-image",
  clipWriteText: "studio:clipboard:write-text",
  clipReadImage: "studio:clipboard:read-image",
  meshExport: "studio:mesh:export",
  blenderGetStatus: "studio:blender:get-status",
  blenderImport: "studio:blender:import",
  blenderLaunch: "studio:blender:launch",
  settingsGet: "studio:settings:get",
  settingsSet: "studio:settings:set",
} as const;

export const EVT = {
  windowState: "studio:evt:window-state",
  engineStatus: "studio:evt:engine-status",
  blenderStatus: "studio:evt:blender-status",
  libraryChanged: "studio:evt:library-changed",
  settingsChanged: "studio:evt:settings-changed",
} as const;

export interface IpcContext {
  cfg: ResolvedConfig;
  settings: SettingsStore;
  engine: EngineManager;
  blender: BlenderBridge;
  window: MainWindow;
  broadcast: (channel: string, payload: unknown) => void;
}

const THEMES: ReadonlyArray<ThemeName> = ["zen-light", "zen-dark"];
const EXPORT_FORMATS: ReadonlyArray<MeshExportFormat> = ["glb", "obj", "stl", "fbx", "blend"];
const SIDECAR_SUFFIX = ".studio.json";

/** Per-file serialisation of read–modify–write sidecar updates. */
const sidecarLocks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sidecarLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  sidecarLocks.set(key, next);
  void next.finally(() => {
    if (sidecarLocks.get(key) === next) sidecarLocks.delete(key);
  });
  return next;
}

let lastSaveDir: string | null = null;

function defaultSaveDir(kind: "image" | "3d"): string {
  if (lastSaveDir && fs.existsSync(lastSaveDir)) return lastSaveDir;
  if (kind === "3d") {
    const objects3d = path.join(os.homedir(), "3D Objects");
    if (fs.existsSync(objects3d)) return objects3d;
    return app.getPath("documents");
  }
  return app.getPath("pictures");
}

function senderWindow(e: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined;
}

/** Builds an `OutputItem` from a sidecar on disk (same rules as studio-core, §5.3). */
export function outputItemFromSidecar(cfg: ResolvedConfig, sidecarPath: string, sidecar: StudioSidecar): OutputItem {
  const dir = path.dirname(sidecarPath);
  const thumb = path.join(cfg.outputsDir, ".cache", "thumbs", `${sidecar.id}.webp`);
  const previewPath =
    sidecar.kind === "3d" && typeof sidecar.preview === "string" && sidecar.preview !== "" ? path.join(dir, sidecar.preview) : null;
  return {
    ...sidecar,
    path: path.join(dir, sidecar.file),
    dir,
    sidecarPath,
    previewPath,
    thumbPath: fs.existsSync(thumb) ? thumb : null,
    assetDir: sidecar.kind === "3d" ? dir : null,
  };
}

async function setFavorite(ctx: IpcContext, payload: unknown): Promise<OutputItem> {
  if (!payload || typeof payload !== "object") fail("BAD_REQUEST", "expected { sidecarPath, favorite }");
  const { sidecarPath, favorite } = payload as { sidecarPath?: unknown; favorite?: unknown };
  if (typeof favorite !== "boolean") fail("BAD_REQUEST", "favorite must be boolean", { field: "favorite" });
  const file = requireInside(ctx.cfg.outputsDir, sidecarPath, "sidecarPath");
  if (!file.toLowerCase().endsWith(SIDECAR_SUFFIX)) fail("INVALID_PATH", "not a .studio.json sidecar", { path: file });

  const item = await withLock(file.toLowerCase(), async () => {
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch {
      fail("INVALID_PATH", "sidecar does not exist", { path: file });
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw.replace(/^﻿/, "")) as Record<string, unknown>;
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
    } catch (err) {
      fail("BAD_REQUEST", `sidecar is not valid JSON: ${String(err)}`, { path: file });
    }
    if (typeof json.id !== "string" || typeof json.file !== "string") fail("BAD_REQUEST", "sidecar lacks id/file", { path: file });
    json.favorite = favorite;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(json, null, 2), "utf8");
      await fs.promises.rename(tmp, file);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    return outputItemFromSidecar(ctx.cfg, file, json as unknown as StudioSidecar);
  });
  const change: LibraryChange = { reason: "favorite", ids: [item.id] };
  ctx.broadcast(EVT.libraryChanged, change);
  return item;
}

/** Decodes images nativeImage cannot read (WebP) through the renderer's image decoders. */
async function decodeViaRenderer(win: BrowserWindow | undefined, file: string): Promise<Electron.NativeImage> {
  if (!win || win.isDestroyed()) return nativeImage.createEmpty();
  const url = `studio://file/${Buffer.from(file, "utf8").toString("base64url")}`;
  const script = `(async () => {
    const r = await fetch(${JSON.stringify(url)});
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    try {
      c.getContext("2d").drawImage(bmp, 0, 0);
    } finally {
      bmp.close(); // release the decoded pixels now, not at GC
    }
    const blob = await c.convertToBlob({ type: "image/png" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  })()`;
  try {
    const b64 = (await win.webContents.executeJavaScript(script, true)) as string | null;
    return b64 ? nativeImage.createFromBuffer(Buffer.from(b64, "base64")) : nativeImage.createEmpty();
  } catch (err) {
    log.warn("clipboard", `renderer decode failed: ${String(err)}`);
    return nativeImage.createEmpty();
  }
}

async function meshExport(ctx: IpcContext, e: IpcMainInvokeEvent, payload: unknown): Promise<MeshExportResult | null> {
  if (!payload || typeof payload !== "object") fail("BAD_REQUEST", "expected MeshExportRequest");
  const req = payload as MeshExportRequest;
  const input = requireAbsolute(req.path);
  if (!fs.existsSync(input)) fail("INVALID_PATH", "input file does not exist", { path: input });
  if (!EXPORT_FORMATS.includes(req.format)) fail("BAD_REQUEST", "invalid format", { field: "format" });
  if (req.suggestedName !== undefined && typeof req.suggestedName !== "string") fail("BAD_REQUEST", "suggestedName must be a string");
  if (req.format !== "glb" && !(await refreshBlenderExe(ctx.cfg, true))) fail("BLENDER_NOT_INSTALLED", "Blender executable not found");

  const stem = (req.suggestedName ? path.parse(path.basename(req.suggestedName)).name : "") || path.parse(input).name;
  const defaultPath = path.join(defaultSaveDir("3d"), `${stem}.${req.format}`);
  const win = senderWindow(e);
  const opts: Electron.SaveDialogOptions = {
    title: "Export mesh",
    defaultPath,
    filters: [{ name: req.format.toUpperCase(), extensions: [req.format] }],
  };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  let output = res.filePath;
  if (path.extname(output).toLowerCase() !== `.${req.format}`) output += `.${req.format}`;
  lastSaveDir = path.dirname(output);

  if (req.format === "glb") {
    const started = Date.now();
    try {
      await fs.promises.copyFile(input, output);
    } catch (err) {
      fail("EXPORT_FAILED", `copy failed: ${String(err)}`, { exitCode: null, exportCode: "COPY_FAILED" });
    }
    return { format: "glb", output, files: [output], elapsedMs: Date.now() - started };
  }
  return exportWithBlender(ctx.cfg, input, output, req.format);
}

function handle(channel: string, fn: (e: IpcMainInvokeEvent, payload: unknown) => unknown): void {
  ipcMain.handle(channel, async (e, payload: unknown) => {
    try {
      return await fn(e, payload);
    } catch (err) {
      const ipcErr = toIpcError(err);
      log.warn("ipc", `${channel} rejected: ${ipcErr.message}`);
      throw ipcErr;
    }
  });
}

export function registerIpc(ctx: IpcContext): void {
  const { cfg } = ctx;

  // Synchronous bootstrap for the preload when additionalArguments is unavailable.
  ipcMain.on("studio:preload:config", (e) => {
    e.returnValue = { outputsDir: cfg.outputsDir };
  });

  handle(CH.appGetInfo, async (): Promise<AppInfo> => {
    // The registry check runs asynchronously after window creation; never report a material
    // that is about to be corrected (bounded wait, see MainWindow.whenAppearanceSettled).
    // `systemTheme()` then answers from that same cached reading (no extra `reg.exe`).
    await ctx.window.whenAppearanceSettled();
    return {
      name: "Studio",
      version: app.getVersion(),
      apiVersion: API_VERSION,
      platform: "win32",
      isDev: cfg.devServerUrl !== null,
      material: ctx.window.material,
      systemTheme: systemTheme(),
      paths: studioPaths(cfg),
      engine: { httpUrl: ENGINE_HTTP, wsUrl: ENGINE_WS },
    };
  });

  handle(CH.winMinimize, (e) => {
    senderWindow(e)?.minimize();
  });
  handle(CH.winToggleMaximize, (e) => {
    const w = senderWindow(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  handle(CH.winClose, (e) => {
    senderWindow(e)?.close();
  });
  handle(CH.winGetState, () => ctx.window.getState());
  handle(CH.winSetTheme, (_e, theme) => {
    if (!THEMES.includes(theme as ThemeName)) fail("BAD_REQUEST", "theme must be zen-light or zen-dark", { field: "theme" });
    ctx.window.setTheme(theme as ThemeName);
  });

  handle(CH.engineGetStatus, () => ctx.engine.getStatus());
  handle(CH.engineStart, () => ctx.engine.start());
  handle(CH.engineRestart, () => ctx.engine.restart());
  handle(CH.engineStop, () => ctx.engine.stop());

  handle(CH.coreScanModels, () => core.scanModels(cfg));
  handle(CH.coreTelemetry, () => {
    const pid = ctx.engine.pid;
    return core.telemetry(cfg, pid ? [pid] : []);
  });

  handle(CH.libraryScan, async (_e, opts) => {
    const result = await core.libraryScan(cfg, opts);
    // The preload strips `__thumbVersions` and keeps it for `files.toUrl` cache busting.
    return { ...result, __thumbVersions: await core.thumbVersions(result) };
  });
  handle(CH.libraryDelete, async (_e, payload) => {
    if (!Array.isArray(payload) || payload.length === 0) fail("BAD_REQUEST", "expected a non-empty array of sidecar paths");
    const paths = payload.map((p, i) => requireInside(cfg.outputsDir, p, `sidecarPaths[${i}]`));
    const result = await core.libraryDelete(cfg, paths);
    if (result.deleted.length > 0) {
      const change: LibraryChange = { reason: "deleted", ids: result.deleted.map((d) => d.id).filter((id) => id !== "") };
      ctx.broadcast(EVT.libraryChanged, change);
    }
    return result;
  });
  handle(CH.librarySetFavorite, (_e, payload) => setFavorite(ctx, payload));

  handle(CH.filesReveal, (_e, p) => {
    const file = requireAbsolute(p);
    if (!fs.existsSync(file)) fail("INVALID_PATH", "path does not exist", { path: file });
    shell.showItemInFolder(file);
  });
  handle(CH.filesOpenImages, async (e, payload) => {
    const multiple = !!(payload && typeof payload === "object" && (payload as { multiple?: unknown }).multiple === true);
    const win = senderWindow(e);
    const opts: Electron.OpenDialogOptions = {
      title: multiple ? "Open images" : "Open image",
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? [] : res.filePaths;
  });
  handle(CH.filesSaveCopy, async (e, payload) => {
    if (!payload || typeof payload !== "object") fail("BAD_REQUEST", "expected { path, suggestedName? }");
    const { path: src, suggestedName } = payload as { path?: unknown; suggestedName?: unknown };
    const file = requireAbsolute(src);
    if (!fs.existsSync(file)) fail("INVALID_PATH", "file does not exist", { path: file });
    if (suggestedName !== undefined && typeof suggestedName !== "string") fail("BAD_REQUEST", "suggestedName must be a string");
    const ext = path.extname(file);
    const is3d = [".glb", ".gltf", ".obj", ".fbx", ".stl", ".blend"].includes(ext.toLowerCase());
    let name = suggestedName ? path.basename(suggestedName) : path.basename(file);
    if (path.extname(name) === "") name += ext;
    const win = senderWindow(e);
    const opts: Electron.SaveDialogOptions = {
      title: "Save a copy",
      defaultPath: path.join(defaultSaveDir(is3d ? "3d" : "image"), name),
      filters: ext ? [{ name: ext.slice(1).toUpperCase(), extensions: [ext.slice(1)] }] : [],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    if (path.resolve(res.filePath).toLowerCase() === file.toLowerCase()) return res.filePath;
    await fs.promises.copyFile(file, res.filePath);
    lastSaveDir = path.dirname(res.filePath);
    return res.filePath;
  });

  handle(CH.clipWriteImage, async (e, p) => {
    const file = requireAbsolute(p);
    if (!fs.existsSync(file)) fail("INVALID_PATH", "file does not exist", { path: file });
    let img = nativeImage.createFromPath(file);
    if (img.isEmpty()) img = await decodeViaRenderer(senderWindow(e), file);
    if (img.isEmpty()) fail("INVALID_PATH", "file is not an image the clipboard can take", { path: file });
    clipboard.writeImage(img);
  });
  handle(CH.clipWriteText, (_e, text) => {
    if (typeof text !== "string") fail("BAD_REQUEST", "text must be a string");
    clipboard.writeText(text);
  });
  handle(CH.clipReadImage, () => {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : img.toDataURL();
  });

  handle(CH.meshExport, (e, payload) => meshExport(ctx, e, payload));

  handle(CH.blenderGetStatus, () => ctx.blender.getStatus());
  handle(CH.blenderImport, (_e, req) => ctx.blender.import(req));
  handle(CH.blenderLaunch, () => ctx.blender.launch());

  handle(CH.settingsGet, () => ctx.settings.get());
  handle(CH.settingsSet, (_e, patch) => ctx.settings.set(patch));
}
