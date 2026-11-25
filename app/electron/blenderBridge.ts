/** Blender add-on bridge and headless mesh export (API_CONTRACT.md §7.4, §9). */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  BLENDER_HTTP,
  type BlenderImportRequest,
  type BlenderImportResult,
  type BlenderStatus,
  type MeshExportFormat,
  type MeshExportResult,
} from "../src/shared/contract";
import { fail, IpcError, requireAbsolute } from "./errors";
import { appendTo, log } from "./log";
import { refreshBlenderExe, type ResolvedConfig } from "./paths";

const HEALTH_TIMEOUT_MS = 400;
const IMPORT_TIMEOUT_MS = 90_000;
const EXPORT_TIMEOUT_MS = 180_000;
/** Connected: keep `busy`/version fresh. */
const POLL_FOCUSED_MS = 3_000;
const POLL_BLURRED_MS = 15_000;
/** Steady-state while disconnected (a launch switches to a 1 s burst instead). */
const POLL_DISCONNECTED_FOCUSED_MS = 10_000;
const POLL_DISCONNECTED_BLURRED_MS = 15_000;
const BLENDER_SERIES = "5.3";
const IMPORT_EXTS = new Set([".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply"]);

interface HealthBody {
  status?: string;
  addonVersion?: string;
  blenderVersion?: string;
  busy?: boolean;
}

export class BlenderBridge {
  private status: BlenderStatus;
  private timer: NodeJS.Timeout | null = null;
  private focused = true;
  private burstUntil = 0;
  private listeners: Array<(s: BlenderStatus) => void> = [];
  /** The health check in flight; concurrent `poll()` callers share it instead of reading stale status. */
  private inFlightPoll: Promise<BlenderStatus> | null = null;
  /** The launch in flight; a double-clicked Launch joins it instead of starting a second Blender. */
  private inFlightLaunch: Promise<BlenderStatus> | null = null;
  /** Background polling is on; `stopPolling()` clears it so an in-flight poll cannot re-arm the timer. */
  private pollingEnabled = false;
  /** The Blender process we last launched, until it exits. */
  private launchedChild: ChildProcess | null = null;

  constructor(private readonly cfg: ResolvedConfig) {
    this.status = { connected: false, installed: cfg.blenderExe !== null, blenderVersion: null, addonVersion: null, busy: false, checkedAt: 0 };
  }

  onStatus(cb: (s: BlenderStatus) => void): void {
    this.listeners.push(cb);
  }

  getStatus(): BlenderStatus {
    return { ...this.status };
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (focused) void this.poll();
    else this.schedule();
  }

  startPolling(): void {
    this.pollingEnabled = true;
    void this.poll();
  }

  stopPolling(): void {
    this.pollingEnabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pollingEnabled) return;
    const burst = Date.now() < this.burstUntil;
    const delay = burst
      ? 1_000
      : this.status.connected
        ? this.focused
          ? POLL_FOCUSED_MS
          : POLL_BLURRED_MS
        : this.focused
          ? POLL_DISCONNECTED_FOCUSED_MS
          : POLL_DISCONNECTED_BLURRED_MS;
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  /** Checks the add-on now. Concurrent callers share one request and all get its fresh result. */
  poll(): Promise<BlenderStatus> {
    if (this.inFlightPoll) return this.inFlightPoll;
    const p = this.doPoll().finally(() => {
      if (this.inFlightPoll === p) this.inFlightPoll = null;
      // Re-arm only while polling is enabled (checked inside schedule()).
      this.schedule();
    });
    this.inFlightPoll = p;
    return p;
  }

  private async doPoll(): Promise<BlenderStatus> {
    try {
      // Cached (re-checked at most every 30 s), asynchronous; launch() forces a fresh check.
      const installed = (await refreshBlenderExe(this.cfg)) !== null;
      let next: BlenderStatus = { connected: false, installed, blenderVersion: null, addonVersion: null, busy: false, checkedAt: Date.now() };
      // No Blender on this machine and nothing connected: skip the network probe entirely.
      if (installed || this.status.connected) next = (await this.probeHealth(installed)) ?? next;
      const prev = this.status;
      this.status = next;
      const changed =
        prev.connected !== next.connected ||
        prev.installed !== next.installed ||
        prev.blenderVersion !== next.blenderVersion ||
        prev.addonVersion !== next.addonVersion ||
        prev.busy !== next.busy;
      if (changed) {
        const snapshot = this.getStatus();
        for (const l of this.listeners) l(snapshot);
      }
      return this.getStatus();
    } catch (err) {
      log.warn("blender", `poll failed: ${String(err)}`);
      return this.getStatus();
    }
  }

