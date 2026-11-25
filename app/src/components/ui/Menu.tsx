import { useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import { LoaderCircle } from "lucide-react";
import { Popover, type Placement } from "./Popover";
import { Tooltip } from "./Tooltip";

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
  selected?: boolean;
  danger?: boolean;
  onSelect(): void;
}

interface MenuProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null> | { x: number; y: number };
  items: (MenuItem | "separator")[];
  placement?: Placement;
  align?: "start" | "center" | "end";
  width?: number;
  ariaLabel: string;
}

/** Opaque menu: 32 px items, leading icon, trailing mono shortcut (§4). */
export function Menu({ open, onClose, anchor, items, placement, align = "start", width = 220, ariaLabel }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length];
    next?.focus();
  };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} align={align} surface="menu" width={width} padding={4} ariaLabel={ariaLabel}>
      <div ref={listRef} role="menu" onKeyDown={onKey} className="flex flex-col">
        {items.map((it, i) =>
          it === "separator" ? (
            <div key={`sep-${i}`} className="mx-2 my-1 h-px bg-hairline" />
          ) : (
            <MenuRow key={it.id} item={it} onClose={onClose} />
          ),
        )}
      </div>
    </Popover>
  );
}

function MenuRow({ item, onClose }: { item: MenuItem; onClose(): void }) {
  const Icon = item.busy ? LoaderCircle : item.icon;
  const row = (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={() => {
        item.onSelect();
        if (!item.busy) onClose();
      }}
      className={`t-ui flex h-8 w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 text-left transition-colors duration-[var(--dur-instant)] hover:bg-hover focus-visible:bg-hover disabled:opacity-40 ${
        item.danger ? "text-danger" : item.selected ? "text-accent" : "text-ink"
      }`}
    >
      {Icon ? <Icon size={16} strokeWidth={1.75} absoluteStrokeWidth className={item.busy ? "anim-spin" : ""} /> : <span className="w-4" />}
      <span className="flex-1 truncate">{item.label}</span>
      {item.shortcut && <span className="mono-sm text-ink-3">{item.shortcut}</span>}
    </button>
  );
  return item.disabled && item.disabledReason ? (
    <Tooltip label={item.disabledReason} side="left" block>
      {row}
    </Tooltip>
  ) : (
    row
  );
}
