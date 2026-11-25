import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Box, Brush, Copy, FolderOpen, Heart, RotateCcw, Trash2, X } from "lucide-react";
import type { OutputItem } from "../../shared/contract";
import { useDragStore } from "../../stores/drag";
import { STAGE_ORDER } from "../../stores/three";
import { useEngineStore } from "../../stores/engine";
import { useLibraryStore } from "../../stores/library";
import { copyImage, copySeed, copyText, deleteItems, makeIn3D, openHome, openInEdit, reusePromptAndSeed, reveal, sendToBlender, toggleFavorite } from "../../lib/actions";
import { formatCount, formatCreated, formatDims, formatDuration, formatMeters } from "../../lib/format";
import { imagePathOf, resolveAssetFile, thumbUrl } from "../../lib/images";
import { pushLayer } from "../../lib/layers";
import { toUrl } from "../../lib/studio";
import { BlenderIcon } from "../../components/ui/EmptyStateIcons";
import { IconButton } from "../../components/ui/IconButton";
import { Checker } from "../../components/ui/misc";

const MODE_LABEL: Record<string, string> = {
  t2i: "Text to image",
  qwen_edit: "Smart edit",
  inpaint: "Inpaint",
  img2img: "Img2Img",
  remove_bg: "Remove background",
  t23d: "Text to 3D",
  i23d: "Image to 3D",
};

