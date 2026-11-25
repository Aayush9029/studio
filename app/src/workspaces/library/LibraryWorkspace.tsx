import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { Box, Check, Heart, Search, Trash2 } from "lucide-react";
import type { OutputItem } from "../../shared/contract";
import { filterItems, useLibraryStore, type LibraryFilter } from "../../stores/library";
import { registerCommands } from "../../lib/commands";
import { deleteItems, openHome, toggleFavorite } from "../../lib/actions";
import { thumbnailUrl } from "../../lib/images";
import { truncate } from "../../lib/format";
import { useConfirm } from "../../lib/useConfirm";
import { IconButton } from "../../components/ui/IconButton";
import { Pill } from "../../components/ui/Pill";
import { EmptyState } from "../../components/ui/misc";
import { Inspector, useInspectedItem } from "./Inspector";

const GAP = 12;
const MIN_COL = 220;
const PAD_X = 32;

interface Placed {
  item: OutputItem;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Masonry {
  placed: Placed[];
  /** Per column, indices into `placed` in ascending y (cards are appended top-down). */
  columns: number[][];
  height: number;
}

/** Masonry by columns, shortest column first; positions only (virtualized rendering below). */
function layoutMasonry(items: OutputItem[], width: number): Masonry {
  const inner = Math.max(MIN_COL, width - PAD_X * 2);
  const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_COL + GAP)));
  const colW = (inner - GAP * (cols - 1)) / cols;
  const heights = new Array<number>(cols).fill(0);
  const placed: Placed[] = [];
  const columns: number[][] = Array.from({ length: cols }, () => []);
  for (const item of items) {
    let c = 0;
    for (let i = 1; i < cols; i++) if (heights[i] < heights[c]) c = i;
    const ratio = item.kind === "3d" || !item.width || !item.height ? 1 : item.height / item.width;
    const h = Math.round(colW * ratio);
    columns[c].push(placed.length);
    placed.push({ item, x: PAD_X + c * (colW + GAP), y: heights[c], w: colW, h });
    heights[c] += h + GAP;
  }
  return { placed, columns, height: Math.max(0, ...heights) };
}

/** Cards intersecting [lo, hi]: binary-search each column's first visible card, then walk until past `hi`. */
function visibleRange(m: Masonry, lo: number, hi: number): Placed[] {
  const out: number[] = [];
  for (const col of m.columns) {
    // First card whose bottom edge reaches `lo` (bottoms ascend with y within a column).
    let a = 0;
    let b = col.length;
    while (a < b) {
      const mid = (a + b) >>> 1;
      const p = m.placed[col[mid]];
      if (p.y + p.h < lo) a = mid + 1;
      else b = mid;
    }
    for (let i = a; i < col.length; i++) {
      const p = m.placed[col[i]];
      if (p.y > hi) break;
      out.push(col[i]);
    }
  }
  out.sort((x, y) => x - y); // stable, newest-first DOM order
  return out.map((i) => m.placed[i]);
}

const FILTERS: { id: LibraryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "edit", label: "Edits" },
  { id: "3d", label: "3D" },
];

