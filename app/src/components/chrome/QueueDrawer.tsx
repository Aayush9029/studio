/* Slide-over queue drawer showing the active job and queued items (move, cancel, remove). */

import { ArrowDown, ArrowUp, Square, Trash2, X } from "lucide-react";
import type { WorkspaceId } from "../../shared/contract";
import { useJobStore } from "../../stores/job";
import { useQueueStore } from "../../stores/queue";
import { cancelActiveJob } from "../../lib/engine/jobs";
import { Drawer } from "../ui/Drawer";
import { EmptyQueueIcon } from "../ui/EmptyStateIcons";
import { IconButton } from "../ui/IconButton";
import { Pill } from "../ui/Pill";
import { EmptyState } from "../ui/misc";

const WS_LABEL: Record<WorkspaceId, string> = {
  generate: "Generate",
  edit: "Edit",
  three: "3D",
  library: "Library",
};

export function QueueDrawer() {
  const open = useQueueStore((s) => s.drawerOpen);
  const close = () => useQueueStore.getState().setDrawerOpen(false);
  const items = useQueueStore((s) => s.items);
  const remove = useQueueStore((s) => s.remove);
  const move = useQueueStore((s) => s.move);
  const clear = useQueueStore((s) => s.clear);
  const active = useJobStore((s) => s.active);
  const livePreviewUrl = useJobStore((s) => s.livePreviewUrl);

  const empty = !active && items.length === 0;

  return (
    <Drawer
      open={open}
      onClose={close}
      width="400px"
      ariaLabel="Queue"
      title={<h2 className="t-title m-0 text-ink">Queue</h2>}
      footer={
        items.length > 0 ? (
          <div className="flex items-center justify-between">
            <span className="mono-sm text-ink-3">{items.length} queued</span>
            <Pill tone="danger" icon={Trash2} onClick={clear}>
              Clear queue
            </Pill>
          </div>
        ) : null
      }
    >
      {empty ? (
        <div className="flex flex-1 items-center justify-center py-12">
          <EmptyState
            icon={<EmptyQueueIcon size={56} className="text-ink-3" />}
            lead="Nothing queued."
            sub="Submit more while generating to line them up here."
          />
        </div>
      ) : (
        <div className="flex flex-col gap-5 pt-2">
          {active && (
            <section className="flex flex-col gap-2">
              <span className="t-micro text-ink-3">RUNNING NOW</span>
              <div className="flex items-center gap-3 rounded-[var(--r-md)] bg-sunken p-3">
                <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[var(--r-sm)] bg-active">
                  {livePreviewUrl ? (
                    <img src={livePreviewUrl} alt="Live preview" className="h-full w-full object-cover" draggable={false} />
                  ) : (
                    <div className="shimmer h-full w-full" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="t-ui truncate text-ink">{WS_LABEL[active.owner]}</span>
                    <span className="mono-sm text-ink-2">
                      {active.phase === "sampling" && active.totalSteps > 0
                        ? `${active.step}/${active.totalSteps}`
                        : `${Math.round(active.progress * 100)}%`}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-active">
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-300"
                      style={{ width: `${Math.max(4, Math.round(active.progress * 100))}%` }}
                    />
                  </div>
                </div>
                <IconButton
                  icon={Square}
                  label="Stop"
                  variant="danger"
                  size={30}
                  iconSize={12}
                  iconClassName="fill-current"
                  onClick={() => void cancelActiveJob()}
                />
              </div>
            </section>
          )}

          {items.length > 0 && (
            <section className="flex flex-col gap-2">
              <span className="t-micro text-ink-3">UP NEXT ({items.length})</span>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {items.map((q, idx) => (
                  <li key={q.id} className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-sunken p-2.5">
                    <span className="mono-sm flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent font-semibold">
                      {idx + 1}
                    </span>
                    {q.previewUrl && (
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-[var(--r-sm)] bg-active">
                        <img src={q.previewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="t-ui m-0 line-clamp-2 text-ink">{q.label || "(Untitled job)"}</p>
                      <span className="mono-sm block truncate text-ink-3">
                        {WS_LABEL[q.owner]} · {q.modelLabel}
                        {q.meta ? ` · ${q.meta}` : ""}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <IconButton icon={ArrowUp} label="Move up" size={26} iconSize={13} disabled={idx === 0} onClick={() => move(q.id, -1)} />
                      <IconButton icon={ArrowDown} label="Move down" size={26} iconSize={13} disabled={idx === items.length - 1} onClick={() => move(q.id, 1)} />
                      <IconButton icon={X} label="Remove from queue" variant="danger" size={26} iconSize={13} onClick={() => remove(q.id)} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
