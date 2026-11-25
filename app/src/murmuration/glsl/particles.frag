in vec2  vDir;
in float vAlpha;
in float vContrast;

uniform vec3  uInk;
uniform float uInkAlpha, uPhaseB, uSpriteScale;

out vec4 o;

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  pc.y = -pc.y;
  pc *= uSpriteScale;
  // Rotate into the velocity frame and shape an elongated soft dash.
  vec2 q = vec2(dot(pc, vDir), dot(pc, vec2(-vDir.y, vDir.x)));
  float d = length(q * vec2(1.0, 2.6));
  float shape = smoothstep(1.0, 0.25, d);
  // Over the preview, birds above bright areas turn dark and vice versa.
  vec3 ink = mix(uInk, mix(vec3(0.96), vec3(0.07), vContrast), uPhaseB);
  float a = shape * vAlpha * uInkAlpha;
  if (a <= 0.002) discard;
  o = vec4(ink * a, a);
}
