in vec2 vMom;
out vec4 o;
void main() {
  float w = smoothstep(1.0, 0.0, length(gl_PointCoord * 2.0 - 1.0));
  o = vec4(vMom * w, w, 1.0);
}
