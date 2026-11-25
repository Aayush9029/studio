/* Canvas2D Murmuration fallback (DESIGN_SPEC.md §7.8) and the reduced-motion variant.
   Same lifecycle as the WebGL2 module: one rAF handle while animating, none while idle. */

import * as C from "./config";
import {
  clamp01,
  computeGeometry,
  createPalette,
  easeOutCubic,
  mulberry32,
  readPalette,
  smoothstep,
  type MurmurationBackend,
  type MurmurationBeginOptions,
  type MurmurationPhase,
  type StageGeometry,
} from "./types";

type Mode = "idle" | "run" | "reveal" | "fadeout";

const BLUR_FILTERS: string[] = Array.from({ length: C.CANVAS2D.blurMaxPx + 1 }, (_, i) => (i === 0 ? "none" : `blur(${i}px)`));

/* ───────── 2D simplex noise (Gustavson), seeded permutation, zero allocation per call ───────── */

const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);
const PERM = new Uint8Array(512);
(() => {
  const rnd = mulberry32(0x0c0ffee);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

function noise2(x: number, y: number): number {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = (PERM[ii + PERM[jj]] & 7) * 2;
    t0 *= t0;
    n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = (PERM[ii + i1 + PERM[jj + j1]] & 7) * 2;
    t1 *= t1;
    n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    const g = (PERM[ii + 1 + PERM[jj + 1]] & 7) * 2;
    t2 *= t2;
    n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
  }
  return 70 * n;
}

export class Canvas2DMurmuration implements MurmurationBackend {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reduced: boolean;
  private readonly frameBound: FrameRequestCallback;
  private readonly onVisibility: () => void;

  private raf = 0;
  private mode: Mode = "idle";
  private active = true;
  private visible = !document.hidden;
  private disposed = false;
  private lastFrame = 0;
  private dirty = false;
  private idleResolvers: (() => void)[] = [];

  private time = 0;
  private fadeIn = 0;
  private phaseB = 0;
  private previewMix = 1;
  private progress = 0;
  private progressTarget = 0;
  private revealT = 0;
  private fadeOutT = 0;
  private fadeOutMs = C.CANCEL_FADE_MS;
  private crisp = false;

  private readonly geo: StageGeometry = { cssW: 1, cssH: 1, pane: new Float32Array([0, 0, 0.6, 0.6]), paneCss: { x: 0, y: 0, w: 1, h: 1 } };
  private dpr = 1;
  private readonly palette = createPalette();
  private paneGradient: CanvasGradient | null = null;
  private inkStyle = "rgba(0,0,0,0.6)";
  private readonly particles = new Float32Array(C.CANVAS2D.particles * 4);

  private prevA: ImageBitmap | null = null;
  private prevB: ImageBitmap | null = null;
  private final: ImageBitmap | null = null;
  private clip: ImageBitmap | null = null;
  private scratch: HTMLCanvasElement | null = null;

  static create(canvas: HTMLCanvasElement, reduced: boolean): Canvas2DMurmuration | null {
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    return ctx ? new Canvas2DMurmuration(canvas, ctx, reduced) : null;
  }

  private constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, reduced: boolean) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.reduced = reduced;
    this.frameBound = (t) => this.frame(t);
    this.onVisibility = () => {
      this.visible = !document.hidden;
      if (this.visible) this.startLoop();
      else this.stopLoop();
    };
    document.addEventListener("visibilitychange", this.onVisibility);
    canvas.style.visibility = "hidden";
    this.refreshTheme();
  }

  get phase(): MurmurationPhase {
    if (this.mode === "idle") return "idle";
    if (this.mode === "run") return this.prevB ? "preview" : "warming";
    return "reveal";
  }

  begin(opts: MurmurationBeginOptions): void {
    if (this.disposed) {
      opts.clipMask?.close();
      return;
    }
    this.releaseBitmaps();
    this.clip = opts.clipMask ?? null;
    this.crisp = !!opts.crisp;
    this.mode = "run";
    this.time = 0;
    this.fadeIn = this.reduced ? 1 : 0;
    this.phaseB = 0;
    this.previewMix = 1;
    this.progress = 0;
    this.progressTarget = 0;
    this.revealT = 0;
    this.fadeOutT = 0;
    this.refreshTheme();
    this.seedParticles(opts.seed >>> 0);
    this.canvas.style.visibility = "visible";
    if (this.reduced) this.canvas.classList.add("murmur-pulse");
    this.dirty = true;
    this.startLoop();
  }

  pushPreview(frame: ImageBitmap, step: number, totalSteps: number): void {
    if (this.mode !== "run" || this.disposed) {
      frame.close();
      return;
    }
    const first = !this.prevB;
    this.prevA?.close();
    this.prevA = this.prevB;
    this.prevB = frame;
    this.previewMix = first ? 1 : 0;
    if (totalSteps > 0) this.progressTarget = Math.max(this.progressTarget, clamp01(step / totalSteps));
    if (this.reduced) {
      this.phaseB = 1;
      this.progress = this.progressTarget;
      this.canvas.classList.remove("murmur-pulse");
    }
    this.dirty = true;
    this.startLoop();
  }

  setProgress(p: number): void {
    this.progressTarget = Math.max(this.progressTarget, clamp01(p) * 0.5);
  }

  setCrisp(on: boolean): void {
    this.crisp = on;
    this.dirty = true;
  }

  complete(final: ImageBitmap): Promise<void> {
    if (this.mode === "idle" || this.disposed) {
      final.close();
      return Promise.resolve();
    }
    this.final?.close();
    this.final = final;
    this.mode = "reveal";
    this.revealT = 0;
    this.canvas.classList.remove("murmur-pulse");
    this.dirty = true;
    return this.whenIdle();
  }

  finish(): Promise<void> {
    return this.fadeOut(C.FINISH_FADE_MS);
  }

  cancel(): Promise<void> {
    return this.fadeOut(C.CANCEL_FADE_MS);
  }

  layout(stage: DOMRectReadOnly, pane: DOMRectReadOnly): void {
    computeGeometry(stage, pane, this.geo);
    // Same 2.5 MP backing-store cap as the WebGL path (matters on 4K stages).
    this.dpr = C.cappedBackingScale(this.geo.cssW, this.geo.cssH, Math.min(window.devicePixelRatio || 1, C.CANVAS2D.dprCap));
    const w = Math.max(1, Math.round(this.geo.cssW * this.dpr));
    const h = Math.max(1, Math.round(this.geo.cssH * this.dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.paneGradient = null;
    this.dirty = true;
    if (this.mode !== "idle") this.startLoop();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.startLoop();
    else {
      this.stopLoop();
      if (this.mode === "reveal" || this.mode === "fadeout") this.enterIdle();
    }
  }

  refreshTheme(): void {
    readPalette(this.palette);
    const k = this.palette.ink;
    this.inkStyle = `rgba(${Math.round(k[0] * 255)},${Math.round(k[1] * 255)},${Math.round(k[2] * 255)},${this.palette.inkAlpha})`;
    this.paneGradient = null;
    this.dirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.enterIdle();
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  // ───────── Internals ─────────

  private fadeOut(ms: number): Promise<void> {
    if (this.mode === "idle" || this.disposed) return Promise.resolve();
    if (this.mode !== "fadeout") {
      this.mode = "fadeout";
      this.fadeOutT = 0;
      this.fadeOutMs = ms;
    }
    this.canvas.classList.remove("murmur-pulse");
    this.dirty = true;
    return this.whenIdle();
  }

  private whenIdle(): Promise<void> {
    if (!this.canRun()) {
      this.enterIdle();
      return Promise.resolve();
    }
    this.startLoop();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private canRun(): boolean {
    return this.active && this.visible && !this.disposed;
  }

  private startLoop(): void {
    if (this.raf === 0 && this.mode !== "idle" && this.canRun()) {
      this.lastFrame = 0;
      this.raf = requestAnimationFrame(this.frameBound);
    }
  }

  private stopLoop(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private releaseBitmaps(): void {
    this.prevA?.close();
    this.prevB?.close();
    this.final?.close();
    this.clip?.close();
    this.prevA = this.prevB = this.final = this.clip = null;
  }

  /** Drops the clip scratch layer's backing store; it is recreated on the next clipped frame. */
  private releaseScratch(): void {
    if (!this.scratch) return;
    this.scratch.width = this.scratch.height = 1;
    this.scratch = null;
  }

  private enterIdle(): void {
    this.stopLoop();
    this.mode = "idle";
    this.canvas.style.visibility = "hidden";
    this.canvas.classList.remove("murmur-pulse");
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.releaseBitmaps();
    this.releaseScratch();
    const rs = this.idleResolvers;
    if (rs.length) {
      this.idleResolvers = [];
      for (const r of rs) r();
    }
  }

  private seedParticles(seed: number): void {
    const rnd = mulberry32(seed || 1);
    const p = this.geo.pane;
    const d = this.particles;
    for (let i = 0; i < C.CANVAS2D.particles; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd());
      const o = i * 4;
      d[o] = p[0] + Math.cos(a) * r * p[2];
      d[o + 1] = p[1] + Math.sin(a) * r * p[3];
      d[o + 2] = 0;
      d[o + 3] = 0;
    }
  }

  /** Reduced motion only animates transitions; otherwise the loop always runs. */
  private needsFrames(): boolean {
    if (!this.reduced) return true;
    return this.dirty || this.previewMix < 1 || this.mode === "reveal" || this.mode === "fadeout";
  }

  private frame(now: number): void {
    this.raf = 0;
    if (this.mode === "idle" || !this.canRun()) return;
    if (this.lastFrame !== 0 && now - this.lastFrame < C.CANVAS2D.frameMinMs) {
      this.raf = requestAnimationFrame(this.frameBound);
      return;
    }
    const dtMs = this.lastFrame === 0 ? 16.7 : Math.min(now - this.lastFrame, C.MAX_DT_MS * 2);
    this.lastFrame = now;
    if (!this.advance(dtMs)) return;
    this.draw();
    this.dirty = false;
    if (this.needsFrames()) this.raf = requestAnimationFrame(this.frameBound);
  }

  private advance(dtMs: number): boolean {
    const dt = dtMs / 1000;
    this.time += dt;
    if (this.fadeIn < 1) this.fadeIn = Math.min(1, this.fadeIn + dtMs / C.FADE_IN_MS);
    if (this.prevB && this.phaseB < 1) this.phaseB = Math.min(1, this.phaseB + dtMs / C.PHASE_B_MS);
    if (this.previewMix < 1) this.previewMix = Math.min(1, this.previewMix + dtMs / C.PREVIEW_MIX_MS);
    const np = this.progress + (this.progressTarget - this.progress) * (1 - Math.exp(-C.PROGRESS_RATE * dt));
    if (np > this.progress) this.progress = np;
    if (this.mode === "reveal") {
      this.revealT += dtMs / C.REVEAL_MS;
      if (this.revealT >= 1) {
        this.enterIdle();
        return false;
      }
    } else if (this.mode === "fadeout") {
      this.fadeOutT += dtMs / this.fadeOutMs;
      if (this.fadeOutT >= 1) {
        this.enterIdle();
        return false;
      }
    }
    if (!this.reduced) this.step(dt);
    return true;
  }

  private step(dt: number): void {
    const p = this.geo.pane;
    const d = this.particles;
    const t = this.time * 0.07;
    const disperse = this.mode === "run" ? smoothstep(0.55, 1, this.progress) : 1;
    const e = 0.01;
    for (let i = 0; i < C.CANVAS2D.particles; i++) {
      const o = i * 4;
      const x = d[o];
      const y = d[o + 1];
      const sx = x * 0.9 + i * 0.0005 + t;
      const sy = y * 0.9 - t * 0.6;
      const n = noise2(sx, sy);
      const cx = (noise2(sx, sy + e) - n) / e;
      const cy = -(noise2(sx + e, sy) - n) / e;
      const qx = (x - p[0]) / (p[2] * 1.08);
      const qy = (y - p[1]) / (p[3] * 1.08);
      const r = Math.sqrt(qx * qx + qy * qy) + 1e-4;
      const home = smoothstep(0.85, 1.25, r) * 2.2 * (1 - disperse);
      let ax = cx * 0.35 - qx * home + (qx / r) * disperse * 1.4;
      let ay = cy * 0.35 - qy * home + (qy / r) * disperse * 1.4;
      const al = Math.sqrt(ax * ax + ay * ay);
      if (al > C.SPEED.maxAccel) {
        ax *= C.SPEED.maxAccel / al;
        ay *= C.SPEED.maxAccel / al;
      }
      let vx = d[o + 2] + ax * dt;
      let vy = d[o + 3] + ay * dt;
      const s = Math.sqrt(vx * vx + vy * vy) + 1e-5;
      const cs = Math.min(Math.max(s, C.SPEED.min), C.SPEED.max * (1 + disperse));
      vx = (vx / s) * cs;
      vy = (vy / s) * cs;
      d[o] = x + vx * dt;
      d[o + 1] = y + vy * dt;
      d[o + 2] = vx;
      d[o + 3] = vy;
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const g = this.geo;
    const pc = g.paneCss;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let fade = this.fadeIn;
    if (this.mode === "fadeout") fade *= 1 - this.fadeOutT;
    const reveal = this.mode === "reveal" ? easeOutCubic(this.revealT) : 0;

    // Pane (optionally into a scratch layer when clipping to an inpaint mask).
    const clip = this.clip;
    let target: CanvasRenderingContext2D = ctx;
    if (clip) {
      if (!this.scratch) this.scratch = document.createElement("canvas");
      if (this.scratch.width !== W || this.scratch.height !== H) {
        this.scratch.width = W;
        this.scratch.height = H;
      }
      const sc = this.scratch.getContext("2d")!;
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.clearRect(0, 0, W, H);
      sc.setTransform(dpr, 0, 0, dpr, 0, 0);
      target = sc;
    }

    target.save();
    target.globalAlpha = fade;
    target.beginPath();
    target.roundRect(pc.x, pc.y, pc.w, pc.h, C.CORNER_PX);
    target.clip();
    if (!this.paneGradient) {
      const pa = this.palette.paneA;
      const pb = this.palette.paneB;
      const grad = target.createLinearGradient(pc.x, pc.y, pc.x + pc.w, pc.y + pc.h);
      grad.addColorStop(0, `rgb(${pa[0] * 255},${pa[1] * 255},${pa[2] * 255})`);
      grad.addColorStop(1, `rgb(${pb[0] * 255},${pb[1] * 255},${pb[2] * 255})`);
      this.paneGradient = grad;
    }
    target.fillStyle = this.paneGradient;
    target.fillRect(pc.x, pc.y, pc.w, pc.h);

    if (this.prevB && this.phaseB > 0) {
      const blur = this.crisp ? 0 : Math.round(C.CANVAS2D.blurMaxPx * (1 - this.progress) * (1 - reveal));
      target.filter = BLUR_FILTERS[Math.min(C.CANVAS2D.blurMaxPx, Math.max(0, blur))];
      const pb = smoothstep(0, 1, this.phaseB);
      if (this.prevA && this.previewMix < 1) {
        target.globalAlpha = fade * pb * (1 - this.previewMix);
        target.drawImage(this.prevA, pc.x, pc.y, pc.w, pc.h);
      }
      target.globalAlpha = fade * pb * (this.prevA ? this.previewMix : 1);
      target.drawImage(this.prevB, pc.x, pc.y, pc.w, pc.h);
      target.filter = "none";
    }
    if (this.final && reveal > 0) {
      target.globalAlpha = fade * reveal;
      target.drawImage(this.final, pc.x, pc.y, pc.w, pc.h);
    }
    target.restore();

    if (clip && this.scratch) {
      target.save();
      target.globalCompositeOperation = "destination-in";
      target.drawImage(clip, pc.x, pc.y, pc.w, pc.h);
      target.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.scratch, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    if (this.reduced) return;

    // Particles: one path, rotated 1.5 × 4 px dashes.
    const disperse = this.mode === "run" ? smoothstep(0.55, 1, this.progress) : 1;
    const alpha = Math.pow(1 - disperse, 1.5) * (1 - reveal) * fade;
    if (alpha <= 0.01) return;
    const d = this.particles;
    const halfH = g.cssH / 2;
    const cxs = g.cssW / 2;
    const hw = C.CANVAS2D.dashW / 2;
    const hl = C.CANVAS2D.dashH / 2;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.inkStyle;
    ctx.beginPath();
    for (let i = 0; i < C.CANVAS2D.particles; i++) {
      const o = i * 4;
      const x = cxs + d[o] * halfH;
      const y = halfH - d[o + 1] * halfH;
      const vx = d[o + 2];
      const vy = -d[o + 3];
      const s = Math.sqrt(vx * vx + vy * vy) + 1e-6;
      const ux = vx / s;
      const uy = vy / s;
      // corners of a rect aligned with (ux, uy)
      ctx.moveTo(x + ux * hl - uy * hw, y + uy * hl + ux * hw);
      ctx.lineTo(x + ux * hl + uy * hw, y + uy * hl - ux * hw);
      ctx.lineTo(x - ux * hl + uy * hw, y - uy * hl - ux * hw);
      ctx.lineTo(x - ux * hl - uy * hw, y - uy * hl + ux * hw);
      ctx.closePath();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}