export default function LibraryWorkspace({ active }: { active: boolean }) {
  const items = useLibraryStore((s) => s.items);
  const loaded = useLibraryStore((s) => s.loaded);
  const filter = useLibraryStore((s) => s.filter);
  const query = useLibraryStore((s) => s.query);
  const favoritesOnly = useLibraryStore((s) => s.favoritesOnly);
  const selectMode = useLibraryStore((s) => s.selectMode);
  const selection = useLibraryStore((s) => s.selection);
  const lib = useLibraryStore.getState;
  const inspected = useInspectedItem();

  const [search, setSearch] = useState(query);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => useLibraryStore.getState().setQuery(search.trim()), 150);
    return () => window.clearTimeout(t);
  }, [search]);

  const visible = useMemo(() => filterItems(items, filter, query, favoritesOnly), [items, filter, query, favoritesOnly]);

  // ───────── Virtualized masonry ─────────
  const scroller = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0, top: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp((v) => ({ ...v, w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVp((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  const masonry = useMemo(() => layoutMasonry(visible, vp.w), [visible, vp.w]);
  const { height } = masonry;
  const lo = vp.top - vp.h * 0.5;
  const hi = vp.top + vp.h * 1.5;
  const shown = useMemo(() => visibleRange(masonry, lo, hi), [masonry, lo, hi]);

  // ───────── Selection / actions ─────────
  const { armed, press, disarm } = useConfirm(3000);
  const selectedItems = useMemo(() => visible.filter((i) => selection.has(i.id)), [visible, selection]);

  const onTileClick = useCallback(
    (item: OutputItem, e: RMouseEvent) => {
      const s = lib();
      if (e.shiftKey && (s.selectMode || s.anchorId)) {
        const ids = visible.map((i) => i.id);
        const a = ids.indexOf(s.anchorId ?? item.id);
        const b = ids.indexOf(item.id);
        s.selectRange(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
      if (e.ctrlKey || s.selectMode) {
        s.toggleSelected(item.id);
        return;
      }
      s.inspect(item.id);
    },
    [visible, lib],
  );

  const deleteSelected = () => {
    const run = () => {
      void deleteItems(selectedItems).then((ok) => ok && lib().setSelectMode(false));
    };
    if (selectedItems.length >= 2) press(run);
    else run();
  };

  const favoriteSelected = () => {
    const anyOff = selectedItems.some((i) => !i.favorite);
    selectedItems.filter((i) => i.favorite !== anyOff).forEach((i) => void toggleFavorite(i));
  };

  const step = useCallback(
    (dir: number) => {
      const s = lib();
      const i = visible.findIndex((x) => x.id === s.inspectedId);
      const n = visible[i + dir];
      if (n) s.inspect(n.id);
    },
    [visible, lib],
  );

  useEffect(
    () =>
      registerCommands("library", {
        escape: () => {
          if (lib().selectMode) {
            lib().setSelectMode(false);
            disarm();
            return true;
          }
          return false;
        },
        key: (e, typing) => {
          const s = lib();
          if (e.ctrlKey && e.key.toLowerCase() === "f") {
            searchRef.current?.focus();
            searchRef.current?.select();
            return true;
          }
          if (typing) return false;
          if (e.ctrlKey && e.key.toLowerCase() === "a") {
            s.setSelection(visible.map((i) => i.id));
            return true;
          }
          const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.itemId ?? null;
          const target = focusedId ? visible.find((i) => i.id === focusedId) : s.inspectedId ? visible.find((i) => i.id === s.inspectedId) : undefined;
          if (e.key === "Delete") {
            if (s.selection.size) deleteSelected();
            else if (target) void deleteItems([target]);
            return true;
          }
          if (e.ctrlKey || e.altKey) return false;
          if ((e.key === "f" || e.key === "F") && target) {
            void toggleFavorite(target);
            return true;
          }
          if (e.key === "Enter" && target) {
            s.inspect(target.id);
            return true;
          }
          if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && s.inspectedId) {
            step(e.key === "ArrowLeft" ? -1 : 1);
            return true;
          }
          return false;
        },
      }),
    // deleteSelected depends on selection; re-register when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, step, selectedItems, armed],
  );

  void active;
  const nothing = loaded && items.length === 0;
  const noMatch = loaded && items.length > 0 && visible.length === 0;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 px-8">
          <h1 className="t-title m-0 text-ink">Library</h1>
          <div className="flex-1" />
          {selectMode ? (
            <div className="anim-enter flex items-center gap-2">
              <span className="mono mr-1 text-ink-2">{selection.size} selected</span>
              <IconButton icon={Heart} label="Favorite selected" disabled={!selection.size} onClick={favoriteSelected} />
              <Pill tone={armed ? "danger-solid" : "danger"} disabled={!selection.size} onClick={deleteSelected}>
                {armed ? `Delete ${selectedItems.length} — confirm` : "Delete selected"}
              </Pill>
              <Pill
                onClick={() => {
                  lib().setSelectMode(false);
                  disarm();
                }}
              >
                Done
              </Pill>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Filter">
                {FILTERS.map((f) => (
                  <Pill key={f.id} role="radio" aria-checked={filter === f.id} selected={filter === f.id} onClick={() => lib().setFilter(f.id)}>
                    {f.label}
                  </Pill>
                ))}
              </div>
              <IconButton
                icon={Heart}
                label="Favorites only"
                pressed={favoritesOnly}
                active={favoritesOnly}
                iconClassName={favoritesOnly ? "fill-current" : ""}
                onClick={() => lib().toggleFavoritesOnly()}
              />
              <label className="flex h-8 w-[220px] items-center gap-2 rounded-full bg-sunken px-3 text-ink-3 focus-within:text-ink-2">
                <Search size={14} strokeWidth={1.75} absoluteStrokeWidth />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="Search prompts"
                  placeholder="Search prompts"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && search) {
                      e.stopPropagation();
                      setSearch("");
                    }
                  }}
                  className="t-ui min-w-0 flex-1 border-0 bg-transparent text-ink outline-none placeholder:text-ink-3"
                />
              </label>
              <Pill onClick={() => lib().setSelectMode(true)}>Select</Pill>
            </>
          )}
        </header>

        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto pb-8">
          {nothing && (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState lead="Nothing here yet." sub="What you make appears in this room." />
            </div>
          )}
          {noMatch && (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState lead="No match." sub="Try fewer words" />
            </div>
          )}
          <div className="relative" style={{ height }} role="grid" aria-label="Library items" aria-rowcount={visible.length}>
            {shown.map((p) => (
              <Tile
                key={p.item.id}
                p={p}
                selectMode={selectMode}
                selected={selection.has(p.item.id)}
                inspected={inspected?.id === p.item.id}
                onClick={onTileClick}
              />
            ))}
          </div>
        </div>
      </div>
      {inspected && <Inspector key="inspector" item={inspected} onClose={() => lib().inspect(null)} onStep={step} />}
    </div>
  );
}

const Tile = memo(function Tile({
  p,
  selectMode,
  selected,
  inspected,
  onClick,
}: {
  p: Placed;
  selectMode: boolean;
  selected: boolean;
  inspected: boolean;
  onClick(item: OutputItem, e: RMouseEvent): void;
}) {
  const { item } = p;
  const src = thumbnailUrl(item);
  return (
    <div
      role="gridcell"
      className="group absolute overflow-hidden rounded-[var(--r-md)] bg-sunken"
      style={{
        left: 0,
        top: 0,
        transform: `translate3d(${p.x}px, ${p.y}px, 0)`,
        contain: "layout style paint",
        width: p.w,
        height: p.h,
        boxShadow: selected || inspected ? "0 0 0 2px var(--accent)" : undefined,
      }}
    >
      <button
        type="button"
        data-item-id={item.id}
        aria-label={truncate(item.params.prompt || item.model.label, 120)}
        aria-selected={selectMode ? selected : undefined}
        onClick={(e) => onClick(item, e)}
        onDoubleClick={() => !selectMode && openHome(item)}
        className="absolute inset-0 block h-full w-full focus-visible:outline-offset-[-2px]"
      >
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" />
        ) : (
          // Thumbnail not generated yet: a calm paper cell instead of decoding the full-size original.
          <span aria-hidden className="block h-full w-full" style={{ background: "linear-gradient(160deg, var(--surface-active), transparent 70%)", opacity: 0.6 }} />
        )}
      </button>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100"
        style={{ background: "linear-gradient(to top, var(--scrim), transparent)" }}
      />
      {item.kind === "3d" && (
        <span className="glass pointer-events-none absolute bottom-2 left-2 flex h-6 w-6 items-center justify-center rounded-full text-ink">
          <Box size={14} strokeWidth={1.75} absoluteStrokeWidth />
        </span>
      )}
      {selectMode && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-full"
          style={selected ? { background: "var(--accent)", color: "var(--text-on-accent)" } : { boxShadow: "inset 0 0 0 1.5px var(--surface-elevated)", background: "var(--scrim)" }}
        >
          {selected && <Check size={12} strokeWidth={2} absoluteStrokeWidth />}
        </span>
      )}
      {!selectMode && (
        <span className={`absolute right-2 top-2 flex gap-1 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 group-focus-within:opacity-100 ${item.favorite ? "" : "opacity-0"}`}>
          <IconButton
            icon={Heart}
            label={item.favorite ? "Remove from favorites" : "Favorite"}
            variant="glass"
            size={28}
            iconSize={14}
            tone={item.favorite ? "accent" : "default"}
            iconClassName={item.favorite ? "fill-current" : ""}
            onClick={() => void toggleFavorite(item)}
          />
          <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <IconButton icon={Trash2} label="Delete" variant="glass" size={28} iconSize={14} className="hover:!text-danger" onClick={() => void deleteItems([item])} />
          </span>
        </span>
      )}
    </div>
  );
});
