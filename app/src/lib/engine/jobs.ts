/* Routes job events, supports job queuing, and drains queued requests sequentially (§11.3). */

import type {
  JobCancelledEvent,
  JobCompletedEvent,
  JobErrorEvent,
  JobProgressEvent,
  JobStagePreviewEvent,
  JobStartedEvent,
  OutputItem,
  WorkspaceId,
} from "../../shared/contract";
import { getMurmuration } from "../../murmuration";
import { enginePhase, useEngineStore } from "../../stores/engine";
import { ownerForKind, useJobStore } from "../../stores/job";
import { useLibraryStore } from "../../stores/library";
import { useQueueStore, type QueuedJob } from "../../stores/queue";
import { useUiStore } from "../../stores/ui";
import { whisperError } from "../errors";
import { loadLibrary } from "../libraryScan";
import { engineHttp, toStudioError } from "./http";

export interface JobHost {
  started?(e: JobStartedEvent): void;
  progress?(e: JobProgressEvent): void;
  stagePreview?(e: JobStagePreviewEvent): void;
  completed?(e: JobCompletedEvent): void;
  error?(e: JobErrorEvent): void;
  cancelled?(e: JobCancelledEvent): void;
}

const hosts: Partial<Record<WorkspaceId, JobHost>> = {};

export function registerJobHost(ws: WorkspaceId, host: JobHost): () => void {
  hosts[ws] = host;
  return () => {
    if (hosts[ws] === host) delete hosts[ws];
  };
}

type JobEvent = JobStartedEvent | JobProgressEvent | JobStagePreviewEvent | JobCompletedEvent | JobErrorEvent | JobCancelledEvent;

/** Record newly created outputs immediately and generate missing 512 px grid thumbnails. */
function recordOutputs(outputs: OutputItem[]): void {
  if (!outputs.length) return;
  useLibraryStore.getState().prepend(outputs);
  if (outputs.some((o) => !o.thumbPath)) loadLibrary();
}

export function handleJobEvent(ev: JobEvent): void {
  const js = useJobStore.getState();
  if (ev.type === "job.started") {
    const owner = js.active?.jobId === ev.jobId ? js.active.owner : (js.pendingOwner ?? ownerForKind(ev.kind));
    js.start(ev, owner);
    hosts[owner]?.started?.(ev);
    return;
  }
  const active = js.active;
  if (!active || active.jobId !== ev.jobId) {
    // Outputs of a job we never saw start still belong in the Library.
    if (ev.type === "job.completed" || ev.type === "job.error" || ev.type === "job.cancelled") {
      recordOutputs(ev.outputs);
    }
    return;
  }
  const host = hosts[active.owner];
  switch (ev.type) {
    case "job.progress":
      js.progress(ev);
      if (ev.output) recordOutputs([ev.output]);
      host?.progress?.(ev);
      break;
    case "job.stage_preview":
      host?.stagePreview?.(ev);
      break;
    case "job.completed":
      recordOutputs(ev.outputs);
      js.end(ev.jobId);
      host?.completed?.(ev);
      window.setTimeout(drainQueue, 0);
      break;
    case "job.error":
      recordOutputs(ev.outputs);
      js.end(ev.jobId);
      host?.error?.(ev);
      whisperError(ev.error, active.model);
      window.setTimeout(drainQueue, 0);
      break;
    case "job.cancelled":
      recordOutputs(ev.outputs);
      js.end(ev.jobId);
      host?.cancelled?.(ev);
      window.setTimeout(drainQueue, 0);
      break;
  }
}

/**
 * Reconnect reconciliation (§4): called with the engine's authoritative `telemetry.activeJobId`.
 */
export function reconcileActiveJob(engineActiveJobId: string | null | undefined): boolean {
  const js = useJobStore.getState();
  const active = js.active;
  if (!active || active.jobId === (engineActiveJobId ?? null)) return false;
  const { owner, jobId } = active;
  js.end(jobId);
  const synthetic: JobCancelledEvent = {
    type: "job.cancelled",
    jobId,
    stageIndex: null,
    elapsedMs: 0,
    outputs: [],
    ts: Date.now(),
    seq: -1,
  };
  try {
    hosts[owner]?.cancelled?.(synthetic);
  } catch {
    /* a host's UI reset must not block reconciliation */
  }
  void getMurmuration(owner)?.cancel();
  loadLibrary();
  window.setTimeout(drainQueue, 0);
  return true;
}

/** Submits a job for `owner`. Attribution is set before the request so a fast `job.started` binds correctly. */
export async function submitJob(owner: WorkspaceId, send: () => Promise<{ jobId: string }>): Promise<string | null> {
  const js = useJobStore.getState();
  if (js.active || js.submitting) {
    useUiStore.getState().say("Still working on the last one.", { tone: "error" });
    return null;
  }
  js.setPending(owner);
  js.setSubmitting(owner);
  try {
    const { jobId } = await send();
    return jobId;
  } catch (e) {
    js.setPending(null);
    whisperError(toStudioError(e));
    return null;
  } finally {
    if (useJobStore.getState().submitting === owner) useJobStore.getState().setSubmitting(null);
  }
}

/** Submits immediately when idle, or enqueues cleanly to run in order once current work finishes. */
export async function enqueueOrSubmit(entry: Omit<QueuedJob, "id" | "createdAt">): Promise<void> {
  const js = useJobStore.getState();
  const q = useQueueStore.getState();
  const ready = enginePhase(useEngineStore.getState()) === "ready";
  if (ready && !js.active && !js.submitting && q.items.length === 0) {
    try {
      await submitJob(entry.owner, entry.execute);
    } finally {
      entry.cleanup?.();
    }
    return;
  }
  const pos = q.enqueue(entry);
  useUiStore.getState().say(`Queued #${pos}`, {
    action: { label: "View queue", run: () => useQueueStore.getState().setDrawerOpen(true) },
  });
}

let draining = false;

/** Starts the next queued job when the engine is ready and idle. */
export function drainQueue(): void {
  if (draining) return;
  const js = useJobStore.getState();
  if (js.active || js.submitting) return;
  if (enginePhase(useEngineStore.getState()) !== "ready") return;
  const next = useQueueStore.getState().shift();
  if (!next) return;
  draining = true;
  void submitJob(next.owner, next.execute)
    .then((jobId) => {
      if (!jobId) window.setTimeout(drainQueue, 150);
    })
    .finally(() => {
      draining = false;
      next.cleanup?.();
    });
}

// Drain automatically when the engine reaches ready (e.g. queued during warmup/startup).
useEngineStore.subscribe((s, p) => {
  if (enginePhase(s) === "ready" && enginePhase(p) !== "ready" && useQueueStore.getState().items.length > 0) {
    window.setTimeout(drainQueue, 0);
  }
});

export async function cancelActiveJob(): Promise<void> {
  const a = useJobStore.getState().active;
  try {
    await engineHttp.cancel(a ? { jobId: a.jobId } : {});
  } catch (e) {
    whisperError(toStudioError(e));
  }
}