  /** `GET /health` on the add-on; `null` when it is not running or not answering "ok". */
  private async probeHealth(installed: boolean): Promise<BlenderStatus | null> {
    try {
      const res = await fetch(`${BLENDER_HTTP}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const body = (await res.json()) as HealthBody;
      if (!body || body.status !== "ok") return null;
      return {
        connected: true,
        installed,
        blenderVersion: typeof body.blenderVersion === "string" ? body.blenderVersion : null,
        addonVersion: typeof body.addonVersion === "string" ? body.addonVersion : null,
        busy: body.busy === true,
        checkedAt: Date.now(),
      };
    } catch {
      return null; // not running
    }
  }

  async import(req: unknown): Promise<BlenderImportResult> {
    if (!req || typeof req !== "object") fail("BAD_REQUEST", "import request must be an object");
    const r = req as BlenderImportRequest;
    const file = requireAbsolute(r.path);
    if (!fs.existsSync(file)) fail("INVALID_PATH", "file does not exist", { path: file });
    if (!IMPORT_EXTS.has(path.extname(file).toLowerCase())) fail("INVALID_PATH", "unsupported format for Blender import", { path: file });
    const body: BlenderImportRequest = { path: file };
    if (r.name !== undefined) {
      if (typeof r.name !== "string") fail("BAD_REQUEST", "name must be a string", { field: "name" });
      body.name = r.name;
    }
    for (const k of ["autoGround", "smoothShade"] as const) {
      if (r[k] !== undefined) {
        if (typeof r[k] !== "boolean") fail("BAD_REQUEST", `${k} must be boolean`, { field: k });
        body[k] = r[k];
      }
    }
    let res: Response;
    try {
      res = await fetch(`${BLENDER_HTTP}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
      });
    } catch (err) {
      void this.poll();
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (timedOut) fail("BLENDER_IMPORT_FAILED", "Blender did not answer within 90 s", { blenderCode: "TIMEOUT" });
      fail("BLENDER_UNREACHABLE", "cannot connect to the Blender add-on on 127.0.0.1:48215");
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* handled below */
    }
    void this.poll();
    const o = (json ?? {}) as { ok?: boolean; error?: { code?: string; message?: string } } & Partial<BlenderImportResult>;
    if (res.ok && o.ok === true) return o as BlenderImportResult;
    fail("BLENDER_IMPORT_FAILED", o.error?.message ?? `Blender import failed (HTTP ${res.status})`, {
      blenderCode: o.error?.code ?? `HTTP_${res.status}`,
      status: res.status,
    });
  }

  addonInstallDir(): string {
    return path.join(app.getPath("appData"), "Blender Foundation", "Blender", BLENDER_SERIES, "scripts", "addons");
  }

  /** Copies the add-on when missing or older than the source copy. */
  installAddon(): boolean {
    const src = this.cfg.blenderBridgeSrc;
    if (!fs.existsSync(src)) {
      log.warn("blender", `add-on source missing: ${src}`);
      return false;
    }
    const dir = this.addonInstallDir();
    const dst = path.join(dir, "studio_bridge.py");
    try {
      const srcStat = fs.statSync(src);
      let needsCopy = true;
      try {
        needsCopy = fs.statSync(dst).mtimeMs < srcStat.mtimeMs;
      } catch {
        needsCopy = true;
      }
      if (needsCopy) {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${dst}.${process.pid}.tmp`;
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, dst);
        fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
        log.info("blender", `installed add-on to ${dst}`);
      }
      return true;
    } catch (err) {
      log.error("blender", `add-on install failed: ${String(err)}`);
      return false;
    }
  }

  /** Starts Blender with the add-on unless it is already connected. Concurrent calls share one launch. */
  launch(): Promise<BlenderStatus> {
    if (this.inFlightLaunch) return this.inFlightLaunch;
    const p = this.doLaunch().finally(() => {
      if (this.inFlightLaunch === p) this.inFlightLaunch = null;
    });
    this.inFlightLaunch = p;
    return p;
  }

  private async doLaunch(): Promise<BlenderStatus> {
    const exe = await refreshBlenderExe(this.cfg, true);
    if (!exe) fail("BLENDER_NOT_INSTALLED", "Blender executable not found");
    const current = await this.poll();
    if (current.connected) return current;
    // A Blender we launched is still running (booting, add-on not up yet): never start a second one.
    const prev = this.launchedChild;
    if (prev && prev.exitCode === null && prev.signalCode === null) {
      log.info("blender", `launch skipped: Blender ${prev.pid ?? "?"} is still starting`);
      return current;
    }
    this.installAddon();
    try {
      const child = spawn(exe, ["--addons", "studio_bridge"], { detached: true, stdio: "ignore", windowsHide: false });
      this.launchedChild = child;
      const forget = () => {
        if (this.launchedChild === child) this.launchedChild = null;
      };
      child.on("error", (err) => {
        forget();
        log.error("blender", `launch failed: ${err.message}`);
      });
      child.on("exit", forget);
      child.unref();
    } catch (err) {
      fail("BLENDER_NOT_INSTALLED", `cannot start Blender: ${String(err)}`);
    }
    // Poll every second for a while so the connection shows up promptly.
    this.burstUntil = Date.now() + 60_000;
    this.schedule();
    return this.getStatus();
  }
}

/** Runs `export_mesh.py` headlessly and parses its `STUDIO_EXPORT ` result line (§9.3). */
export async function exportWithBlender(
  cfg: ResolvedConfig,
  input: string,
  output: string,
  format: Exclude<MeshExportFormat, "glb">,
): Promise<MeshExportResult> {
  const exe = await refreshBlenderExe(cfg, true);
  if (!exe) return Promise.reject(new IpcError("BLENDER_NOT_INSTALLED", "Blender executable not found"));
  if (!fs.existsSync(cfg.exportMeshScript)) {
    return Promise.reject(new IpcError("EXPORT_FAILED", `export script missing: ${cfg.exportMeshScript}`, { exitCode: null, exportCode: "SCRIPT_MISSING" }));
  }
  const logFile = path.join(cfg.logsDir, "blender-export.log");
  const args = ["--background", "--factory-startup", "--python", cfg.exportMeshScript, "--", "--input", input, "--output", output, "--format", format];
  const started = Date.now();
  appendTo(logFile, `\n=== ${new Date().toISOString()} ${exe} ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {
        child.kill();
      }
    }, EXPORT_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      const t = b.toString("utf8");
      stdout = (stdout + t).slice(-1024 * 1024);
      appendTo(logFile, t);
    });
    child.stderr.on("data", (b: Buffer) => appendTo(logFile, b.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new IpcError("EXPORT_FAILED", `cannot start Blender: ${err.message}`, { exitCode: null, exportCode: "SPAWN" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      appendTo(logFile, `=== exit ${code ?? "null"} after ${Date.now() - started} ms\n`);
      const line = stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith("STUDIO_EXPORT "))
        .pop();
      let result: { ok?: boolean; files?: string[]; output?: string; elapsedMs?: number; error?: { code?: string; message?: string } } | null = null;
      if (line) {
        try {
          result = JSON.parse(line.slice("STUDIO_EXPORT ".length));
        } catch {
          result = null;
        }
      }
      if (timedOut) {
        reject(new IpcError("EXPORT_FAILED", "Blender export timed out after 180 s", { exitCode: code, exportCode: "TIMEOUT" }));
        return;
      }
      if (code === 0 && result?.ok === true) {
        resolve({
          format,
          output: typeof result.output === "string" ? result.output : output,
          files: Array.isArray(result.files) ? result.files.filter((f): f is string => typeof f === "string") : [output],
          elapsedMs: Date.now() - started,
        });
        return;
      }
      reject(
        new IpcError("EXPORT_FAILED", result?.error?.message ?? `Blender export failed (exit ${code ?? "null"})`, {
          exitCode: code,
          exportCode: result?.error?.code ?? null,
        }),
      );
    });
  });
}
