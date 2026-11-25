// Murmuration — pane composite. DESIGN_SPEC.md §7.4.4.
// Prepended at build time: #version, precision, snoise3.glsl.

uniform vec2  uResolution;     // drawing buffer px
uniform float uAspect, uTime, uCorner, uPx;
uniform vec4  uPane;
uniform sampler2D uField, uPrevA, uPrevB, uFinal, uClipMask;
uniform float uPreviewMix, uPhaseB, uDistort, uFrost, uReveal, uFade, uUseClip, uChroma, uHasField;
uniform vec3  uPaneA, uPaneB, uGlow;

out vec4 o;

// Divergence-free 2D flow from a scalar potential: (dn/dy, -dn/dx), from one
// analytical-gradient simplex evaluation (the limit of the old 3-tap e=0.01 difference).
vec2 curl(vec2 p, float t) {
  vec3 g;
  snoiseGrad(vec3(p, t), g);
  return vec2(g.y, -g.x);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 tap(sampler2D t, vec2 uv, vec2 d) {
  if (uChroma > 0.5) {
    return vec3(textureLod(t, uv + d, uFrost).r,
                textureLod(t, uv + d * 0.92, uFrost).g,
                textureLod(t, uv + d * 0.84, uFrost).b);
  }
  return textureLod(t, uv + d, uFrost).rgb;
}

void main() {
  vec2 suv = gl_FragCoord.xy / uResolution;
  vec2 p = (suv * 2.0 - 1.0) * vec2(uAspect, 1.0);

  // 1. Pane mask: rounded-rect signed distance.
  float sdf = sdRoundRect(p - uPane.xy, uPane.zw, uCorner);
  float inside = smoothstep(1.5 * uPx, 0.0, sdf);
  if (inside <= 0.0) { o = vec4(0.0); return; }

  vec2 puv = (p - uPane.xy) / uPane.zw * 0.5 + 0.5;
  vec2 iuv = vec2(puv.x, 1.0 - puv.y);   // image rows are top-down

  // Once the reveal has (all but) landed the pane is the final image; once Phase B has fully
  // blended in, the glass term is multiplied by zero. Skip the dead work in both cases.
  bool revealed = uReveal >= 0.999;
  bool needGlass = uPhaseB < 0.999 && !revealed;

  // 2. Phase A glass + flock halo (one simplex evaluation).
  vec3 glass = vec3(0.0);
  if (needGlass) {
    float n = 0.5 + 0.5 * snoise(vec3(p * 0.6, uTime * 0.03));
    glass = mix(uPaneA, uPaneB, n);
    float dens = uHasField > 0.5 ? textureLod(uField, suv, 2.0).z : 0.0;
    glass += uGlow * 0.06 * smoothstep(0.0, 6.0, dens);
  }

  vec3 col = glass;
  if (uPhaseB > 0.0 && !revealed) {
    // 3. Distortion flow: one curl octave (one gradient-noise evaluation) plus a
    //    noise-free ripple standing in for the finer octave, to stay in budget.
    vec2 d = vec2(0.0);
    if (uDistort > 1e-5) {
      vec2 flow = curl(p * 1.7, uTime * 0.12)
                + 0.5 * vec2(sin(p.y * 9.0 + uTime * 1.3 + 7.1), cos(p.x * 8.2 - uTime * 1.1));
      d = flow * uDistort;
      d.y = -d.y;
    }
    // 4. Frosted, refracted preview (<= six taps; three once the cross-fade has settled).
    vec3 prev = tap(uPrevB, iuv, d);
    if (uPreviewMix < 0.999) prev = mix(tap(uPrevA, iuv, d), prev, uPreviewMix);
    // 5. Phase blend.
    col = needGlass ? mix(glass, prev, uPhaseB) : prev;
  }

  float alpha = 1.0;
  if (uReveal > 0.0) {
    vec4 f = texture(uFinal, iuv);
    col = revealed ? f.rgb : mix(col, f.rgb, uReveal);
    alpha = mix(1.0, f.a, uReveal);
  }

  // 6. Inpaint clip: only the masked region is covered.
  if (uUseClip > 0.5) alpha *= texture(uClipMask, iuv).r;

  // 7. Grain against banding.
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) * (2.0 / 255.0);

  // 8. Premultiplied output.
  float a = alpha * inside * uFade;
  o = vec4(col * a, a);
}
