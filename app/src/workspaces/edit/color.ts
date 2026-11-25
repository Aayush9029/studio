/* Brush colour data (DESIGN_SPEC.md §5.2.3). These are paint values the user applies to pixels,
   not UI styling, so they live here rather than in the token sheet. */

export const DEFAULT_SWATCHES: readonly string[] = ["#18181B", "#FFFFFF", "#B8433A", "#C9A227", "#4F6F5B", "#4B50C8"];
export const DEFAULT_BRUSH_COLOR = "#4B50C8";

/** Last six custom colours replace swatches right-to-left. */
export function displayedSwatches(custom: readonly string[]): string[] {
  const out = DEFAULT_SWATCHES.slice();
  custom.slice(0, 6).forEach((c, k) => (out[5 - k] = c));
  return out;
}

export function addCustom(custom: readonly string[], color: string): string[] {
  const c = normalizeHex(color);
  if (!c || DEFAULT_SWATCHES.includes(c)) return custom.slice();
  return [c, ...custom.filter((x) => x !== c)].slice(0, 6);
}

export function normalizeHex(s: string): string | null {
  let h = s.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((x) => x + x).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return `#${h.toUpperCase()}`;
}

export interface HSV {
  h: number; // 0–360
  s: number; // 0–1
  v: number; // 0–1
}

export function hexToHsv(hex: string): HSV {
  const n = normalizeHex(hex) ?? "#000000";
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: HSV): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(5))}${to(f(3))}${to(f(1))}`.toUpperCase();
}
