import type { CSSProperties, ReactNode } from "react";
import type { ModelState } from "../../shared/contract";

/** CSS conic checkerboard behind any image with alpha (§4). */
export function Checker({ className, children, style }: { className?: string; children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className={`checker ${className ?? ""}`} style={style}>
      {children}
    </div>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
}

export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 py-1"
    >
      <span className="t-ui text-ink">{label}</span>
      <span className={`relative inline-flex h-[18px] w-8 shrink-0 rounded-full transition-colors duration-[var(--dur-fast)] ${checked ? "bg-accent" : "bg-active"}`}>
        <span
          className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-elevated transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)]"
          style={{ transform: `translateX(${checked ? 16 : 2}px)`, boxShadow: "var(--shadow-1)" }}
        />
      </span>
    </button>
  );
}

/** Model state dot + word; colour is never the only carrier (hollow ring vs filled). */
export function StateBadge({ state, wordless }: { state: ModelState; wordless?: boolean }) {
  const word = state === "cold" ? "Cold" : state === "warming" ? "Warming" : state === "warm" ? "Warm" : "Unloading";
  const color = state === "warm" ? "var(--sage)" : state === "warming" ? "var(--warn)" : "var(--text-muted)";
  const hollow = state === "cold";
  const pulse = state === "warming" || state === "unloading";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${pulse ? "anim-pulse" : ""}`}
        style={hollow ? { boxShadow: `inset 0 0 0 1px ${color}` } : { background: color }}
      />
      {!wordless && (
        <span className="t-caption" style={{ color }}>
          {word}
        </span>
      )}
    </span>
  );
}

/** Empty-state lines: optional icon illustration + serif display + muted body + optional action (§8.2). */
export function EmptyState({ icon, lead, italic, sub, action }: { icon?: ReactNode; lead: string; italic?: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="pointer-events-none flex flex-col items-center gap-3 text-center">
      {icon && <div className="mb-1 text-ink-3">{icon}</div>}
      <h1 className="t-display m-0 text-ink">
        {lead}
        {italic && (
          <>
            {" "}
            <span className="serif-italic">{italic}</span>
          </>
        )}
      </h1>
      {sub && <p className="t-body m-0 text-ink-3">{sub}</p>}
      {action && <div className="pointer-events-auto mt-1">{action}</div>}
    </div>
  );
}

/** Thin hairline divider for rails. */
export function RailDivider({ vertical }: { vertical?: boolean }) {
  return vertical ? <span className="mx-1.5 h-5 w-px shrink-0 bg-hairline" aria-hidden /> : <span className="my-1.5 h-px w-5 shrink-0 bg-hairline" aria-hidden />;
}
