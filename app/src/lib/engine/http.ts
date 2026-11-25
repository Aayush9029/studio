/* Typed fetch client for the engine daemon (API_CONTRACT.md §3). */

import {
  ENGINE_HTTP,
  type CancelRequest,
  type CancelResponse,
  type EditRequest,
  type EngineSettings,
  type EngineTelemetry,
  type EnhanceRequest,
  type EnhanceResponse,
  type ErrorResponse,
  type Health,
  type JobAccepted,
  type ModelFamilyStatus,
  type OutputKind,
  type OutputsResponse,
  type StudioError,
  type T2IRequest,
  type ThreeDRequest,
  type UnloadRequest,
  type UnloadResponse,
  type UploadJsonRequest,
  type UploadResponse,
  type WarmupRequest,
  type WarmupResponse,
} from "../../shared/contract";
import { parseIpcError } from "../studio";

export class EngineError extends Error {
  readonly error: StudioError;
  readonly status: number;
  constructor(error: StudioError, status: number) {
    super(error.message || error.code);
    this.error = error;
    this.status = status;
  }
}

function isErrorResponse(v: unknown): v is ErrorResponse {
  return !!v && typeof v === "object" && "error" in v && !!(v as ErrorResponse).error && typeof (v as ErrorResponse).error.code === "string";
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    const init: RequestInit = { method, signal };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    res = await fetch(`${ENGINE_HTTP}${path}`, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new EngineError({ code: "ENGINE_UNREACHABLE", message: e instanceof Error ? e.message : String(e) }, 0);
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err: StudioError = isErrorResponse(json) ? json.error : { code: "INTERNAL", message: `HTTP ${res.status}` };
    throw new EngineError(err, res.status);
  }
  return json as T;
}

export const engineHttp = {
  health: (signal?: AbortSignal) => request<Health>("GET", "/api/health", undefined, signal),
  models: () => request<ModelFamilyStatus[]>("GET", "/api/models"),
  warmup: (req: WarmupRequest) => request<WarmupResponse>("POST", "/api/models/warmup", req),
  unload: (req: UnloadRequest) => request<UnloadResponse>("POST", "/api/models/unload", req),
  getSettings: () => request<EngineSettings>("GET", "/api/settings"),
  setSettings: (patch: Partial<EngineSettings>) => request<EngineSettings>("POST", "/api/settings", patch),
  telemetry: () => request<EngineTelemetry>("GET", "/api/telemetry"),
  enhance: (req: EnhanceRequest) => request<EnhanceResponse>("POST", "/api/enhance-prompt", req),
  upload: (req: UploadJsonRequest) => request<UploadResponse>("POST", "/api/upload", req),
  uploadFile: (file: Blob, filename = "upload.png") => {
    const fd = new FormData();
    fd.append("file", file, filename);
    return request<UploadResponse>("POST", "/api/upload", fd);
  },
  t2i: (req: T2IRequest) => request<JobAccepted>("POST", "/api/generate/t2i", req),
  edit: (req: EditRequest) => request<JobAccepted>("POST", "/api/generate/edit", req),
  threeD: (req: ThreeDRequest) => request<JobAccepted>("POST", "/api/generate/3d", req),
  cancel: (req: CancelRequest = {}) => request<CancelResponse>("POST", "/api/cancel", req),
  outputs: (kind: "all" | OutputKind = "all", limit = 200, offset = 0) =>
    request<OutputsResponse>("GET", `/api/outputs?kind=${kind}&limit=${limit}&offset=${offset}`),
};

/** Normalises anything thrown by the engine client or an IPC call into a StudioError. */
export function toStudioError(e: unknown): StudioError {
  if (e instanceof EngineError) return e.error;
  return parseIpcError(e);
}
