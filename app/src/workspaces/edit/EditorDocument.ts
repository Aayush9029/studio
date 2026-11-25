/* Non-reactive canvas document (DESIGN_SPEC.md §5.2.1): three same-sized layers + a view transform.
   The visible <canvas> redraws only when something changed (dirty flag + one rAF), never in a loop.

   Accuracy & memory rules:
   • Layer occupancy is tracked exactly per 64 px tile and re-verified from real alpha over the
     tiles an operation touched, so a 1 px stroke on a 2048² document always counts (mask
     detection, undo snapshots, export).
   • Stroke history stores sparse, tile-aligned diffs (one region per run of touched tiles), and
     all retained diff bytes stay under MAX_RETAINED_BYTES.
   • Base/comparison ImageBitmaps are reference-counted across the document and history; at most
     MAX_BASE_BITMAPS unique bitmaps are alive, and each is closed as soon as its last holder drops.
   • During a stroke only the damaged rectangle (brush footprint + softness + edge pad) is
     re-tinted and re-composited; zoom/pan/resize/doc-load still redraw everything.
   • Only layers that are read back with getImageData (paint, mask, their backups, the probe) opt
     into `willReadFrequently` (CPU backing); stroke buffer, tint, edge and stamps stay
     GPU-accelerated. The base is drawn straight from its ImageBitmap (no duplicate canvas), and
     the tint/edge overlays exist only while the mask is non-empty. */

type Layer = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export type StrokeKind = "paint" | "mask" | "erase";
export type LayerId = "paint" | "mask";

export interface BrushParams {
  size: number;
  hardness: number; // 0–1
  opacity: number; // 0–1
  color: string;
}

export interface DocChange {
  hasDoc: boolean;
  width: number;
  height: number;
  maskEmpty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasBefore: boolean;
  zoom: number;
  /** Bumps on pixel mutations only (open, strokes, mask ops, undo/redo) — never on view changes. */
  contentVersion: number;
}

/** Synchronous copies taken at submission time; encoding them later can't mix revisions. */
export interface SubmissionCapture {
  /** Base flattened with paint (what the engine receives). */
  image: Layer;
  /** 8-bit mask: white = regenerate, black = keep. */
  mask: Layer | null;
  /** Murmuration inpaint clip, ≤ 512 px. */
  clip: Layer | null;
}

/** Half-open rectangle in document (or screen) pixels. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Integer, tile-aligned pixel region. */
interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Diff extends Region {
  /** `null` = fully transparent. */
  before: ImageData | null;
  after: ImageData | null;
}

interface PixelRegion extends Region {
  data: ImageData;
}

interface Snapshot {
  w: number;
  h: number;
  base: ImageBitmap;
  before: ImageBitmap | null;
  paint: PixelRegion[];
  mask: PixelRegion[];
  paintOcc: Uint8Array;
  maskOcc: Uint8Array;
}

type Entry =
  | { kind: "stroke"; layer: LayerId; diffs: Diff[]; bytes: number }
  | { kind: "invert"; bytes: number }
  | { kind: "base"; before: Snapshot | null; after: Snapshot; bytes: number };

const MAX_HISTORY = 40;
/** Unique base/comparison bitmaps alive across document + history. */
const MAX_BASE_BITMAPS = 8;
/** Retained pixel bytes across stroke diffs and snapshot paint/mask regions. */
const MAX_RETAINED_BYTES = 192 * 1024 * 1024;
const TILE = 64;
/** Extra doc-px padding around brush damage (mask edge outline + AA). */
const EDGE_PAD = 2;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 16;

/** Each layer's 2D context, created once with the right attributes (they are fixed at first getContext). */
const CONTEXTS = new WeakMap<Layer, Ctx>();

/** `readback`: the layer is read with getImageData, so it gets a CPU backing store. */
function makeLayer(w: number, h: number, readback = false): Layer {
  let l: Layer;
  if (typeof OffscreenCanvas !== "undefined") l = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  else {
    l = document.createElement("canvas");
    l.width = Math.max(1, w);
    l.height = Math.max(1, h);
  }
  const c = (l as OffscreenCanvas).getContext("2d", readback ? { willReadFrequently: true } : undefined) as Ctx | null;
  if (!c) throw new Error("2D context unavailable");
  CONTEXTS.set(l, c);
  return l;
}

function ctx2d(l: Layer): Ctx {
  const c = CONTEXTS.get(l);
  if (!c) throw new Error("2D context unavailable");
  return c;
}

/** Drops a layer's backing store (the object stays valid and can be resized again). */
function shrink(l: Layer): void {
  l.width = 1;
  l.height = 1;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function expandRect(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by };
}

