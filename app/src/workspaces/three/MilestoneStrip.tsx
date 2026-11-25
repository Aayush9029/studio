import { useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Stage3DId } from "../../shared/contract";
import { useDragStore } from "../../stores/drag";
import { useJobStore } from "../../stores/job";
import { STAGE_LABEL, STAGE_ORDER, useThreeStore } from "../../stores/three";
import { resolveAssetFile } from "../../lib/images";
import { Popover } from "../../components/ui/Popover";
import { Checker } from "../../components/ui/misc";
import { viewportBus } from "./viewportBus";

/** Vertical left-centered milestone rail of 7 compact tiles joined by vertical hairlines. */
export function MilestoneStrip() {
  const visible = useThreeStore((s) => s.stripVisible);
  if (!visible) return null;
  return (
    <ol className="glass anim-enter m-0 flex list-none flex-col items-center rounded-[20px] px-1.5 py-2" aria-label="Progress">
      {STAGE_ORDER.map((id, i) => (
        <li key={id} className="flex flex-col items-center">
          {i > 0 && <span aria-hidden className="my-0.5 h-2 w-px bg-hairline" />}
          <Tile id={id} />
        </li>
      ))}
    </ol>
  );
}

function Tile({ id }: { id: Stage3DId }) {
  const m = useThreeStore((s) => s.milestones[id]);
  const inspected = useThreeStore((s) => s.inspectStage === id);
  const current = useThreeStore((s) => s.current);
  const livePreviewUrl = useJobStore((s) => (s.livePreviewOwner === "three" && s.active?.stages[s.livePreviewStage]?.id === id ? s.livePreviewUrl : null));
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const label = STAGE_LABEL[id];
  const st = m.status;
  const counter = st === "active" && m.total > 0 ? `${m.step}/${m.total}` : null;
  const displayUrl = st === "done" && m.imageUrl ? m.imageUrl : livePreviewUrl;

  const ring = inspected
    ? "0 0 0 2px var(--accent)"
    : st === "active"
      ? "0 0 0 1.5px var(--accent)"
      : st === "error"
        ? "0 0 0 1.5px var(--danger)"
        : "inset 0 0 0 1px var(--border-hairline)";

  const onClick = () => {
    if (id === "mesh" && st === "done") {
      useThreeStore.getState().setInspectStage(null);
      viewportBus.reframe();
      return;
    }
    if (st === "done" && m.imageUrl) {
      useThreeStore.getState().setInspectStage(inspected ? null : id);
    }
  };

  const assetRel = current?.stages.find((s) => s.id === id)?.file ?? null;
  const absPath = current && assetRel ? resolveAssetFile(current, assetRel) : null;

  const img = displayUrl ? (
    id === "cutout" ? (
      <Checker className="h-full w-full">
        <img src={displayUrl} alt="" draggable={false} className="anim-fade h-full w-full object-contain" />
      </Checker>
    ) : (
      <img src={displayUrl} alt="" draggable={false} className="anim-fade h-full w-full object-cover" />
    )
  ) : null;

  return (
    <div className="flex w-[52px] flex-col items-center gap-0.5">
      <button
        ref={ref}
        type="button"
        draggable={Boolean(st === "done" && displayUrl && absPath)}
        aria-label={`${label}: ${st}`}
        aria-pressed={inspected}
        onPointerEnter={() => st === "done" && m.imageUrl && setHover(true)}
        onPointerLeave={() => setHover(false)}
        onClick={onClick}
        onDragStart={(e) => {
          if (!displayUrl || !absPath) return;
          useDragStore.getState().start({ kind: "image", path: absPath, previewUrl: displayUrl, name: `${label}.webp` }, e.clientX, e.clientY, e.dataTransfer);
        }}
        className={`relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-[var(--r-sm)] bg-sunken ${st === "active" && !livePreviewUrl ? "shimmer" : ""}`}
        style={{ boxShadow: ring }}
      >
        {img}
        {st === "done" && !m.imageUrl && <Check size={14} strokeWidth={1.75} absoluteStrokeWidth className="text-sage" />}
        {st === "skipped" && <span aria-hidden className="h-px w-3 bg-ink-4" />}
      </button>
      <span className={`leading-tight ${counter ? "mono-sm text-[10px]" : "t-caption text-[10px]"} ${st === "active" || inspected ? "text-accent" : st === "done" ? "text-ink-2" : "text-ink-4"}`}>
        {counter ?? label}
      </span>
      <Popover open={hover} onClose={() => setHover(false)} anchor={ref} placement="right" width={300} padding={6} noFocus ariaLabel={label}>
        {m.imageUrl &&
          (id === "cutout" ? (
            <Checker className="rounded-[var(--r-sm)]">
              <img src={m.imageUrl} alt={label} className="block w-full rounded-[var(--r-sm)]" />
            </Checker>
          ) : (
            <img src={m.imageUrl} alt={label} className="block w-full rounded-[var(--r-sm)]" />
          ))}
      </Popover>
    </div>
  );
}
