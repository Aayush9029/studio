/** Main window: Mica glass, native caption buttons, persisted bounds (DESIGN_SPEC.md §3.1). */
import { BrowserWindow, nativeTheme, screen, shell } from "electron";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { AppSettings, ThemeName, WindowState } from "../src/shared/contract";
import { log } from "./log";
import type { ResolvedConfig } from "./paths";
import { APP_ORIGIN } from "./protocol";
import type { SettingsStore } from "./settings";

export const SYMBOL_COLOR: Record<ThemeName, string> = { "zen-light": "#18181B", "zen-dark": "#ECEBE6" };
export const OPAQUE_BG: Record<ThemeName, string> = { "zen-light": "#F6F5F1", "zen-dark": "#0D0E12" };
const TRANSPARENT = "#00000000";
const TITLEBAR_HEIGHT = 40;
const DEFAULT_SIZE = { width: 1440, height: 920 };
const MIN_SIZE = { width: 1080, height: 700 };

const PERSONALIZE_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
/** Cap on how long `whenAppearanceSettled()` may delay its callers. */
const APPEARANCE_SETTLE_MAX_MS = 300;

/** Re-read the registry when a cached reading is older than this (and something asks). */
const APPEARANCE_MAX_AGE_MS = 60_000;

/**
 * Every REG_DWORD under `HKCU\<key>` from one asynchronous `reg query` (no `/v`), so the app
 * theme and the transparency setting cost a single `reg.exe` spawn. Empty when unreadable.
 */
function readHkcuDwords(key: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (process.platform !== "win32") return Promise.resolve(out);
  return new Promise((resolve) => {
    try {
      execFile("reg", ["query", `HKCU\\${key}`], { windowsHide: true, encoding: "utf8", timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(out);
        for (const m of stdout.matchAll(/^\s*(\S+)\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/gim)) out.set(m[1], parseInt(m[2], 16));
        resolve(out);
      });
    } catch {
      resolve(out);
    }
  });
}

interface SystemAppearance {
  /** `AppsUseLightTheme`, or null when unreadable. */
  theme: ThemeName | null;
  /** `EnableTransparency === 0`, or null when unreadable. */
  transparencyOff: boolean | null;
}

/** Last registry reading; `null` until the first asynchronous read completes. */
let cachedAppearance: SystemAppearance | null = null;
let cachedAt = 0;
let appearanceRead: Promise<SystemAppearance> | null = null;
let watchingTheme = false;

/** Refreshes the cached registry appearance; concurrent callers share one read. */
function refreshSystemAppearance(): Promise<SystemAppearance> {
  if (appearanceRead) return appearanceRead;
  appearanceRead = readHkcuDwords(PERSONALIZE_KEY)
    .then((values): SystemAppearance => {
      const light = values.get("AppsUseLightTheme") ?? null;
      const transparency = values.get("EnableTransparency") ?? null;
      cachedAppearance = {
        theme: light === null ? null : light === 0 ? "zen-dark" : "zen-light",
        transparencyOff: transparency === null ? null : transparency === 0,
      };
      cachedAt = Date.now();
      return cachedAppearance;
    })
    .finally(() => {
      appearanceRead = null;
    });
  return appearanceRead;
}

/** Keeps the cached reading current: re-read once whenever Electron reports a theme change. */
function watchSystemAppearance(): void {
  if (watchingTheme) return;
  watchingTheme = true;
  nativeTheme.on("updated", () => void refreshSystemAppearance());
}

/** OS dark mode as seen before Studio overrides `nativeTheme.themeSource` (captured in `create()`). */
let bootSystemDark: boolean | null = null;

/**
 * The OS app theme, independent of `nativeTheme.themeSource`. Never blocks: answers from the
 * cached registry reading (or Electron's view at startup). The registry is only re-read when
 * nothing is cached yet or the reading is stale; `nativeTheme` updates refresh it as well.
 */
export function systemTheme(): ThemeName {
  if (cachedAppearance === null || Date.now() - cachedAt > APPEARANCE_MAX_AGE_MS) void refreshSystemAppearance();
  if (cachedAppearance?.theme) return cachedAppearance.theme;
  const dark = bootSystemDark ?? nativeTheme.shouldUseDarkColors;
  return dark ? "zen-dark" : "zen-light";
}

/**
 * Whether Mica may be applied, from cheap synchronous facts only: Windows 11 22H2+ (build
 * 22621) and not disabled with `STUDIO_MATERIAL=none`. The "transparency effects" setting is
 * verified asynchronously after the window exists (`verifyAppearance`).
 */
