import { create } from "zustand";
import type { Engine3D, Mode3D, OutputItem, RemeshResolution, Stage3DId } from "../shared/contract";
import { randomSeed } from "./generate";

export type Shading = "pbr" | "clay" | "wireframe" | "normals";
export type Lighting = "studio" | "warm" | "rim";
export type MilestoneStatus = "pending" | "active" | "done" | "skipped" | "error";

export interface Milestone {
  status: MilestoneStatus;
  imageUrl: string | null;
  step: number;
  total: number;
}

export const STAGE_ORDER: readonly Stage3DId[] = ["source", "cutout", "depth", "structure", "shape", "texture", "mesh"];
export const STAGE_LABEL: Record<Stage3DId, string> = {
  source: "Source",
  cutout: "Cutout",
  depth: "Depth",
  structure: "Structure",
  shape: "Shape",
  texture: "Texture",
  mesh: "Mesh",
};

export interface ThreeSource {
  /** Absolute path when known (outputs, dropped files in Electron). */
  path: string | null;
  /** Bytes when the path is not known (pasted image, browser). */
  blob: Blob | null;
  url: string;
  sourceId: string | null;
}

export interface ThreePersisted {
  mode: Mode3D;
  engine: Engine3D;
  prompt: string;
  targetFaces: number;
  remesh: RemeshResolution;
  removeBg: boolean;
  seed: number;
  seedLocked: boolean;
  enhance: boolean;
  shading: Shading;
  lighting: Lighting;
  exposure: number;
  autoRotate: boolean;
}

interface ThreeState extends ThreePersisted {
  source: ThreeSource | null;
  current: OutputItem | null;
  milestones: Record<Stage3DId, Milestone>;
  stripVisible: boolean;
  /** Clay thumbnail shown large while the final GLB is still coming. */
  shapeStill: string | null;

  patch(p: Partial<ThreePersisted>): void;
  setSource(s: ThreeSource | null): void;
  setCurrent(item: OutputItem | null): void;
  resetMilestones(): void;
  setMilestone(id: Stage3DId, m: Partial<Milestone>): void;
  setMilestones(m: Record<Stage3DId, Milestone>): void;
  setStripVisible(v: boolean): void;
  setShapeStill(url: string | null): void;
  hydrate(p: Partial<ThreePersisted>): void;
}

export function emptyMilestones(): Record<Stage3DId, Milestone> {
  const out = {} as Record<Stage3DId, Milestone>;
  for (const id of STAGE_ORDER) out[id] = { status: "pending", imageUrl: null, step: 0, total: 0 };
  return out;
}

export const THREE_DEFAULTS: ThreePersisted = {
  mode: "t23d",
  engine: "pixal3d",
  prompt: "",
  targetFaces: 300000,
  remesh: 512,
  removeBg: true,
  seed: randomSeed(),
  seedLocked: false,
  enhance: false,
  shading: "pbr",
  lighting: "studio",
  exposure: 1,
  autoRotate: false,
};

export const PERSISTED_THREE_KEYS = Object.keys(THREE_DEFAULTS) as (keyof ThreePersisted)[];

export const useThreeStore = create<ThreeState>()((set) => ({
  ...THREE_DEFAULTS,
  source: null,
  current: null,
  milestones: emptyMilestones(),
  stripVisible: false,
  shapeStill: null,

  patch: (p) => set(p),
  setSource: (s) =>
    set((st) => {
      const prev = st.source;
      // Dropped / picked sources are previewed through object URLs; free the one being replaced.
      if (prev?.url.startsWith("blob:") && prev.url !== s?.url) URL.revokeObjectURL(prev.url);
      return { source: s };
    }),
  setCurrent: (item) => set({ current: item }),
  resetMilestones: () => set({ milestones: emptyMilestones() }),
  setMilestone: (id, m) => set((s) => ({ milestones: { ...s.milestones, [id]: { ...s.milestones[id], ...m } } })),
  setMilestones: (m) => set({ milestones: m }),
  setStripVisible: (v) => set({ stripVisible: v }),
  setShapeStill: (url) => set({ shapeStill: url }),
  hydrate: (p) =>
    set(() => {
      const out: Record<string, unknown> = {};
      for (const k of PERSISTED_THREE_KEYS) {
        if (p[k] !== undefined && typeof p[k] === typeof THREE_DEFAULTS[k]) out[k] = p[k];
      }
      return out as Partial<ThreePersisted>;
    }),
}));
