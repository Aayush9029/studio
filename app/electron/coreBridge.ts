/** Spawns `studio-core.exe` per call and unwraps its `CoreEnvelope<T>` (§6, §7.4). */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  CoreEnvelope,
  CoreTelemetry,
  LibraryDeleteResult,
  LibraryScanOptions,
  LibraryScanResult,
  ModelScan,
} from "../src/shared/contract";
import { fail, IpcError } from "./errors";
import { log } from "./log";
import type { ResolvedConfig } from "./paths";

type Command = CoreEnvelope<unknown>["command"];

export interface CoreRun<T> {
  envelope: CoreEnvelope<T>;
  exitCode: number;
}

const MAX_STDOUT = 256 * 1024 * 1024;

export function runCore<T>(
  cfg: ResolvedConfig,
  command: Command,
  args: string[],
  opts: { timeoutMs: number; stdin?: string },
): Promise<CoreRun<T>> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cfg.coreExe)) {
      reject(new IpcError("CORE_FAILED", `studio-core not found at ${cfg.coreExe}`, { coreCode: "FILE_NOT_FOUND", path: cfg.coreExe }));
      return;
    }
    const started = Date.now();
    const child = spawn(cfg.coreExe, [command, ...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, STUDIO_LOG_DIR: cfg.logsDir },
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errText = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    child.stdout.on("data", (b: Buffer) => {
      outBytes += b.length;
      if (outBytes <= MAX_STDOUT) out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (errText.length < 64 * 1024) errText += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new IpcError("CORE_FAILED", `cannot start studio-core: ${err.message}`, { coreCode: "SPAWN" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      const ms = Date.now() - started;
      if (timedOut) {
        log.error("core", `${command} timed out after ${opts.timeoutMs} ms`);
        reject(new IpcError("CORE_FAILED", `studio-core ${command} timed out`, { coreCode: "TIMEOUT", timeoutMs: opts.timeoutMs }));
        return;
      }
      const text = Buffer.concat(out).toString("utf8").trim();
      const line = text.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "";
      let envelope: CoreEnvelope<T>;
      try {
        envelope = JSON.parse(line) as CoreEnvelope<T>;
        if (typeof envelope !== "object" || envelope === null || typeof envelope.ok !== "boolean") throw new Error("not an envelope");
      } catch {
        log.error("core", `${command} exit ${exitCode}: unparseable output; stderr: ${errText.slice(-2000)}`);
        reject(new IpcError("CORE_FAILED", `studio-core ${command} printed unparseable output`, { coreCode: "PARSE", exitCode, stderr: errText.slice(-2000) }));
        return;
      }
      log.info("core", `${command} exit ${exitCode} in ${ms} ms`);
      resolve({ envelope, exitCode });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin, "utf8");
    else child.stdin.end();
  });
}

function unwrap<T>(command: Command, run: CoreRun<T>): T {
  const { envelope, exitCode } = run;
  if ((exitCode === 0 || exitCode === 3) && envelope.ok && envelope.data !== undefined) return envelope.data;
  fail("CORE_FAILED", envelope.error?.message ?? `studio-core ${command} failed`, {
    coreCode: envelope.error?.code ?? "UNKNOWN",
    exitCode,
    ...(envelope.error?.path ? { path: envelope.error.path } : {}),
  });
}

export async function scanModels(cfg: ResolvedConfig): Promise<ModelScan> {
  return unwrap("scan-models", await runCore<ModelScan>(cfg, "scan-models", ["--dir", cfg.modelsDir], { timeoutMs: 10_000 }));
}

export async function telemetry(cfg: ResolvedConfig, pids: number[]): Promise<CoreTelemetry> {
  const args = pids.flatMap((p) => ["--pid", String(p)]);
  return unwrap("telemetry", await runCore<CoreTelemetry>(cfg, "telemetry", args, { timeoutMs: 10_000 }));
}

export function libraryScanArgs(cfg: ResolvedConfig, opts: unknown): string[] {
  const args = ["--dir", cfg.outputsDir, "--thumbs"];
  if (opts === undefined || opts === null) return args;
  if (typeof opts !== "object" || Array.isArray(opts)) fail("BAD_REQUEST", "library.scan options must be an object");
  const o = opts as LibraryScanOptions & Record<string, unknown>;
  if (o.kind !== undefined) {
    if (!["all", "image", "edit", "3d"].includes(o.kind as string)) fail("BAD_REQUEST", "invalid kind", { field: "kind" });
    args.push("--kind", o.kind);
  }
  for (const key of ["limit", "offset"] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail("BAD_REQUEST", `${key} must be a non-negative integer`, { field: key });
    args.push(`--${key}`, String(v));
  }
  if (o.since !== undefined) {
    if (typeof o.since !== "string" || Number.isNaN(Date.parse(o.since))) fail("BAD_REQUEST", "since must be an ISO-8601 string", { field: "since" });
    args.push("--since", o.since);
  }
  return args;
}

export async function libraryScan(cfg: ResolvedConfig, opts: unknown): Promise<LibraryScanResult> {
  const args = libraryScanArgs(cfg, opts);
  return unwrap("library-scan", await runCore<LibraryScanResult>(cfg, "library-scan", args, { timeoutMs: 120_000 }));
}

export async function libraryDelete(cfg: ResolvedConfig, sidecars: string[]): Promise<LibraryDeleteResult> {
  const run = await runCore<LibraryDeleteResult>(cfg, "delete", ["--dir", cfg.outputsDir, "--stdin"], {
    timeoutMs: 60_000,
    stdin: JSON.stringify({ sidecars }),
  });
  const { envelope, exitCode } = run;
  if ((exitCode === 0 || exitCode === 3) && envelope.data) return envelope.data;
  if (exitCode === 1) {
    fail("DELETE_FAILED", envelope.error?.message ?? "every item failed to delete", {
      coreCode: envelope.error?.code ?? "UNKNOWN",
      failed: envelope.data?.failed ?? [],
    });
  }
  return unwrap("delete", run);
}

/** Concurrent `fs.promises.stat` calls in flight for `thumbVersions`. */
const THUMB_STAT_CONCURRENCY = 32;

/**
 * Thumbnail mtimes keyed by thumbnail file name, for `files.toUrl` cache busting (`?v=<mtimeMs>`).
 * Fully asynchronous: one `readdir` per cache directory drops thumbnails that are already gone,
 * then the rest are stat'ed with bounded concurrency, so a large library never stalls the main
 * process on thousands of synchronous NTFS stats.
 */
export async function thumbVersions(result: LibraryScanResult): Promise<Record<string, number>> {
  const byDir = new Map<string, string[]>();
  for (const item of result.items) {
    if (!item.thumbPath) continue;
    const dir = path.dirname(item.thumbPath);
    const names = byDir.get(dir);
    if (names) names.push(path.basename(item.thumbPath));
    else byDir.set(dir, [path.basename(item.thumbPath)]);
  }
  const files: Array<[name: string, file: string]> = [];
  for (const [dir, names] of byDir) {
    let present: Set<string>;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      present = new Set(entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase()));
    } catch {
      continue; // cache directory removed meanwhile
    }
    for (const name of names) if (present.has(name.toLowerCase())) files.push([name, path.join(dir, name)]);
  }

  const out: Record<string, number> = {};
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const [name, file] = files[next++];
      try {
        out[name] = Math.floor((await fs.promises.stat(file)).mtimeMs);
      } catch {
        /* removed meanwhile */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(THUMB_STAT_CONCURRENCY, files.length) }, worker));
  return out;
}