export function micaCapable(): boolean {
  if (process.platform !== "win32") return false;
  if ((process.env.STUDIO_MATERIAL ?? "").toLowerCase() === "none") return false;
  const build = Number(os.release().split(".")[2] ?? 0);
  if (!Number.isFinite(build) || build < 22621) return false;
  return cachedAppearance?.transparencyOff !== true;
}

/** `p`, but resolved after at most `ms` (and never rejected). */
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}

function boundsVisible(b: NonNullable<AppSettings["windowBounds"]>): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return ix >= 120 && iy >= 40;
  });
}

export class MainWindow {
  win: BrowserWindow | null = null;
  material: "mica" | "none" = "none";
  private theme: ThemeName = "zen-light";
  private boundsTimer: NodeJS.Timeout | null = null;
  private boundsDirty = false;
  private stateListeners: Array<(s: WindowState) => void> = [];
  /** Resolves once the post-create registry check has applied any material/theme correction. */
  private appearanceSettled: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly settings: SettingsStore,
  ) {}

  onState(cb: (s: WindowState) => void): void {
    this.stateListeners.push(cb);
  }

  getState(): WindowState {
    const w = this.win;
    if (!w || w.isDestroyed()) return { maximized: false, focused: false, fullscreen: false };
    return { maximized: w.isMaximized(), focused: w.isFocused(), fullscreen: w.isFullScreen() };
  }

  private emitState(): void {
    const s = this.getState();
    for (const l of this.stateListeners) l(s);
  }

  /**
   * Creates the window immediately from the stored settings and Electron's own `nativeTheme`
   * view; no synchronous registry reads. The Windows registry (app theme, transparency effects)
   * is checked asynchronously afterwards and corrects `material`/`theme` in place if needed.
   */
  create(): BrowserWindow {
    // Before themeSource is overridden, nativeTheme reflects the OS setting.
    if (bootSystemDark === null) bootSystemDark = nativeTheme.shouldUseDarkColors;
    watchSystemAppearance();
    // Starts the single startup registry read; `verifyAppearance` below joins the same read.
    const sys = systemTheme();
    this.theme = this.settings.resolvedTheme(sys === "zen-dark");
    nativeTheme.themeSource = this.settings.get().theme === "system" ? "system" : this.theme === "zen-dark" ? "dark" : "light";

    const saved = this.settings.get().windowBounds;
    const useSaved = saved !== null && boundsVisible(saved);
    const wantMica = micaCapable();

    const common = {
      width: useSaved ? Math.max(saved.width, MIN_SIZE.width) : DEFAULT_SIZE.width,
      height: useSaved ? Math.max(saved.height, MIN_SIZE.height) : DEFAULT_SIZE.height,
      ...(useSaved ? { x: saved.x, y: saved.y } : {}),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: "Studio",
      icon: this.cfg.iconPath,
      titleBarStyle: "hidden" as const,
      titleBarOverlay: { color: TRANSPARENT, symbolColor: SYMBOL_COLOR[this.theme], height: TITLEBAR_HEIGHT },
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        additionalArguments: [`--studio-preload=${Buffer.from(JSON.stringify({ outputsDir: this.cfg.outputsDir }), "utf8").toString("base64url")}`],
      },
    };

    let win: BrowserWindow;
    if (wantMica) {
      try {
        win = new BrowserWindow({ ...common, backgroundMaterial: "mica", backgroundColor: TRANSPARENT });
        this.material = "mica";
      } catch (err) {
        log.warn("window", `Mica unavailable: ${String(err)}`);
        win = new BrowserWindow({ ...common, backgroundColor: OPAQUE_BG[this.theme] });
        this.material = "none";
      }
    } else {
      win = new BrowserWindow({ ...common, backgroundColor: OPAQUE_BG[this.theme] });
      this.material = "none";
    }
    this.win = win;
    log.info("window", `material=${this.material} theme=${this.theme}`);

    if (useSaved && saved.maximized) win.maximize();
    // Verify against the registry off the startup path. Showing waits for that check (bounded)
    // so a material/theme correction never flickers on screen.
    const settled = this.verifyAppearance(win);
    this.appearanceSettled = settled;
    win.once("ready-to-show", () => {
      void withTimeout(settled, APPEARANCE_SETTLE_MAX_MS).then(() => {
        if (!win.isDestroyed()) win.show();
      });
    });

    for (const ev of ["maximize", "unmaximize", "focus", "blur", "enter-full-screen", "leave-full-screen"] as const) {
      win.on(ev as "maximize", () => this.emitState());
    }
    // Save only after real user changes: re-saving unchanged bounds on every close drifts by a
    // pixel or two per launch under fractional DPI scaling.
    for (const ev of ["resized", "moved", "maximize", "unmaximize"] as const) {
      win.on(ev as "resized", () => {
        this.boundsDirty = true;
        this.scheduleBoundsSave();
      });
    }
    win.on("close", () => this.saveBounds());
    win.on("closed", () => {
      this.win = null;
    });

    // Navigation and window-open hardening.
    const allowedOrigins = new Set([APP_ORIGIN, ...(this.cfg.devServerUrl ? [new URL(this.cfg.devServerUrl).origin] : [])]);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && !url.startsWith("http://localhost:") && !url.startsWith("http://127.0.0.1:")) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      try {
        if (!allowedOrigins.has(new URL(url).origin)) e.preventDefault();
      } catch {
        e.preventDefault();
      }
    });
    win.webContents.on("will-attach-webview", (e) => e.preventDefault());
    win.webContents.on("did-fail-load", (_e, code, desc, url) => log.error("window", `load failed ${code} ${desc} ${url}`));
    win.webContents.on("render-process-gone", (_e, d) => log.error("window", `renderer gone: ${d.reason} (${d.exitCode})`));
    if (this.cfg.devServerUrl || process.env.STUDIO_LOG_RENDERER === "1") {
      win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
        log.info("renderer", `[${level}] ${message} (${sourceId}:${line})`);
      });
    }

    const target = this.cfg.devServerUrl ?? `${APP_ORIGIN}/index.html`;
    void win.loadURL(target).catch((err) => log.error("window", `load ${target} failed: ${String(err)}`));
    return win;
  }

  /**
   * Resolves once the startup registry check has applied (bounded, never rejects). IPC callers
   * that report `material` await this so they never hand out a value about to change.
   */
  whenAppearanceSettled(): Promise<void> {
    return withTimeout(this.appearanceSettled, APPEARANCE_SETTLE_MAX_MS);
  }

  /** Reads the registry asynchronously and corrects material/theme on `win` if they differ. */
  private async verifyAppearance(win: BrowserWindow): Promise<void> {
    let a: SystemAppearance;
    try {
      // Joins the read `systemTheme()` started in `create()` (one `reg.exe` for both values).
      a = appearanceRead ? await appearanceRead : (cachedAppearance ?? (await refreshSystemAppearance()));
    } catch (err) {
      log.warn("window", `appearance check failed: ${String(err)}`);
      return;
    }
    if (win.isDestroyed() || this.win !== win) return;
    if (this.material === "mica" && a.transparencyOff === true) {
      try {
        win.setBackgroundMaterial("none");
      } catch (err) {
        log.warn("window", `setBackgroundMaterial failed: ${String(err)}`);
      }
      this.material = "none";
      win.setBackgroundColor(OPAQUE_BG[this.theme]);
      log.info("window", "transparency effects are off; material=none");
    }
    if (this.settings.get().theme === "system" && a.theme !== null && a.theme !== this.theme) {
      log.info("window", `system theme is ${a.theme}; correcting from ${this.theme}`);
      this.applyTheme(a.theme);
    }
  }

  setTheme(theme: ThemeName): void {
    nativeTheme.themeSource = theme === "zen-dark" ? "dark" : "light";
    this.applyTheme(theme);
  }

  /** Window chrome for `theme` (caption symbols, opaque background); leaves `themeSource` alone. */
  private applyTheme(theme: ThemeName): void {
    this.theme = theme;
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    try {
      w.setTitleBarOverlay({ color: TRANSPARENT, symbolColor: SYMBOL_COLOR[theme], height: TITLEBAR_HEIGHT });
    } catch (err) {
      log.warn("window", `setTitleBarOverlay failed: ${String(err)}`);
    }
    if (this.material === "none") w.setBackgroundColor(OPAQUE_BG[theme]);
  }

  private scheduleBoundsSave(): void {
    if (this.boundsTimer) clearTimeout(this.boundsTimer);
    this.boundsTimer = setTimeout(() => this.saveBounds(), 500);
  }

  saveBounds(): void {
    if (this.boundsTimer) {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = null;
    }
    const w = this.win;
    if (!this.boundsDirty || !w || w.isDestroyed() || w.isMinimized()) return;
    this.boundsDirty = false;
    const b = w.getNormalBounds();
    this.settings.update({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized() } });
  }
}
