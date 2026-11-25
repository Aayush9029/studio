/* Preference + workspace-state persistence through window.studio.settings (§11.2). */

import type { AppSettings, ThemeName, WorkspaceId } from "../shared/contract";
import { studio } from "../lib/studio";
import { useUiStore } from "./ui";
import { PERSISTED_GENERATE_KEYS, useGenerateStore, type GeneratePersisted } from "./generate";
import { PERSISTED_EDIT_KEYS, useEditStore, type EditPersisted } from "./edit";
import { PERSISTED_THREE_KEYS, useThreeStore, type ThreePersisted } from "./three";

const WORKSPACES: readonly WorkspaceId[] = ["generate", "edit", "three", "library"];

function pick<T extends object>(state: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) out[k] = state[k];
  return out;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function resolveTheme(pref: ThemeName | "system", system: ThemeName): ThemeName {
  return pref === "system" ? system : pref;
}

export function hydrateFromSettings(s: AppSettings, systemTheme: ThemeName, material: "mica" | "none"): void {
  const ws = WORKSPACES.includes(s.lastWorkspace) ? s.lastWorkspace : "generate";
  const state = asRecord(s.workspaceState);
  const uiState = asRecord(state.ui);
  useUiStore.setState((u) => ({
    themePref: s.theme,
    systemTheme,
    theme: resolveTheme(s.theme, systemTheme),
    material,
    sidebarCollapsed: !!s.sidebarCollapsed,
    workspace: ws,
    ignoreGenerateDrop: !!uiState.ignoreGenerateDrop,
    visited: { ...u.visited, [ws]: true },
    hydrated: true,
  }));
  useGenerateStore.getState().hydrate(asRecord(state.generate) as Partial<GeneratePersisted>);
  useEditStore.getState().hydrate(asRecord(state.edit) as Partial<EditPersisted>);
  useThreeStore.getState().hydrate(asRecord(state.three) as Partial<ThreePersisted>);
}

let timer = 0;
let lastJson = "";

function snapshot(): Partial<AppSettings> {
  const ui = useUiStore.getState();
  return {
    theme: ui.themePref,
    sidebarCollapsed: ui.sidebarCollapsed,
    lastWorkspace: ui.workspace,
    workspaceState: {
      ui: { ignoreGenerateDrop: ui.ignoreGenerateDrop },
      generate: pick(useGenerateStore.getState(), PERSISTED_GENERATE_KEYS),
      edit: pick(useEditStore.getState(), PERSISTED_EDIT_KEYS),
      three: pick(useThreeStore.getState(), PERSISTED_THREE_KEYS),
    },
  };
}

function schedule(): void {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    const snap = snapshot();
    const json = JSON.stringify(snap);
    if (json === lastJson) return;
    lastJson = json;
    studio.settings.set(snap).catch(() => {
      /* settings are best-effort */
    });
  }, 400);
}

/** Starts writing preference changes back (debounced). Returns an unsubscribe. */
export function startPersistence(): () => void {
  lastJson = JSON.stringify(snapshot());
  const unsubs = [
    useUiStore.subscribe((s, p) => {
      if (s.themePref !== p.themePref || s.sidebarCollapsed !== p.sidebarCollapsed || s.workspace !== p.workspace || s.ignoreGenerateDrop !== p.ignoreGenerateDrop) schedule();
    }),
    useGenerateStore.subscribe((s, p) => {
      if (PERSISTED_GENERATE_KEYS.some((k) => s[k] !== p[k])) schedule();
    }),
    useEditStore.subscribe((s, p) => {
      if (PERSISTED_EDIT_KEYS.some((k) => s[k] !== p[k])) schedule();
    }),
    useThreeStore.subscribe((s, p) => {
      if (PERSISTED_THREE_KEYS.some((k) => s[k] !== p[k])) schedule();
    }),
  ];
  const flush = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
      studio.settings.set(snapshot()).catch(() => {});
    }
  };
  window.addEventListener("beforeunload", flush);
  return () => {
    unsubs.forEach((u) => u());
    window.removeEventListener("beforeunload", flush);
  };
}
