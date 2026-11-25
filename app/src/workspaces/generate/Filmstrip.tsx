import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Brush, Copy, FolderOpen, RotateCcw, Trash2, X } from "lucide-react";
import type { OutputItem } from "../../shared/contract";
import { useDragStore } from "../../stores/drag";
import { useLibraryStore } from "../../stores/library";
import { useGenerateStore } from "../../stores/generate";
import { useJobStore } from "../../stores/job";
import { useQueueStore } from "../../stores/queue";
import { copyImage, deleteItems, makeIn3D, openInEdit, reusePromptAndSeed, reveal } from "../../lib/actions";
import { imagePathOf, thumbUrl } from "../../lib/images";
import { truncate } from "../../lib/format";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";

const MAX = 24;

/** Persistent 76 px tray: live active diffusion preview, numbered queued tiles, and 24 recent images (§5.1.3). */
export function Filmstrip({ hidden }: { hidden: boolean }) {
  const allItems = useLibraryStore((s) => s.items);
  const items = useMemo(() => allItems.filter((i) => i.kind === "image").slice(0, MAX), [allItems]);
  const currentId = useGenerateStore((s) => s.current?.id ?? null);
  const show = useGenerateStore((s) => s.show);

  const active = useJobStore((s) => s.active);
  const livePreviewUrl = useJobStore((s) => s.livePreviewUrl);
  const livePreviewOwner = useJobStore((s) => s.livePreviewOwner);
  const runningGen = active?.owner === "generate";

  const queueItems = useQueueStore((s) => s.items);
  const genQueue = useMemo(() => queueItems.filter((q) => q.owner === "generate"), [queueItems]);
  const removeQueued = useQueueStore((s) => s.remove);
  const openQueue = () => useQueueStore.getState().setDrawerOpen(true);

  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: OutputItem } | null>(null);
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
        {runningGen && (
          <div
            role="listitem"
            aria-label="Live generation preview"
            className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[10px] bg-sunken"
            style={{ boxShadow: "0 0 0 2px var(--accent)" }}
          >
            {livePreviewUrl && livePreviewOwner === "generate" ? (
              <img src={livePreviewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
              <div aria-hidden className="shimmer h-full w-full" />
            )}
            <span className="mono-sm absolute bottom-0.5 right-0.5 rounded bg-accent px-1 text-[10px] leading-[14px] text-on-accent">
              {active?.totalSteps ? `${active.step}/${active.totalSteps}` : "…"}
            </span>
          </div>
        )}

        {genQueue.map((q, idx) => (
          <div key={q.id} role="listitem" className="group relative shrink-0">
            <button
              type="button"
              onClick={openQueue}
              aria-label={`Queued #${idx + 1}: ${truncate(q.label, 60)}`}
              title={`#${idx + 1} Queued — ${q.label}`}
              className="glass relative flex h-14 w-14 flex-col items-center justify-center overflow-hidden rounded-[10px] px-1 text-center transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] group-hover:-translate-y-0.5"
              style={{ boxShadow: "inset 0 0 0 1px var(--accent-ring)" }}
            >
              {q.previewUrl && <img src={q.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" draggable={false} />}
              <span className="mono-sm relative flex h-5 w-5 items-center justify-center rounded-full bg-accent text-on-accent font-semibold">
                {idx + 1}
              </span>
              <span className="relative mt-0.5 line-clamp-1 w-full text-[9px] leading-tight text-ink-2">
                {truncate(q.label, 18)}
              </span>
            </button>
            <span className="absolute -right-1.5 -top-1.5 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 group-focus-within:opacity-100">
              <IconButton icon={X} label="Remove from queue" variant="glass" size={20} iconSize={12} className="hover:!text-danger" onClick={() => removeQueued(q.id)} />
            </span>
          </div>
        ))}

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
        items={
          menu
            ? [
                { id: "reuse", icon: RotateCcw, label: "Reuse prompt and seed", onSelect: () => reusePromptAndSeed(menu.item) },
                { id: "edit", icon: Brush, label: "Edit in canvas", onSelect: () => openInEdit(menu.item) },
                { id: "3d", icon: Box, label: "Make 3D", onSelect: () => makeIn3D(menu.item) },
                { id: "copy", icon: Copy, label: "Copy image", onSelect: () => void copyImage(menu.item) },
                { id: "reveal", icon: FolderOpen, label: "Reveal in Explorer", onSelect: () => void reveal(menu.item) },
                "separator",
                { id: "del", icon: Trash2, label: "Delete", danger: true, onSelect: () => void deleteItems([menu.item]) },
              ]
            : []
        }
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
  const url = thumbUrl(item);
  return (
    <div role="listitem" className={`group relative shrink-0 ${fresh ? "film-insert" : ""}`}>
      <button
        type="button"
        draggable
        aria-label={truncate(item.params.prompt || "Image", 80)}
        aria-current={active || undefined}
        onClick={() => onShow(item)}
        onDragStart={(e) =>
          useDragStore.getState().start(
            {
              kind: item.kind,
              path: imagePathOf(item) ?? item.path,
              previewUrl: url,
              name: item.file,
              item,
            },
            e.clientX,
            e.clientY,
            e.dataTransfer,
          )
        }
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(item, e.clientX, e.clientY);
        }}
        className="block h-14 w-14 overflow-hidden rounded-[10px] bg-sunken transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] group-hover:-translate-y-0.5"
        style={active ? { outline: "2px solid var(--accent)", outlineOffset: 2 } : undefined}
      >
        <img src={url} alt="" draggable={false} loading="lazy" decoding="async" className="h-full w-full object-cover" />
      </button>
      <span className="absolute -right-1.5 -top-1.5 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 group-focus-within:opacity-100">
        <IconButton icon={Trash2} label="Delete" variant="glass" size={20} iconSize={12} className="hover:!text-danger" onClick={() => void deleteItems([item])} />
      </span>
    </div>
  );
});
