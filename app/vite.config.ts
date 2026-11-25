import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Renderer build for Studio.
// - `base: "./"` keeps every asset URL relative, so the same build loads from
//   `studio://app/index.html` (production) and `http://localhost:5173` (dev).
// - Three.js only ever enters through the lazily imported `Viewport3D`, so Rollup
//   emits it as its own dynamic chunk; `manualChunks` gives it a stable name.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome134", // Electron 35
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/")) return "three";
          return undefined;
        },
      },
    },
  },
});
