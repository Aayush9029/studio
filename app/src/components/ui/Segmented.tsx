import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  tooltip?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

interface SegmentedProps<T extends string | number> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange(v: T): void;
  ariaLabel: string;
  mono?: boolean;
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
}

/** Pills on one sunken track; the selected segment is elevated and slides (§4). role=radiogroup (§10.1). */
export function Segmented<T extends string | number>({ options, value, onChange, ariaLabel, mono, size = "md", className, disabled }: SegmentedProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));

  useLayoutEffect(() => {
    const el = btnRefs.current[idx];
    const track = trackRef.current;
    if (!el || !track) return;
    const update = () => setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(track);
    return () => ro.disconnect();
  }, [idx, options.length]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    let i = idx;
    for (let k = 0; k < options.length; k++) {
      i = (i + dir + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    onChange(options[i].value);
    btnRefs.current[i]?.focus();
  };

  const h = size === "sm" ? 24 : 28;
  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      onKeyDown={onKey}
      className={`relative inline-flex shrink-0 items-center rounded-full bg-sunken p-0.5 ${disabled ? "opacity-40" : ""} ${className ?? ""}`}
    >
      {thumb && (
        <span
          aria-hidden
          className="absolute left-0 top-0.5 rounded-full bg-elevated transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)]"
          style={{ width: thumb.w, height: h, transform: `translateX(${thumb.x}px)`, boxShadow: "var(--shadow-1)" }}
        />
      )}
      {options.map((o, i) => {
        const selected = o.value === value;
        const btn = (
          <button
            key={String(o.value)}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.ariaLabel}
            tabIndex={selected ? 0 : -1}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            className={`relative z-[1] inline-flex items-center justify-center whitespace-nowrap rounded-full px-2.5 transition-colors duration-[var(--dur-instant)] disabled:opacity-50 ${
              mono ? "mono" : "t-ui"
            } ${selected ? "text-ink" : "text-ink-2 hover:text-ink"}`}
            style={{ height: h }}
          >
            {o.label}
          </button>
        );
        return o.tooltip ? (
          <Tooltip key={String(o.value)} label={o.tooltip}>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}
