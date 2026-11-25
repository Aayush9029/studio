import { create } from "zustand";
import { randomSeed } from "./generate";

export type EditUiMode = "qwen_edit" | "inpaint" | "img2img";
export type EditTool = "select" | "brush" | "mask" | "eraser";

export interface EditReference {
  id: string;
  path: string;
  url: string;
}

/** Something to open as the canvas document. */
export interface EditOpenRequest {
  url?: string;
  blob?: Blob;
  name: string;
  sourceId?: string | null;
}

export interface EditPersisted {
  mode: EditUiMode;
  instruction: string;
  denoiseInpaint: number;
  denoiseImg2img: number;
  brushSize: number;
  hardnessPaint: number;
  hardnessMask: number;
  opacity: number;
  color: string;
  customColors: string[];
  seed: number;
  seedLocked: boolean;
  steps: number | null;
  cfg: number;
  sampler: string;
  scheduler: string;
  resolution: number;
  negative: string;
  enhance: boolean;
}

export interface DocMeta {
  hasDoc: boolean;
  width: number;
  height: number;
  name: string;
  sourceId: string | null;
  maskEmpty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasBefore: boolean;
  zoom: number;
}

interface EditState extends EditPersisted {
  tool: EditTool;
  maskVisible: boolean;
  compare: boolean;
  split: number;
  references: (EditReference | null)[];
  doc: DocMeta;
  pendingOpen: EditOpenRequest | null;

  patch(p: Partial<EditPersisted>): void;
  setTool(t: EditTool): void;
  setMaskVisible(v: boolean): void;
  setCompare(v: boolean): void;
  setSplit(v: number): void;
  setReference(slot: number, ref: EditReference | null): void;
  setDoc(p: Partial<DocMeta>): void;
  requestOpen(r: EditOpenRequest | null): void;
  hydrate(p: Partial<EditPersisted>): void;
}

export const EDIT_DEFAULTS: EditPersisted = {
  mode: "qwen_edit",
  instruction: "",
  denoiseInpaint: 0.85,
  denoiseImg2img: 0.6,
  brushSize: 48,
  hardnessPaint: 80,
  hardnessMask: 100,
  opacity: 100,
  color: "",
  customColors: [],
  seed: randomSeed(),
  seedLocked: false,
  steps: null,
  cfg: 1.0,
  sampler: "euler",
  scheduler: "simple",
  resolution: 1024,
  negative: "",
  enhance: false,
};

export const PERSISTED_EDIT_KEYS = Object.keys(EDIT_DEFAULTS) as (keyof EditPersisted)[];

export const useEditStore = create<EditState>()((set) => ({
  ...EDIT_DEFAULTS,
  tool: "brush",
  maskVisible: true,
  compare: false,
  split: 0.5,
  references: [null, null, null],
  doc: { hasDoc: false, width: 0, height: 0, name: "", sourceId: null, maskEmpty: true, canUndo: false, canRedo: false, hasBefore: false, zoom: 1 },
  pendingOpen: null,

  patch: (p) => set(p),
  setTool: (t) => set({ tool: t }),
  setMaskVisible: (v) => set({ maskVisible: v }),
  setCompare: (v) => set({ compare: v }),
  setSplit: (v) => set({ split: Math.min(1, Math.max(0, v)) }),
  setReference: (slot, ref) =>
    set((s) => {
      const prev = s.references[slot];
      // Reference thumbnails are object URLs of the uploaded bytes; free the one being replaced.
      if (prev?.url.startsWith("blob:") && prev.url !== ref?.url) URL.revokeObjectURL(prev.url);
      const next = s.references.slice();
      next[slot] = ref;
      return { references: next };
    }),
  setDoc: (p) => set((s) => ({ doc: { ...s.doc, ...p } })),
  requestOpen: (r) => set({ pendingOpen: r }),
  hydrate: (p) =>
    set(() => {
      const out: Record<string, unknown> = {};
      for (const k of PERSISTED_EDIT_KEYS) {
        const v = p[k];
        if (v === undefined) continue;
        const d = EDIT_DEFAULTS[k];
        if (d === null || v === null || typeof v === typeof d) out[k] = v;
      }
      return out as Partial<EditPersisted>;
    }),
}));

export function editDefaultSteps(mode: EditUiMode): number {
  return mode === "qwen_edit" ? 8 : 9;
}
