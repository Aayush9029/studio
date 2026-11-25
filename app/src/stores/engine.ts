/* Engine state + rolling telemetry history. Written by lib/engine/socket.ts and engine IPC. */

import { create } from "zustand";
import type {
  BlenderStatus,
  EngineProcessStatus,
  Health,
  ModelFamilyStatus,
  Telemetry,
} from "../shared/contract";

export type EnginePhase = "starting" | "ready" | "stopped";

export interface TelemetrySample {
  ts: number;
  vramPct: number;
  ramPct: number;
  cpuPct: number | null;
}

const MAX_HISTORY = 28;

interface EngineState {
  process: EngineProcessStatus | null;
  health: Health | null;
  models: ModelFamilyStatus[] | null;
  telemetry: Telemetry | null;
  history: TelemetrySample[];
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

function sampleFrom(t: Telemetry): TelemetrySample {
  const vramPct = t.vramTotalMb > 0 ? Math.min(100, Math.max(0, (t.vramUsedMb / t.vramTotalMb) * 100)) : 0;
  const ramPct = t.ramTotalMb > 0 ? Math.min(100, Math.max(0, (t.ramUsedMb / t.ramTotalMb) * 100)) : 0;
  const rawCpu = t.cpuUtilPct;
  const cpuPct = rawCpu != null && Number.isFinite(rawCpu) ? Math.min(100, Math.max(0, rawCpu)) : null;
  return { ts: t.ts, vramPct, ramPct, cpuPct };
}

export const useEngineStore = create<EngineState>()((set) => ({
  process: null,
  health: null,
  models: null,
  telemetry: null,
  history: [],
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
    const sample = sampleFrom(t);
    set((s) => {
      const next = s.history.length >= MAX_HISTORY ? s.history.slice(s.history.length - (MAX_HISTORY - 1)) : s.history;
      return { telemetry: t, history: [...next, sample] };
    });
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
