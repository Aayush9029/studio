import { create } from "zustand";
import type { FamilyId, ThemeName, WorkspaceId } from "../shared/contract";

export interface WhisperAction {
  label: string;
  run: () => void;
}

export interface Whisper {
  id: number;
  text: string;
  tone: "info" | "error";
  action?: WhisperAction;
}

interface UiState {
  workspace: WorkspaceId;
  visited: Record<WorkspaceId, boolean>;
  sidebarCollapsed: boolean;
  /** Window narrower than the comfortable threshold: sidebar renders as a rail regardless of preference. */
  narrow: boolean;
  themePref: ThemeName | "system";
  theme: ThemeName;
  systemTheme: ThemeName;
  material: "mica" | "none";
  modelsDrawerOpen: boolean;
  expandFamily: FamilyId | null;
  whisper: Whisper | null;
  hydrated: boolean;
  /** Measured capsule heights, for stage insets and whisper placement. */
  capsuleH: Record<WorkspaceId, number>;
  setCapsuleH(ws: WorkspaceId, h: number): void;

  setWorkspace(ws: WorkspaceId): void;
  toggleSidebar(): void;
  setNarrow(n: boolean): void;
  setTheme(t: ThemeName): void;
  toggleTheme(): void;
  openModels(family?: FamilyId): void;
  closeModels(): void;
  toggleModels(): void;
  say(text: string, opts?: { tone?: "info" | "error"; action?: WhisperAction }): void;
  clearWhisper(id?: number): void;
}

let whisperSeq = 0;

export const useUiStore = create<UiState>()((set, get) => ({
  workspace: "generate",
  visited: { generate: true, edit: false, three: false, library: false },
  sidebarCollapsed: false,
  narrow: false,
  themePref: "system",
  theme: "zen-light",
  systemTheme: "zen-light",
  material: "none",
  modelsDrawerOpen: false,
  expandFamily: null,
  whisper: null,
  hydrated: false,
  capsuleH: { generate: 104, edit: 140, three: 140, library: 0 },
  setCapsuleH: (ws, h) => set((s) => (s.capsuleH[ws] === h ? s : { capsuleH: { ...s.capsuleH, [ws]: h } })),

  setWorkspace: (ws) =>
    set((s) => (s.workspace === ws ? s : { workspace: ws, visited: s.visited[ws] ? s.visited : { ...s.visited, [ws]: true } })),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setNarrow: (n) => set((s) => (s.narrow === n ? s : { narrow: n })),
  setTheme: (t) => set({ theme: t, themePref: t }),
  toggleTheme: () => {
    const next: ThemeName = get().theme === "zen-dark" ? "zen-light" : "zen-dark";
    set({ theme: next, themePref: next });
  },
  openModels: (family) => set({ modelsDrawerOpen: true, expandFamily: family ?? null }),
  closeModels: () => set({ modelsDrawerOpen: false, expandFamily: null }),
  toggleModels: () => set((s) => ({ modelsDrawerOpen: !s.modelsDrawerOpen, expandFamily: null })),
  say: (text, opts) => set({ whisper: { id: ++whisperSeq, text, tone: opts?.tone ?? "info", action: opts?.action } }),
  clearWhisper: (id) => set((s) => (id === undefined || s.whisper?.id === id ? { whisper: null } : s)),
}));

export const say = (text: string, opts?: { tone?: "info" | "error"; action?: WhisperAction }) => useUiStore.getState().say(text, opts);
