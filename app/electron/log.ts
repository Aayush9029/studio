/**
 * Append-only logging to `logs\app.log` (plus the console in development).
 *
 * Each log file is written through one persistent append-mode `fs.WriteStream` (its directory
 * is created once, when the stream opens), so stdout/stderr chunks from child processes never
 * block the main process on a synchronous open/append/close. `flushLogs()` drains and closes the
 * streams on quit; anything logged after that is appended synchronously.
 */
import fs from "node:fs";
import path from "node:path";

let logFile: string | null = null;

/** Open streams keyed by normalised path (case-insensitive on Windows). */
const streams = new Map<string, fs.WriteStream>();
/** Files whose stream failed recently: writes are dropped until the backoff expires. */
const failedUntil = new Map<string, number>();
const FAIL_BACKOFF_MS = 5_000;
/** Set by `flushLogs()`: later writes bypass the (closed) streams. */
let closing = false;

function keyOf(file: string): string {
  const abs = path.resolve(file);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function initLog(logsDir: string): void {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    logFile = path.join(logsDir, "app.log");
    rotate(logFile);
  } catch {
    logFile = null;
  }
}

function rotate(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.size > 10 * 1024 * 1024) {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* no file yet */
  }
}

function streamFor(file: string): fs.WriteStream | null {
  const key = keyOf(file);
  const existing = streams.get(key);
  if (existing) return existing;
  const until = failedUntil.get(key);
  if (until !== undefined && Date.now() < until) return null;
  failedUntil.delete(key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    failedUntil.set(key, Date.now() + FAIL_BACKOFF_MS);
    return null;
  }
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  stream.on("error", (err) => {
    console.error(`[studio] log stream ${file} failed: ${String(err)}`);
    if (streams.get(key) === stream) streams.delete(key);
    failedUntil.set(key, Date.now() + FAIL_BACKOFF_MS);
    stream.destroy();
  });
  streams.set(key, stream);
  return stream;
}

function appendSync(file: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
  } catch {
    /* ignore */
  }
}

/** Appends `text` to `file` without blocking (synchronously once `flushLogs()` has run). */
export function appendTo(file: string, text: string): void {
  if (text === "") return;
  if (closing) {
    appendSync(file, text);
    return;
  }
  streamFor(file)?.write(text);
}

function write(level: string, scope: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${scope}: ${msg}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
  if (logFile) appendTo(logFile, line + "\n");
}

/**
 * Drains and closes every log stream (call on quit). Resolves once everything buffered has
 * reached the OS, or after `timeoutMs`. Later log lines are appended synchronously.
 */
export function flushLogs(timeoutMs = 1_000): Promise<void> {
  closing = true;
  const open = [...streams.values()];
  streams.clear();
  if (open.length === 0) return Promise.resolve();
  const drained = Promise.all(
    open.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (s.destroyed || s.writableFinished) return resolve();
          s.once("close", () => resolve());
          s.once("error", () => resolve());
          s.end();
        }),
    ),
  );
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    void drained.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

export const log = {
  info: (scope: string, msg: string) => write("INFO", scope, msg),
  warn: (scope: string, msg: string) => write("WARN", scope, msg),
  error: (scope: string, msg: string) => write("ERROR", scope, msg),
};
