/** `studio://` custom protocol (API_CONTRACT.md §7.2). */
import { protocol, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { ENGINE_HTTP, ENGINE_WS } from "../src/shared/contract";
import { isInside } from "./errors";
import { log } from "./log";
import type { ResolvedConfig } from "./paths";

export const SCHEME = "studio";
export const APP_ORIGIN = "studio://app";

/** Must run before `app.whenReady()`. */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".hdr": "image/vnd.radiance",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const FILE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".glb", ".gltf"]);

export function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

export function buildCsp(dev: boolean): string {
  const devHosts = dev ? " http://localhost:5173 ws://localhost:5173" : "";
  const engine = `${ENGINE_HTTP} ${new URL(ENGINE_WS).origin}`;
  // Vite's React refresh preamble is an inline script, so development also needs 'unsafe-inline'.
  const scriptDev = dev ? " http://localhost:5173 'unsafe-inline'" : "";
  return [
    `default-src 'self' studio:${devHosts}`,
    `img-src 'self' studio: blob: data:${devHosts}`,
    `connect-src 'self' studio: blob: ${engine}${devHosts}`,
    `style-src 'self' 'unsafe-inline'${devHosts}`,
    `font-src 'self' studio: data:${devHosts}`,
    `worker-src 'self' blob:${devHosts}`,
    `script-src 'self'${scriptDev}`,
  ].join("; ");
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function refusal(r: 403 | 404): Response {
  return textResponse(r, r === 403 ? "Forbidden" : "Not found");
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    // `fs.promises.realpath` is the native (libuv) resolver, like `realpathSync.native`.
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

/**
 * Canonical path of a served root, resolved once and cached. A root that does not exist yet
 * (e.g. the thumbnail cache before the first scan) is retried on the next request instead of
 * caching the lexical fallback.
 */
export function cachedRealRoot(root: string): () => Promise<string> {
  let real: string | null = null;
  return async () => {
    if (real !== null) return real;
    const r = await realOrNull(root);
    if (r !== null) real = r;
    return r ?? root;
  };
}

export interface ResolvedFile {
  file: string;
  stat: fs.Stats;
}

/**
 * Resolves `rel` (URL path, percent-encoded, forward slashes) inside `root`.
 * Returns a status code on refusal: 403 for traversal or directories, 404 for missing files.
 */
export async function resolveUnder(
  root: string,
  urlPath: string,
  realRoot: () => Promise<string> = cachedRealRoot(root),
): Promise<ResolvedFile | 403 | 404> {
  let rel: string;
  try {
    rel = urlPath
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s))
      .join(path.sep);
  } catch {
    return 403;
  }
  if (rel === "" || rel.includes("\0")) return 403;
  const candidate = path.resolve(root, rel);
  if (!isInside(root, candidate)) return 403;
  const real = await realOrNull(candidate);
  if (real === null) return 404;
  if (!isInside(await realRoot(), real)) return 403;
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(real);
  } catch {
    return 404;
  }
  if (!stat.isFile()) return 403;
  return { file: real, stat };
}

/** Decodes the `studio://file/<base64url(absPath)>` payload. */
export function decodeFilePayload(segment: string): string | null {
  try {
    const decoded = Buffer.from(decodeURIComponent(segment), "base64url").toString("utf8");
    if (!decoded || decoded.includes("\0") || !path.win32.isAbsolute(decoded) || !/^([a-zA-Z]:[\\/]|\\\\)/.test(decoded)) return null;
    return path.resolve(decoded);
  } catch {
    return null;
  }
}

type ByteRange = { start: number; end: number };

/**
 * A single `bytes=` range (RFC 9110 §14.1.2) clamped to `size`. `null` means "serve the whole
 * file" (no header, or a multi-range / malformed header we ignore); `"unsatisfiable"` is a 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function etagFor(st: fs.Stats): string {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === etag || v === etag.slice(2);
  });
}

/**
 * Streams `file` straight from disk with `ETag`/`Last-Modified`, conditional `304`, `HEAD`
 * and single-range `206 Partial Content` support (video/GLB seeking, partial fetches).
 */
