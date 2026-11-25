import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { Tooltip } from "./Tooltip";

interface PrimaryButtonProps {
  running: boolean;
  /** 0–1, drives the 2 px ring on a 46 px track while running. */
  progress: number;
  disabled?: boolean;
  /** Request in flight (between click and job.started). */
  pending?: boolean;
  label: string;
  shortcut?: string;
  disabledReason?: string;
  onRun(): void;
  onStop(): void;
}

const R = 22; // ring radius on the 46 px track (2 px stroke)
const CIRC = 2 * Math.PI * R;

/** 40 px circular primary action with a progress ring (§4). */
export function PrimaryButton({ running, progress, disabled, pending, label, shortcut, disabledReason, onRun, onStop }: PrimaryButtonProps) {
  const off = disabled && !running;
  const tip = running ? "Stop" : off && disabledReason ? disabledReason : label;
  return (
    <Tooltip label={tip} shortcut={running ? "Esc" : off ? undefined : shortcut}>
      <span className="relative inline-flex h-[46px] w-[46px] shrink-0 items-center justify-center">
        {running && (
          <svg className="pointer-events-none absolute inset-0" width={46} height={46} viewBox="0 0 46 46" aria-hidden>
            <circle cx={23} cy={23} r={R} fill="none" stroke="var(--surface-active)" strokeWidth={2} />
            <circle
              cx={23}
              cy={23}
              r={R}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - Math.max(0, Math.min(1, progress)))}
              transform="rotate(-90 23 23)"
              style={{ transition: "stroke-dashoffset 300ms linear" }}
            />
          </svg>
        )}
        <button
          type="button"
          aria-label={running ? "Stop" : label}
          disabled={off}
          onClick={running ? onStop : onRun}
          className={`inline-flex h-10 w-10 items-center justify-center rounded-full transition-[background-color,opacity] duration-[var(--dur-instant)] ${
            off ? "bg-active text-ink-4" : "bg-accent text-on-accent hover:bg-[var(--accent-hover)] active:bg-[var(--accent-pressed)]"
          }`}
        >
          {running ? (
            <Square size={12} fill="currentColor" strokeWidth={0} />
          ) : pending ? (
            <LoaderCircle size={18} strokeWidth={1.75} absoluteStrokeWidth className="anim-spin" />
          ) : (
            <ArrowUp size={18} strokeWidth={1.75} absoluteStrokeWidth />
          )}
        </button>
      </span>
    </Tooltip>
  );
}
