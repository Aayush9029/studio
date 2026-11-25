import { clamp01 } from "../lib/math";

export type MurmurationPhase = "idle" | "warming" | "preview" | "reveal";

export interface MurmurationBeginOptions {
  aspect: number;
  seed: number;
  /** Render preview frames sharp with zero frost/distortion (e.g. 3D building blocks). */
  crisp?: boolean;
  /** Inpaint clip (white = covered). Ownership passes to the module, which closes it. */
  clipMask?: ImageBitmap;
}

/** DESIGN_SPEC.md §7.5 */
export interface Murmuration {
  /** Phase A. Seeds the flock deterministically from `seed`, starts the frame loop. */
  begin(opts: MurmurationBeginOptions): void;
  /** Phase B. Uploads a decoded preview; first call triggers the A→B transition. Takes ownership of `frame`. */
  pushPreview(frame: ImageBitmap, step: number, totalSteps: number): void;
  /** Phase C. 300 ms reveal into `final`; resolves when the loop has stopped. Takes ownership of `final`. */
  complete(final: ImageBitmap): Promise<void>;
  /** Phase A-only jobs: 300 ms fade-out; resolves when the loop has stopped. */
  finish(): Promise<void>;
  /** Cancel / error: 200 ms fade-out, then idle. */
  cancel(): Promise<void>;
  /** Stage or pane geometry changed (ResizeObserver). */
  layout(stage: DOMRectReadOnly, pane: DOMRectReadOnly): void;
  readonly phase: MurmurationPhase;
  dispose(): void;
}

/** Internal backend surface: the public interface plus workspace activity and theme refresh. */
export interface MurmurationBackend extends Murmuration {
  /** Inactive workspaces stop their loop; previews are still uploaded (latest only). */
  setActive(active: boolean): void;
  /** Re-read the --murmur-* palette (theme change). */
  refreshTheme(): void;
  /** Sub-progress for Phase-A-only jobs (keeps the flock calm, no dispersal until the end). */
  setProgress(p: number): void;
  /** Toggle razor-sharp unblurred preview rendering. */
  setCrisp?(on: boolean): void;
}

export interface MurmurPalette {
  ink: Float32Array; // 3
  inkAlpha: number;
  paneA: Float32Array; // 3
  paneB: Float32Array; // 3
  glow: Float32Array; // 3
}

function readTriplet(style: CSSStyleDeclaration, name: string, out: Float32Array): void {
  const raw = style.getPropertyValue(name);
  const parts = raw.split(",");
  for (let i = 0; i < 3; i++) {
    const v = parseFloat(parts[i] ?? "");
    out[i] = Number.isFinite(v) ? v / 255 : 0.5;
  }
}

/** Reads the palette from CSS custom properties (once per begin / theme change, never per frame). */
export function readPalette(target: MurmurPalette): void {
  const style = getComputedStyle(document.documentElement);
  readTriplet(style, "--murmur-ink", target.ink);
  readTriplet(style, "--murmur-pane-a", target.paneA);
  readTriplet(style, "--murmur-pane-b", target.paneB);
  readTriplet(style, "--murmur-glow", target.glow);
  const a = parseFloat(style.getPropertyValue("--murmur-ink-alpha"));
  target.inkAlpha = Number.isFinite(a) ? a : 0.65;
}

export function createPalette(): MurmurPalette {
  return { ink: new Float32Array(3), inkAlpha: 0.65, paneA: new Float32Array(3), paneB: new Float32Array(3), glow: new Float32Array(3) };
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { clamp01 };
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
export const easeOutCubic = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

/** Stage-space geometry shared by both backends (DESIGN_SPEC.md §7.2). */
export interface StageGeometry {
  cssW: number;
  cssH: number;
  /** cx, cy, halfW, halfH in stage units (canvas height spans [-1, 1]). */
  pane: Float32Array;
  /** Pane rect in CSS px relative to the canvas. */
  paneCss: { x: number; y: number; w: number; h: number };
}

export function computeGeometry(stage: DOMRectReadOnly, pane: DOMRectReadOnly, out: StageGeometry): void {
  out.cssW = Math.max(1, stage.width);
  out.cssH = Math.max(1, stage.height);
  const halfH = out.cssH / 2;
  const scx = stage.left + stage.width / 2;
  const scy = stage.top + stage.height / 2;
  const pcx = pane.left + pane.width / 2;
  const pcy = pane.top + pane.height / 2;
  out.pane[0] = (pcx - scx) / halfH;
  out.pane[1] = -(pcy - scy) / halfH;
  out.pane[2] = Math.max(1e-3, pane.width / out.cssH);
  out.pane[3] = Math.max(1e-3, pane.height / out.cssH);
  out.paneCss.x = pane.left - stage.left;
  out.paneCss.y = pane.top - stage.top;
  out.paneCss.w = pane.width;
  out.paneCss.h = pane.height;
}
