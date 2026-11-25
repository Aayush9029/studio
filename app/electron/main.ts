/** Studio — Electron main process. */
import { app, BrowserWindow, nativeTheme, session } from "electron";
import path from "node:path";

import { BlenderBridge } from "./blenderBridge";
import { EngineManager } from "./engineManager";
import { EVT, registerIpc } from "./ipc";
import { flushLogs, initLog, log } from "./log";
import { resolveConfig } from "./paths";
import { installProtocol, registerSchemePrivileges } from "./protocol";
import { SettingsStore } from "./settings";
import { MainWindow } from "./window";

// ── Before ready ────────────────────────────────────────────────────────────
app.setName("Studio");
app.setPath("userData", path.join(app.getPath("appData"), "Studio"));
app.setAppUserModelId("Studio");
registerSchemePrivileges();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  const cfg = resolveConfig();
  initLog(cfg.logsDir);
  log.info("main", `Studio ${app.getVersion()} starting (pid ${process.pid}, dev=${cfg.devServerUrl !== null})`);
  log.info(
    "main",
    `python=${cfg.pythonExe} comfy=${cfg.comfyDir} models=${cfg.modelsDir} outputs=${cfg.outputsDir} core=${cfg.coreExe} blender=${cfg.blenderExe ?? "-"}`,
  );

  const settings = new SettingsStore(cfg.userDataDir);
  const engine = new EngineManager(cfg);
  const blender = new BlenderBridge(cfg);
  const mainWindow = new MainWindow(cfg, settings);

  const broadcast = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  };
  engine.onStatus((s) => broadcast(EVT.engineStatus, s));
  blender.onStatus((s) => broadcast(EVT.blenderStatus, s));
  settings.onChanged((s) => broadcast(EVT.settingsChanged, s));
  mainWindow.onState((s) => {
    broadcast(EVT.windowState, s);
    blender.setFocused(s.focused);
  });

  // ── Quit: never leave an orphaned engine (and its GPU memory) behind ──────
  let quitReady = false;
  let quitting = false;
  /** Drains the log streams, then lets the real quit through (once). */
  const finalQuit = (): void => {
    if (quitReady) return;
    quitReady = true;
    void flushLogs().finally(() => app.quit());
  };
  app.on("before-quit", (e) => {
    if (quitReady) return;
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    mainWindow.saveBounds();
    settings.flush();
    blender.stopPolling();
    const hardStop = setTimeout(() => {
      engine.killSync();
      finalQuit();
    }, 8_000);
    void engine
      .shutdownForQuit()
      .catch((err) => log.error("main", `engine shutdown failed: ${String(err)}`))
      .finally(() => {
        clearTimeout(hardStop);
        engine.killSync();
        log.info("main", "quit");
        finalQuit();
      });
  });
  app.on("window-all-closed", () => app.quit());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      log.info("main", `${sig} received`);
      app.quit();
    });
  }
  process.on("exit", () => engine.killSync());

  app.on("second-instance", () => {
    const w = mainWindow.win;
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  await app.whenReady();

  // Deny every permission the renderer does not need.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "clipboard-sanitized-write" || permission === "fullscreen");
  });

  installProtocol(cfg);
  registerIpc({ cfg, settings, engine, blender, window: mainWindow, broadcast });

  nativeTheme.on("updated", () => {
    // Follow the OS only while the stored preference is "system".
    if (settings.get().theme === "system") mainWindow.setTheme(nativeTheme.shouldUseDarkColors ? "zen-dark" : "zen-light");
  });

  mainWindow.create();
  blender.startPolling();
  if (process.env.STUDIO_ENGINE_AUTOSTART !== "0") void engine.start();
}
