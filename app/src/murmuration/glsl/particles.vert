// Murmuration — boid sprites. DESIGN_SPEC.md §7.4.5.
layout(location = 0) in vec2  aPos;
layout(location = 1) in vec2  aVel;
layout(location = 2) in float aSeed;

uniform float uAspect, uPointSize, uDisperse, uReveal, uFade, uPhaseB;
uniform vec4  uPane;
uniform sampler2D uPrevB;

out vec2  vDir;
out float vAlpha;
out float vContrast;

void main() {
  gl_Position = vec4(aPos / vec2(uAspect, 1.0), 0.0, 1.0);
  gl_PointSize = uPointSize * (0.75 + 0.5 * fract(aSeed * 91.7));
  float s = length(aVel);
  vDir = s > 1e-5 ? aVel / s : vec2(1.0, 0.0);
  vAlpha = (0.55 + 0.45 * fract(aSeed * 17.3)) * pow(max(1.0 - uDisperse, 0.0), 1.5) * (1.0 - uReveal) * uFade;
  vContrast = 0.0;
  if (uPhaseB > 0.0) {
    vec2 puv = (aPos - uPane.xy) / uPane.zw * 0.5 + 0.5;
    vec3 c = textureLod(uPrevB, clamp(vec2(puv.x, 1.0 - puv.y), 0.0, 1.0), 4.0).rgb;
    vContrast = smoothstep(0.35, 0.65, dot(c, vec3(0.2126, 0.7152, 0.0722)));
  }
}
