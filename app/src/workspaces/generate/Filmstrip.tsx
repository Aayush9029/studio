import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { OutputItem } from "../../shared/contract";
import { useLibraryStore } from "../../stores/library";
import { useGenerateStore } from "../../stores/generate";
import { useJobStore } from "../../stores/job";
import { deleteItems, reusePromptAndSeed } from "../../lib/actions";
import { thumbUrl } from "../../lib/images";
import { truncate } from "../../lib/format";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";

const MAX = 24;

/** Persistent 76 px tray of the 24 most recent images, newest at the left (§5.1.3). */
export function Filmstrip({ hidden }: { hidden: boolean }) {
  const allItems = useLibraryStore((s) => s.items);
  const items = useMemo(() => allItems.filter((i) => i.kind === "image").slice(0, MAX), [allItems]);
  const currentId = useGenerateStore((s) => s.current?.id ?? null);
  const show = useGenerateStore((s) => s.show);
  const running = useJobStore((s) => s.active?.owner === "generate");
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: OutputItem } | null>(null);
  // Stable handlers (the item is passed back), so memo(Thumb) skips every unchanged thumb.
  const onMenu = useCallback((item: OutputItem, x: number, y: number) => setMenu({ x, y, item }), []);

  // Items present at first render don't animate; later arrivals slide in.
  if (seen.current === null && useLibraryStore.getState().loaded) seen.current = new Set(items.map((i) => i.id));
  const fresh = (id: string) => seen.current !== null && !seen.current.has(id);
  useEffect(() => {
    if (seen.current) items.forEach((i) => seen.current!.add(i.id));
  }, [items]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className={`glass relative flex h-[var(--filmstrip-h)] shrink-0 items-center rounded-none border-x-0 border-b-0 transition-opacity duration-[var(--dur-fast)] ${
        hidden ? "pointer-events-none opacity-0" : ""
      }`}
      style={{ boxShadow: "none", zIndex: 10 }}
    >
      <div ref={scroller} role="list" aria-label="Recent images" className="no-scrollbar fade-mask-x flex h-full flex-1 items-center gap-2 overflow-x-auto px-4">
        {running && <div aria-hidden className="shimmer h-14 w-14 shrink-0 rounded-[10px] bg-sunken" style={{ boxShadow: "inset 0 0 0 1px var(--accent-ring)" }} />}
        {items.map((item) => (
          <Thumb
            key={item.id}
            item={item}
            active={item.id === currentId}
            fresh={fresh(item.id)}
            onShow={show}
            onMenu={onMenu}
          />
        ))}
      </div>
      <Menu
        open={!!menu}
        onClose={() => setMenu(null)}
        anchor={menu ? { x: menu.x, y: menu.y } : { x: 0, y: 0 }}
        placement="top"
        ariaLabel="Image"
        items={menu ? [{ id: "reuse", label: "Reuse prompt and seed", onSelect: () => reusePromptAndSeed(menu.item) }] : []}
      />
    </div>
  );
}

const Thumb = memo(function Thumb({
  item,
  active,
  fresh,
  onShow,
  onMenu,
}: {
  item: OutputItem;
  active: boolean;
  fresh: boolean;
  onShow(item: OutputItem): void;
  onMenu(item: OutputItem, x: number, y: number): void;
}) {
  return (
    <div role="listitem" className={`group relative shrink-0 ${fresh ? "film-insert" : ""}`}>
      <button
        type="button"
        aria-label={truncate(item.params.prompt || "Image", 80)}
        aria-current={active || undefined}
        onClick={() => onShow(item)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(item, e.clientX, e.clientY);
        }}
        className="block h-14 w-14 overflow-hidden rounded-[10px] bg-sunken transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] group-hover:-translate-y-0.5"
        style={active ? { outline: "2px solid var(--accent)", outlineOffset: 2 } : undefined}
      >
        <img src={thumbUrl(item)} alt="" draggable={false} loading="lazy" decoding="async" className="h-full w-full object-cover" />
      </button>
      <span className="absolute -right-1.5 -top-1.5 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 group-focus-within:opacity-100">
        <IconButton icon={Trash2} label="Delete" variant="glass" size={20} iconSize={12} className="hover:!text-danger" onClick={() => void deleteItems([item])} />
      </span>
    </div>
  );
});
