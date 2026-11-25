// Murmuration — flock field splat. DESIGN_SPEC.md §7.4.3.
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aVel;
uniform float uAspect;
out vec2 vMom;
void main() {
  vMom = aVel;
  gl_Position = vec4(aPos / vec2(uAspect, 1.0), 0.0, 1.0);
  gl_PointSize = 3.0;
}