/** Slide-over inspector, no scrim; the grid reflows beside it (§5.4.1). */
export function Inspector({ item, onClose, onStep }: { item: OutputItem; onClose(): void; onStep(dir: number): void }) {
  const blenderConnected = useEngineStore((s) => !!s.blender?.connected);
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => pushLayer(() => closeRef.current()), []);

  const p = item.params;
  const preview = item.kind === "3d" ? toUrl(item.previewPath) : toUrl(item.path);
  const fallback = thumbUrl(item);
  const rows: [string, ReactNode][] = [
    [
      "Seed",
      <button type="button" className="mono rounded px-0.5 text-left text-ink hover:bg-hover" onClick={() => void copySeed(p.seed)}>
        {p.seed}
      </button>,
    ],
    ["Model", item.model.label],
  ];
  if (item.width && item.height) rows.push(["Size", formatDims(item.width, item.height)]);
  if (p.steps != null) rows.push(["Steps", String(p.steps)]);
  if (p.cfg != null) rows.push(["CFG", p.cfg.toFixed(1)]);
  if (p.sampler) rows.push(["Sampler", `${p.sampler} / ${p.scheduler ?? "—"}`]);
  if (p.denoise != null) rows.push(["Denoise", p.denoise.toFixed(2)]);
  rows.push(["Mode", MODE_LABEL[item.mode] ?? item.mode]);
  rows.push(["Took", formatDuration(item.elapsedMs)]);
  rows.push(["Created", formatCreated(item.createdAt)]);
  if (item.mesh) {
    rows.push(["Engine", item.mesh.engine === "pixal3d" ? "Pixal3D" : "TRELLIS.2"]);
    rows.push(["Vertices", formatCount(item.mesh.vertices)]);
    rows.push(["Triangles", formatCount(item.mesh.triangles)]);
    rows.push(["Bounds", formatMeters(item.mesh.size)]);
  }

  return (
    <aside
      ref={ref}
      aria-label="Inspector"
      className="glass-strong anim-drawer flex h-full w-[var(--inspector-w)] shrink-0 flex-col rounded-l-[var(--r-xl)] border-r-0"
      onKeyDown={(e) => {
        if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          onStep(e.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="flex items-center justify-end gap-1 px-4 pt-4">
        <IconButton
          icon={Heart}
          label={item.favorite ? "Remove from favorites" : "Favorite"}
          shortcut="F"
          pressed={item.favorite}
          tone={item.favorite ? "accent" : "default"}
          iconClassName={item.favorite ? "fill-current" : ""}
          onClick={() => void toggleFavorite(item)}
        />
        <IconButton icon={Trash2} label="Delete" shortcut="Del" variant="danger" onClick={() => void deleteItems([item])} />
        <IconButton icon={X} label="Close" shortcut="Esc" onClick={onClose} tooltipSide="left" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6">
        <button
          type="button"
          draggable
          aria-label="Open in its workspace"
          onClick={() => openHome(item)}
          onDragStart={(e) =>
            useDragStore.getState().start(
              {
                kind: item.kind,
                path: imagePathOf(item) ?? item.path,
                previewUrl: preview || fallback,
                name: item.file,
                item,
              },
              e.clientX,
              e.clientY,
              e.dataTransfer,
            )
          }
          className="block overflow-hidden rounded-[var(--r-md)]"
        >
          {item.hasAlpha ? (
            <Checker className="rounded-[var(--r-md)]">
              <img src={preview || fallback} alt={p.prompt.slice(0, 200)} decoding="async" draggable={false} className="block w-full" />
            </Checker>
          ) : (
            <img src={preview || fallback} alt={p.prompt.slice(0, 200)} decoding="async" draggable={false} className="block w-full bg-sunken" />
          )}
        </button>

        <div className="flex flex-col gap-1.5">
          <InspectorAction icon={<RotateCcw size={15} strokeWidth={1.75} absoluteStrokeWidth />} label="Reuse prompt and seed" onClick={() => reusePromptAndSeed(item)} />
          {imagePathOf(item) && (
            <>
              <InspectorAction icon={<Brush size={15} strokeWidth={1.75} absoluteStrokeWidth />} label="Edit in canvas" onClick={() => openInEdit(item)} />
              <InspectorAction icon={<Box size={15} strokeWidth={1.75} absoluteStrokeWidth />} label="Make 3D" onClick={() => makeIn3D(item)} />
            </>
          )}
          {item.kind === "3d" && (
            <InspectorAction
              icon={<BlenderIcon size={15} colored={blenderConnected} />}
              label={blenderConnected ? "Send to Blender" : "Send to Blender (not running)"}
              disabled={!blenderConnected}
              onClick={() => void sendToBlender(item)}
            />
          )}
          {imagePathOf(item) && (
            <InspectorAction icon={<Copy size={15} strokeWidth={1.75} absoluteStrokeWidth />} label="Copy image" onClick={() => void copyImage(item)} />
          )}
          <InspectorAction icon={<FolderOpen size={15} strokeWidth={1.75} absoluteStrokeWidth />} label="Reveal in Explorer" onClick={() => void reveal(item)} />
        </div>

        {p.prompt && (
          <Block label="PROMPT" copy={p.prompt}>
            <p className="t-body m-0 select-text whitespace-pre-wrap text-ink" style={{ userSelect: "text" }}>
              {p.prompt}
            </p>
          </Block>
        )}
        {p.enhanced && p.enhancedPrompt && (
          <Block label="ENHANCED">
            <p className="t-body m-0 select-text whitespace-pre-wrap text-ink-2" style={{ userSelect: "text" }}>
              {p.enhancedPrompt}
            </p>
          </Block>
        )}

        <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-3 gap-y-2">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="t-caption text-ink-3">{k}</dt>
              <dd className="mono m-0 min-w-0 truncate text-ink">{v}</dd>
            </div>
          ))}
        </dl>

        {item.kind === "3d" && item.stages.length > 0 && (
          <div className="grid grid-cols-4 gap-2">
            {STAGE_ORDER.map((id) => {
              const s = item.stages.find((x) => x.id === id);
              const file = s ? resolveAssetFile(item, s.file) : null;
              return (
                <div key={id} className="flex flex-col items-center gap-1">
                  <div className="h-14 w-full overflow-hidden rounded-[var(--r-sm)] bg-sunken">
                    {file && <img src={toUrl(file)} alt={s?.label ?? id} decoding="async" className="h-full w-full object-cover" />}
                  </div>
                  <span className="t-caption text-ink-3">{s?.label ?? id}</span>
                </div>
              );
            })}
          </div>
        )}

        {p.negativePrompt && (
          <Block label="EXCLUDED">
            <p className="t-body m-0 text-ink-2">{p.negativePrompt}</p>
          </Block>
        )}
      </div>
    </aside>
  );
}

function InspectorAction({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="t-ui flex h-9 w-full items-center gap-2.5 rounded-[var(--r-sm)] bg-sunken px-3 text-left text-ink transition-colors duration-[var(--dur-instant)] hover:bg-hover disabled:opacity-40"
    >
      <span className="flex w-4 shrink-0 items-center justify-center text-ink-2">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function Block({ label, children, copy }: { label: string; children: ReactNode; copy?: string }) {
  return (
    <section className="group flex flex-col gap-1.5">
      <div className="flex h-5 items-center justify-between">
        <span className="t-micro text-ink-3">{label}</span>
        {copy && (
          <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <IconButton icon={Copy} label="Copy prompt" size={24} iconSize={12} onClick={() => void copyText(copy)} />
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/** The inspected item; the lookup re-runs only when the items or the inspected id change
    (not on every selection / filter / query update of the library store). */
export function useInspectedItem(): OutputItem | null {
  const items = useLibraryStore((s) => s.items);
  const id = useLibraryStore((s) => s.inspectedId);
  return useMemo(() => (id ? (items.find((i) => i.id === id) ?? null) : null), [items, id]);
}
