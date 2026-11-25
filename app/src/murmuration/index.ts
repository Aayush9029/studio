/* Murmuration — public entry (DESIGN_SPEC.md §7.5, §7.9).
   `createMurmuration` picks WebGL2, then Canvas2D; `prefers-reduced-motion` selects the reduced
   variant. The backend (and its GPU context) is created lazily on the first `begin()`, so idle
   workspaces cost nothing at start-up. */

import type { WorkspaceId } from "../shared/contract";
import { Canvas2DMurmuration } from "./canvas2d";
import type { Murmuration, MurmurationBackend, MurmurationBeginOptions, MurmurationPhase } from "./types";
import { WebGLMurmuration } from "./webgl";

export type { Murmuration, MurmurationPhase, MurmurationBeginOptions } from "./types";

export interface MurmurationHandle extends Murmuration {
  setActive(active: boolean): void;
  refreshTheme(): void;
  setProgress(p: number): void;
  readonly backend: "pending" | "webgl2" | "canvas2d" | "reduced" | "none";
}

const live = new Set<MurmurationHandle>();
let themeObserver: MutationObserver | null = null;

function ensureThemeObserver(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  themeObserver = new MutationObserver(() => live.forEach((m) => m.refreshTheme()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Set `localStorage["studio.murmuration.force2d"] = "1"` to exercise the Canvas2D fallback. */
function forced2d(): boolean {
  try {
    return localStorage.getItem("studio.murmuration.force2d") === "1";
  } catch {
    return false;
  }
}

class LazyMurmuration implements MurmurationHandle {
  private impl: MurmurationBackend | null = null;
  private kind: MurmurationHandle["backend"] = "pending";
  private stage: DOMRectReadOnly | null = null;
  private pane: DOMRectReadOnly | null = null;
  private active = true;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.style.visibility = "hidden";
    canvas.setAttribute("aria-hidden", "true");
  }

  get backend() {
    return this.kind;
  }

  get phase(): MurmurationPhase {
    return this.impl ? this.impl.phase : "idle";
  }

  private ensure(): MurmurationBackend | null {
    if (this.impl || this.kind === "none") return this.impl;
    const reduced = prefersReducedMotion();
    let impl: MurmurationBackend | null = null;
    if (!reduced && !forced2d()) {
      impl = WebGLMurmuration.create(this.canvas);
      if (impl) this.kind = "webgl2";
    }
    if (!impl) {
      impl = Canvas2DMurmuration.create(this.canvas, reduced);
      this.kind = impl ? (reduced ? "reduced" : "canvas2d") : "none";
    }
    this.impl = impl;
    if (impl) {
      impl.setActive(this.active);
      if (this.stage && this.pane) impl.layout(this.stage, this.pane);
    }
    return impl;
  }

  begin(opts: MurmurationBeginOptions): void {
    const impl = this.ensure();
    if (!impl) {
      opts.clipMask?.close();
      return;
    }
    impl.begin(opts);
  }

  pushPreview(frame: ImageBitmap, step: number, totalSteps: number): void {
    if (!this.impl) {
      frame.close();
      return;
    }
    this.impl.pushPreview(frame, step, totalSteps);
  }

  complete(final: ImageBitmap): Promise<void> {
    if (!this.impl) {
      final.close();
      return Promise.resolve();
    }
    return this.impl.complete(final);
  }

  finish(): Promise<void> {
    return this.impl ? this.impl.finish() : Promise.resolve();
  }

  cancel(): Promise<void> {
    return this.impl ? this.impl.cancel() : Promise.resolve();
  }

  layout(stage: DOMRectReadOnly, pane: DOMRectReadOnly): void {
    this.stage = stage;
    this.pane = pane;
    this.impl?.layout(stage, pane);
  }

  setActive(active: boolean): void {
    this.active = active;
    this.impl?.setActive(active);
  }

  refreshTheme(): void {
    this.impl?.refreshTheme();
  }

  setProgress(p: number): void {
    this.impl?.setProgress(p);
  }

  dispose(): void {
    live.delete(this);
    this.impl?.dispose();
    this.impl = null;
    this.kind = "pending";
  }
}

export function createMurmuration(canvas: HTMLCanvasElement): MurmurationHandle {
  ensureThemeObserver();
  const m = new LazyMurmuration(canvas);
  live.add(m);
  return m;
}

/* ───────── Registry: the socket hands decoded previews to the owning workspace's instance ───────── */

const registry: Partial<Record<WorkspaceId, MurmurationHandle>> = {};

export function registerMurmuration(ws: WorkspaceId, m: MurmurationHandle): () => void {
  registry[ws] = m;
  return () => {
    if (registry[ws] === m) delete registry[ws];
  };
}

export function getMurmuration(ws: WorkspaceId): MurmurationHandle | null {
  return registry[ws] ?? null;
}
