/* Tabular formatting for mono figures: bytes, memory, durations, seeds, counts. */

const GIB = 1024 ** 3;
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 20948784834 → "19.51 GB" (binary units, labelled GB as in the spec). */
export function formatBytes(bytes: number, digits = 2): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= GIB) return `${(digits === 1 ? nf1 : nf2).format(bytes / GIB)} GB`;
  if (bytes >= 1024 ** 2) return `${nf1.format(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${nf0.format(bytes / 1024)} KB`;
  return `${nf0.format(bytes)} B`;
}

/** Exact byte count with grouping: "20,948,784,834 bytes". */
export function formatExactBytes(bytes: number): string {
  return `${nf0.format(bytes)} bytes`;
}

/** Mebibytes → "21.4" (GB, one decimal). */
export function mbToGb(mb: number | null | undefined, digits = 1): string {
  if (mb == null || !Number.isFinite(mb)) return "—";
  return (digits === 1 ? nf1 : nf2).format(mb / 1024);
}

/** Mebibytes → "102" when integral-ish GB, else one decimal. */
export function mbToGbShort(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return "—";
  const gb = mb / 1024;
  return Math.abs(gb - Math.round(gb)) < 0.05 ? nf0.format(Math.round(gb)) : nf1.format(gb);
}

/** Runtime guard: VRAM counters can be missing (no GPU / driver query failed) even though the
    contract types them as numbers. */
export function hasVram(t: { vramTotalMb?: number | null; vramUsedMb?: number | null } | null | undefined): boolean {
  if (!t) return false;
  const total = t.vramTotalMb;
  const used = t.vramUsedMb;
  return total != null && used != null && Number.isFinite(total) && Number.isFinite(used) && total > 0;
}

/** "12.3 / 24 GB", or "—" when either counter is unavailable (never "0 / 0 GB"). */
export function formatMemPair(used: number | null | undefined, total: number | null | undefined, short = false): string {
  if (used == null || total == null || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "—";
  return `${mbToGb(used)} / ${short ? mbToGbShort(total) : mbToGb(total)} GB`;
}

/** 4209 → "4.2 s", 74000 → "1 min 14 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${nf0.format(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${nf1.format(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return nf0.format(n);
}

export function formatDims(w: number | null | undefined, h: number | null | undefined): string {
  if (!w || !h) return "—";
  return `${w} × ${h}`;
}

export function formatMeters(size: [number, number, number] | null | undefined): string {
  if (!size) return "—";
  return `${size.map((v) => nf2.format(v)).join(" × ")} m`;
}

/** "used 2 min ago" style relative time. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
/** "25 Nov 2026, 14:30" in local time. */
export function formatCreated(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return dateFmt.format(new Date(t));
}

/** 6150000000 → "6.15 B params". */
export function formatParams(n: number): string {
  if (n >= 1e9) return `${nf2.format(n / 1e9)} B params`;
  if (n >= 1e6) return `${nf1.format(n / 1e6)} M params`;
  if (n >= 1e3) return `${nf1.format(n / 1e3)} K params`;
  return `${nf0.format(n)} params`;
}

/** Middle-ellipsis for long file names. */
export function middleEllipsis(s: string, max = 42): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.55);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function stem(p: string): string {
  const b = basename(p);
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
}
