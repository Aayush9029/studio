/* Image helpers: loading, decoding, encoding. */

import type { OutputItem } from "../shared/contract";
import { isDesktop, toUrl } from "./studio";

export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(JSON.stringify({ code: "IMAGE_DECODE_FAILED", message: `HTTP ${res.status}` }));
  return res.blob();
}

/** Decodes a blob, downscaling so the long edge is at most `maxEdge` (high-quality resize). */
export async function decodeFitted(blob: Blob, maxEdge = 2048): Promise<{ bitmap: ImageBitmap; fitted: boolean }> {
  const probe = await createImageBitmap(blob, { premultiplyAlpha: "none" });
  const long = Math.max(probe.width, probe.height);
  if (long <= maxEdge) return { bitmap: probe, fitted: false };
  const scale = maxEdge / long;
  const w = Math.max(1, Math.round(probe.width * scale));
  const h = Math.max(1, Math.round(probe.height * scale));
  probe.close();
  const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "high", premultiplyAlpha: "none" });
  return { bitmap, fitted: true };
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export function canvasToPng(c: AnyCanvas): Promise<Blob> {
  if (c instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
  }
  return c.convertToBlob({ type: "image/png" });
}

export function imageFileFromEvent(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files)) if (f.type.startsWith("image/")) return f;
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/** Native picker in Electron (absolute paths), hidden <input type=file> in the browser. */
export async function pickImages(multiple = false): Promise<{ path: string | null; blob: Blob | null; url: string; name: string }[]> {
  if ("studio" in window && window.studio) {
    const paths = await window.studio.files.openImages({ multiple });
    return paths.map((p) => ({ path: p, blob: null, url: toUrl(p), name: p.split(/[\\/]/).pop() ?? "image" }));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.multiple = multiple;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      resolve(files.map((f) => ({ path: null, blob: f, url: URL.createObjectURL(f), name: f.name })));
    };
    input.click();
  });
}

export function outputUrl(item: OutputItem): string {
  return toUrl(item.path);
}

export function thumbUrl(item: OutputItem): string {
  if (item.thumbPath) return toUrl(item.thumbPath);
  if (item.kind === "3d") return toUrl(item.previewPath);
  return toUrl(item.path);
}

/**
 * Grid-safe thumbnail: the 512 px WebP from the thumbnail scan, or null while it doesn't exist yet
 * (callers render a placeholder rather than decoding a full-resolution primary PNG per tile).
 * The browser fallback has no thumbnail pipeline at all, so there it degrades to the full image.
 */
export function thumbnailUrl(item: OutputItem): string | null {
  if (item.thumbPath) return toUrl(item.thumbPath);
  if (!isDesktop) return item.kind === "3d" ? (item.previewPath ? toUrl(item.previewPath) : null) : toUrl(item.path);
  return null;
}

/** Image path representing an item visually (3D items use their preview render). */
export function imagePathOf(item: OutputItem): string | null {
  return item.kind === "3d" ? item.previewPath : item.path;
}

/** Path of a file, from a File in Electron (webUtils), else null. */
export function pathForFile(f: File): string | null {
  if (!("studio" in window) || !window.studio) return null;
  try {
    const p = window.studio.files.pathForFile(f);
    return p || null;
  } catch {
    return null;
  }
}

export function resolveAssetFile(item: OutputItem, rel: string | null): string | null {
  if (!rel) return null;
  const sep = item.dir.includes("\\") ? "\\" : "/";
  return `${item.dir}${item.dir.endsWith(sep) ? "" : sep}${rel.replace(/\//g, sep)}`;
}
