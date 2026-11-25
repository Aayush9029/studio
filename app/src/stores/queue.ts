/* Persistent in-memory job queue allowing submissions while a job is already running. */

import { create } from "zustand";
import type { JobMode, WorkspaceId } from "../shared/contract";

export interface QueuedJob {
  id: string;
  owner: WorkspaceId;
  mode: JobMode;
  label: string;
  modelLabel: string;
  meta: string;
  previewUrl: string | null;
  createdAt: number;
  execute: () => Promise<{ jobId: string }>;
  cleanup?: () => void;
}

interface QueueState {
  items: QueuedJob[];
  drawerOpen: boolean;

  enqueue(job: Omit<QueuedJob, "id" | "createdAt">): number;
  remove(id: string): void;
  move(id: string, dir: -1 | 1): void;
  clear(): void;
  shift(): QueuedJob | null;
  setDrawerOpen(open: boolean): void;
  toggleDrawer(): void;
}

let seq = 0;

export const useQueueStore = create<QueueState>()((set, get) => ({
  items: [],
  drawerOpen: false,

  enqueue: (job) => {
    const entry: QueuedJob = {
      ...job,
      id: `q_${++seq}`,
      createdAt: Date.now(),
    };
    const next = [...get().items, entry];
    set({ items: next });
    return next.length;
  },

  remove: (id) =>
    set((s) => {
      const target = s.items.find((x) => x.id === id);
      target?.cleanup?.();
      return { items: s.items.filter((x) => x.id !== id) };
    }),

  move: (id, dir) =>
    set((s) => {
      const idx = s.items.findIndex((x) => x.id === id);
      if (idx < 0) return s;
      const to = idx + dir;
      if (to < 0 || to >= s.items.length) return s;
      const next = [...s.items];
      const [item] = next.splice(idx, 1);
      next.splice(to, 0, item);
      return { items: next };
    }),

  clear: () =>
    set((s) => {
      for (const item of s.items) item.cleanup?.();
      return { items: [] };
    }),

  shift: () => {
    const items = get().items;
    if (!items.length) return null;
    const [head, ...rest] = items;
    set({ items: rest });
    return head;
  },

  setDrawerOpen: (open) => set({ drawerOpen: open }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
}));
