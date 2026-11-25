/* Every tunable Murmuration constant (DESIGN_SPEC.md §7.4, §7.7, §7.8), in one place.
   Values are tuned starting points; the phase behaviour, caps and zero-idle rules are not tunable. */

export const BOIDS_DEFAULT = 3000;
export const BOIDS_LOW = 1500;
export const BOIDS_MAX = 4500;

export const FIELD_SIZE = 64;
/** 64 → 32 → 16 → 8: the deepest field tap is LOD 3.0 (update.vert cohesion), so 4 levels suffice. */
export const FIELD_LEVELS = 4;

export const DPR_CAP = 1.5;
export const MAX_BACKING_PIXELS = 2_500_000;

/** Backing-store scale shared by both backends: `dpr`, capped so cssW·cssH·scale² ≤ maxPixels
    (scale = sqrt(maxPixels / cssArea)) — keeps 4K stages at ~2.5 MP instead of 8+ MP. */
export function cappedBackingScale(cssW: number, cssH: number, dpr: number, maxPixels = MAX_BACKING_PIXELS): number {
  const area = Math.max(1, cssW) * Math.max(1, cssH);
  return Math.max(0.05, Math.min(dpr, Math.sqrt(maxPixels / area)));
}

/** 60 fps cap, with headroom for ±1.5 ms DWM rAF jitter so on-time 60 Hz vsyncs are never skipped. */
export const FRAME_MIN_MS = 13.5;
export const FRAME_MIN_MS_UNFOCUSED = 28; // 30 fps while the window is unfocused
export const MAX_DT_MS = 33.3;

export const FLOCK = { cohesion: 0.9, alignment: 1.4, separation: 1.8, swirl: 0.35 } as const;
export const SPEED = { min: 0.06, max: 0.24, maxAccel: 1.6 } as const;
export const LUMA_DRIFT = 0.7;
export const POINT_SIZE_PX = 2.6;
/** Extra point-sprite room so the velocity-aligned dash is not clipped by the sprite square. */
export const POINT_SPRITE_SCALE = 2.2;

export const DISTORT_AMOUNT = 0.008;
export const DISTORT_POW = 2.0;
export const FROST_MAX_LOD = 0.9;

export const FADE_IN_MS = 300;
export const CANCEL_FADE_MS = 200;
export const FINISH_FADE_MS = 300;
export const REVEAL_MS = 300;
export const PHASE_B_MS = 400;
export const PREVIEW_MIX_MS = 180;
export const PROGRESS_RATE = 6;

export const CORNER_PX = 14;

export const LADDER_THRESHOLD_MS = 12;
export const LADDER_WINDOW = 30;
export const LADDER_WARMUP_FRAMES = 20;
/** Raw rAF deltas kept to estimate the display's vsync period (rolling minimum). */
export const VSYNC_WINDOW = 120;
/** A frame whose interval exceeds the expected cadence by this factor counts as a missed target. */
export const LADDER_MISS_FACTOR = 1.5;
/** Step down when more than this share of the window missed its target (GPU-bound fallback). */
export const LADDER_MISS_RATIO = 0.5;

export const CANVAS2D = {
  particles: 600,
  frameMinMs: 32,
  dprCap: 1.0,
  blurMaxPx: 4,
  dashW: 1.5,
  dashH: 4,
} as const;
