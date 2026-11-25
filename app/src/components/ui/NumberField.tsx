import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Applied on commit (e.g. snap to the model grid). */
  normalize?(v: number): number;
  onCommit(v: number): void;
  ariaLabel: string;
  width?: number;
  className?: string;
}

/** mono, 28 px, sunken; wheel or ↑/↓ steps; invalid input reverts on blur (§4). */
export function NumberField({ value, min, max, step = 1, normalize, onCommit, ariaLabel, width = 72, className }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setText(String(value)), [value]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = () => {
    const n = Number(text.trim());
    if (!text.trim() || !Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const v = clamp(normalize ? normalize(n) : Math.round(n));
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  const stepBy = (dir: number, big: boolean) => {
    const v = clamp((normalize ? normalize(value + dir * step * (big ? 10 : 1)) : value + dir * step * (big ? 10 : 1)));
    onCommit(v);
  };
  // The wheel listener is attached once and always calls the latest stepBy (fresh value/props).
  const stepRef = useRef(stepBy);
  stepRef.current = stepBy;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      stepRef.current(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      stepBy(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setText(String(value));
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      className={`mono h-7 rounded-[var(--r-sm)] bg-sunken px-2 text-ink outline-none ${className ?? ""}`}
      style={{ width }}
    />
  );
}
