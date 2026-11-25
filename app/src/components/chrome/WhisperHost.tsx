import { useEffect, useState } from "react";
import { useUiStore } from "../../stores/ui";

/** The single whisper: one-line pill near the capsule, 2.4 s (errors 6 s, one action). role=status (§4).
    Tracks the active capsule's height itself (a primitive selector), so prompt auto-grow re-renders
    only this host — never <App> or the workspaces. */
export function WhisperHost() {
  const bottom = useUiStore((s) => {
    const ws = s.workspace;
    if (ws === "generate") return 76 + 16 + s.capsuleH.generate + 16;
    if (ws === "library") return 24;
    return 20 + (s.capsuleH[ws] ?? 120) + 16;
  });
  const w = useUiStore((s) => s.whisper);
  const clear = useUiStore((s) => s.clearWhisper);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!w) return;
    setLeaving(false);
    const ms = w.tone === "error" ? 6000 : 2400;
    const t1 = window.setTimeout(() => setLeaving(true), ms - 112);
    const t2 = window.setTimeout(() => clear(w.id), ms);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [w, clear]);

  return (
    <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ bottom, zIndex: 80 }}>
      <div role="status" aria-live="polite" className="flex justify-center">
        {w && (
          <div
            key={w.id}
            className={`glass-strong t-caption pointer-events-auto flex h-8 items-center gap-3 rounded-full px-3.5 ${leaving ? "opacity-0" : "anim-enter"} ${
              w.tone === "error" ? "text-ink" : "text-ink-2"
            }`}
            style={{ transition: "opacity calc(var(--dur-fast) * 0.7) linear" }}
          >
            {w.tone === "error" && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />}
            <span>{w.text}</span>
            {w.action && (
              <button
                type="button"
                className="t-caption -mr-1 rounded-full px-2 py-0.5 text-accent hover:bg-accent-soft"
                onClick={() => {
                  w.action?.run();
                  clear(w.id);
                }}
              >
                {w.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
