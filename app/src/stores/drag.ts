/* Cross-workspace internal HTML5 drag state with custom thumbnail preview. */

import { create } from "zustand";
import type { OutputItem, OutputKind } from "../shared/contract";

export interface StudioDragItem {
  kind: OutputKind;
  path: string;
  previewUrl: string;
  name: string;
  item?: OutputItem;
}

interface DragState {
  item: StudioDragItem | null;
  x: number;
  y: number;
  hoverTarget: string | null;

  start(item: StudioDragItem, x: number, y: number, dt?: DataTransfer | null): void;
  move(x: number, y: number): void;
  setHoverTarget(target: string | null): void;
  end(): void;
}

let blankGhost: HTMLCanvasElement | null = null;
function getBlankGhost(): HTMLCanvasElement {
  if (!blankGhost) {
    blankGhost = document.createElement("canvas");
    blankGhost.width = 1;
    blankGhost.height = 1;
  }
  return blankGhost;
}

export const STUDIO_DRAG_MIME = "application/x-studio-item";

export const useDragStore = create<DragState>()((set) => ({
  item: null,
  x: 0,
  y: 0,
  hoverTarget: null,

  start: (item, x, y, dt) => {
    if (dt) {
      dt.effectAllowed = "copy";
      try {
        dt.setData(STUDIO_DRAG_MIME, JSON.stringify({ kind: item.kind, path: item.path, name: item.name }));
        dt.setData("text/plain", item.path);
        dt.setDragImage(getBlankGhost(), 0, 0);
      } catch {
        /* ignore synthetic DataTransfer restrictions */
      }
    }
    set({ item, x, y, hoverTarget: null });
  },

  move: (x, y) => set((s) => (s.item && (s.x !== x || s.y !== y) ? { x, y } : s)),

  setHoverTarget: (target) => set((s) => (s.hoverTarget === target ? s : { hoverTarget: target })),

  end: () => set((s) => (s.item ? { item: null, hoverTarget: null } : s)),
}));

export function hasStudioDrag(dt: DataTransfer | null): boolean {
  if (useDragStore.getState().item) return true;
  if (!dt) return false;
  return Array.from(dt.types).includes(STUDIO_DRAG_MIME) || Array.from(dt.types).includes("Files");
}
