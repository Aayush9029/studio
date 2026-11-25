/**
 * Engine daemon lifecycle (API_CONTRACT.md §2.4, §7.4).
 *
 * stopped → starting → ready → stopping → stopped, or crashed on unexpected exit.
 * A managed daemon is always shut down with the app (POST /api/shutdown, then
 * `taskkill /T /F`), so no Python/ROCm process outlives Studio.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ENGINE_HTTP, type EngineProcessStatus, type Health } from "../src/shared/contract";
import { appendTo, log } from "./log";
import type { ResolvedConfig } from "./paths";

const HEALTH_TIMEOUT_MS = 500;
const READY_POLL_MS = 250;
const READY_TIMEOUT_MS = 60_000;
const SHUTDOWN_WAIT_MS = 5_000;
const RESTART_DELAY_MS = 1_000;
const CRASH_WINDOW_MS = 60_000;
const ADOPTED_POLL_MS = 3_000;
/** How long to wait for a tree-killed PID to disappear before declaring teardown failed. */
const KILL_VERIFY_MS = 3_000;

export async function probeHealth(timeoutMs = HEALTH_TIMEOUT_MS): Promise<Health | null> {
  try {
    const res = await fetch(`${ENGINE_HTTP}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as Health;
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface KillResult {
  /** The PID is verifiably gone. */
  dead: boolean;
  /** Why taskkill failed (spawn error, timeout, non-zero exit), when the PID survived. */
  error: string | null;
}

/**
 * `taskkill /T /F` on `pid`, checking the spawn `error` and exit status, then whether the PID is
 * actually gone. taskkill exits non-zero for an already-dead PID (128), so liveness decides.
 */
function killTreeSync(pid: number): KillResult {
  let error: string | null = null;
  try {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, encoding: "utf8" });
    if (r.error) {
      error = `taskkill failed: ${r.error.message}`;
    } else if (r.status !== 0) {
      const out = `${r.stderr ?? ""} ${r.stdout ?? ""}`.replace(/\s+/g, " ").trim();
      error = `taskkill exited ${r.status ?? r.signal ?? "?"}${out ? `: ${out}` : ""}`;
    }
  } catch (err) {
    error = `taskkill failed: ${String(err)}`;
  }
  const dead = !isAlive(pid);
  if (error && dead) log.info("engine", `taskkill ${pid}: ${error} (process is gone)`);
  return { dead, error: dead ? null : error };
}

/** Tree-kills `pid` and waits briefly for it to vanish. Returns null on success, else why it survived. */
async function terminate(pid: number): Promise<string | null> {
  const r = killTreeSync(pid);
  if (r.dead) return null;
  const deadline = Date.now() + KILL_VERIFY_MS;
  while (Date.now() < deadline) {
    await sleep(50);
    if (!isAlive(pid)) return null;
  }
  const why = r.error ?? `process ${pid} still running after taskkill`;
  log.error("engine", `teardown of ${pid} failed: ${why}`);
  return why;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class EngineManager {
  private status: EngineProcessStatus = { state: "stopped", pid: null, managed: false, startedAt: null, exitCode: null, lastError: null };
  private child: ChildProcess | null = null;
  private listeners: Array<(s: EngineProcessStatus) => void> = [];
  private crashTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private adoptedTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<EngineProcessStatus> | null = null;
  private stopPromise: Promise<EngineProcessStatus> | null = null;
  /** Generation counter: exit/poll callbacks from an older child are ignored. */
  private generation = 0;
  private stderrTail = "";
  private quitting = false;
  /**
   * Lifecycle token, bumped by every `stop()` / quit. An in-flight start (e.g. the initial
   * `/api/health` probe) that sees a different token must not adopt or spawn anything.
   */
  private lifecycle = 0;
  /** Set by `stop()` / quit, cleared by an explicit `start()`: exits are then never "crashes". */
  private stopRequested = false;
  /** `lifecycle` value captured by the start currently in `startPromise`. */
  private startToken = -1;

  constructor(private readonly cfg: ResolvedConfig) {}

  onStatus(cb: (s: EngineProcessStatus) => void): void {
    this.listeners.push(cb);
  }

  getStatus(): EngineProcessStatus {
    return { ...this.status };
  }

  /** PID to report to `studio-core telemetry`. */
  get pid(): number | null {
    return this.status.pid;
  }

  private set(patch: Partial<EngineProcessStatus>): void {
    const next = { ...this.status, ...patch };
    const changed = (Object.keys(next) as Array<keyof EngineProcessStatus>).some((k) => next[k] !== this.status[k]);
    this.status = next;
    if (changed) {
      log.info("engine", `state=${next.state} pid=${next.pid ?? "-"} managed=${next.managed}${next.lastError ? ` error=${next.lastError}` : ""}`);
      const snapshot = this.getStatus();
      for (const l of this.listeners) l(snapshot);
    }
  }

  start(): Promise<EngineProcessStatus> {
    if (this.quitting) return Promise.resolve(this.getStatus());
    if (this.status.state === "ready") return Promise.resolve(this.getStatus());
    if (this.startPromise) {
      // A start cancelled by a later stop() must not be joined: wait for it to unwind, then start fresh.
      return this.startToken === this.lifecycle ? this.startPromise : this.startPromise.then(() => this.start());
    }
    if (this.stopPromise) return this.stopPromise.then(() => this.start());
    this.stopRequested = false;
    const token = this.lifecycle;
    this.startToken = token;
    const p = this.doStart(token).finally(() => {
      if (this.startPromise === p) this.startPromise = null;
    });
    this.startPromise = p;
    return p;
  }

  async restart(): Promise<EngineProcessStatus> {
    this.crashTimes = [];
    await this.stop();
    return this.start();
  }

  /** True once `stop()` or quit has begun since the start that captured `token`. */
  private cancelled(token: number): boolean {
    return token !== this.lifecycle || this.stopRequested || this.quitting;
  }

  private async doStart(token: number): Promise<EngineProcessStatus> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.set({ state: "starting", lastError: null, exitCode: null });

    // Adopt a daemon that already answers with apiVersion 1.
    const existing = await probeHealth();
    if (this.cancelled(token)) {
      // stop()/quit ran while the probe was in flight: it owns the state now; spawn nothing.
      log.info("engine", "start cancelled by stop/quit during the initial health probe");
      if (this.status.state === "starting" && !this.child) this.set({ state: "stopped", pid: null });
      return this.getStatus();
    }
    if (existing && existing.apiVersion === 1) {
      this.set({
        state: existing.status === "ok" ? "ready" : "starting",
        pid: typeof existing.pid === "number" ? existing.pid : null,
        managed: false,
        startedAt: new Date().toISOString(),
      });
      if (existing.status !== "ok") await this.waitReady(this.generation, null);
      if (!this.cancelled(token)) this.watchAdopted();
      return this.getStatus();
    }
    if (existing) log.warn("engine", `port 48210 answers with apiVersion ${String(existing.apiVersion)}; spawning anyway`);
    return this.spawnManaged(token);
  }

  private spawnManaged(token: number): Promise<EngineProcessStatus> {
    // Last gate before a process exists: never spawn once stop()/quit has begun.
    if (this.cancelled(token)) return Promise.resolve(this.getStatus());
    const c = this.cfg;
    for (const [label, p] of [["python", c.pythonExe], ["engine script", c.engineScript]] as const) {
      if (!fs.existsSync(p)) {
        this.set({ state: "stopped", pid: null, managed: true, lastError: `${label} not found: ${p}` });
        return Promise.resolve(this.getStatus());
      }
    }
    const args = [
      "-s",
      c.engineScript,
      "--host", "127.0.0.1",
      "--port", "48210",
      "--comfy-dir", c.comfyDir,
      "--models-dir", c.modelsDir,
      "--outputs-dir", c.outputsDir,
      "--state-dir", c.userDataDir,
      "--log-file", path.join(c.logsDir, "engine.log"),
      "--inkling-url", c.inklingUrl,
      "--inkling-model", c.inklingModel,
      "--parent-pid", String(process.pid),
    ];
    if (c.devServerUrl) args.push("--allow-origin", new URL(c.devServerUrl).origin);

    const gen = ++this.generation;
    this.stderrTail = "";
    log.info("engine", `spawn ${c.pythonExe} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = spawn(c.pythonExe, args, {
        cwd: path.dirname(c.engineScript),
        windowsHide: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      });
    } catch (err) {
      this.set({ state: "crashed", pid: null, managed: true, lastError: `spawn failed: ${String(err)}` });
      return Promise.resolve(this.getStatus());
    }
    this.child = child;
    this.set({ state: "starting", pid: child.pid ?? null, managed: true, startedAt: new Date().toISOString(), exitCode: null });

    const capture = (b: Buffer) => {
      const text = b.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      appendTo(path.join(c.logsDir, "app.log"), text.replace(/^/gm, "[engine-stdio] "));
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", (err) => {
      if (gen !== this.generation) return;
      this.child = null;
      this.set({ state: "crashed", pid: null, lastError: `spawn failed: ${err.message}` });
    });
    child.on("exit", (code, signal) => this.onExit(gen, code, signal));

    return this.waitReady(gen, child);
  }

  private async waitReady(gen: number, child: ChildProcess | null): Promise<EngineProcessStatus> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (gen !== this.generation || this.status.state !== "starting") return this.getStatus();
      if (child && child.exitCode !== null) return this.getStatus();
      const h = await probeHealth();
      if (gen !== this.generation || this.status.state !== "starting") return this.getStatus();
      if (h && h.apiVersion === 1 && h.status === "ok") {
        this.set({ state: "ready", pid: child?.pid ?? h.pid ?? this.status.pid });
        return this.getStatus();
      }
      await sleep(READY_POLL_MS);
    }
    const tail = this.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ");
    log.error("engine", `not ready after ${READY_TIMEOUT_MS} ms`);
    const reason = `engine did not become ready within 60 s${tail ? `: ${tail}` : ""}`;
    if (child?.pid) {
      this.generation++; // the exit that follows is ours
      const failure = await terminate(child.pid);
      if (failure) {
        // Keep the handle and PID so stop()/quit can retry; never pretend it is gone.
        this.set({ state: "crashed", pid: child.pid, lastError: `${reason}; teardown failed: ${failure}` });
        return this.getStatus();
      }
      if (this.child === child) this.child = null;
    }
    this.set({ state: "crashed", pid: null, lastError: reason });
    return this.getStatus();
  }

  private onExit(gen: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (gen !== this.generation) return;
    this.child = null;
    const exitCode = code ?? null;
    if (this.status.state === "stopping" || this.quitting || this.stopRequested) {
      this.set({ state: "stopped", pid: null, exitCode });
      return;
    }
    const tail = this.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ");
    const reason =
      exitCode === 3 ? "port 48210 already in use" :
      exitCode === 4 ? "comfyDir or modelsDir invalid" :
      exitCode === 2 ? "bad arguments" :
      `exited unexpectedly (code ${exitCode ?? "null"}${signal ? `, ${signal}` : ""})`;
    this.set({ state: "crashed", pid: null, exitCode, lastError: tail ? `${reason}: ${tail}` : reason });
    this.scheduleAutoRestart();
  }

  /** Restart once after 1 s; a second crash within 60 s stays crashed until `restart()`. */
  private scheduleAutoRestart(): void {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashTimes.push(now);
    if (this.crashTimes.length > 1 || this.quitting) {
      log.warn("engine", "second crash within 60 s; staying crashed");
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.status.state === "crashed" && !this.quitting && !this.stopRequested) void this.start();
    }, RESTART_DELAY_MS);
  }

  /** Watches an adopted daemon; treats loss of health as a crash. */
  private watchAdopted(): void {
    if (this.adoptedTimer) clearInterval(this.adoptedTimer);
    let misses = 0;
    const gen = this.generation;
    this.adoptedTimer = setInterval(async () => {
      if (gen !== this.generation || this.status.managed || this.status.state !== "ready") {
        if (this.adoptedTimer) clearInterval(this.adoptedTimer);
        this.adoptedTimer = null;
        return;
      }
      const h = await probeHealth(1000);
      misses = h ? 0 : misses + 1;
      if (misses >= 3) {
        if (this.adoptedTimer) clearInterval(this.adoptedTimer);
        this.adoptedTimer = null;
        this.set({ state: "crashed", pid: null, lastError: "adopted engine stopped responding" });
        this.scheduleAutoRestart();
      }
    }, ADOPTED_POLL_MS);
  }

  stop(): Promise<EngineProcessStatus> {
    // Invalidate any in-flight start synchronously, before anything else awaits.
    this.lifecycle++;
    this.stopRequested = true;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.doStop().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async doStop(): Promise<EngineProcessStatus> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.adoptedTimer) {
      clearInterval(this.adoptedTimer);
      this.adoptedTimer = null;
    }
    const pid = this.status.pid;
    const child = this.child;
    if (this.status.state === "stopped" || this.status.state === "crashed") {
      // A crashed state may still hold a child whose earlier teardown failed: verify it dies.
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const failure = await terminate(child.pid);
        if (failure) return this.teardownFailed(child.pid, failure);
      }
      if (child && this.child === child) {
        this.generation++;
        this.child = null;
      }
      this.set({ state: "stopped", pid: null });
      return this.getStatus();
    }
    this.set({ state: "stopping" });
    try {
      await fetch(`${ENGINE_HTTP}/api/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      /* fall through to kill */
    }
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    if (child) {
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        log.warn("engine", `did not exit within ${SHUTDOWN_WAIT_MS} ms; killing tree ${child.pid}`);
        const failure = await terminate(child.pid);
        if (failure) return this.teardownFailed(child.pid, failure);
      }
    } else if (pid) {
      // Adopted daemon: wait for it to go away, then kill by PID as a last resort.
      while (isAlive(pid) && Date.now() < deadline) await sleep(100);
      if (isAlive(pid) && (await probeHealth()) !== null) {
        const failure = await terminate(pid);
        if (failure) return this.teardownFailed(pid, failure);
      }
    }
    this.generation++;
    this.child = null;
    this.set({ state: "stopped", pid: null });
    return this.getStatus();
  }

  /** The process survived teardown: keep the handle and PID and say so, never "stopped". */
  private teardownFailed(pid: number, why: string): EngineProcessStatus {
    this.set({ state: "crashed", pid, lastError: `stop failed: engine process ${pid} is still running (${why})` });
    return this.getStatus();
  }

  /** App quit: shut a managed daemon down; leave an adopted one running. */
  async shutdownForQuit(): Promise<void> {
    this.quitting = true;
    // Cancel an in-flight start (e.g. the initial health probe) so it can never spawn now.
    this.lifecycle++;
    this.stopRequested = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.adoptedTimer) clearInterval(this.adoptedTimer);
    this.adoptedTimer = null;
    if (this.status.managed && this.child) await this.stop();
  }

  /** Last-resort synchronous cleanup from `process.on("exit")`. Keeps the handle if the PID survives. */
  killSync(): void {
    const child = this.child;
    if (!child) return;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const r = killTreeSync(child.pid);
      if (!r.dead) {
        log.error("engine", `last-resort kill of ${child.pid} not confirmed${r.error ? `: ${r.error}` : ""}`);
        return;
      }
    }
    this.child = null;
  }
}
