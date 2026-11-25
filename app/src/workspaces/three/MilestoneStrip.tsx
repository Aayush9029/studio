import { useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Stage3DId } from "../../shared/contract";
import { STAGE_LABEL, STAGE_ORDER, useThreeStore } from "../../stores/three";
import { Popover } from "../../components/ui/Popover";
import { viewportBus } from "./viewportBus";

/** Seven 56 px milestone tiles joined by hairline connectors (§5.3.2). */
export function MilestoneStrip() {
  const visible = useThreeStore((s) => s.stripVisible);
  if (!visible) return null;
  return (
    <ol className="anim-enter m-0 flex list-none items-start p-0" aria-label="Progress">
      {STAGE_ORDER.map((id, i) => (
        <li key={id} className="flex items-start">
          {i > 0 && <span aria-hidden className="mt-7 h-px w-4 bg-hairline" />}
          <Tile id={id} />
        </li>
      ))}
    </ol>
  );
}

/** Subscribes to its own milestone only: a step on one stage re-renders one tile (and its popover). */
function Tile({ id }: { id: Stage3DId }) {
  const m = useThreeStore((s) => s.milestones[id]);
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const label = STAGE_LABEL[id];
  const st = m.status;
  const counter = st === "active" && m.total > 0 ? `${m.step}/${m.total}` : null;
  const ring =
    st === "active" ? "0 0 0 1.5px var(--accent)" : st === "error" ? "0 0 0 1.5px var(--danger)" : "inset 0 0 0 1px var(--border-hairline)";
  return (
    <div className="flex w-14 flex-col items-center gap-1.5">
      <button
        ref={ref}
        type="button"
        aria-label={`${label}: ${st}`}
        onPointerEnter={() => st === "done" && m.imageUrl && setHover(true)}
        onPointerLeave={() => setHover(false)}
        onClick={() => id === "mesh" && st === "done" && viewportBus.reframe()}
        className={`relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-sunken ${st === "active" ? "shimmer" : ""}`}
        style={{ boxShadow: ring }}
      >
        {st === "done" && m.imageUrl && <img src={m.imageUrl} alt="" draggable={false} className="anim-fade h-full w-full object-cover" />}
        {st === "done" && !m.imageUrl && <Check size={16} strokeWidth={1.75} absoluteStrokeWidth className="text-sage" />}
        {st === "skipped" && <span aria-hidden className="h-px w-3 bg-ink-4" />}
      </button>
      <span className={`${counter ? "mono-sm" : "t-caption"} ${st === "active" ? "text-ink" : st === "done" ? "text-ink-2" : "text-ink-4"}`}>{counter ?? label}</span>
      <Popover open={hover} onClose={() => setHover(false)} anchor={ref} placement="bottom" width={320} padding={6} noFocus ariaLabel={label}>
        {m.imageUrl && <img src={m.imageUrl} alt={label} className="block w-full rounded-[var(--r-sm)]" />}
      </Popover>
    </div>
  );
}
