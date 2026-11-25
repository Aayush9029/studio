/* Engine state. Written only by lib/engine/socket.ts and the `engine` IPC listener (§11.2). */

import { create } from "zustand";
import type {
  BlenderStatus,
  EngineProcessStatus,
  Health,
  ModelFamilyStatus,
  Telemetry,
} from "../shared/contract";

export type EnginePhase = "starting" | "ready" | "stopped";

interface EngineState {
  process: EngineProcessStatus | null;
  health: Health | null;
  models: ModelFamilyStatus[] | null;
  telemetry: Telemetry | null;
  socketConnected: boolean;
  blender: BlenderStatus | null;

  setProcess(p: EngineProcessStatus): void;
  setHealth(h: Health | null): void;
  setModels(m: ModelFamilyStatus[]): void;
  setTelemetry(t: Telemetry): void;
  setSocket(c: boolean): void;
  setBlender(b: BlenderStatus): void;
}

let lastTelemetryCommit = 0;

export const useEngineStore = create<EngineState>()((set) => ({
  process: null,
  health: null,
  models: null,
  telemetry: null,
  socketConnected: false,
  blender: null,

  setProcess: (p) => set({ process: p }),
  setHealth: (h) => set({ health: h }),
  setModels: (m) => set({ models: m }),
  // The memory pill re-renders at most once per second (§3.4).
  setTelemetry: (t) => {
    const now = performance.now();
    if (now - lastTelemetryCommit < 950) return;
    lastTelemetryCommit = now;
    set({ telemetry: t });
  },
  setSocket: (c) => set({ socketConnected: c }),
  setBlender: (b) => set({ blender: b }),
}));

export function enginePhase(s: Pick<EngineState, "process" | "health" | "socketConnected">): EnginePhase {
  const p = s.process?.state;
  if (s.socketConnected && s.health?.status === "ok") return "ready";
  if (p === "stopped" || p === "crashed" || p === "stopping") return "stopped";
  return "starting";
}

export const useEnginePhase = () => useEngineStore((s) => enginePhase(s));
export const useInklingAvailable = () => useEngineStore((s) => !!s.health?.inklingAvailable && enginePhase(s) === "ready");
