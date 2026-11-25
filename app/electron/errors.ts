/**
 * IPC error convention (API_CONTRACT.md §7.1): a failed invoke rejects with an `Error`
 * whose `message` is the JSON string `{"code","message","details"}`.
 */
import fs from "node:fs";
import path from "node:path";

import type { ErrorCode, StudioError } from "../src/shared/contract";

export class IpcError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly detailMessage: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(JSON.stringify({ code, message: detailMessage, details } satisfies StudioError));
    this.name = "IpcError";
  }
}

export function fail(code: ErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new IpcError(code, message, details);
}

/** Normalises any thrown value into an `IpcError`. */
export function toIpcError(err: unknown): IpcError {
  if (err instanceof IpcError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new IpcError("INTERNAL", message);
}

/** Case-insensitive containment on Windows; `child === root` is not inside. */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Validates an absolute path argument (§7.1). */
export function requireAbsolute(value: unknown, field = "path"): string {
  if (typeof value !== "string" || value.trim() === "") fail("INVALID_PATH", `${field} must be a non-empty string`, { field });
  if (value.includes("\0")) fail("INVALID_PATH", `${field} contains a NUL byte`, { field });
  if (!path.isAbsolute(value) || !/^([a-zA-Z]:[\\/]|\\\\)/.test(value)) {
    fail("INVALID_PATH", `${field} must be an absolute path`, { field, path: value });
  }
  return path.resolve(value);
}

/** Validates an absolute path that must resolve (after symlinks/junctions) inside `root`. */
export function requireInside(root: string, value: unknown, field = "path"): string {
  const abs = requireAbsolute(value, field);
  const realRoot = realOrSelf(root);
  const real = realOrSelf(abs);
  if (!isInside(root, abs) || !isInside(realRoot, real)) {
    fail("INVALID_PATH", `${field} must be inside the outputs directory`, { field, path: abs, root });
  }
  return abs;
}
