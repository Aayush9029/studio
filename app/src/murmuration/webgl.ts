/* WebGL2 Murmuration: transform-feedback boids over a frosted diffusion pane (DESIGN_SPEC.md §7).

   Zero-idle guarantee (§7.5): exactly one requestAnimationFrame handle exists while the phase is
   not idle and the instance is active + visible; none otherwise. The frame callback is bound once
   in the constructor, all uniforms are written from preallocated arrays, and no timers exist. */

import snoiseSrc from "./glsl/snoise3.glsl?raw";
import updateVertSrc from "./glsl/update.vert?raw";
import updateFragSrc from "./glsl/update.frag?raw";
import fieldVertSrc from "./glsl/field.vert?raw";
import fieldFragSrc from "./glsl/field.frag?raw";
import fullscreenVertSrc from "./glsl/fullscreen.vert?raw";
import compositeFragSrc from "./glsl/composite.frag?raw";
import particlesVertSrc from "./glsl/particles.vert?raw";
import particlesFragSrc from "./glsl/particles.frag?raw";
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

const HEADER = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n";

type Mode = "idle" | "run" | "reveal" | "fadeout";

/** Adaptive quality rung, remembered for the session (§7.7). 0 full · 1 dpr 1.0 · 2 N=1500 · 3 no chroma split. */
let sessionRung = 0;
/** Rolling window of raw rAF deltas; its minimum ≈ the display's vsync period (0 = unknown). A
    rolling (not session-wide) minimum lets one jittery short callback, or a refresh-rate change,
    age out instead of skewing the ladder for the rest of the session. */
const vsyncRing = new Float32Array(C.VSYNC_WINDOW);
let vsyncIdx = 0;
let vsyncCount = 0;
let vsyncMinMs = 0;

function recordRafDelta(raw: number): void {
  const evicted = vsyncCount === C.VSYNC_WINDOW ? vsyncRing[vsyncIdx] : 0;
  vsyncRing[vsyncIdx] = raw;
  vsyncIdx = (vsyncIdx + 1) % C.VSYNC_WINDOW;
  if (vsyncCount < C.VSYNC_WINDOW) vsyncCount++;
  if (vsyncMinMs === 0 || raw <= vsyncMinMs) {
    vsyncMinMs = raw;
  } else if (evicted === vsyncMinMs) {
    let m = raw;
    for (let i = 0; i < vsyncCount; i++) if (vsyncRing[i] < m) m = vsyncRing[i];
    vsyncMinMs = m;
  }
}

interface Programs {
  update: WebGLProgram;
  field: WebGLProgram;
  composite: WebGLProgram;
  particles: WebGLProgram;
}

type Locs = Record<string, WebGLUniformLocation | null>;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Murmuration shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, varyings?: string[]): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("createProgram failed");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Murmuration program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function locations(gl: WebGL2RenderingContext, p: WebGLProgram, names: readonly string[]): Locs {
  const out: Locs = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}

export class WebGLMurmuration implements MurmurationBackend {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly frameBound: FrameRequestCallback;
  private readonly onLost: (e: Event) => void;
  private readonly onRestored: () => void;
  private readonly onVisibility: () => void;

  // Loop state
  private raf = 0;
  private mode: Mode = "idle";
  private active = true;
  private visible = !document.hidden;
  private lost = false;
  private disposed = false;
  private lastFrame = 0;
  private idleResolvers: (() => void)[] = [];

  // Clocks and animated values
  private time = 0;
  private fadeIn = 0;
  private phaseB = 0;
  private hasPreview = false;
  private previewMix = 1;
  private progress = 0;
  private progressTarget = 0;
  private revealT = 0;
  private fadeOutT = 0;
  private fadeOutMs = C.CANCEL_FADE_MS;
  private seed = 0;

  // Uniform scratch (written every frame, never reallocated)
  private uDisperse = 0;
  private uFade = 0;
  private uReveal = 0;
  private uPhaseB = 0;
  private uDistort = 0;
  private uFrost = 0;
  private uDt = 0;
  /** Static uniforms (aspect, pane, corner, px, resolution, flock, speed, palette, chroma, clip,
      sprite size) change only on layout / theme / rung / job start / context restore. */
  private staticDirty = true;

