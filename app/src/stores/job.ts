/* Single active job (§11.2). Preview bitmaps stay off React state; lightweight blob URLs mirror PREV for thumbnails. */

import { create } from "zustand";
import type {
  FamilyId,
  JobMode,
  JobPhase,
  JobProgressEvent,
  JobStartedEvent,
  OutputKind,
  StageInfo,
  WorkspaceId,
} from "../shared/contract";

export interface ActiveJob {
  jobId: string;
  owner: WorkspaceId;
  kind: OutputKind;
  mode: JobMode;
  model: FamilyId;
  seed: number;
  batchSize: number;
  width: number | null;
  height: number | null;
  stages: StageInfo[];
  stageIndex: number;
  phase: JobPhase | null;
  step: number;
  totalSteps: number;
  progress: number;
  batchIndex: number;
  enhancedPrompt: string | null;
}

interface JobState {
  active: ActiveJob | null;
  /** Set right before a generate request so `job.started` can be attributed even if it beats the 202. */
  pendingOwner: WorkspaceId | null;
  /** Workspace whose request is in flight (button shows a pending state). */
  submitting: WorkspaceId | null;
  /** Latest binary PREV JPEG object URL for live thumbnails (filmstrip, 3D milestones, queue drawer). */
  livePreviewUrl: string | null;
  livePreviewOwner: WorkspaceId | null;
  livePreviewStage: number;

  setPending(ws: WorkspaceId | null): void;
  setSubmitting(ws: WorkspaceId | null): void;
  start(ev: JobStartedEvent, owner: WorkspaceId): void;
  progress(ev: JobProgressEvent): void;
  setLivePreview(owner: WorkspaceId, jpeg: Blob, stageIndex: number): void;
  end(jobId: string): void;
}

function revokePreview(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}

export const useJobStore = create<JobState>()((set) => ({
  active: null,
  pendingOwner: null,
  submitting: null,
  livePreviewUrl: null,
  livePreviewOwner: null,
  livePreviewStage: 0,

  setPending: (ws) => set({ pendingOwner: ws }),
  setSubmitting: (ws) => set({ submitting: ws }),
  start: (ev, owner) =>
    set((s) => {
      const prev = s.active && s.active.jobId === ev.jobId ? s.active : null;
      if (!prev && s.livePreviewUrl) revokePreview(s.livePreviewUrl);
      return {
        pendingOwner: null,
        submitting: null,
        ...(prev ? {} : { livePreviewUrl: null, livePreviewOwner: owner, livePreviewStage: ev.stageIndex }),
        active: {
          jobId: ev.jobId,
          owner: prev?.owner ?? owner,
          kind: ev.kind,
          mode: ev.mode,
          model: ev.model,
          seed: ev.seed,
          batchSize: ev.batchSize,
          width: ev.width,
          height: ev.height,
          stages: ev.stages,
          stageIndex: ev.stageIndex,
          phase: prev?.phase ?? null,
          step: prev?.step ?? 0,
          totalSteps: prev?.totalSteps ?? 0,
          progress: prev?.progress ?? 0,
          batchIndex: prev?.batchIndex ?? 0,
          enhancedPrompt: prev?.enhancedPrompt ?? null,
        },
      };
    }),
  progress: (ev) =>
    set((s) => {
      const a = s.active;
      if (!a || a.jobId !== ev.jobId) return s;
      return {
        active: {
          ...a,
          stageIndex: ev.stageIndex,
          phase: ev.phase,
          step: ev.step,
          totalSteps: ev.totalSteps,
          progress: Math.max(a.progress, ev.progress),
          batchIndex: ev.batchIndex,
          enhancedPrompt: ev.enhancedPrompt ?? a.enhancedPrompt,
        },
      };
    }),
  setLivePreview: (owner, jpeg, stageIndex) =>
    set((s) => {
      if (!s.active || s.active.owner !== owner) return s;
      const url = URL.createObjectURL(jpeg);
      revokePreview(s.livePreviewUrl);
      return { livePreviewUrl: url, livePreviewOwner: owner, livePreviewStage: stageIndex };
    }),
  end: (jobId) =>
    set((s) => {
      if (s.active?.jobId !== jobId) return s;
      revokePreview(s.livePreviewUrl);
      return { active: null, livePreviewUrl: null, livePreviewOwner: null, livePreviewStage: 0 };
    }),
}));

export function ownerForKind(kind: OutputKind): WorkspaceId {
  return kind === "image" ? "generate" : kind === "edit" ? "edit" : "three";
}
