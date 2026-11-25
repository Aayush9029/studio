import { ArrowUp, ListPlus, LoaderCircle, Square, type LucideIcon } from "lucide-react";
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
  /** Optional icon override when idle (e.g. ListPlus when queueing). */
  icon?: LucideIcon;
  onRun(): void;
  onStop(): void;
}

const R = 22; // ring radius on the 46 px track (2 px stroke)
const CIRC = 2 * Math.PI * R;

/** 40 px circular primary action with crisp white foreground on accent fill (§4). */
export function PrimaryButton({
  running,
  progress,
  disabled,
  pending,
  label,
  shortcut,
  disabledReason,
  icon: IconOverride,
  onRun,
  onStop,
}: PrimaryButtonProps) {
  const off = disabled && !running;
  const tip = running ? "Stop" : off && disabledReason ? disabledReason : label;
  const Icon = IconOverride ?? ArrowUp;
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
            off
              ? "bg-active text-ink-3"
              : "bg-accent text-on-accent hover:bg-[var(--accent-hover)] active:bg-[var(--accent-pressed)]"
          }`}
        >
          {running ? (
            <Square size={12} fill="currentColor" strokeWidth={0} />
          ) : pending ? (
            <LoaderCircle size={18} strokeWidth={1.75} absoluteStrokeWidth className="anim-spin" />
          ) : (
            <Icon size={18} strokeWidth={1.9} absoluteStrokeWidth />
          )}
        </button>
      </span>
    </Tooltip>
  );
}

/** Standalone circular Stop button with SVG progress ring, paired next to Queue while running. */
export function StopButton({ progress, onStop, label = "Stop" }: { progress: number; onStop(): void; label?: string }) {
  return (
    <Tooltip label={label} shortcut="Esc">
      <span className="relative inline-flex h-[46px] w-[46px] shrink-0 items-center justify-center">
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
        <button
          type="button"
          aria-label={label}
          onClick={onStop}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent transition-[background-color,opacity] duration-[var(--dur-instant)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-pressed)]"
        >
          <Square size={12} fill="currentColor" strokeWidth={0} />
        </button>
      </span>
    </Tooltip>
  );
}

export { ListPlus };