  // Geometry
  private readonly geo: StageGeometry = { cssW: 1, cssH: 1, pane: new Float32Array([0, 0, 0.6, 0.6]), paneCss: { x: 0, y: 0, w: 0, h: 0 } };
  private haveLayout = false;
  private aspect = 1;
  private corner = 0.02;
  private px = 0.002;
  private pointSize = 2.6;
  private readonly palette = createPalette();
  private readonly flock = new Float32Array(4);
  private readonly speed = new Float32Array([C.SPEED.min, C.SPEED.max, C.SPEED.maxAccel]);

  // Quality ladder
  private rung = 0;
  private n = C.BOIDS_DEFAULT;
  private chroma = 1;
  private readonly costRing = new Float32Array(C.LADDER_WINDOW);
  private costIdx = 0;
  private costCount = 0;
  private costSum = 0;
  private minInterval = 0;
  private framesSinceBegin = 0;
  private readonly missRing = new Uint8Array(C.LADDER_WINDOW);
  private missSum = 0;
  private lastRaf = 0;

  // GPU resources
  private programs!: Programs;
  private uUpdate: Locs = {};
  private uField: Locs = {};
  private uComposite: Locs = {};
  private uParticles: Locs = {};
  private state: WebGLBuffer[] = [];
  private seedBuf: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject[] = [];
  private tf: WebGLTransformFeedback[] = [];
  private quadVao: WebGLVertexArrayObject | null = null;
  private fieldTex: WebGLTexture | null = null;
  private fieldFbo: WebGLFramebuffer | null = null;
  private fieldOk = false;
  private prevTex: WebGLTexture[] = [];
  private prevW = [1, 1];
  private prevH = [1, 1];
  private prevA = 0;
  private prevB = 1;
  private finalTex: WebGLTexture | null = null;
  private clipTex: WebGLTexture | null = null;
  private useClip = false;
  private blankTex: WebGLTexture | null = null;
  private cur = 0;
  private readonly stateData = new Float32Array(C.BOIDS_MAX * 4);
  private readonly seedData = new Float32Array(C.BOIDS_MAX);

