/**
 * `%APPDATA%\Studio\settings.json` — validated, debounced (300 ms), atomic writes (§7.4).
 * Debounced saves are asynchronous; only `flush()` (on quit) writes synchronously.
 */
import fs from "node:fs";
import path from "node:path";

import type { AppSettings, ThemeName, WorkspaceId } from "../src/shared/contract";
import { fail } from "./errors";
import { log } from "./log";

const THEMES: ReadonlyArray<AppSettings["theme"]> = ["system", "zen-light", "zen-dark"];
const WORKSPACES: ReadonlyArray<WorkspaceId> = ["generate", "edit", "three", "library"];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  sidebarCollapsed: false,
  lastWorkspace: "generate",
  windowBounds: null,
  workspaceState: {},
};

type Bounds = NonNullable<AppSettings["windowBounds"]>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validBounds(v: unknown): v is Bounds {
  if (!isObject(v)) return false;
  const nums = ["x", "y", "width", "height"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k] as number));
  return nums && typeof v.maximized === "boolean" && (v.width as number) > 0 && (v.height as number) > 0;
}

/** Lenient merge for values read from disk: invalid fields fall back to defaults. */
function sanitize(raw: unknown): AppSettings {
  const s: AppSettings = { ...DEFAULT_SETTINGS, workspaceState: {} };
  if (!isObject(raw)) return s;
  if (THEMES.includes(raw.theme as AppSettings["theme"])) s.theme = raw.theme as AppSettings["theme"];
  if (typeof raw.sidebarCollapsed === "boolean") s.sidebarCollapsed = raw.sidebarCollapsed;
  if (WORKSPACES.includes(raw.lastWorkspace as WorkspaceId)) s.lastWorkspace = raw.lastWorkspace as WorkspaceId;
  if (raw.windowBounds === null || validBounds(raw.windowBounds)) s.windowBounds = (raw.windowBounds as Bounds | null) ?? null;
  if (isObject(raw.workspaceState)) s.workspaceState = raw.workspaceState;
  return s;
}

/** Strict validation for renderer patches: any invalid field rejects the whole patch. */
export function validatePatch(patch: unknown): Partial<AppSettings> {
  if (!isObject(patch)) fail("BAD_REQUEST", "settings patch must be an object");
  const out: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "theme":
        if (!THEMES.includes(value as AppSettings["theme"])) fail("BAD_REQUEST", "invalid theme", { field: key });
        out.theme = value as AppSettings["theme"];
        break;
      case "sidebarCollapsed":
        if (typeof value !== "boolean") fail("BAD_REQUEST", "sidebarCollapsed must be boolean", { field: key });
        out.sidebarCollapsed = value;
        break;
      case "lastWorkspace":
        if (!WORKSPACES.includes(value as WorkspaceId)) fail("BAD_REQUEST", "invalid lastWorkspace", { field: key });
        out.lastWorkspace = value as WorkspaceId;
        break;
      case "windowBounds":
        if (value !== null && !validBounds(value)) fail("BAD_REQUEST", "invalid windowBounds", { field: key });
        out.windowBounds = value as Bounds | null;
        break;
      case "workspaceState":
        if (!isObject(value)) fail("BAD_REQUEST", "workspaceState must be an object", { field: key });
        try {
          JSON.stringify(value);
        } catch {
          fail("BAD_REQUEST", "workspaceState must be JSON-serialisable", { field: key });
        }
        out.workspaceState = value;
        break;
      default:
        // Unknown keys are ignored (§1.1).
        break;
    }
  }
  return out;
}

export class SettingsStore {
  private current: AppSettings;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private listeners: Array<(s: AppSettings) => void> = [];
  /** The asynchronous save in flight, if any. */
  private writing: Promise<void> | null = null;
  /** Another change arrived while `writing`: save again when it finishes. */
  private writeAgain = false;
  /** `flush()` wrote synchronously while `writing`, whose older rename may land last. */
  private flushedDuringWrite = false;
  private dirReady = false;
  private seq = 0;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "settings.json");
    this.current = this.load();
  }

  private load(): AppSettings {
    try {
      const raw = fs.readFileSync(this.file, "utf8").replace(/^﻿/, "");
      return sanitize(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("settings", `ignoring unreadable settings: ${String(err)}`);
      return sanitize({});
    }
  }

  get(): AppSettings {
    return structuredClone(this.current);
  }

  /** Renderer-facing set: validates, merges, schedules a write and notifies listeners. */
  set(patch: unknown): AppSettings {
    const valid = validatePatch(patch);
    this.current = { ...this.current, ...valid };
    this.schedule();
    const snapshot = this.get();
    for (const l of this.listeners) l(snapshot);
    return snapshot;
  }

  /** Internal update (e.g. window bounds) without notifying the renderer. */
  update(patch: Partial<AppSettings>): void {
    this.current = { ...this.current, ...patch };
    this.schedule();
  }

  onChanged(cb: (s: AppSettings) => void): void {
    this.listeners.push(cb);
  }

  resolvedTheme(systemDark: boolean): ThemeName {
    if (this.current.theme === "system") return systemDark ? "zen-dark" : "zen-light";
    return this.current.theme;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeAsync();
    }, 300);
  }

  /** Synchronous save of anything not yet on disk; for `before-quit` only. */
  flush(): void {
    const dirty = this.timer !== null || this.writing !== null || this.writeAgain;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!dirty) return;
    this.writeAgain = false;
    this.writeSync();
    if (this.writing) this.flushedDuringWrite = true;
  }

  /** Background save: serialised, never blocks the main process. */
  private writeAsync(): void {
    if (this.writing) {
      this.writeAgain = true;
      return;
    }
    const data = JSON.stringify(this.current, null, 2);
    // Unique per write so a synchronous `flush()` never shares the temp file.
    const tmp = `${this.file}.${process.pid}.${++this.seq}.tmp`;
    const run = async (): Promise<void> => {
      try {
        if (!this.dirReady) {
          await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
          this.dirReady = true;
        }
        await fs.promises.writeFile(tmp, data, "utf8");
        await fs.promises.rename(tmp, this.file);
      } catch (err) {
        log.error("settings", `write failed: ${String(err)}`);
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      }
    };
    this.writing = run().finally(() => {
      this.writing = null;
      if (this.flushedDuringWrite) {
        // Our (older) rename may have replaced the flushed file: put the latest state back.
        this.flushedDuringWrite = false;
        this.writeSync();
      } else if (this.writeAgain) {
        this.writeAgain = false;
        this.writeAsync();
      }
    });
  }

  private writeSync(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error("settings", `write failed: ${String(err)}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
