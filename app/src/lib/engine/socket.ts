/* Engine WebSocket client (API_CONTRACT.md §4): JSON events, binary PREV frames, reconnect.

   Preview frames never touch React state: they are decoded off the main thread with
   createImageBitmap and handed straight to the owning workspace's Murmuration. A frame whose
   decode finishes after a newer frame arrived is dropped. */

import {
  ENGINE_WS,
  PREVIEW_HEADER_BYTES,
  PREVIEW_MAGIC,
  type EngineEvent,
  type PreviewFrame,
} from "../../shared/contract";
import { getMurmuration } from "../../murmuration";
import { useEngineStore } from "../../stores/engine";
import { useJobStore } from "../../stores/job";
import { engineHttp } from "./http";
import { handleJobEvent, reconcileActiveJob } from "./jobs";

export function parsePreview(buf: ArrayBuffer): PreviewFrame | null {
  if (buf.byteLength < PREVIEW_HEADER_BYTES + 2) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== PREVIEW_MAGIC) return null; // "PREV"
  return {
    step: dv.getUint32(4, true),
    totalSteps: dv.getUint32(8, true),
    stageIndex: dv.getUint32(12, true),
    jpeg: new Blob([new Uint8Array(buf, PREVIEW_HEADER_BYTES)], { type: "image/jpeg" }),
  };
}

const KNOWN_TYPES = new Set([
  "job.started",
  "job.progress",
  "job.stage_preview",
  "job.completed",
  "job.error",
  "job.cancelled",
  "models.status",
  "telemetry",
]);

class EngineSocket {
  private ws: WebSocket | null = null;
  private backoff = 250;
  private timer = 0;
  private started = false;
  private decodeSeq = 0;
  /** performance.now() of the last health request (periodic refresh is time-gated, not count-gated). */
  private lastHealthAt = -Infinity;
  private healthInFlight = false;
  /** Set on every (re)open: the first telemetry snapshot afterwards reconciles the local job binding. */
  private reconcilePending = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /** Reconnect now (engine process reported a state change). */
  kick(): void {
    if (!this.started) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
    this.backoff = 250;
    this.connect();
  }

  private connect(): void {
    this.timer = 0;
    let ws: WebSocket;
    try {
      ws = new WebSocket(ENGINE_WS);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 250;
      this.reconcilePending = true;
      useEngineStore.getState().setSocket(true);
      void this.refreshHealth();
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") this.onText(e.data);
      else if (e.data instanceof ArrayBuffer) this.onBinary(e.data);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      useEngineStore.getState().setSocket(false);
      useEngineStore.getState().setHealth(null);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 5000);
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  async refreshHealth(): Promise<void> {
    if (this.healthInFlight) return;
    this.healthInFlight = true;
    this.lastHealthAt = performance.now();
    try {
      const h = await engineHttp.health();
      useEngineStore.getState().setHealth(h);
    } catch {
      useEngineStore.getState().setHealth(null);
    } finally {
      this.healthInFlight = false;
    }
  }

  private onText(text: string): void {
    let ev: EngineEvent;
    try {
      ev = JSON.parse(text) as EngineEvent;
    } catch {
      return;
    }
    if (!ev || typeof ev !== "object" || !KNOWN_TYPES.has(ev.type)) return; // ignore unknown types
    switch (ev.type) {
      case "models.status":
        useEngineStore.getState().setModels(ev.models);
        break;
      case "telemetry": {
        useEngineStore.getState().setTelemetry(ev);
        // Events on one socket are ordered, so any `job.started` replay sent with the reconnect
        // snapshot has already been applied by the time this first telemetry arrives.
        if (this.reconcilePending) {
          this.reconcilePending = false;
          reconcileActiveJob(ev.activeJobId);
        }
        // Inkling availability is cached by the engine for 10 s; re-read health every 20 s while the
        // window is visible (an unhealthy engine is re-checked on every snapshot regardless).
        const h = useEngineStore.getState().health;
        if (!h || h.status !== "ok") void this.refreshHealth();
        else if (!document.hidden && performance.now() - this.lastHealthAt >= 20_000) void this.refreshHealth();
        break;
      }
      default:
        handleJobEvent(ev);
    }
  }

  private onBinary(buf: ArrayBuffer): void {
    const frame = parsePreview(buf);
    if (!frame) return;
    const job = useJobStore.getState().active;
    if (!job) return; // no active job binding → discard (§4.3 rule 1)
    const seq = ++this.decodeSeq;
    const { owner, jobId } = job;
    createImageBitmap(frame.jpeg).then(
      (bmp) => {
        if (seq !== this.decodeSeq || useJobStore.getState().active?.jobId !== jobId) {
          bmp.close();
          return;
        }
        const m = getMurmuration(owner);
        useJobStore.getState().setLivePreview(owner, frame.jpeg, frame.stageIndex);
        if (!m) {
          bmp.close();
          return;
        }
        m.pushPreview(bmp, frame.step, frame.totalSteps);
      },
      () => {
        /* undecodable frame: ignore */
      },
    );
  }
}

export const engineSocket = new EngineSocket();
