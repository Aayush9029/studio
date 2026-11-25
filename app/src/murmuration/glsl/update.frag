// The update pass runs with RASTERIZER_DISCARD; this shader never produces fragments.
out vec4 o;
void main() { o = vec4(0.0); }
