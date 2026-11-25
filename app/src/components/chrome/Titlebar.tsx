import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { JobMode, WorkspaceId } from "../../shared/contract";
import { familyShortLabel } from "../../shared/families";
import { useEditStore } from "../../stores/edit";
import { useGenerateStore } from "../../stores/generate";
import { useJobStore, type ActiveJob } from "../../stores/job";
import { filterItems, useLibraryStore } from "../../stores/library";
import { useThreeStore } from "../../stores/three";
import { useUiStore } from "../../stores/ui";
import { formatCount } from "../../lib/format";

export const WORKSPACE_LABEL: Record<WorkspaceId, string> = { generate: "Generate", edit: "Edit", three: "3D", library: "Library" };

const EDIT_MODE_LABEL: Record<string, string> = { qwen_edit: "Smart edit", inpaint: "Inpaint", img2img: "Img2Img", remove_bg: "Remove background" };

/** The active-job fields the titlebar shows (progress, previews, stages… don't re-render it). */
type TitleJob = Pick<ActiveJob, "owner" | "mode" | "model" | "phase" | "step" | "totalSteps" | "batchSize" | "batchIndex">;

function jobDetail(job: TitleJob): string {
  if (job.owner === "edit") return EDIT_MODE_LABEL[job.mode as JobMode] ?? familyShortLabel(job.model);
  return familyShortLabel(job.model);
}

function phaseWord(job: TitleJob): string | null {
  switch (job.phase) {
    case "sampling":
      return null;
    case "loading":
      return "warming";
    case "enhancing":
      return "enhancing";
    case "encoding":
      return "encoding";
    case "decoding":
      return "decoding";
    case "processing":
      return "processing";
    case "saving":
    case "saved":
      return "saving";
    default:
      return "starting";
  }
}

/** Mounted only in the idle Library, so the titlebar doesn't filter 5,000 items on every library change elsewhere. */
function LibraryCount() {
  // Subscribe to the filter inputs only; selection / inspector changes never re-filter.
  const { items, filter, query, favoritesOnly } = useLibraryStore(
    useShallow((s) => ({ items: s.items, filter: s.filter, query: s.query, favoritesOnly: s.favoritesOnly })),
  );
  const libCount = useMemo(() => filterItems(items, filter, query, favoritesOnly).length, [items, filter, query, favoritesOnly]);
  return (
    <span>
      <span className="mono-sm">{formatCount(libCount)}</span> items
    </span>
  );
}

/** 40 px transparent drag region with the centred mode indicator; 138 px reserved for native caption buttons (§3.3). */
export function Titlebar() {
  const workspace = useUiStore((s) => s.workspace);
  const job = useJobStore(
    useShallow((s): TitleJob | null => {
      const a = s.active;
      return a
        ? { owner: a.owner, mode: a.mode, model: a.model, phase: a.phase, step: a.step, totalSteps: a.totalSteps, batchSize: a.batchSize, batchIndex: a.batchIndex }
        : null;
    }),
  );
  const genModel = useGenerateStore((s) => s.model);
  const editMode = useEditStore((s) => s.mode);
  const engine3d = useThreeStore((s) => s.engine);

  let title: string;
  let detail: string;
  let running = false;
  let counter: string | null = null;
  let phase: string | null = null;
  if (job) {
    running = true;
    title = WORKSPACE_LABEL[job.owner];
    detail = jobDetail(job);
    const w = phaseWord(job);
    if (w) phase = w;
    else counter = `${job.step}/${job.totalSteps}`;
    if (job.batchSize > 1) detail = `${detail} · ${job.batchIndex + 1} of ${job.batchSize}`;
  } else {
    title = WORKSPACE_LABEL[workspace];
    detail =
      workspace === "generate"
        ? familyShortLabel(genModel)
        : workspace === "edit"
          ? EDIT_MODE_LABEL[editMode]
          : workspace === "three"
            ? familyShortLabel(engine3d)
            : "";
  }

  return (
    <div
      className="drag relative flex h-[var(--titlebar-h)] shrink-0 items-center justify-center"
      style={{ paddingRight: "var(--caption-reserve)", zIndex: 40 }}
    >
      <div className="t-caption flex items-center gap-2 text-ink-3" aria-live="off">
        {running && <span aria-hidden className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />}
        <span className="text-ink-2">{title}</span>
        {(detail || (!job && workspace === "library")) && <span aria-hidden>{" — "}</span>}
        {!job && workspace === "library" ? (
          <LibraryCount />
        ) : (
          <span>{detail}</span>
        )}
        {counter && <span className="mono-sm ml-1.5 text-ink-2">{counter}</span>}
        {phase && <span className="ml-1.5">{phase}</span>}
      </div>
    </div>
  );
}
