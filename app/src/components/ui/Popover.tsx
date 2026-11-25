import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { focusables, pushLayer, trapTab } from "../../lib/layers";

export type Placement = "auto" | "top" | "bottom" | "left" | "right";

interface PopoverProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null> | { x: number; y: number };
  children: ReactNode;
  width?: number;
  placement?: Placement;
  align?: "start" | "center" | "end";
  /** "glass" popover (§4) or opaque "menu" surface. */
  surface?: "glass" | "menu";
  className?: string;
  ariaLabel?: string;
  /** Don't move focus into the popover on open (hover previews). */
  noFocus?: boolean;
  padding?: number;
  style?: CSSProperties;
}

const GAP = 8;

/** Glass popover in a portal (never nested glass); opens toward free space; focus-trapped; closes on
    outside click, Esc or focus leaving; focus returns to the trigger (§4). */
export function Popover({
  open,
  onClose,
  anchor,
  children,
  width,
  placement = "auto",
  align = "center",
  surface = "glass",
  className,
  ariaLabel,
  noFocus,
  padding = 12,
  style,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; side: "top" | "bottom" | "left" | "right" } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r =
        "current" in anchor
          ? anchor.current?.getBoundingClientRect()
          : ({ left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 } as DOMRect);
      if (!r) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let side: "top" | "bottom" | "left" | "right" =
        placement === "auto" ? (r.top + r.height / 2 > vh / 2 ? "top" : "bottom") : placement;
      if (side === "top" && r.top - h - GAP < 8 && vh - r.bottom > r.top) side = "bottom";
      if (side === "bottom" && r.bottom + h + GAP > vh - 8 && r.top > vh - r.bottom) side = "top";
      if (side === "left" && r.left - w - GAP < 8) side = "right";
      if (side === "right" && r.right + w + GAP > vw - 8) side = "left";
      let x: number;
      let y: number;
      if (side === "top" || side === "bottom") {
        y = side === "top" ? r.top - h - GAP : r.bottom + GAP;
        x = align === "start" ? r.left : align === "end" ? r.right - w : r.left + r.width / 2 - w / 2;
      } else {
        x = side === "left" ? r.left - w - GAP : r.right + GAP;
        y = align === "start" ? r.top : align === "end" ? r.bottom - h : r.top + r.height / 2 - h / 2;
      }
      x = Math.max(8, Math.min(vw - w - 8, x));
      y = Math.max(48, Math.min(vh - h - 8, y));
      setPos({ x, y, side });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, placement, align]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const pop = pushLayer(() => onCloseRef.current());
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ("current" in anchor && anchor.current?.contains(t)) return;
      onCloseRef.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    if (!noFocus) {
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el || el.contains(document.activeElement)) return;
        const f = focusables(el);
        (f[0] ?? el).focus({ preventScroll: true });
      });
    }
    return () => {
      pop();
      window.removeEventListener("pointerdown", onDown, true);
      const rf = returnFocus.current;
      if (!noFocus && rf && document.contains(rf) && (!document.activeElement || document.activeElement === document.body || ref.current?.contains(document.activeElement))) {
        rf.focus({ preventScroll: true });
      }
    };
  }, [open, anchor, noFocus]);

  if (!open) return null;
  const surfaceCls = surface === "menu" ? "elevated" : "glass-strong";
  const enter = pos?.side === "bottom" ? "anim-enter-down" : "anim-enter";
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(e) => trapTab(e, ref.current)}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!noFocus && next && !ref.current?.contains(next) && !("current" in anchor && anchor.current?.contains(next))) onClose();
      }}
      className={`fixed rounded-[var(--r-md)] text-ink ${surfaceCls} ${pos ? enter : "opacity-0"} ${className ?? ""}`}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, width, padding, zIndex: 60, ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}
