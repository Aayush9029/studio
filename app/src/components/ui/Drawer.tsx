import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { focusables, pushLayer, trapTab } from "../../lib/layers";
import { IconButton } from "./IconButton";

interface DrawerProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  width: string;
  /** Library inspector has no scrim (the grid stays interactive). */
  scrim?: boolean;
  /** Trap focus (modal drawers). The inspector does not trap. */
  trap?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  ariaLabel: string;
  headerExtra?: ReactNode;
}

/** Slide-over from the right below the titlebar (§4). Esc, scrim click or X closes. */
export function Drawer({ open, onClose, title, width, scrim = true, trap = true, children, footer, ariaLabel, headerExtra }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const pop = pushLayer(() => onCloseRef.current());
    if (trap) {
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el && !el.contains(document.activeElement)) (focusables(el)[0] ?? el).focus({ preventScroll: true });
      });
    }
    return () => {
      pop();
      if (trap && prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [open, trap]);

  if (!open) return null;
  return createPortal(
    <>
      {scrim && (
        <div className="anim-fade fixed inset-x-0 bottom-0 bg-[var(--scrim)]" style={{ top: "var(--titlebar-h)", zIndex: 50 }} onPointerDown={onClose} aria-hidden />
      )}
      <aside
        ref={ref}
        role="dialog"
        aria-modal={trap || undefined}
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={(e) => trap && trapTab(e, ref.current)}
        className="glass-strong anim-drawer fixed bottom-0 right-0 flex flex-col rounded-l-[var(--r-xl)] border-r-0"
        style={{ top: "var(--titlebar-h)", width, zIndex: 50 }}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 px-6 pb-2 pt-6">
          <div className="min-w-0 flex-1">{title}</div>
          {headerExtra}
          <IconButton icon={X} label="Close" shortcut="Esc" onClick={onClose} tooltipSide="left" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer && <footer className="shrink-0 border-t border-hairline px-6 py-4">{footer}</footer>}
      </aside>
    </>,
    document.body,
  );
}
