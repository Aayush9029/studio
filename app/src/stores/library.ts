import { create } from "zustand";
import type { OutputItem, OutputKind } from "../shared/contract";

export type LibraryFilter = "all" | OutputKind;

interface LibraryState {
  items: OutputItem[];
  loaded: boolean;
  loading: boolean;
  filter: LibraryFilter;
  query: string;
  favoritesOnly: boolean;
  selectMode: boolean;
  selection: ReadonlySet<string>;
  anchorId: string | null;
  inspectedId: string | null;

  setItems(items: OutputItem[]): void;
  setLoading(l: boolean): void;
  prepend(items: OutputItem[]): void;
  upsert(item: OutputItem): void;
  remove(ids: readonly string[]): void;
  setFilter(f: LibraryFilter): void;
  setQuery(q: string): void;
  toggleFavoritesOnly(): void;
  setSelectMode(on: boolean): void;
  toggleSelected(id: string): void;
  selectRange(ids: readonly string[]): void;
  setSelection(ids: readonly string[]): void;
  inspect(id: string | null): void;
}

function sortItems(items: OutputItem[]): OutputItem[] {
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const useLibraryStore = create<LibraryState>()((set) => ({
  items: [],
  loaded: false,
  loading: false,
  filter: "all",
  query: "",
  favoritesOnly: false,
  selectMode: false,
  selection: new Set(),
  anchorId: null,
  inspectedId: null,

  setItems: (items) =>
    set((s) => {
      // Keep items that arrived over the socket but are newer than the scan.
      const ids = new Set(items.map((i) => i.id));
      const extra = s.items.filter((i) => !ids.has(i.id) && (items.length === 0 || i.createdAt > items[0].createdAt));
      return { items: sortItems([...extra, ...items]), loaded: true, loading: false };
    }),
  setLoading: (l) => set({ loading: l }),
  prepend: (incoming) =>
    set((s) => {
      if (!incoming.length) return s;
      const ids = new Set(incoming.map((i) => i.id));
      return { items: sortItems([...incoming, ...s.items.filter((i) => !ids.has(i.id))]) };
    }),
  upsert: (item) => set((s) => ({ items: s.items.map((i) => (i.id === item.id ? item : i)) })),
  remove: (ids) =>
    set((s) => {
      const gone = new Set(ids);
      const selection = new Set([...s.selection].filter((id) => !gone.has(id)));
      return {
        items: s.items.filter((i) => !gone.has(i.id)),
        selection,
        inspectedId: s.inspectedId && gone.has(s.inspectedId) ? null : s.inspectedId,
      };
    }),
  setFilter: (f) => set({ filter: f }),
  setQuery: (q) => set({ query: q }),
  toggleFavoritesOnly: () => set((s) => ({ favoritesOnly: !s.favoritesOnly })),
  setSelectMode: (on) => set({ selectMode: on, selection: on ? new Set() : new Set(), anchorId: null }),
  toggleSelected: (id) =>
    set((s) => {
      const next = new Set(s.selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selection: next, anchorId: id, selectMode: true };
    }),
  selectRange: (ids) =>
    set((s) => {
      const next = new Set(s.selection);
      ids.forEach((id) => next.add(id));
      return { selection: next, selectMode: true };
    }),
  setSelection: (ids) => set({ selection: new Set(ids), selectMode: true }),
  inspect: (id) => set({ inspectedId: id }),
}));

/** Lower-cased search text per item; items are immutable (upserts replace the object), so a
    WeakMap keyed by identity never goes stale and frees entries with the items. */
const haystacks = new WeakMap<OutputItem, string>();

function haystackOf(item: OutputItem): string {
  let hay = haystacks.get(item);
  if (hay === undefined) {
    hay = `${item.params.prompt} ${item.params.enhancedPrompt ?? ""} ${item.params.seed} ${item.model.label}`.toLowerCase();
    haystacks.set(item, hay);
  }
  return hay;
}

function queryWords(q: string): string[] {
  return q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
}

function matchesWords(item: OutputItem, words: readonly string[]): boolean {
  if (!words.length) return true;
  const hay = haystackOf(item);
  return words.every((w) => hay.includes(w));
}

export function matchesQuery(item: OutputItem, q: string): boolean {
  return matchesWords(item, queryWords(q));
}

export function filterItems(items: OutputItem[], filter: LibraryFilter, query: string, favoritesOnly: boolean): OutputItem[] {
  const words = queryWords(query); // split once, not once per item
  return items.filter((i) => (filter === "all" || i.kind === filter) && (!favoritesOnly || i.favorite) && matchesWords(i, words));
}
