/* Start-up: hydrate preferences, connect to the engine, load the Library, wire IPC listeners. */

import type { AppInfo, AppSettings, ThemeName } from "../shared/contract";
import { useEngineStore } from "../stores/engine";
import { useLibraryStore } from "../stores/library";
import { hydrateFromSettings, resolveTheme, startPersistence } from "../stores/persist";
import { useUiStore } from "../stores/ui";
import { engineSocket } from "./engine/socket";
import { loadLibrary } from "./libraryScan";
import { DEFAULT_SETTINGS, isDesktop, studio } from "./studio";

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = window.setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      () => {
        window.clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

function systemTheme(): ThemeName {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "zen-dark" : "zen-light";
}

export function applyTheme(theme: ThemeName, material: "mica" | "none"): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.material = material;
  void studio.window.setTheme(theme).catch(() => {});
}

export { loadLibrary };

export async function boot(): Promise<void> {
  const fallbackInfo = { material: "none", systemTheme: systemTheme() } as Pick<AppInfo, "material" | "systemTheme">;
  const [info, settings] = await Promise.all([
    withTimeout<Pick<AppInfo, "material" | "systemTheme">>(studio.app.getInfo(), 400, fallbackInfo),
    withTimeout<AppSettings>(studio.settings.get(), 400, DEFAULT_SETTINGS),
  ]);
  hydrateFromSettings(settings, info.systemTheme ?? systemTheme(), info.material ?? "none");
  const ui = useUiStore.getState();
  applyTheme(ui.theme, ui.material);
  startPersistence();

  // Follow the OS while the preference is "system".
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const s = useUiStore.getState();
    const sys = systemTheme();
    useUiStore.setState({ systemTheme: sys, theme: resolveTheme(s.themePref, sys) });
  });

  // Engine process (IPC) + socket.
  const eng = useEngineStore.getState();
  studio.engine
    .getStatus()
    .then((s) => useEngineStore.getState().setProcess(s))
    .catch(() => {});
  studio.engine.onStatus((s) => {
    const prev = useEngineStore.getState().process?.state;
    useEngineStore.getState().setProcess(s);
    engineSocket.kick();
    if ((s.state === "crashed" || s.state === "stopped") && prev !== s.state && prev !== undefined) {
      useUiStore.getState().say("The engine stopped.", {
        tone: "error",
        action: { label: "Restart", run: () => void studio.engine.restart().catch(() => {}) },
      });
    }
  });
  engineSocket.start();

  // Blender connectivity.
  studio.blender
    .getStatus()
    .then((b) => eng.setBlender(b))
    .catch(() => {});
  studio.blender.onStatus((b) => useEngineStore.getState().setBlender(b));

  // Library.
  loadLibrary();
  studio.library.onChanged((c) => {
    if (c.reason === "deleted") useLibraryStore.getState().remove(c.ids);
    loadLibrary();
  });
  if (!isDesktop) {
    // Browser fallback scans through the engine: rescan once it is reachable.
    useEngineStore.subscribe((s, p) => {
      if (s.socketConnected && !p.socketConnected) loadLibrary();
    });
  }

  // Settings changed elsewhere (another window / main).
  studio.settings.onChanged((s) => {
    const u = useUiStore.getState();
    if (s.theme !== u.themePref) useUiStore.setState({ themePref: s.theme, theme: resolveTheme(s.theme, u.systemTheme) });
  });
}
