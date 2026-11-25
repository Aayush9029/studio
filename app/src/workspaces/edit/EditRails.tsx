import { useEffect, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import {
  Brush,
  ChevronsLeftRight,
  CircleDashed,
  CircleSlash,
  Columns2,
  Contrast,
  Eraser,
  Eye,
  EyeOff,
  MousePointer2,
  Plus,
  Redo2,
  Scan,
  Scissors,
  Undo2,
  X,
} from "lucide-react";
import { hasStudioDrag, useDragStore } from "../../stores/drag";
import { useEditStore, type EditTool } from "../../stores/edit";
import { engineHttp, toStudioError } from "../../lib/engine/http";
import { whisperError } from "../../lib/errors";
import { fetchBlob, imageFileFromEvent, pickImages } from "../../lib/images";
import { toUrl } from "../../lib/studio";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { Tooltip } from "../../components/ui/Tooltip";
import { RailDivider } from "../../components/ui/misc";
import type { EditorDocument } from "./EditorDocument";

/* ───────── Tool rail (§5.2.2) ───────── */

const TOOLS: { id: EditTool; icon: typeof Brush; label: string; key: string }[] = [
  { id: "select", icon: MousePointer2, label: "Select / Pan", key: "V" },
  { id: "brush", icon: Brush, label: "Paintbrush", key: "B" },
  { id: "mask", icon: CircleDashed, label: "Mask brush", key: "M" },
  { id: "eraser", icon: Eraser, label: "Eraser", key: "E" },
];

export function ToolRail({
  doc,
  disabled,
  busy,
  onRemoveBg,
}: {
  doc: EditorDocument;
  disabled: boolean;
  busy: boolean;
  onRemoveBg(): void;
}) {
  const tool = useEditStore((s) => s.tool);
  const setTool = useEditStore((s) => s.setTool);
  const maskEmpty = useEditStore((s) => s.doc.maskEmpty);
  const maskVisible = useEditStore((s) => s.maskVisible);
  const setMaskVisible = useEditStore((s) => s.setMaskVisible);
  return (
    <div
      className={`glass pointer-events-auto flex w-11 flex-col items-center gap-1 rounded-full py-1.5 transition-opacity ${disabled ? "pointer-events-none opacity-40" : ""}`}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Tools"
    >
      {TOOLS.map((t) => (
        <IconButton
          key={t.id}
          icon={t.icon}
          label={t.label}
          shortcut={t.id === "select" ? "V · Space" : t.key}
          size={36}
          tooltipSide="right"
          active={tool === t.id}
          pressed={tool === t.id}
          onClick={() => setTool(t.id)}
        />
      ))}
      <RailDivider />
      <IconButton icon={Contrast} label="Invert mask" shortcut="Ctrl+I" size={36} tooltipSide="right" disabled={maskEmpty} onClick={() => doc.invertMask()} />
      <IconButton icon={CircleSlash} label="Clear mask" shortcut="Ctrl+Shift+X" size={36} tooltipSide="right" disabled={maskEmpty} onClick={() => doc.clearMask()} />
      <IconButton
        icon={maskVisible ? Eye : EyeOff}
        label={maskVisible ? "Hide mask" : "Show mask"}
        shortcut="H"
        size={36}
        tooltipSide="right"
        disabled={maskEmpty}
        pressed={!maskVisible}
        onClick={() => setMaskVisible(!maskVisible)}
      />
      <RailDivider />
      <IconButton icon={Scissors} label="Remove background" shortcut="Ctrl+Shift+B" size={36} tooltipSide="right" disabled={busy} onClick={onRemoveBg} />
    </div>
  );
}

/* ───────── Vertical view cluster on bottom-left (keeps top BrushBar clear) ───────── */

export function ViewCluster({ doc, disabled }: { doc: EditorDocument; disabled: boolean }) {
  const canUndo = useEditStore((s) => s.doc.canUndo);
  const canRedo = useEditStore((s) => s.doc.canRedo);
  const zoom = useEditStore((s) => s.doc.zoom);
  const hasBefore = useEditStore((s) => s.doc.hasBefore);
  const compare = useEditStore((s) => s.compare);
  const setCompare = useEditStore((s) => s.setCompare);
  const zoomRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  return (
    <div
      className={`glass pointer-events-auto flex w-11 flex-col items-center gap-0.5 rounded-full py-1.5 ${disabled ? "pointer-events-none opacity-40" : ""}`}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="View"
    >
      <IconButton icon={Undo2} label="Undo" shortcut="Ctrl+Z" size={34} tooltipSide="right" disabled={!canUndo} onClick={() => doc.undo()} />
      <IconButton icon={Redo2} label="Redo" shortcut="Ctrl+Y" size={34} tooltipSide="right" disabled={!canRedo} onClick={() => doc.redo()} />
      <RailDivider />
      <Tooltip label="Zoom presets" side="right">
        <button
          ref={zoomRef}
          type="button"
          aria-label="Zoom"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
          className="mono-sm h-7 w-9 rounded-full text-center text-[10px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          {Math.round(zoom * 100)}%
        </button>
      </Tooltip>
      <IconButton icon={Scan} label="Fit" shortcut="Ctrl+0" size={34} tooltipSide="right" onClick={() => doc.fit()} />
      <RailDivider />
      <IconButton
        icon={Columns2}
        label="Before / After"
        shortcut="\"
        size={34}
        tooltipSide="right"
        disabled={!hasBefore}
        active={compare}
        pressed={compare}
        onClick={() => setCompare(!compare)}
      />
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        anchor={zoomRef}
        placement="right"
        align="end"
        width={180}
        ariaLabel="Zoom"
        items={[
          { id: "fit", label: "Fit", shortcut: "Ctrl+0", onSelect: () => doc.fit() },
          { id: "100", label: "100%", shortcut: "Ctrl+Alt+0", onSelect: () => doc.setZoom(1) },
          { id: "200", label: "200%", onSelect: () => doc.setZoom(2) },
          { id: "400", label: "400%", onSelect: () => doc.setZoom(4) },
        ]}
      />
    </div>
  );
}

/* ───────── Reference strip (§5.2.5) ───────── */

async function uploadReference(src: { blob: Blob | null; url: string; name: string }) {
  const blob = src.blob ?? (await fetchBlob(src.url));
  const res = await engineHttp.uploadFile(blob, src.name || "reference.png");
  return { id: res.id, path: res.path, url: URL.createObjectURL(blob) };
}

export function ReferenceStrip({ doc, contentVersion, visible }: { doc: EditorDocument; contentVersion: number; visible: boolean }) {
  const refs = useEditStore((s) => s.references);
  const setRef = useEditStore((s) => s.setReference);
  const thumb = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    // Pixel changes only: pans and zooms never re-blit the 2048² document into the thumbnail.
    if (thumb.current && visible) doc.drawThumbnail(thumb.current);
  }, [doc, contentVersion, visible]);

  const fill = async (slot: number, src: { blob: Blob | null; url: string; name: string }) => {
    setBusy(slot);
    try {
      const r = await uploadReference(src);
      setRef(slot, r);
    } catch (e) {
      whisperError(toStudioError(e));
    } finally {
      setBusy(null);
    }
  };

  const onDrop = (slot: number) => (e: DragEvent) => {
    const f = imageFileFromEvent(e.dataTransfer);
    if (f) {
      e.preventDefault();
      e.stopPropagation();
      useDragStore.getState().end();
      void fill(slot, { blob: f, url: "", name: f.name });
      return;
    }
    const drag = useDragStore.getState().item;
    if (drag) {
      e.preventDefault();
      e.stopPropagation();
      useDragStore.getState().end();
      void fill(slot, { blob: null, url: toUrl(drag.path), name: drag.name });
    }
  };

  return (
    <div
      className={`glass absolute flex flex-col gap-2 rounded-[18px] p-2 transition-opacity duration-[var(--dur-fast)] ${visible ? "" : "pointer-events-none opacity-0"}`}
      style={{ right: 16, top: "50%", transform: "translateY(-50%)", zIndex: 20 }}
      aria-label="Reference images"
      aria-hidden={!visible}
    >
      <div className="relative h-16 w-16 overflow-hidden rounded-[var(--r-md)] bg-sunken">
        <canvas ref={thumb} width={128} height={128} className="h-full w-full" aria-label="Image 1: the canvas" />
        <span className="mono-sm glass absolute bottom-1 left-1 rounded-full px-1.5 text-ink">1</span>
      </div>
      {refs.map((r, i) => (
        <div
          key={i}
          className="group relative h-16 w-16 overflow-hidden rounded-[var(--r-md)]"
          onDragOver={(e) => {
            if (hasStudioDrag(e.dataTransfer)) {
              e.preventDefault();
              useDragStore.getState().setHoverTarget(`Reference ${i + 2}`);
            }
          }}
          onDragLeave={() => useDragStore.getState().setHoverTarget(null)}
          onDrop={onDrop(i)}
          onPaste={(e) => {
            const f = imageFileFromEvent(e.clipboardData);
            if (f) {
              e.preventDefault();
              e.stopPropagation();
              void fill(i, { blob: f, url: "", name: f.name });
            }
          }}
        >
          {r ? (
            <>
              <img src={r.url} alt={`Reference ${i + 2}`} className="h-full w-full object-cover" draggable={false} />
              <span className="mono-sm glass absolute bottom-1 left-1 rounded-full px-1.5 text-ink">{i + 2}</span>
              <span className="absolute right-0.5 top-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <IconButton icon={X} label="Remove reference" variant="glass" size={20} iconSize={12} onClick={() => setRef(i, null)} />
              </span>
            </>
          ) : (
            <button
              type="button"
              aria-label={`Add reference image ${i + 2}`}
              onClick={async () => {
                const [p] = await pickImages(false);
                if (p) void fill(i, p);
              }}
              className={`flex h-full w-full items-center justify-center bg-sunken text-ink-4 hover:bg-hover hover:text-ink-2 ${busy === i ? "shimmer" : ""}`}
            >
              <Plus size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ───────── Before / After divider (§5.2.4) ───────── */

export function CompareOverlay({ rect, split, onSplit }: { rect: { x: number; y: number; w: number; h: number }; split: number; onSplit(v: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = (e: RPointerEvent) => {
    const el = ref.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const set = (cx: number) => {
      const r = el.getBoundingClientRect();
      onSplit((cx - r.left) / r.width);
    };
    set(e.clientX);
    const move = (ev: PointerEvent) => set(ev.clientX);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div ref={ref} className="absolute" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: 15, cursor: "ew-resize" }} onPointerDown={drag}>
      <span className="t-caption glass absolute left-3 top-3 rounded-full px-2.5 py-1 text-ink">Before</span>
      <span className="t-caption glass absolute right-3 top-3 rounded-full px-2.5 py-1 text-ink">After</span>
      <div className="absolute inset-y-0 w-px bg-on-accent" style={{ left: `${split * 100}%`, boxShadow: "0 0 0 0.5px var(--border-strong)" }}>
        <span
          role="slider"
          tabIndex={0}
          aria-label="Before and after"
          aria-valuenow={Math.round(split * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              e.stopPropagation();
              onSplit(split + (e.key === "ArrowLeft" ? -0.02 : 0.02));
            }
          }}
          className="glass absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-ink"
        >
          <ChevronsLeftRight size={14} strokeWidth={1.75} absoluteStrokeWidth />
        </span>
      </div>
    </div>
  );
}
