import { useEffect, useRef, useState } from "react";
import type { WorkspaceId } from "../shared/contract";
import { useJobStore } from "../stores/job";

/** Visually hidden live text for canvases: "Generating, step 4 of 9", at most once per second (§10.1). */
export function LiveStatus({ ws, verb = "Generating" }: { ws: WorkspaceId; verb?: string }) {
  const [text, setText] = useState("");
  const last = useRef(0);
  const pending = useRef(0);
  useEffect(() => {
    const compute = () => {
      const a = useJobStore.getState().active;
      if (!a || a.owner !== ws) return "";
      if (a.phase === "sampling" && a.totalSteps > 0) return `${verb}, step ${a.step} of ${a.totalSteps}`;
      return `${verb}, ${a.stages[a.stageIndex]?.label?.toLowerCase() ?? "starting"}`;
    };
    const unsub = useJobStore.subscribe(() => {
      const now = performance.now();
      window.clearTimeout(pending.current);
      if (now - last.current >= 1000) {
        last.current = now;
        setText(compute());
      } else {
        pending.current = window.setTimeout(() => {
          last.current = performance.now();
          setText(compute());
        }, 1000 - (now - last.current));
      }
    });
    return () => {
      unsub();
      window.clearTimeout(pending.current);
    };
  }, [ws, verb]);
  return (
    <span className="sr-only" aria-live="polite">
      {text}
    </span>
  );
}
