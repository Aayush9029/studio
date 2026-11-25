import { create } from "zustand";
import type { ImageModel, OutputItem } from "../shared/contract";
import type { EditOpenRequest } from "./edit";
import { staticFamily, type AspectId } from "../shared/families";

export interface GeneratePersisted {
  prompt: string;
  negative: string;
  negativeOpen: boolean;
  model: ImageModel;
  width: number;
  height: number;
  aspect: AspectId | "custom";
  ratioLocked: boolean;
  seed: number;
  seedLocked: boolean;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  batch: number;
  enhance: boolean;
}

interface GenerateState extends GeneratePersisted {
  /** Item shown on the stage. */
  current: OutputItem | null;
  /** Images of the last batch, in order (for the batch dots). */
  batchItems: OutputItem[];
  /** Enhanced prompt of the last run, shown under the metadata pill. */
  enhancedNote: string | null;
  /** Temporary image drop awaiting user choice ("Edit" vs "Dismiss" / "Don't ask again"). */
  pendingDrop: EditOpenRequest | null;

  patch(p: Partial<GeneratePersisted>): void;
  setModel(m: ImageModel, defaults?: { steps: number; cfg: number; sampler: string; scheduler: string }): void;
  setSize(w: number, h: number, aspect: AspectId | "custom"): void;
  show(item: OutputItem | null): void;
  setBatch(items: OutputItem[]): void;
  addBatchItem(item: OutputItem): void;
  setEnhancedNote(s: string | null): void;
  requestDrop(d: EditOpenRequest | null): void;
  hydrate(p: Partial<GeneratePersisted>): void;
}

export function sizeMultiple(model: ImageModel): 16 | 32 {
  return model === "qwen_image" ? 32 : 16;
}

export function snapSize(v: number, multiple: number): number {
  const n = Number.isFinite(v) ? v : 1024;
  return Math.min(2048, Math.max(256, Math.round(n / multiple) * multiple));
}

const z = staticFamily("z_image").defaults!;

export const GENERATE_DEFAULTS: GeneratePersisted = {
  prompt: "",
  negative: "",
  negativeOpen: false,
  model: "z_image",
  width: 1024,
  height: 1024,
  aspect: "1:1",
  ratioLocked: false,
  seed: 3829104412,
  seedLocked: false,
  steps: z.steps,
  cfg: z.cfg,
  sampler: z.sampler,
  scheduler: z.scheduler,
  batch: 1,
  enhance: false,
};

export const PERSISTED_GENERATE_KEYS = Object.keys(GENERATE_DEFAULTS) as (keyof GeneratePersisted)[];

export const useGenerateStore = create<GenerateState>()((set) => ({
  ...GENERATE_DEFAULTS,
  current: null,
  batchItems: [],
  enhancedNote: null,
  pendingDrop: null,

  patch: (p) => set(p),
  setModel: (m, d) =>
    set((s) => {
      const f = staticFamily(m).defaults!;
      const def = d ?? f;
      const mult = sizeMultiple(m);
      return {
        model: m,
        steps: def.steps,
        cfg: def.cfg,
        sampler: def.sampler,
        scheduler: def.scheduler,
        width: snapSize(s.width, mult),
        height: snapSize(s.height, mult),
      };
    }),
  setSize: (w, h, aspect) => set({ width: w, height: h, aspect }),
  show: (item) => set({ current: item }),
  setBatch: (items) => set({ batchItems: items }),
  addBatchItem: (item) =>
    set((s) => (s.batchItems.some((i) => i.id === item.id) ? s : { batchItems: [...s.batchItems, item] })),
  setEnhancedNote: (note) => set({ enhancedNote: note }),
  requestDrop: (d) =>
    set((s) => {
      if (s.pendingDrop?.url && s.pendingDrop.url.startsWith("blob:") && s.pendingDrop.url !== d?.url) {
        URL.revokeObjectURL(s.pendingDrop.url);
      }
      return { pendingDrop: d };
    }),
  hydrate: (p) =>
    set(() => {
      const out: Partial<GeneratePersisted> = {};
      for (const k of PERSISTED_GENERATE_KEYS) {
        if (k in p && typeof p[k] === typeof GENERATE_DEFAULTS[k]) (out as Record<string, unknown>)[k] = p[k];
      }
      return out;
    }),
}));

export function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}