/** Rounds outwards and clamps to [0, w) × [0, h); null when empty. */
function clampRegion(r: Rect, w: number, h: number): Region | null {
  const x = Math.max(0, Math.floor(r.x0));
  const y = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(w, Math.ceil(r.x1));
  const y1 = Math.min(h, Math.ceil(r.y1));
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

function regionsBounds(rs: readonly Region[]): Rect | null {
  let b: Rect | null = null;
  for (const r of rs) b = unionRect(b, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
  return b;
}

/* ───────── Exact tile grid (occupancy / dirty tracking) ───────── */

class TileGrid {
  w = 1;
  h = 1;
  cols = 1;
  rows = 1;
  flags = new Uint8Array(1);
  count = 0;

  reset(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.cols = Math.ceil(this.w / TILE);
    this.rows = Math.ceil(this.h / TILE);
    if (this.flags.length === this.cols * this.rows) this.flags.fill(0);
    else this.flags = new Uint8Array(this.cols * this.rows);
    this.count = 0;
  }

  clear(): void {
    this.flags.fill(0);
    this.count = 0;
  }

  set(i: number, v: 0 | 1): void {
    if (this.flags[i] === v) return;
    this.flags[i] = v;
    this.count += v ? 1 : -1;
  }

  /** Marks (or clears) every tile intersecting `r` (doc px, any precision). */
  markRect(r: Rect, v: 0 | 1 = 1): void {
    const tx0 = Math.max(0, Math.floor(r.x0 / TILE));
    const ty0 = Math.max(0, Math.floor(r.y0 / TILE));
    const tx1 = Math.min(this.cols - 1, Math.floor((Math.ceil(r.x1) - 1) / TILE));
    const ty1 = Math.min(this.rows - 1, Math.floor((Math.ceil(r.y1) - 1) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.set(ty * this.cols + tx, v);
  }

  /** True when any tile intersecting the tile-aligned region is set. */
  anyIn(r: Region): boolean {
    const tx0 = Math.floor(r.x / TILE);
    const ty0 = Math.floor(r.y / TILE);
    const tx1 = Math.ceil((r.x + r.w) / TILE);
    const ty1 = Math.ceil((r.y + r.h) / TILE);
    for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) if (this.flags[ty * this.cols + tx]) return true;
    return false;
  }

  /** Re-derives the flags of every tile in a tile-aligned region from its exact alpha. */
  scan(data: Uint8ClampedArray, r: Region): void {
    const tx0 = Math.floor(r.x / TILE);
    const ty0 = Math.floor(r.y / TILE);
    const tx1 = Math.ceil((r.x + r.w) / TILE);
    const ty1 = Math.ceil((r.y + r.h) / TILE);
    const stride = r.w * 4;
    for (let ty = ty0; ty < ty1; ty++) {
      const py0 = ty * TILE - r.y;
      const py1 = Math.min((ty + 1) * TILE, r.y + r.h) - r.y;
      for (let tx = tx0; tx < tx1; tx++) {
        const px0 = tx * TILE - r.x;
        const px1 = Math.min((tx + 1) * TILE, r.x + r.w) - r.x;
        let found: 0 | 1 = 0;
        for (let y = py0; y < py1 && !found; y++) {
          const end = y * stride + px1 * 4;
          for (let i = y * stride + px0 * 4 + 3; i < end; i += 4) {
            if (data[i] !== 0) {
              found = 1;
              break;
            }
          }
        }
        this.set(ty * this.cols + tx, found);
      }
    }
  }

  copy(): Uint8Array {
    return this.flags.slice();
  }

  load(a: Uint8Array): void {
    if (a.length !== this.flags.length) {
      this.clear();
      return;
    }
    this.flags.set(a);
    let n = 0;
    for (let i = 0; i < a.length; i++) n += a[i] ? 1 : 0;
    this.count = n;
  }

  /** Tile-aligned pixel regions covering the set tiles: horizontal runs, merged down identical rows. */
  regions(): Region[] {
    if (this.count === 0) return [];
    const done: { tx0: number; tx1: number; ty0: number; ty1: number }[] = [];
    let open: { tx0: number; tx1: number; ty0: number; ty1: number }[] = [];
    for (let ty = 0; ty < this.rows; ty++) {
      const next: typeof open = [];
      let tx = 0;
      while (tx < this.cols) {
        if (!this.flags[ty * this.cols + tx]) {
          tx++;
          continue;
        }
        const tx0 = tx;
        while (tx < this.cols && this.flags[ty * this.cols + tx]) tx++;
        const prev = open.find((o) => o.tx0 === tx0 && o.tx1 === tx);
        if (prev) {
          prev.ty1 = ty + 1;
          next.push(prev);
        } else {
          const r = { tx0, tx1: tx, ty0: ty, ty1: ty + 1 };
          done.push(r);
          next.push(r);
        }
      }
      open = next;
    }
    return done.map((t) => {
      const x = t.tx0 * TILE;
      const y = t.ty0 * TILE;
      return { x, y, w: Math.min(t.tx1 * TILE, this.w) - x, h: Math.min(t.ty1 * TILE, this.h) - y };
    });
  }
}

/** Tile-aligns a doc-space rect (clamped to the document). */
function alignToTiles(r: Rect, w: number, h: number): Region | null {
  const c = clampRegion(r, w, h);
  if (!c) return null;
  const x = Math.floor(c.x / TILE) * TILE;
  const y = Math.floor(c.y / TILE) * TILE;
  const x1 = Math.min(w, Math.ceil((c.x + c.w) / TILE) * TILE);
  const y1 = Math.min(h, Math.ceil((c.y + c.h) / TILE) * TILE);
  return { x, y, w: x1 - x, h: y1 - y };
}

export interface ViewInsets {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export class EditorDocument {
  width = 0;
  height = 0;
  hasDoc = false;
  readonly view = { scale: 1, tx: 0, ty: 0 };

  // Read back with getImageData (diffs, occupancy scans, eyedropper): CPU backing stores.
  private readonly paint: Layer = makeLayer(1, 1, true);
  private readonly mask: Layer = makeLayer(1, 1, true);
  private readonly paintBackup: Layer = makeLayer(1, 1, true);
  private readonly maskBackup: Layer = makeLayer(1, 1, true);
  private readonly probe: Layer = makeLayer(4, 4, true);
  // Composited only: GPU-accelerated. Tint/edge are allocated lazily while the mask is non-empty.
  private readonly strokeBuf: Layer = makeLayer(1, 1);
  private tint: Layer | null = null;
  private edge: Layer | null = null;

  // Exact per-tile occupancy of paint/mask, and the tiles the current stroke touched.
  private readonly paintOcc = new TileGrid();
  private readonly maskOcc = new TileGrid();
  private readonly strokeTiles = new TileGrid();

  // Reference-counted base/comparison bitmaps (document + history holders).
  private readonly bitmapRefs = new Map<ImageBitmap, number>();
  /** The bitmap the base layer currently equals (shared with history, never re-encoded). */
  private currentBase: ImageBitmap | null = null;
  private beforeBase: ImageBitmap | null = null;

  private history: Entry[] = [];
  private index = 0; // entries [0, index) are applied
  private retainedBytes = 0;
  private contentVersion = 0;
  private maskEmpty = true;

  // Tint/edge caches: full rebuild flag or an accumulated doc-space damage rect. Both rebuild
  // lazily inside drawScene, so the edge costs nothing while hidden, empty or mid-stroke.
  private tintFull = true;
  private tintRect: Rect | null = null;
  private edgeFull = true;
  private edgeRect: Rect | null = null;
  private edgePx = 1;

  // Visible canvas
  private canvas: HTMLCanvasElement | null = null;
  private vctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private insets: ViewInsets = { top: 72, left: 80, right: 96, bottom: 180 };
  private raf = 0;
  private readonly renderBound = () => this.render();
  /** Full redraw pending (zoom/pan/resize/load/theme/overlay); otherwise only the damage below. */
  private fullDirty = true;
  private docDamage: Rect | null = null; // doc px
  private screenDamage: Rect | null = null; // CSS px

  // Overlay state
  maskVisible = true;
  compare = false;
  split = 0.5;
  private cursor: { x: number; y: number } | null = null;
  private cursorRadius = 0;

  // Theme-derived styles
  private checker: CanvasPattern | null = null;
  private tintColor = "rgba(75,80,200,0.44)";
  private edgeColor = "rgba(75,80,200,0.9)";
  private gridColor = "rgba(24,24,27,0.08)";
  private inkColor = "#000";
  private paperColor = "#fff";

  // Stroke state
  private stroking: StrokeKind | null = null;
  private strokeLayer: LayerId = "paint";
  private brush: BrushParams = { size: 48, hardness: 0.8, opacity: 1, color: "black" };
  private stamp: Layer | null = null;
  private stampReadback = false;
  private stampKey = "";
  private pts: { x: number; y: number; p: number }[] = [];
  private carry = 0;
  private lastStamp: { x: number; y: number } | null = null;
  lastTarget: LayerId = "paint";

  private listener: ((c: DocChange) => void) | null = null;
  private viewListener: (() => void) | null = null;

  onChange(cb: (c: DocChange) => void): void {
    this.listener = cb;
    this.emit(false);
  }

  /** Pan-only view changes (no zoom, no pixels): cheap, never routed through the store. */
  onView(cb: (() => void) | null): void {
    this.viewListener = cb;
  }

  /** `content`: pixels changed (bumps `contentVersion`); false for zoom/fit-only changes. */
  private emit(content: boolean): void {
    if (content) this.contentVersion++;
    this.listener?.({
      hasDoc: this.hasDoc,
      width: this.width,
      height: this.height,
      maskEmpty: this.maskEmpty,
      canUndo: this.index > 0,
      canRedo: this.index < this.history.length,
      hasBefore: !!this.beforeBase,
      zoom: this.view.scale,
      contentVersion: this.contentVersion,
    });
  }

  // ───────── Bitmap ownership ─────────

  private retain(b: ImageBitmap): void {
    this.bitmapRefs.set(b, (this.bitmapRefs.get(b) ?? 0) + 1);
  }

  /** Drops one reference; closes the bitmap the moment nobody holds it. */
  private releaseBitmap(b: ImageBitmap | null | undefined): void {
    if (!b) return;
    const n = (this.bitmapRefs.get(b) ?? 0) - 1;
    if (n > 0) {
      this.bitmapRefs.set(b, n);
      return;
    }
    this.bitmapRefs.delete(b);
    b.close();
  }

  private setCurrentBase(b: ImageBitmap | null): void {
    if (b === this.currentBase) return;
    if (b) this.retain(b);
    const old = this.currentBase;
    this.currentBase = b;
    this.releaseBitmap(old);
  }

  private setBeforeBase(b: ImageBitmap | null): void {
    if (b === this.beforeBase) return;
    if (b) this.retain(b);
    const old = this.beforeBase;
    this.beforeBase = b;
    this.releaseBitmap(old);
  }

  // ───────── Canvas binding & rendering ─────────

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.vctx = canvas.getContext("2d", { desynchronized: true, alpha: true });
    this.refreshTheme();
  }

  detach(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas = null;
    this.vctx = null;
  }

  resize(cssW: number, cssH: number, insets?: ViewInsets): void {
    const prevW = this.cssW;
    const prevH = this.cssH;
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    if (insets) this.insets = insets;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas) {
      const w = Math.round(this.cssW * this.dpr);
      const h = Math.round(this.cssH * this.dpr);
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
    }
    // Keep the document centred where it was.
    this.view.tx += (this.cssW - prevW) / 2;
    this.view.ty += (this.cssH - prevH) / 2;
    this.invalidate();
  }

  setInsets(insets: ViewInsets): void {
    this.insets = insets;
  }

  refreshTheme(): void {
    this.tintColor = cssVar("--mask-tint") || this.tintColor;
    this.edgeColor = cssVar("--mask-edge") || this.edgeColor;
    this.gridColor = cssVar("--border-hairline") || this.gridColor;
    this.inkColor = cssVar("--text-primary") || this.inkColor;
    this.paperColor = cssVar("--bg-canvas") || this.paperColor;
    const a = cssVar("--bg-checker-a");
    const b = cssVar("--bg-checker-b");
    const tile = document.createElement("canvas");
    tile.width = 24;
    tile.height = 24;
    const t = tile.getContext("2d")!;
    t.fillStyle = a;
    t.fillRect(0, 0, 24, 24);
    t.fillStyle = b;
    t.fillRect(0, 0, 12, 12);
    t.fillRect(12, 12, 12, 12);
    this.checker = this.vctx?.createPattern(tile, "repeat") ?? null;
    this.markTintFull();
    this.markEdge();
    this.invalidate();
  }

  /** Full redraw on the next frame. */
  invalidate(): void {
    this.fullDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || !this.canvas) return;
    this.raf = requestAnimationFrame(this.renderBound);
  }

  private damageDoc(r: Rect): void {
    this.docDamage = unionRect(this.docDamage, r);
    this.schedule();
  }

  private damageScreen(r: Rect): void {
    this.screenDamage = unionRect(this.screenDamage, r);
    this.schedule();
  }

  private markTintFull(): void {
    this.tintFull = true;
    this.tintRect = null;
  }

  private markTintRect(r: Rect): void {
    if (!this.tintFull) this.tintRect = unionRect(this.tintRect, r);
  }

  /** Queues an outline rebuild: everything (no rect) or an accumulated doc-space area. */
  private markEdge(r?: Rect | null): void {
    if (!r) {
      this.edgeFull = true;
      this.edgeRect = null;
    } else if (!this.edgeFull) this.edgeRect = unionRect(this.edgeRect, r);
  }

  /** Frees the tint/edge overlays (empty mask / new document); they reallocate on demand. */
  private releaseOverlays(): void {
    if (this.tint) shrink(this.tint);
    if (this.edge) shrink(this.edge);
    this.tint = null;
    this.edge = null;
    this.markTintFull();
    this.markEdge();
  }

  /** Doc rect in CSS px. */
  docRect(): { x: number; y: number; w: number; h: number } {
    return { x: this.view.tx, y: this.view.ty, w: this.width * this.view.scale, h: this.height * this.view.scale };
  }

  private render(): void {
    this.raf = 0;
    const c = this.vctx;
    const canvas = this.canvas;
    if (!c || !canvas) return;
    const dpr = this.dpr;
    const { scale, tx, ty } = this.view;

    // Partial frame: clip to the union of brush damage (doc → screen) and cursor damage.
    const full = this.fullDirty || !this.hasDoc;
    let clip: Rect | null = null;
    if (!full) {
      if (this.docDamage) {
        const d = expandRect(this.docDamage, EDGE_PAD);
        clip = unionRect(clip, { x0: tx + d.x0 * scale, y0: ty + d.y0 * scale, x1: tx + d.x1 * scale, y1: ty + d.y1 * scale });
      }
      if (this.screenDamage) clip = unionRect(clip, this.screenDamage);
    }
    this.fullDirty = false;
    this.docDamage = null;
    this.screenDamage = null;
    if (!full && !clip) return;

    c.setTransform(1, 0, 0, 1, 0, 0);
    let src: Region | null = null; // doc-space source rect for layer blits on partial frames
    if (clip) {
      const dev = clampRegion({ x0: clip.x0 * dpr - 2, y0: clip.y0 * dpr - 2, x1: clip.x1 * dpr + 2, y1: clip.y1 * dpr + 2 }, canvas.width, canvas.height);
      if (!dev) return;
      c.save();
      c.beginPath();
      c.rect(dev.x, dev.y, dev.w, dev.h);
      c.clip();
      c.clearRect(dev.x, dev.y, dev.w, dev.h);
      src = clampRegion(
        {
          x0: (dev.x / dpr - tx) / scale - 2,
          y0: (dev.y / dpr - ty) / scale - 2,
          x1: ((dev.x + dev.w) / dpr - tx) / scale + 2,
          y1: ((dev.y + dev.h) / dpr - ty) / scale + 2,
        },
        this.width,
        this.height,
      );
    } else {
      c.clearRect(0, 0, canvas.width, canvas.height);
    }
    try {
      if (!this.hasDoc) return;
      this.drawScene(c, scale, tx, ty, dpr, clip ? src : null, !!clip);
    } finally {
      if (clip) c.restore();
    }
  }

  private drawScene(c: CanvasRenderingContext2D, scale: number, tx: number, ty: number, dpr: number, src: Region | null, partial: boolean): void {
    const r = this.docRect();
    const base = this.currentBase;
    // A partial frame whose damage misses the document only needs the cursor rings.
    const drawLayers = !partial || !!src;
    const blit = (l: Layer | ImageBitmap) => {
      if (src) c.drawImage(l, src.x, src.y, src.w, src.h, src.x, src.y, src.w, src.h);
      else c.drawImage(l, 0, 0);
    };

    // Checker (screen space)
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.checker && drawLayers) {
      c.fillStyle = this.checker;
      c.fillRect(r.x, r.y, r.w, r.h);
    }

    if (drawLayers) {
      c.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
      c.imageSmoothingEnabled = scale < 8;
      c.imageSmoothingQuality = "high";

      if (this.compare && this.beforeBase) {
        const sx = this.width * this.split;
        c.save();
        c.beginPath();
        c.rect(0, 0, sx, this.height);
        c.clip();
        c.drawImage(this.beforeBase, 0, 0, this.width, this.height);
        c.restore();
        c.save();
        c.beginPath();
        c.rect(sx, 0, this.width - sx, this.height);
        c.clip();
        if (base) blit(base);
        blit(this.paint);
        c.restore();
      } else {
        if (base) blit(base);
        blit(this.paint);
        if (this.stroking === "paint") {
          c.globalAlpha = this.brush.opacity;
          blit(this.strokeBuf);
          c.globalAlpha = 1;
        }
        if (this.maskVisible && !this.maskEmptyFast()) {
          blit(this.tintLayer());
          // The outline hides while painting; it is rebuilt (lazily) once the stroke lands.
          if (!this.stroking && !this.maskEmpty) blit(this.edgeLayer());
        }
      }

      // Pixel grid above 800 %
      if (scale > 8) {
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.strokeStyle = this.gridColor;
        c.lineWidth = 1 / dpr;
        c.beginPath();
        const x0 = Math.max(0, Math.floor(-tx / scale));
        const x1 = Math.min(this.width, Math.ceil((this.cssW - tx) / scale));
        const y0 = Math.max(0, Math.floor(-ty / scale));
        const y1 = Math.min(this.height, Math.ceil((this.cssH - ty) / scale));
        for (let x = x0; x <= x1; x++) {
          const px = Math.round(tx + x * scale) + 0.5 / dpr;
          c.moveTo(px, ty + y0 * scale);
          c.lineTo(px, ty + y1 * scale);
        }
        for (let y = y0; y <= y1; y++) {
          const py = Math.round(ty + y * scale) + 0.5 / dpr;
          c.moveTo(tx + x0 * scale, py);
          c.lineTo(tx + x1 * scale, py);
        }
        c.stroke();
      }
    }

    // Brush cursor: two 1 px rings (ink + paper) so it reads on any image.
    if (this.cursor && this.cursorRadius >= 2) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.lineWidth = 1;
      c.strokeStyle = this.paperColor;
      c.beginPath();
      c.arc(this.cursor.x, this.cursor.y, this.cursorRadius + 1, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = this.inkColor;
      c.beginPath();
      c.arc(this.cursor.x, this.cursor.y, this.cursorRadius, 0, Math.PI * 2);
      c.stroke();
    }
  }

  private maskEmptyFast(): boolean {
    return this.maskEmpty && this.stroking !== "mask" && !(this.stroking === "erase" && this.strokeLayer === "mask");
  }

  /** Allocates (or re-sizes) an overlay layer to the document; a fresh layer needs a full rebuild. */
  private ensureOverlay(l: Layer | null): { layer: Layer; fresh: boolean } {
    if (l && l.width === this.width && l.height === this.height) return { layer: l, fresh: false };
    if (!l) return { layer: makeLayer(this.width, this.height), fresh: true };
    l.width = this.width;
    l.height = this.height;
    return { layer: l, fresh: true };
  }

  /** Mask tint cache, brought up to date: full rebuild, or only the damage accumulated during strokes. */
  private tintLayer(): Layer {
    const o = this.ensureOverlay(this.tint);
    this.tint = o.layer;
    if (o.fresh) this.markTintFull();
    if (!this.tintFull && !this.tintRect) return o.layer;
    const t = ctx2d(o.layer);
    const full = this.tintFull;
    const r = full ? { x: 0, y: 0, w: this.width, h: this.height } : clampRegion(expandRect(this.tintRect!, 1), this.width, this.height);
    this.tintFull = false;
    this.tintRect = null;
    if (!r) return o.layer;
    t.save();
    if (!full) {
      t.beginPath();
      t.rect(r.x, r.y, r.w, r.h);
      t.clip();
    }
    t.globalCompositeOperation = "source-over";
    t.clearRect(r.x, r.y, r.w, r.h);
    t.drawImage(this.mask, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = this.tintColor;
    t.fillRect(r.x, r.y, r.w, r.h);
    t.restore();
    return o.layer;
  }

  /** 1 px (screen) outline around the mask, brought up to date: everything, or only the queued area. */
  private edgeLayer(): Layer {
    const o = this.ensureOverlay(this.edge);
    this.edge = o.layer;
    const w = this.width;
    const h = this.height;
    const px = Math.max(1, Math.round(1 / Math.max(this.view.scale, 0.0001)));
    // A zoom that changed the outline's doc-pixel width invalidates every queued partial rebuild.
    if (o.fresh || px !== this.edgePx) this.markEdge();
    if (!this.edgeFull && !this.edgeRect) return o.layer;
    const full = this.edgeFull;
    const rect = this.edgeRect;
    this.edgeFull = false;
    this.edgeRect = null;
    this.edgePx = px;
    const r = full || !rect ? { x: 0, y: 0, w, h } : clampRegion(expandRect(rect, px + EDGE_PAD), w, h);
    if (!r) return o.layer;
    const e = ctx2d(o.layer);
    e.save();
    if (!full) {
      e.beginPath();
      e.rect(r.x, r.y, r.w, r.h);
      e.clip();
    }
    e.globalCompositeOperation = "source-over";
    e.clearRect(r.x, r.y, r.w, r.h);
    // Source window: the rebuilt area plus the outline offset on every side.
    const a = clampRegion({ x0: r.x - px, y0: r.y - px, x1: r.x + r.w + px, y1: r.y + r.h + px }, w, h)!;
    const shifted = (dx: number, dy: number) => e.drawImage(this.mask, a.x, a.y, a.w, a.h, a.x + dx, a.y + dy, a.w, a.h);
    shifted(-px, 0);
    shifted(px, 0);
    shifted(0, -px);
    shifted(0, px);
    e.globalCompositeOperation = "destination-out";
    shifted(0, 0);
    e.globalCompositeOperation = "source-in";
    e.fillStyle = this.edgeColor;
    e.fillRect(r.x, r.y, r.w, r.h);
    e.restore();
    return o.layer;
  }

  setCursor(p: { x: number; y: number } | null, radiusCss: number): void {
    const ring = (q: { x: number; y: number }, rad: number): Rect => ({ x0: q.x - rad - 3, y0: q.y - rad - 3, x1: q.x + rad + 3, y1: q.y + rad + 3 });
    if (this.cursor) this.damageScreen(ring(this.cursor, this.cursorRadius));
    this.cursor = p;
    this.cursorRadius = radiusCss;
    if (p) this.damageScreen(ring(p, radiusCss));
  }

  setOverlay(o: { maskVisible: boolean; compare: boolean; split: number }): void {
    this.maskVisible = o.maskVisible;
    this.compare = o.compare && !!this.beforeBase;
    this.split = o.split;
    this.invalidate();
  }

  // ───────── View ─────────

  fit(): void {
    if (!this.hasDoc) return;
    const i = this.insets;
    const aw = Math.max(40, this.cssW - i.left - i.right);
    const ah = Math.max(40, this.cssH - i.top - i.bottom);
    const s = Math.min(aw / this.width, ah / this.height);
    this.view.scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
    this.view.tx = i.left + (aw - this.width * this.view.scale) / 2;
    this.view.ty = i.top + (ah - this.height * this.view.scale) / 2;
    this.invalidate();
    this.emit(false);
  }

  setZoom(z: number, cx = this.cssW / 2, cy = this.cssH / 2): void {
    const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const k = nz / this.view.scale;
    this.view.tx = cx - (cx - this.view.tx) * k;
    this.view.ty = cy - (cy - this.view.ty) * k;
    this.view.scale = nz;
    this.invalidate();
    this.emit(false);
  }

  zoomBy(f: number, cx?: number, cy?: number): void {
    this.setZoom(this.view.scale * f, cx, cy);
  }

  /** Pans without touching the store or the content version (no React work per pointer move). */
  panBy(dx: number, dy: number): void {
    this.view.tx += dx;
    this.view.ty += dy;
    this.invalidate();
    this.viewListener?.();
  }

  toDoc(cssX: number, cssY: number): { x: number; y: number } {
    return { x: (cssX - this.view.tx) / this.view.scale, y: (cssY - this.view.ty) / this.view.scale };
  }

  // ───────── Opening & base replacement ─────────

  /** Exact pixels of every occupied tile run of a layer. */
  private captureRegions(l: Layer, occ: TileGrid): PixelRegion[] {
    const c = ctx2d(l);
    return occ.regions().map((r) => ({ ...r, data: c.getImageData(r.x, r.y, r.w, r.h) }));
  }

  /** Synchronous snapshot: shares the current base bitmap, copies only occupied paint/mask tiles. */
  private snapshot(): Snapshot | null {
    if (!this.hasDoc || !this.currentBase) return null;
    const s: Snapshot = {
      w: this.width,
      h: this.height,
      base: this.currentBase,
      before: this.beforeBase,
      paint: this.captureRegions(this.paint, this.paintOcc),
      mask: this.captureRegions(this.mask, this.maskOcc),
      paintOcc: this.paintOcc.copy(),
      maskOcc: this.maskOcc.copy(),
    };
    this.retain(s.base);
    if (s.before) this.retain(s.before);
    return s;
  }

  private releaseSnapshot(s: Snapshot | null): void {
    if (!s) return;
    this.releaseBitmap(s.base);
    this.releaseBitmap(s.before);
  }

  private allocate(w: number, h: number): void {
    this.width = w;
    this.height = h;
    for (const l of [this.paint, this.mask, this.paintBackup, this.maskBackup, this.strokeBuf]) {
      if (l.width !== w || l.height !== h) {
        l.width = w;
        l.height = h;
      } else ctx2d(l).clearRect(0, 0, w, h);
    }
    this.paintOcc.reset(w, h);
    this.maskOcc.reset(w, h);
    this.strokeTiles.reset(w, h);
    this.releaseOverlays();
  }

  private putRegions(l: Layer, backup: Layer, regions: readonly PixelRegion[]): void {
    const c = ctx2d(l);
    const b = ctx2d(backup);
    for (const r of regions) {
      c.putImageData(r.data, r.x, r.y);
      b.putImageData(r.data, r.x, r.y);
    }
  }

  private restore(s: Snapshot | null): void {
    if (!s) {
      this.hasDoc = false;
      this.width = this.height = 0;
      this.setCurrentBase(null);
      this.setBeforeBase(null);
      this.paintOcc.reset(1, 1);
      this.maskOcc.reset(1, 1);
      this.maskEmpty = true;
      this.releaseOverlays();
      this.invalidate();
      return;
    }
    const resized = s.w !== this.width || s.h !== this.height || !this.hasDoc;
    this.allocate(s.w, s.h);
    this.hasDoc = true;
    this.setCurrentBase(s.base);
    this.putRegions(this.paint, this.paintBackup, s.paint);
    this.putRegions(this.mask, this.maskBackup, s.mask);
    this.paintOcc.load(s.paintOcc);
    this.maskOcc.load(s.maskOcc);
    this.setBeforeBase(s.before);
    this.maskEmpty = this.maskOcc.count === 0;
    this.markTintFull();
    this.markEdge();
    if (resized) this.fit();
    this.invalidate();
  }

  /**
   * Replaces the base layer (open, generation result, remove background). One history entry.
   * Takes ownership of `bitmap` (closed when the document and history no longer reference it).
   * `keepMask`: Remove background keeps the mask. `asResult`: enables Before/After against the old base.
   */
  async replaceBase(bitmap: ImageBitmap, opts: { keepMask?: boolean; asResult?: boolean; open?: boolean }): Promise<void> {
    if (this.stroking) this.endStroke();
    const before = this.snapshot();
    const prevBase = this.currentBase;
    const sizeChanged = bitmap.width !== this.width || bitmap.height !== this.height;
    const keepMask = !!opts.keepMask && !sizeChanged && !this.maskEmpty && !!before;
    const keptMask = keepMask && before ? before.mask : [];
    const keptOcc = keepMask && before ? before.maskOcc : null;
    const wasDoc = this.hasDoc;

    this.allocate(bitmap.width, bitmap.height);
    this.hasDoc = true;
    this.setCurrentBase(bitmap);
    if (keptOcc) {
      this.putRegions(this.mask, this.maskBackup, keptMask);
      this.maskOcc.load(keptOcc);
    }
    this.maskEmpty = this.maskOcc.count === 0;
    this.markTintFull();
    this.setBeforeBase(opts.asResult && prevBase ? prevBase : opts.open ? null : this.beforeBase);
    const after: Snapshot = {
      w: bitmap.width,
      h: bitmap.height,
      base: bitmap,
      before: this.beforeBase,
      paint: [],
      mask: keptMask,
      paintOcc: this.paintOcc.copy(),
      maskOcc: this.maskOcc.copy(),
    };
    this.retain(after.base);
    if (after.before) this.retain(after.before);
    const bytes = new Set<ImageData>();
    for (const s of [before, after]) if (s) for (const r of [...s.paint, ...s.mask]) bytes.add(r.data);
    let n = 0;
    bytes.forEach((d) => (n += d.data.byteLength));
    this.push({ kind: "base", before, after, bytes: n });
    if (!wasDoc || sizeChanged || opts.open) this.fit();
    this.markEdge();
    this.invalidate();
    this.emit(true);
  }

  // ───────── History ─────────

  private push(e: Entry): void {
    const dropped = this.history.splice(this.index);
    dropped.forEach((d) => this.release(d));
    this.history.push(e);
    this.retainedBytes += e.bytes;
    // Enforce: entry count, unique base/comparison bitmaps, retained pixel bytes. Oldest go first.
    while (
      this.history.length > MAX_HISTORY ||
      (this.bitmapRefs.size > MAX_BASE_BITMAPS && this.history.length > 0) ||
      (this.retainedBytes > MAX_RETAINED_BYTES && this.history.length > 1)
    ) {
      const r = this.history.shift();
      if (!r) break;
      this.release(r);
    }
    this.index = this.history.length;
  }

  private release(e: Entry): void {
    this.retainedBytes = Math.max(0, this.retainedBytes - e.bytes);
    if (e.kind !== "base") return;
    this.releaseSnapshot(e.before);
    this.releaseSnapshot(e.after);
  }

  undo(): void {
    if (this.index === 0 || this.stroking) return;
    const e = this.history[--this.index];
    this.applyEntry(e, "before");
    this.emit(true);
  }

  redo(): void {
    if (this.index >= this.history.length || this.stroking) return;
    const e = this.history[this.index++];
    this.applyEntry(e, "after");
    this.emit(true);
  }

  private applyEntry(e: Entry, side: "before" | "after"): void {
    if (e.kind === "stroke") {
      const l = ctx2d(e.layer === "paint" ? this.paint : this.mask);
      const b = ctx2d(e.layer === "paint" ? this.paintBackup : this.maskBackup);
      const occ = e.layer === "paint" ? this.paintOcc : this.maskOcc;
      for (const d of e.diffs) {
        const data = side === "before" ? d.before : d.after;
        if (data) {
          l.putImageData(data, d.x, d.y);
          b.putImageData(data, d.x, d.y);
          occ.scan(data.data, d);
        } else {
          l.clearRect(d.x, d.y, d.w, d.h);
          b.clearRect(d.x, d.y, d.w, d.h);
          occ.markRect({ x0: d.x, y0: d.y, x1: d.x + d.w, y1: d.y + d.h }, 0);
        }
      }
      if (e.layer === "mask") this.afterMaskChange(regionsBounds(e.diffs));
    } else if (e.kind === "invert") {
      this.invertRaw();
      this.afterMaskChange();
    } else {
      this.restore(side === "before" ? e.before : e.after);
    }
    this.invalidate();
  }

  // ───────── Brush engine ─────────

  setBrush(b: BrushParams): void {
    this.brush = b;
  }

  private ensureStamp(kind: StrokeKind): Layer {
    const { size, hardness, color } = this.brush;
    const col = kind === "paint" ? color : "white";
    // The stamp's backing matches its target: paint dabs land on the GPU stroke buffer; mask and
    // eraser dabs land directly on the CPU-backed paint/mask layers (no per-dab GPU readback).
    const readback = kind !== "paint";
    const key = `${Math.round(size)}|${hardness.toFixed(2)}|${col}|${readback ? "cpu" : "gpu"}`;
    if (this.stamp && key === this.stampKey) return this.stamp;
    const d = Math.max(2, Math.ceil(size) + 2);
    const reuse = !!this.stamp && this.stampReadback === readback;
    if (this.stamp && !reuse) shrink(this.stamp);
    const s = reuse ? this.stamp! : makeLayer(d, d, readback);
    if (s.width !== d || s.height !== d) {
      s.width = d;
      s.height = d;
    }
    const c = ctx2d(s);
    c.clearRect(0, 0, d, d);
    const r = size / 2;
    const cx = d / 2;
    if (r < 1.5) {
      c.fillStyle = col;
      c.beginPath();
      c.arc(cx, cx, Math.max(0.5, r), 0, Math.PI * 2);
      c.fill();
    } else {
      // Opaque inside hardness·r, smoothstep to 0 at r.
      const g = c.createRadialGradient(cx, cx, 0, cx, cx, r);
      const h = Math.min(0.999, Math.max(0, hardness));
      const rgb = this.parseColor(col);
      g.addColorStop(0, `rgba(${rgb},1)`);
      g.addColorStop(h, `rgba(${rgb},1)`);
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        const a = 1 - t * t * (3 - 2 * t);
        g.addColorStop(h + (1 - h) * t, `rgba(${rgb},${a.toFixed(3)})`);
      }
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cx, r, 0, Math.PI * 2);
      c.fill();
    }
    this.stamp = s;
    this.stampReadback = readback;
    this.stampKey = key;
    return s;
  }

  private parseColor(col: string): string {
    const p = ctx2d(this.probe);
    p.clearRect(0, 0, 1, 1);
    p.fillStyle = col;
    p.fillRect(0, 0, 1, 1);
    const d = p.getImageData(0, 0, 1, 1).data;
    return `${d[0]},${d[1]},${d[2]}`;
  }

  beginStroke(kind: StrokeKind, x: number, y: number, pressure: number, straight: boolean, eraseTarget: LayerId): void {
    if (!this.hasDoc || this.compare) return;
    this.stroking = kind;
    this.strokeLayer = kind === "paint" ? "paint" : kind === "mask" ? "mask" : eraseTarget;
    if (kind !== "erase") this.lastTarget = this.strokeLayer;
    this.ensureStamp(kind);
    this.carry = 0;
    this.strokeTiles.clear();
    const prev = this.lastStamp;
    this.pts = [{ x, y, p: pressure }];
    if (straight && prev) {
      this.line(prev.x, prev.y, x, y, pressure, pressure);
    } else {
      this.dab(x, y, pressure);
    }
    // First frame of a stroke is full: the mask outline hides everywhere while painting.
    this.invalidate();
  }

  moveStroke(x: number, y: number, pressure: number): void {
    if (!this.stroking) return;
    const pts = this.pts;
    const last = pts[pts.length - 1];
    if (Math.hypot(x - last.x, y - last.y) < 0.5) return;
    pts.push({ x, y, p: pressure });
    const n = pts.length;
    if (n >= 3) {
      const p0 = pts[Math.max(0, n - 4)];
      const p1 = pts[n - 3];
      const p2 = pts[n - 2];
      const p3 = pts[n - 1];
      this.curve(p0, p1, p2, p3);
    }
    if (pts.length > 8) pts.splice(0, pts.length - 4);
    // Dabs accumulated their own damage rect; the next frame composites only that.
  }

  endStroke(): void {
    if (!this.stroking) return;
    const pts = this.pts;
    const n = pts.length;
    if (n >= 2) {
      const p0 = pts[Math.max(0, n - 3)];
      const p1 = pts[n - 2];
      const p2 = pts[n - 1];
      this.curve(p0, p1, p2, p2);
    }
    const kind = this.stroking;
    const layerId = this.strokeLayer;
    const layer = layerId === "paint" ? this.paint : this.mask;
    const backup = layerId === "paint" ? this.paintBackup : this.maskBackup;
    const occ = layerId === "paint" ? this.paintOcc : this.maskOcc;
    // Sparse, tile-aligned regions the stroke touched (a diagonal line stays a thin staircase).
    const regions = this.strokeTiles.regions();
    if (kind === "paint") {
      const c = ctx2d(this.paint);
      const sb = ctx2d(this.strokeBuf);
      c.globalAlpha = this.brush.opacity;
      for (const r of regions) c.drawImage(this.strokeBuf, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      c.globalAlpha = 1;
      for (const r of regions) sb.clearRect(r.x, r.y, r.w, r.h);
    }
    this.stroking = null;
    const lc = ctx2d(layer);
    const bc = ctx2d(backup);
    const diffs: Diff[] = [];
    let bytes = 0;
    for (const r of regions) {
      const wasOccupied = occ.anyIn(r);
      const before = wasOccupied ? bc.getImageData(r.x, r.y, r.w, r.h) : null;
      const after = lc.getImageData(r.x, r.y, r.w, r.h);
      occ.scan(after.data, r); // exact alpha verification of every touched tile
      const nowOccupied = occ.anyIn(r);
      bc.clearRect(r.x, r.y, r.w, r.h);
      bc.drawImage(layer, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      if (!wasOccupied && !nowOccupied) continue; // nothing changed here
      const d: Diff = { ...r, before, after: nowOccupied ? after : null };
      bytes += (d.before?.data.byteLength ?? 0) + (d.after?.data.byteLength ?? 0);
      diffs.push(d);
    }
    this.strokeTiles.clear();
    if (diffs.length) this.push({ kind: "stroke", layer: layerId, diffs, bytes });
    if (layerId === "mask") this.afterMaskChange(regionsBounds(regions));
    this.invalidate();
    this.emit(true);
  }

  get isStroking(): boolean {
    return this.stroking !== null;
  }

  private curve(p0: { x: number; y: number; p: number }, p1: { x: number; y: number; p: number }, p2: { x: number; y: number; p: number }, p3: { x: number; y: number; p: number }): void {
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(1, Math.ceil(len / 2));
    let px = p1.x;
    let py = p1.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      const pr = p1.p + (p2.p - p1.p) * t;
      this.line(px, py, x, y, pr, pr);
      px = x;
      py = y;
    }
  }

  private line(x0: number, y0: number, x1: number, y1: number, p0: number, p1: number): void {
    const spacing = Math.max(1, 0.12 * this.brush.size);
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) return;
    let d = spacing - this.carry;
    while (d <= len) {
      const t = d / len;
      this.dab(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t);
      d += spacing;
    }
    this.carry = len - (d - spacing);
  }

  private dab(x: number, y: number, pressure: number): void {
    const kind = this.stroking;
    if (!kind) return;
    const stamp = this.stamp!;
    const d = stamp.width * pressure;
    let target: Ctx;
    const touchesMask = kind === "mask" || (kind === "erase" && this.strokeLayer === "mask");
    if (kind === "paint") {
      target = ctx2d(this.strokeBuf);
      target.globalCompositeOperation = "source-over";
      target.globalAlpha = 1;
    } else if (kind === "mask") {
      target = ctx2d(this.mask);
      target.globalCompositeOperation = "source-over";
      target.globalAlpha = 1;
    } else {
      target = ctx2d(this.strokeLayer === "paint" ? this.paint : this.mask);
      target.globalCompositeOperation = "destination-out";
      target.globalAlpha = this.brush.opacity;
    }
    target.drawImage(stamp, x - d / 2, y - d / 2, d, d);
    target.globalCompositeOperation = "source-over";
    target.globalAlpha = 1;
    // Footprint = drawn stamp (radius + softness) + 1 px antialiasing.
    const half = d / 2 + 1;
    const foot: Rect = { x0: x - half, y0: y - half, x1: x + half, y1: y + half };
    this.strokeTiles.markRect(foot);
    if (touchesMask) this.markTintRect(foot);
    this.damageDoc(foot);
    this.lastStamp = { x, y };
  }

  /** Eyedropper: composite of base + paint at a document pixel → #rrggbb. */
  pick(x: number, y: number): string | null {
    if (!this.hasDoc) return null;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return null;
    const p = ctx2d(this.probe);
    p.clearRect(0, 0, 1, 1);
    if (this.currentBase) p.drawImage(this.currentBase, ix, iy, 1, 1, 0, 0, 1, 1);
    p.drawImage(this.paint, ix, iy, 1, 1, 0, 0, 1, 1);
    const d = p.getImageData(0, 0, 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  // ───────── Mask operations ─────────

  /** Exact re-scan of a layer's occupancy, one tile row band at a time (bounded scratch memory). */
  private rescan(l: Layer, occ: TileGrid, rect?: Rect | null): void {
    const r = rect ? alignToTiles(rect, this.width, this.height) : { x: 0, y: 0, w: this.width, h: this.height };
    if (!r) return;
    const c = ctx2d(l);
    for (let y = r.y; y < r.y + r.h; y += TILE) {
      const band: Region = { x: r.x, y, w: r.w, h: Math.min(TILE, r.y + r.h - y) };
      occ.scan(c.getImageData(band.x, band.y, band.w, band.h).data, band);
    }
  }

  private invertRaw(): void {
    const c = ctx2d(this.mask);
    c.globalCompositeOperation = "xor";
    c.fillStyle = "white";
    c.fillRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = "source-over";
    const b = ctx2d(this.maskBackup);
    b.clearRect(0, 0, this.width, this.height);
    b.drawImage(this.mask, 0, 0);
    this.rescan(this.mask, this.maskOcc);
  }

  invertMask(): void {
    if (!this.hasDoc) return;
    if (this.stroking) this.endStroke();
    this.invertRaw();
    this.push({ kind: "invert", bytes: 0 });
    this.afterMaskChange();
    this.emit(true);
  }

  clearMask(): void {
    if (!this.hasDoc || this.maskEmpty) return;
    if (this.stroking) this.endStroke();
    // Only the occupied tile runs are stored; "after" is implicit transparency.
    const c = ctx2d(this.mask);
    const b = ctx2d(this.maskBackup);
    const regions = this.maskOcc.regions();
    const diffs: Diff[] = regions.map((r) => ({ ...r, before: c.getImageData(r.x, r.y, r.w, r.h), after: null }));
    for (const r of regions) {
      c.clearRect(r.x, r.y, r.w, r.h);
      b.clearRect(r.x, r.y, r.w, r.h);
    }
    this.maskOcc.clear();
    const bytes = diffs.reduce((n, d) => n + (d.before?.data.byteLength ?? 0), 0);
    if (diffs.length) this.push({ kind: "stroke", layer: "mask", diffs, bytes });
    this.afterMaskChange(regionsBounds(regions));
    this.emit(true);
  }

  clearPaintAndMask(): void {
    for (const l of [this.paint, this.mask, this.paintBackup, this.maskBackup]) ctx2d(l).clearRect(0, 0, this.width, this.height);
    this.paintOcc.clear();
    this.maskOcc.clear();
    this.afterMaskChange();
    this.emit(true);
  }

  /** `rect`: the doc-space area that changed (null → whole mask). */
  private afterMaskChange(rect?: Rect | null): void {
    this.maskEmpty = this.maskOcc.count === 0;
    if (this.maskEmpty) this.releaseOverlays();
    else if (rect) {
      this.markTintRect(rect);
      this.markEdge(rect);
    } else {
      this.markTintFull();
      this.markEdge();
    }
    this.invalidate();
  }

  // ───────── Export ─────────

  /**
   * Synchronous copies of everything a job submission needs, taken before any async encoding,
   * so pointer input after submission can't leak into (or mix revisions of) the request.
   */
  captureSubmission(opts: { mask?: boolean; clip?: boolean } = {}): SubmissionCapture | null {
    if (!this.hasDoc) return null;
    if (this.stroking) this.endStroke();
    const image = makeLayer(this.width, this.height);
    const ic = ctx2d(image);
    if (this.currentBase) ic.drawImage(this.currentBase, 0, 0);
    ic.drawImage(this.paint, 0, 0);
    let mask: Layer | null = null;
    if (opts.mask) {
      mask = makeLayer(this.width, this.height);
      const mc = ctx2d(mask);
      mc.fillStyle = "black";
      mc.fillRect(0, 0, this.width, this.height);
      mc.drawImage(this.mask, 0, 0);
    }
    let clip: Layer | null = null;
    if (opts.clip && !this.maskEmpty) {
      const k = Math.min(1, 512 / Math.max(this.width, this.height));
      const w = Math.max(1, Math.round(this.width * k));
      const h = Math.max(1, Math.round(this.height * k));
      clip = makeLayer(w, h);
      const cc = ctx2d(clip);
      cc.fillStyle = "black";
      cc.fillRect(0, 0, w, h);
      cc.drawImage(this.mask, 0, 0, w, h);
    }
    return { image, mask, clip };
  }

  drawThumbnail(target: HTMLCanvasElement): void {
    const c = target.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, target.width, target.height);
    if (!this.hasDoc) return;
    const s = Math.max(target.width / this.width, target.height / this.height);
    const w = this.width * s;
    const h = this.height * s;
    if (this.currentBase) c.drawImage(this.currentBase, (target.width - w) / 2, (target.height - h) / 2, w, h);
    c.drawImage(this.paint, (target.width - w) / 2, (target.height - h) / 2, w, h);
  }

  dispose(): void {
    this.detach();
    this.history.forEach((e) => this.release(e));
    this.history = [];
    this.index = 0;
    this.retainedBytes = 0;
    this.setCurrentBase(null);
    this.setBeforeBase(null);
    this.hasDoc = false;
    this.width = this.height = 0;
    this.maskEmpty = true;
    // Release every offscreen backing store (the layers stay valid for a re-attach).
    for (const l of [this.paint, this.mask, this.paintBackup, this.maskBackup, this.strokeBuf]) shrink(l);
    this.releaseOverlays();
    if (this.stamp) shrink(this.stamp);
    this.stamp = null;
    this.stampKey = "";
    // Anything still registered is unreachable now.
    this.bitmapRefs.forEach((_, b) => b.close());
    this.bitmapRefs.clear();
  }
}