function serveFile(
  request: Request,
  { file, stat }: ResolvedFile,
  cacheControl: string,
  extra: Record<string, string> = {},
): Response {
  const etag = etagFor(stat);
  const headers: Record<string, string> = {
    "Content-Type": mimeFor(file),
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
    ...extra,
  };
  if (etagMatches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });

  const range = parseRange(request.headers.get("range"), stat.size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const length = Math.max(0, end - start + 1);
  const status = range ? 206 : 200;
  headers["Content-Length"] = String(length);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  if (request.method === "HEAD" || length === 0) return new Response(null, { status, headers });

  const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

const CACHE_NONE = "no-cache";
/** Hashed Vite build output under `studio://app/assets/`. */
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
/** Generated outputs: written once, revalidated by `ETag` after a day. */
const CACHE_OUTPUTS = "private, max-age=86400";
/** Thumbnails are requested with `?v=<mtimeMs>`, so a URL never changes content. */
const CACHE_THUMBS = "max-age=31536000, immutable";

const THUMB_NAME = /^[A-Za-z0-9_-]{1,128}\.webp$/;

export function installProtocol(cfg: ResolvedConfig): void {
  const dev = cfg.devServerUrl !== null;
  const csp = buildCsp(dev);
  const thumbsDir = path.join(cfg.outputsDir, ".cache", "thumbs");
  // Each served root is canonicalised once, not on every request.
  const rendererRoot = cachedRealRoot(cfg.rendererDir);
  const outputsRoot = cachedRealRoot(cfg.outputsDir);

  protocol.handle(SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse(400, "Bad URL");
    }
    if (request.method !== "GET" && request.method !== "HEAD") return textResponse(405, "Method not allowed");
    try {
      switch (url.hostname) {
        case "app": {
          const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
          let r = await resolveUnder(cfg.rendererDir, pathname, rendererRoot);
          let isIndex = pathname === "/index.html";
          // SPA fallback for extension-less routes.
          if (r === 404 && path.extname(url.pathname) === "") {
            r = await resolveUnder(cfg.rendererDir, "/index.html", rendererRoot);
            isIndex = true;
          }
          if (typeof r === "number") return refusal(r);
          const cache = !isIndex && pathname.startsWith("/assets/") ? CACHE_IMMUTABLE : CACHE_NONE;
          return serveFile(request, r, cache, { "Content-Security-Policy": csp });
        }
        case "outputs": {
          const r = await resolveUnder(cfg.outputsDir, url.pathname, outputsRoot);
          if (typeof r === "number") return refusal(r);
          return serveFile(request, r, CACHE_OUTPUTS);
        }
        case "thumbs": {
          let name: string;
          try {
            name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
          } catch {
            return refusal(403);
          }
          // The name is a bare `[A-Za-z0-9_-].webp`, so no traversal is possible: a single
          // `lstat` (refusing links) replaces the realpath round trips.
          if (!THUMB_NAME.test(name)) return refusal(403);
          const file = path.join(thumbsDir, name);
          let stat: fs.Stats;
          try {
            stat = await fs.promises.lstat(file);
          } catch {
            return refusal(404);
          }
          if (!stat.isFile()) return refusal(403);
          return serveFile(request, { file, stat }, CACHE_THUMBS);
        }
        case "file": {
          const seg = url.pathname.replace(/^\/+/, "");
          const abs = decodeFilePayload(seg);
          if (!abs || seg.includes("/")) return refusal(403);
          if (!FILE_EXTS.has(path.extname(abs).toLowerCase())) return refusal(403);
          const real = await realOrNull(abs);
          if (!real) return refusal(404);
          if (!FILE_EXTS.has(path.extname(real).toLowerCase())) return refusal(403);
          let stat: fs.Stats;
          try {
            stat = await fs.promises.stat(real);
          } catch {
            return refusal(404);
          }
          if (!stat.isFile()) return refusal(403);
          return serveFile(request, { file: real, stat }, CACHE_NONE);
        }
        default:
          return refusal(404);
      }
    } catch (err) {
      log.error("protocol", `${request.url}: ${String(err)}`);
      return textResponse(500, "Internal error");
    }
  });

  // In development the renderer comes from Vite; give it the same CSP (plus the dev hosts).
  if (dev && cfg.devServerUrl) {
    const devOrigin = new URL(cfg.devServerUrl).origin;
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${devOrigin}/*`] }, (details, callback) => {
      const headers = { ...(details.responseHeaders ?? {}) };
      if (details.resourceType === "mainFrame") headers["Content-Security-Policy"] = [csp];
      callback({ responseHeaders: headers });
    });
  }
}
