// Murmuration — boid update (transform feedback). DESIGN_SPEC.md §7.4.2.
// Prepended at build time: #version, precision, snoise3.glsl.

layout(location = 0) in vec2  aPos;    // stage space
layout(location = 1) in vec2  aVel;    // stage units / s
layout(location = 2) in float aSeed;   // [0,1), static

uniform sampler2D uField;     // xy = sum vel*w, z = sum w
uniform sampler2D uPrevB;     // current preview (mipmapped)
uniform float uTime, uDt, uAspect;
uniform vec4  uPane;          // cx, cy, halfW, halfH
uniform vec4  uFlock;         // cohesion, alignment, separation, swirl
uniform vec3  uSpeed;         // min, max, maxAccel
uniform float uPhaseB, uDisperse, uLumaDrift;

out vec2 vPos;
out vec2 vVel;

vec2 stageToUv(vec2 p) { return p / vec2(uAspect, 1.0) * 0.5 + 0.5; }
vec2 paneToUv(vec2 p)  { return (p - uPane.xy) / uPane.zw * 0.5 + 0.5; }

vec2 densityGrad(vec2 uv, float lod) {
  float e = exp2(lod) / 64.0;                       // one texel at this LOD
  float dx = textureLod(uField, uv + vec2(e, 0.0), lod).z - textureLod(uField, uv - vec2(e, 0.0), lod).z;
  float dy = textureLod(uField, uv + vec2(0.0, e), lod).z - textureLod(uField, uv - vec2(0.0, e), lod).z;
  return vec2(dx / uAspect, dy);                    // uv gradient -> stage-space direction
}

// Preview rows are stored top-down; pane uv is y-up.
float luma(vec2 uv) {
  vec2 t = clamp(vec2(uv.x, 1.0 - uv.y), 0.0, 1.0);
  return dot(textureLod(uPrevB, t, 4.0).rgb, vec3(0.2126, 0.7152, 0.0722));
}

// Divergence-free 2D flow from a scalar potential: (dn/dy, -dn/dx), from one
// analytical-gradient simplex evaluation (the limit of the old 3-tap e=0.01 difference).
vec2 curl(vec2 p, float t) {
  vec3 g;
  snoiseGrad(vec3(p, t), g);
  return vec2(g.y, -g.x);
}

void main() {
  vec2 uv = stageToUv(aPos);

  // Separation: move down the fine density gradient, only where it is crowded.
  float crowd = textureLod(uField, uv, 0.0).z;
  vec2 sep = -densityGrad(uv, 0.0) * smoothstep(1.5, 4.0, crowd);

  // Alignment: steer toward the neighbourhood's mean velocity.
  vec3 m = textureLod(uField, uv, 1.5).xyz;
  vec2 ali = (m.xy / max(m.z, 1e-3) - aVel) * step(1e-3, m.z);

  // Cohesion: move up the coarse density gradient (toward the flock's mass).
  vec2 coh = densityGrad(uv, 3.0);
  coh /= max(length(coh), 1e-4);

  // Swirl: slow curl noise, phase-shifted per boid so the flock shears and folds.
  vec2 swirl = curl(aPos * 0.9 + aSeed * 0.35, uTime * 0.07);

  // Phase B: stream along iso-luminance contours of the preview; half the flock each way.
  vec2 drift = vec2(0.0);
  if (uPhaseB > 0.0) {
    vec2 puv = paneToUv(aPos);
    const float le = 0.03;
    vec2 g = vec2(luma(puv + vec2(le, 0.0)) - luma(puv - vec2(le, 0.0)),
                  luma(puv + vec2(0.0, le)) - luma(puv - vec2(0.0, le)));
    drift = vec2(-g.y, g.x) * (aSeed < 0.5 ? 1.0 : -1.0) * 14.0 + g * 3.0;
  }

  // Containment: soft elliptical well around the pane; released and reversed while dispersing.
  vec2 q = (aPos - uPane.xy) / (uPane.zw * 1.08);
  float r = length(q);
  vec2 home = -q * smoothstep(0.85, 1.25, r) * 2.2;
  vec2 flee = normalize(q + 1e-4) * uDisperse * 1.4;

  vec2 acc = coh   * uFlock.x * (1.0 - uDisperse)
           + ali   * uFlock.y
           + sep   * uFlock.z
           + swirl * uFlock.w
           + drift * uLumaDrift * uPhaseB * (1.0 - uDisperse)
           + home  * (1.0 - uDisperse)
           + flee;

  float a = length(acc);
  if (a > uSpeed.z) acc *= uSpeed.z / a;

  vec2 v = aVel + acc * uDt;
  float s = length(v);
  v = v / max(s, 1e-5) * clamp(s, uSpeed.x, uSpeed.y * (1.0 + uDisperse));

  vPos = aPos + v * uDt;
  vVel = v;
}
