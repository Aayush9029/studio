import { Cpu } from "lucide-react";
import { useEngineStore, enginePhase } from "../../stores/engine";
import { useUiStore } from "../../stores/ui";
import { formatMemPair, hasVram } from "../../lib/format";
import { clamp01 } from "../../lib/math";
import { Tooltip } from "../ui/Tooltip";

const RING_OUTER = 12;
const RING_INNER = 8.5;
const C_OUT = 2 * Math.PI * RING_OUTER;
const C_IN = 2 * Math.PI * RING_INNER;

/** Sidebar memory pill: VRAM + RAM bars (expanded) or a concentric ring gauge (rail). §3.4 */
export function MemoryPill({ collapsed }: { collapsed: boolean }) {
  const t = useEngineStore((s) => s.telemetry);
  const phase = useEngineStore((s) => enginePhase(s));
  const toggle = useUiStore((s) => s.toggleModels);

  // VRAM counters may be absent at runtime (no GPU / query failed): show "—", never "0 / 0 GB".
  const vramOk = hasVram(t);
  const vram = t && vramOk ? clamp01(t.vramUsedMb / t.vramTotalMb) : 0;
  const ram = t && t.ramTotalMb > 0 && t.ramUsedMb != null ? clamp01(t.ramUsedMb / t.ramTotalMb) : 0;
  const hot = vram > 0.9;
  const vramColor = hot ? "var(--warn)" : "var(--accent)";

  const stateLabel = phase === "starting" ? "Starting…" : phase === "stopped" ? "Engine stopped" : null;
  const stateColor = phase === "stopped" ? "var(--danger)" : "var(--warn)";
  const tooltip = t
    ? `GPU memory ${vramOk ? formatMemPair(t.vramUsedMb, t.vramTotalMb, true) : "—"} · System memory ${formatMemPair(t.ramUsedMb, t.ramTotalMb, true)}`
    : stateLabel ?? "Models & Memory";
  const showNumbers = phase === "ready" && t;

  if (collapsed) {
    return (
      <Tooltip label={tooltip} shortcut="Ctrl+M" side="right" block>
        <button
          type="button"
          aria-label="Models & Memory"
          onClick={toggle}
          className="no-drag mx-auto flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] hover:bg-hover"
        >
          {showNumbers ? (
            <svg width={28} height={28} viewBox="0 0 28 28" aria-hidden>
              <circle cx={14} cy={14} r={RING_OUTER} fill="none" stroke="var(--surface-active)" strokeWidth={2} />
              <circle
                cx={14}
                cy={14}
                r={RING_OUTER}
                fill="none"
                stroke={vramColor}
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={C_OUT}
                strokeDashoffset={C_OUT * (1 - vram)}
                transform="rotate(-90 14 14)"
              />
              <circle cx={14} cy={14} r={RING_INNER} fill="none" stroke="var(--surface-active)" strokeWidth={2} />
              <circle
                cx={14}
                cy={14}
                r={RING_INNER}
                fill="none"
                stroke="var(--text-muted)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={C_IN}
                strokeDashoffset={C_IN * (1 - ram)}
                transform="rotate(-90 14 14)"
              />
            </svg>
          ) : (
            // Only "starting" pulses; a stopped/idle engine runs zero CSS animations.
            <span className={`h-2 w-2 rounded-full ${phase === "starting" ? "anim-pulse" : ""}`} style={{ background: stateColor }} aria-hidden />
          )}
        </button>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={tooltip} shortcut="Ctrl+M" side="right" block>
      <button
        type="button"
        aria-label="Models & Memory"
        onClick={toggle}
        className="no-drag flex h-11 w-full flex-col justify-center gap-1.5 rounded-[var(--r-md)] bg-sunken px-3 text-left hover:bg-hover"
      >
        {showNumbers ? (
          <>
            <span className="flex items-center gap-2 text-ink-2">
              <Cpu size={14} strokeWidth={1.75} absoluteStrokeWidth />
              <span className="mono text-ink">
                {vramOk ? formatMemPair(t.vramUsedMb, t.vramTotalMb, true) : "—"}
              </span>
            </span>
            <span className="flex flex-col gap-[3px]" aria-hidden>
              <span className="block h-[2px] w-full overflow-hidden rounded-full bg-active">
                <span className="block h-full origin-left rounded-full" style={{ background: vramColor, transform: `scaleX(${vram})`, transition: "transform 400ms linear" }} />
              </span>
              <span className="block h-[2px] w-full overflow-hidden rounded-full bg-active">
                <span className="block h-full origin-left rounded-full bg-ink-3" style={{ transform: `scaleX(${ram})`, transition: "transform 400ms linear" }} />
              </span>
            </span>
          </>
        ) : (
          <span className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${phase === "starting" ? "anim-pulse" : ""}`} style={{ background: stateColor }} aria-hidden />
            <span className="t-caption text-ink-2">{stateLabel ?? "Starting…"}</span>
          </span>
        )}
      </button>
    </Tooltip>
  );
}