  /** Returns null when WebGL2 is unavailable on this canvas. */
  static create(canvas: HTMLCanvasElement): WebGLMurmuration | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
        desynchronized: true,
      });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new WebGLMurmuration(canvas, gl);
    } catch (e) {
      console.warn("[murmuration] WebGL2 init failed, falling back", e);
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.frameBound = (t) => this.frame(t);
    this.onLost = (e) => {
      e.preventDefault();
      this.lost = true;
      this.stopLoop();
    };
    this.onRestored = () => {
      this.lost = false;
      this.initResources();
      if (this.mode !== "idle") {
        this.seedFlock(this.seed);
        this.hasPreview = false;
        this.phaseB = 0;
        this.startLoop();
      }
    };
    this.onVisibility = () => {
      this.visible = !document.hidden;
      if (this.visible) this.startLoop();
      else this.stopLoop();
    };
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    document.addEventListener("visibilitychange", this.onVisibility);
    canvas.style.visibility = "hidden";

    // Static per-boid randoms, generated once.
    const rnd = mulberry32(0x5eed1e55);
    for (let i = 0; i < C.BOIDS_MAX; i++) this.seedData[i] = rnd();

    this.rung = sessionRung;
    this.applyRung();
    this.initResources();
    readPalette(this.palette);
  }

  // ───────── Resources ─────────

  private initResources(): void {
    const gl = this.gl;
    const withNoise = (src: string) => HEADER + snoiseSrc + "\n" + src;
    this.programs = {
      update: link(gl, withNoise(updateVertSrc), HEADER + updateFragSrc, ["vPos", "vVel"]),
      field: link(gl, HEADER + fieldVertSrc, HEADER + fieldFragSrc),
      composite: link(gl, HEADER + fullscreenVertSrc, withNoise(compositeFragSrc)),
      particles: link(gl, HEADER + particlesVertSrc, HEADER + particlesFragSrc),
    };
    this.uUpdate = locations(gl, this.programs.update, [
      "uField", "uPrevB", "uTime", "uDt", "uAspect", "uPane", "uFlock", "uSpeed", "uPhaseB", "uDisperse", "uLumaDrift",
    ]);
    this.uField = locations(gl, this.programs.field, ["uAspect"]);
    this.uComposite = locations(gl, this.programs.composite, [
      "uResolution", "uAspect", "uTime", "uCorner", "uPx", "uPane", "uField", "uPrevA", "uPrevB", "uFinal", "uClipMask",
      "uPreviewMix", "uPhaseB", "uDistort", "uFrost", "uReveal", "uFade", "uUseClip", "uChroma", "uHasField",
      "uPaneA", "uPaneB", "uGlow",
    ]);
    this.staticDirty = true; // fresh programs hold no uniform values
    this.uParticles = locations(gl, this.programs.particles, [
      "uAspect", "uPointSize", "uDisperse", "uReveal", "uFade", "uPhaseB", "uPane", "uPrevB", "uInk", "uInkAlpha", "uSpriteScale",
    ]);

    // Sampler units, fixed for the program lifetime.
    gl.useProgram(this.programs.update);
    gl.uniform1i(this.uUpdate.uField, 0);
    gl.uniform1i(this.uUpdate.uPrevB, 1);
    gl.useProgram(this.programs.composite);
    gl.uniform1i(this.uComposite.uField, 0);
    gl.uniform1i(this.uComposite.uPrevA, 1);
    gl.uniform1i(this.uComposite.uPrevB, 2);
    gl.uniform1i(this.uComposite.uFinal, 3);
    gl.uniform1i(this.uComposite.uClipMask, 4);
    gl.useProgram(this.programs.particles);
    gl.uniform1i(this.uParticles.uPrevB, 2);
    gl.useProgram(null);

    // Boid state ping-pong + static seeds.
    const bytes = C.BOIDS_MAX * 16;
    this.state = [gl.createBuffer()!, gl.createBuffer()!];
    for (const b of this.state) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_COPY);
    }
    this.seedBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.seedData, gl.STATIC_DRAW);

    this.vao = [];
    this.tf = [];
    for (let i = 0; i < 2; i++) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.state[i]);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuf);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 4, 0);
      this.vao.push(vao);

      const tf = gl.createTransformFeedback()!;
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.state[1 - i]);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      this.tf.push(tf);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
    this.quadVao = gl.createVertexArray();

    // Flock field: RGBA16F 64×64, 4 mip levels (the deepest field tap is LOD 3).
    const floatOk = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
    this.fieldOk = false;
    if (floatOk) {
      this.fieldTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
      gl.texStorage2D(gl.TEXTURE_2D, C.FIELD_LEVELS, gl.RGBA16F, C.FIELD_SIZE, C.FIELD_SIZE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, C.FIELD_LEVELS - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.fieldFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fieldTex, 0);
      this.fieldOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    this.blankTex = this.makeTexture(false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    if (!this.fieldOk) {
      // Neither float extension renders: boids follow swirl, drift and containment only (§7.3).
      if (this.fieldTex) gl.deleteTexture(this.fieldTex);
      if (this.fieldFbo) gl.deleteFramebuffer(this.fieldFbo);
      this.fieldFbo = null;
      this.fieldTex = this.blankTex;
    }

    this.prevTex = [this.makeTexture(true), this.makeTexture(true)];
    for (const t of this.prevTex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.prevW = [1, 1];
    this.prevH = [1, 1];
    this.prevA = 0;
    this.prevB = 1;
    this.finalTex = null;
    this.clipTex = null;
    this.useClip = false;
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.cur = 0;
  }

  private makeTexture(mips: boolean): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private freeResources(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const p = this.programs;
    if (p) {
      gl.deleteProgram(p.update);
      gl.deleteProgram(p.field);
      gl.deleteProgram(p.composite);
      gl.deleteProgram(p.particles);
    }
    this.state.forEach((b) => gl.deleteBuffer(b));
    gl.deleteBuffer(this.seedBuf);
    this.vao.forEach((v) => gl.deleteVertexArray(v));
    this.tf.forEach((t) => gl.deleteTransformFeedback(t));
    gl.deleteVertexArray(this.quadVao);
    if (this.fieldTex !== this.blankTex) gl.deleteTexture(this.fieldTex);
    gl.deleteFramebuffer(this.fieldFbo);
    this.prevTex.forEach((t) => gl.deleteTexture(t));
    gl.deleteTexture(this.finalTex);
    gl.deleteTexture(this.clipTex);
    gl.deleteTexture(this.blankTex);
  }

  // ───────── Public API ─────────

  get phase(): MurmurationPhase {
    switch (this.mode) {
      case "idle":
        return "idle";
      case "run":
        return this.hasPreview ? "preview" : "warming";
      default:
        return "reveal";
    }
  }

  begin(opts: MurmurationBeginOptions): void {
    if (this.disposed) {
      opts.clipMask?.close();
      return;
    }
    this.mode = "run";
    this.time = 0;
    this.fadeIn = 0;
    this.phaseB = 0;
    this.hasPreview = false;
    this.previewMix = 1;
    this.progress = 0;
    this.progressTarget = 0;
    this.revealT = 0;
    this.fadeOutT = 0;
    this.framesSinceBegin = 0;
    this.resetLadder();
    this.seed = opts.seed >>> 0;
    this.rung = Math.max(this.rung, sessionRung);
    this.applyRung();
    this.applySize();
    readPalette(this.palette);
    this.staticDirty = true;
    if (!this.lost) {
      this.seedFlock(this.seed);
      this.uploadClip(opts.clipMask ?? null);
    } else {
      opts.clipMask?.close();
    }
    this.canvas.style.visibility = "visible";
    this.startLoop();
  }

  pushPreview(frame: ImageBitmap, step: number, totalSteps: number): void {
    if (this.mode !== "run" || this.lost || this.disposed) {
      frame.close();
      return;
    }
    const gl = this.gl;
    const target = this.prevB === 0 ? 1 : 0; // overwrite the older texture
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex[target]);
    if (this.prevW[target] === frame.width && this.prevH[target] === frame.height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      this.prevW[target] = frame.width;
      this.prevH[target] = frame.height;
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    frame.close();
    this.prevA = this.prevB;
    this.prevB = target;
    this.previewMix = this.hasPreview ? 0 : 1;
    this.hasPreview = true;
    if (totalSteps > 0) this.progressTarget = Math.max(this.progressTarget, clamp01(step / totalSteps));
  }

  setProgress(p: number): void {
    // Only used for preview-less jobs; never decreases.
    this.progressTarget = Math.max(this.progressTarget, clamp01(p) * 0.5);
  }

  complete(final: ImageBitmap): Promise<void> {
    if (this.mode === "idle" || this.disposed) {
      final.close();
      return Promise.resolve();
    }
    if (!this.lost) {
      const gl = this.gl;
      if (!this.finalTex) this.finalTex = this.makeTexture(false);
      gl.bindTexture(gl.TEXTURE_2D, this.finalTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, final);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    final.close();
    this.mode = "reveal";
    this.revealT = 0;
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
    this.haveLayout = true;
    this.applySize();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.startLoop();
    else {
      this.stopLoop();
      // Nobody can see a reveal or fade on an inactive workspace: settle immediately.
      if (this.mode === "reveal" || this.mode === "fadeout") this.enterIdle();
    }
  }

  refreshTheme(): void {
    readPalette(this.palette);
    this.staticDirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.enterIdle();
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.freeResources();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // ───────── Lifecycle internals ─────────

  private fadeOut(ms: number): Promise<void> {
    if (this.mode === "idle" || this.disposed) return Promise.resolve();
    if (this.mode !== "fadeout") {
      this.mode = "fadeout";
      this.fadeOutT = 0;
      this.fadeOutMs = ms;
    }
    if (!this.canRun()) {
      this.enterIdle();
      return Promise.resolve();
    }
    return this.whenIdle();
  }

  private whenIdle(): Promise<void> {
    if (!this.canRun()) {
      this.enterIdle();
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private canRun(): boolean {
    return this.active && this.visible && !this.lost && !this.disposed;
  }

  private startLoop(): void {
    if (this.raf === 0 && this.mode !== "idle" && this.canRun()) {
      this.lastFrame = 0;
      this.lastRaf = 0;
      this.raf = requestAnimationFrame(this.frameBound);
    }
  }

  private stopLoop(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private enterIdle(): void {
    this.stopLoop();
    this.mode = "idle";
    this.canvas.style.visibility = "hidden";
    if (!this.lost && !this.gl.isContextLost()) {
      const gl = this.gl;
      if (this.finalTex) {
        gl.deleteTexture(this.finalTex);
        this.finalTex = null;
      }
      if (this.clipTex) {
        gl.deleteTexture(this.clipTex);
        this.clipTex = null;
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.useClip = false;
    this.hasPreview = false;
    const rs = this.idleResolvers;
    if (rs.length) {
      this.idleResolvers = [];
      for (const r of rs) r();
    }
  }

  private seedFlock(seed: number): void {
    const rnd = mulberry32(seed || 1);
    const d = this.stateData;
    const p = this.geo.pane;
    const cx = p[0];
    const cy = p[1];
    const hw = p[2];
    const hh = p[3];
    for (let i = 0; i < C.BOIDS_MAX; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 1.05;
      const va = rnd() * Math.PI * 2;
      const vs = C.SPEED.min + rnd() * (C.SPEED.max - C.SPEED.min) * 0.6;
      const o = i * 4;
      d[o] = cx + Math.cos(a) * r * hw;
      d[o + 1] = cy + Math.sin(a) * r * hh;
      d[o + 2] = Math.cos(va) * vs;
      d[o + 3] = Math.sin(va) * vs;
    }
    const gl = this.gl;
    this.cur = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.state[0]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private uploadClip(mask: ImageBitmap | null): void {
    this.useClip = false;
    this.staticDirty = true;
    if (!mask) return;
    const gl = this.gl;
    if (!this.clipTex) this.clipTex = this.makeTexture(false);
    gl.bindTexture(gl.TEXTURE_2D, this.clipTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
    mask.close();
    this.useClip = true;
  }

  private applyRung(): void {
    this.n = this.rung >= 2 ? C.BOIDS_LOW : C.BOIDS_DEFAULT;
    this.chroma = this.rung >= 3 ? 0 : 1;
    this.staticDirty = true;
  }

  private applySize(): void {
    const cssW = this.geo.cssW;
    const cssH = this.geo.cssH;
    let dpr = Math.min(window.devicePixelRatio || 1, C.DPR_CAP);
    if (this.rung >= 1) dpr = Math.min(dpr, 1);
    dpr = C.cappedBackingScale(cssW, cssH, dpr);

    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.aspect = cssW / cssH;
    this.corner = (C.CORNER_PX * 2) / cssH;
    this.px = 2 / h;
    this.pointSize = C.POINT_SIZE_PX * dpr * C.POINT_SPRITE_SCALE;
    this.staticDirty = true;
    if (!this.haveLayout) {
      const p = this.geo.pane;
      p[0] = 0;
      p[1] = 0;
      p[2] = 0.6 * Math.min(this.aspect, 1);
      p[3] = 0.6;
    }
  }

  /** Clears every ladder sample so a previous job's timings can't skew the next job's average. */
  private resetLadder(): void {
    this.costRing.fill(0);
    this.missRing.fill(0);
    this.costIdx = 0;
    this.costCount = 0;
    this.costSum = 0;
    this.missSum = 0;
    this.minInterval = 0;
    this.lastRaf = 0;
  }

  /** Interval a healthy frame should take: whole vsyncs needed to clear the frame cap. */
  private expectedInterval(minMs: number): number {
    const v = vsyncMinMs;
    if (v > 0) return Math.max(1, Math.ceil(minMs / v - 0.05)) * v;
    return this.minInterval > 0 ? this.minInterval : Math.max(minMs, 16.7);
  }

  private measure(workMs: number, intervalMs: number, minMs: number): void {
    this.framesSinceBegin++;
    if (intervalMs <= 0 || this.framesSinceBegin < C.LADDER_WARMUP_FRAMES || this.rung >= 3) return;
    if (this.minInterval === 0 || intervalMs < this.minInterval) this.minInterval = intervalMs;
    // Cost = JS submission time, or the overshoot beyond the expected cadence. Measuring against the
    // display's vsync (not the slowest steady interval) catches a loop that is steadily GPU-bound:
    // 33 ms intervals at 6 ms of JS still cost ~23 ms here.
    const expected = this.expectedInterval(minMs);
    const cost = Math.max(workMs, 6 + Math.max(0, intervalMs - expected));
    const missed = intervalMs > expected * C.LADDER_MISS_FACTOR ? 1 : 0;
    this.costSum += cost - this.costRing[this.costIdx];
    this.costRing[this.costIdx] = cost;
    this.missSum += missed - this.missRing[this.costIdx];
    this.missRing[this.costIdx] = missed;
    this.costIdx = (this.costIdx + 1) % C.LADDER_WINDOW;
    if (this.costCount < C.LADDER_WINDOW) this.costCount++;
    if (this.costCount < C.LADDER_WINDOW) return;
    const slowCpu = this.costSum / C.LADDER_WINDOW > C.LADDER_THRESHOLD_MS;
    const missing = this.missSum / C.LADDER_WINDOW > C.LADDER_MISS_RATIO;
    if (slowCpu || missing) {
      this.rung++;
      sessionRung = Math.max(sessionRung, this.rung);
      this.applyRung();
      this.applySize();
      this.resetLadder();
      this.framesSinceBegin = 0;
    }
  }

  // ───────── Frame loop ─────────

  private frame(now: number): void {
    this.raf = 0;
    if (this.mode === "idle" || !this.canRun()) return;
    this.raf = requestAnimationFrame(this.frameBound);

    // Raw rAF cadence (including skipped callbacks) estimates the display's vsync period.
    if (this.lastRaf !== 0) {
      const raw = now - this.lastRaf;
      if (raw >= 4) recordRafDelta(raw);
    }
    this.lastRaf = now;

    const focused = document.hasFocus();
    const minMs = focused ? C.FRAME_MIN_MS : C.FRAME_MIN_MS_UNFOCUSED;
    if (this.lastFrame !== 0 && now - this.lastFrame < minMs) return;
    const interval = this.lastFrame === 0 ? 0 : now - this.lastFrame;
    const dtMs = this.lastFrame === 0 ? 16.7 : Math.min(interval, C.MAX_DT_MS);
    this.lastFrame = now;

    const t0 = performance.now();
    if (!this.advance(dtMs)) return; // went idle
    this.render();
    // An unfocused window is throttled by the compositor: its cadence says nothing about the GPU.
    if (focused) this.measure(performance.now() - t0, interval, minMs);
  }

  /** Advances every clock; returns false when the module entered idle on this frame. */
  private advance(dtMs: number): boolean {
    const dt = dtMs / 1000;
    this.uDt = dt;
    this.time += dt;
    if (this.fadeIn < 1) this.fadeIn = Math.min(1, this.fadeIn + dtMs / C.FADE_IN_MS);
    if (this.hasPreview && this.phaseB < 1) this.phaseB = Math.min(1, this.phaseB + dtMs / C.PHASE_B_MS);
    if (this.previewMix < 1) this.previewMix = Math.min(1, this.previewMix + dtMs / C.PREVIEW_MIX_MS);

    const k = 1 - Math.exp(-C.PROGRESS_RATE * dt);
    const np = this.progress + (this.progressTarget - this.progress) * k;
    if (np > this.progress) this.progress = np;

    let disperse = smoothstep(0.55, 1.0, this.progress);
    let fade = this.fadeIn;
    let reveal = 0;

    if (this.mode === "reveal") {
      this.revealT += dtMs / C.REVEAL_MS;
      if (this.revealT >= 1) {
        this.enterIdle();
        return false;
      }
      reveal = easeOutCubic(this.revealT);
      disperse = 1;
    } else if (this.mode === "fadeout") {
      this.fadeOutT += dtMs / this.fadeOutMs;
      if (this.fadeOutT >= 1) {
        this.enterIdle();
        return false;
      }
      fade *= 1 - this.fadeOutT;
      disperse = 1;
    }

    const pb = smoothstep(0, 1, this.phaseB);
    this.uPhaseB = pb;
    this.uDisperse = disperse;
    this.uFade = fade;
    this.uReveal = reveal;
    this.uDistort = C.DISTORT_AMOUNT * Math.pow(1 - this.progress, C.DISTORT_POW) * (1 - reveal);
    this.uFrost = C.FROST_MAX_LOD * (1 - smoothstep(0, 0.9, this.progress));
    return true;
  }

  private render(): void {
    const gl = this.gl;
    const n = this.n;
    const cur = this.cur;
    const pane = this.geo.pane;
    const fieldOk = this.fieldOk;
    const uploadStatic = this.staticDirty;
    this.staticDirty = false;

    if (uploadStatic) {
      const k = fieldOk ? 1 : 0;
      this.flock[0] = C.FLOCK.cohesion * k;
      this.flock[1] = C.FLOCK.alignment * k;
      this.flock[2] = C.FLOCK.separation * k;
      this.flock[3] = C.FLOCK.swirl;
    }

    // 1. FIELD
    if (fieldOk) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo);
      gl.viewport(0, 0, C.FIELD_SIZE, C.FIELD_SIZE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.programs.field);
      if (uploadStatic) gl.uniform1f(this.uField.uAspect, this.aspect);
      gl.bindVertexArray(this.vao[cur]);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0); // the previous frame left TEXTURE4 active
      gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    // 2. UPDATE (transform feedback)
    gl.disable(gl.BLEND);
    gl.enable(gl.RASTERIZER_DISCARD);
    const uu = this.uUpdate;
    gl.useProgram(this.programs.update);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex[this.prevB]);
    gl.uniform1f(uu.uTime, this.time);
    gl.uniform1f(uu.uDt, this.uDt);
    gl.uniform1f(uu.uPhaseB, this.uPhaseB);
    gl.uniform1f(uu.uDisperse, this.uDisperse);
    if (uploadStatic) {
      gl.uniform1f(uu.uAspect, this.aspect);
      gl.uniform4fv(uu.uPane, pane);
      gl.uniform4fv(uu.uFlock, this.flock);
      gl.uniform3fv(uu.uSpeed, this.speed);
      gl.uniform1f(uu.uLumaDrift, C.LUMA_DRIFT);
    }
    gl.bindVertexArray(this.vao[cur]);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf[cur]);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.endTransformFeedback();
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.disable(gl.RASTERIZER_DISCARD);
    const next = 1 - cur;
    this.cur = next;

    // 3. COMPOSITE
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const uc = this.uComposite;
    gl.useProgram(this.programs.composite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex[this.prevA]);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex[this.prevB]);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.finalTex ?? this.blankTex);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.clipTex ?? this.blankTex);
    gl.uniform1f(uc.uTime, this.time);
    gl.uniform1f(uc.uPreviewMix, this.previewMix);
    gl.uniform1f(uc.uPhaseB, this.uPhaseB);
    gl.uniform1f(uc.uDistort, this.uDistort);
    gl.uniform1f(uc.uFrost, this.uFrost);
    gl.uniform1f(uc.uReveal, this.uReveal);
    gl.uniform1f(uc.uFade, this.uFade);
    if (uploadStatic) {
      gl.uniform2f(uc.uResolution, w, h);
      gl.uniform1f(uc.uAspect, this.aspect);
      gl.uniform1f(uc.uCorner, this.corner);
      gl.uniform1f(uc.uPx, this.px);
      gl.uniform4fv(uc.uPane, pane);
      gl.uniform1f(uc.uUseClip, this.useClip ? 1 : 0);
      gl.uniform1f(uc.uChroma, this.chroma);
      gl.uniform1f(uc.uHasField, fieldOk ? 1 : 0);
      gl.uniform3fv(uc.uPaneA, this.palette.paneA);
      gl.uniform3fv(uc.uPaneB, this.palette.paneB);
      gl.uniform3fv(uc.uGlow, this.palette.glow);
    }
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 4. PARTICLES
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const up = this.uParticles;
    gl.useProgram(this.programs.particles);
    gl.uniform1f(up.uDisperse, this.uDisperse);
    gl.uniform1f(up.uReveal, this.uReveal);
    gl.uniform1f(up.uFade, this.uFade);
    gl.uniform1f(up.uPhaseB, this.uPhaseB);
    if (uploadStatic) {
      gl.uniform1f(up.uAspect, this.aspect);
      gl.uniform1f(up.uPointSize, this.pointSize);
      gl.uniform4fv(up.uPane, pane);
      gl.uniform3fv(up.uInk, this.palette.ink);
      gl.uniform1f(up.uInkAlpha, this.palette.inkAlpha);
      gl.uniform1f(up.uSpriteScale, C.POINT_SPRITE_SCALE);
    }
    gl.bindVertexArray(this.vao[next]);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
