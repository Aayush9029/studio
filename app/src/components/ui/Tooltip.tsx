import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type TooltipSide = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  label: string;
  shortcut?: string;
  side?: TooltipSide;
  children: ReactNode;
  /** Render the wrapper as block-level (fills its slot). */
  block?: boolean;
  disabled?: boolean;
  className?: string;
}

const DELAY_MS = 450;
const GAP = 8;

/** One-line tooltip: 450 ms hover delay, immediate on keyboard focus (§4). */
export function Tooltip({ label, shortcut, side = "top", children, block, disabled, className }: TooltipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = useCallback((immediate: boolean) => {
    window.clearTimeout(timer.current);
    if (immediate) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useLayoutEffect(() => {
    if (!open || !ref.current || !tipRef.current) return;
    const a = ref.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    let x = 0;
    let y = 0;
    let s = side;
    if (s === "top" && a.top - t.height - GAP < 4) s = "bottom";
    if (s === "bottom" && a.bottom + t.height + GAP > window.innerHeight - 4) s = "top";
    if (s === "right" && a.right + t.width + GAP > window.innerWidth - 4) s = "left";
    if (s === "left" && a.left - t.width - GAP < 4) s = "right";
    if (s === "top" || s === "bottom") {
      x = a.left + a.width / 2 - t.width / 2;
      y = s === "top" ? a.top - t.height - GAP : a.bottom + GAP;
    } else {
      y = a.top + a.height / 2 - t.height / 2;
      x = s === "left" ? a.left - t.width - GAP : a.right + GAP;
    }
    x = Math.max(4, Math.min(window.innerWidth - t.width - 4, x));
    y = Math.max(4, Math.min(window.innerHeight - t.height - 4, y));
    setPos({ x, y });
  }, [open, side, label]);

  return (
    <span
      ref={ref}
      className={`${block ? "flex" : "inline-flex"} ${className ?? ""}`}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse" && !disabled) show(false);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => {
        if (!disabled && e.target instanceof HTMLElement && e.target.matches(":focus-visible")) show(true);
      }}
      onBlur={hide}
    >
      {children}
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="t-caption pointer-events-none fixed whitespace-nowrap rounded-[6px] bg-tooltip px-2 py-1.5 text-on-tooltip anim-fade"
            style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, zIndex: 70, animationDuration: "var(--dur-fast)" }}
          >
            {label}
            {shortcut && (
              <>
                <span className="opacity-65"> · </span>
                <span className="mono-sm opacity-65">{shortcut}</span>
              </>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
