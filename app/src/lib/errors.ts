/* Error → whisper copy (DESIGN_SPEC.md §8.3). */

import type { FamilyId, StudioError } from "../shared/contract";
import { say, useUiStore } from "../stores/ui";
import { studio } from "./studio";

export function whisperError(err: StudioError, family?: FamilyId): void {
  const ui = useUiStore.getState();
  switch (err.code) {
    case "OUT_OF_MEMORY":
      say("Not enough memory for that.", { tone: "error", action: { label: "Free memory", run: () => ui.openModels() } });
      return;
    case "MODEL_FILES_MISSING":
      say("A model file is missing.", { tone: "error", action: { label: "Show", run: () => ui.openModels(family) } });
      return;
    case "BUSY":
      say("Still working on the last one.", { tone: "error" });
      return;
    case "IMAGE_DECODE_FAILED":
      say("That file isn't an image Studio can read.", { tone: "error" });
      return;
    case "INVALID_DIMENSIONS":
      say("That size isn't supported.", { tone: "error" });
      return;
    case "ENGINE_UNREACHABLE":
      say("Can't reach the engine.", { tone: "error", action: { label: "Restart", run: () => void studio.engine.restart().catch(() => {}) } });
      return;
    case "BLENDER_UNREACHABLE":
      say("Blender isn't running.", { tone: "error", action: { label: "Open Blender", run: () => void studio.blender.launch().catch(() => {}) } });
      return;
    case "BLENDER_NOT_INSTALLED":
      say("Needs Blender 5.3.", { tone: "error" });
      return;
    case "IMAGE_TOO_LARGE":
      say("That image is too large.", { tone: "error" });
      return;
    default:
      say("Something went wrong.", {
        tone: "error",
        action: {
          label: "Details",
          run: () => {
            const json = JSON.stringify({ error: err }, null, 2);
            void studio.clipboard.writeText(json).catch(() => navigator.clipboard?.writeText(json));
          },
        },
      });
  }
}
