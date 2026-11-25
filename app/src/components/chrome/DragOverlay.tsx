/* Global floating cursor thumbnail overlay during internal Studio drags. */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Box, Image as ImageIcon } from "lucide-react";
import { useDragStore } from "../../stores/drag";

export function DragOverlay() {
  const item = useDragStore((s) => s.item);
  const x = useDragStore((s) => s.x);
  const y = useDragStore((s) => s.y);
  const hoverTarget = useDragStore((s) => s.hoverTarget);

  useEffect(() => {
    if (!item) return;
    const onDragOver = (e: DragEvent) => {
      if (e.clientX || e.clientY) useDragStore.getState().move(e.clientX, e.clientY);
    };
    const finish = () => useDragStore.getState().end();
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", finish, true);
    window.addEventListener("dragend", finish, true);
    window.addEventListener("pointerup", finish, true);
    return () => {
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", finish, true);
      window.removeEventListener("dragend", finish, true);
      window.removeEventListener("pointerup", finish, true);
    };
  }, [item]);

  if (!item) return null;
  const px = Math.min(window.innerWidth - 96, Math.max(8, x + 16));
  const py = Math.min(window.innerHeight - 96, Math.max(8, y + 16));

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 flex items-center gap-2 rounded-[var(--r-md)] p-1.5 glass-strong"
      style={{ transform: `translate3d(${px}px, ${py}px, 0)`, zIndex: 999 }}
    >
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[var(--r-sm)] bg-sunken">
        {item.previewUrl ? (
          <img src={item.previewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-ink-3">
            {item.kind === "3d" ? <Box size={18} /> : <ImageIcon size={18} />}
          </span>
        )}
      </div>
      {hoverTarget && (
        <span className="t-caption max-w-[140px] truncate pr-1.5 text-ink">{hoverTarget}</span>
      )}
    </div>,
    document.body,
  );
}
