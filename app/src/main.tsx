// Bundled fonts only (Latin subset, the exact weights in DESIGN_SPEC.md §2.3) — no network requests.
import "@fontsource/plus-jakarta-sans/latin-400.css";
import "@fontsource/plus-jakarta-sans/latin-500.css";
import "@fontsource/plus-jakarta-sans/latin-600.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { boot } from "./lib/boot";

void boot().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
