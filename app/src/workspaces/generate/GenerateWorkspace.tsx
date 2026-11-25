import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import { flushSync } from "react-dom";
import { Box, Brush, Copy, Download, FolderOpen, Sparkles, Trash2 } from "lucide-react";
import type { OutputItem } from "../../shared/contract";
import { createMurmuration, registerMurmuration, type MurmurationHandle } from "../../murmuration";
import { hasStudioDrag, useDragStore } from "../../stores/drag";
import { useEditStore } from "../../stores/edit";
import { useGenerateStore } from "../../stores/generate";
import { useJobStore } from "../../stores/job";
import { useLibraryStore } from "../../stores/library";
import { useUiStore } from "../../stores/ui";
import { registerJobHost } from "../../lib/engine/jobs";
import { registerCommands } from "../../lib/commands";
import { copyImage, copySeed, deleteItems, makeIn3D, openInEdit, saveCopy } from "../../lib/actions";
import { fetchBlob, imageFileFromEvent, outputUrl, thumbUrl } from "../../lib/images";
import { toUrl } from "../../lib/studio";
import { formatDims, formatDuration, truncate } from "../../lib/format";
import { EmptyGenerateIcon } from "../../components/ui/EmptyStateIcons";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { Pill } from "../../components/ui/Pill";
import { Checker, EmptyState } from "../../components/ui/misc";
import { LiveStatus } from "../LiveStatus";
import { fitRect, paneRects, useStageSize } from "../useStageRect";
import { Filmstrip } from "./Filmstrip";
import { GenerateCapsule, type GenerateCapsuleHandle } from "./GenerateCapsule";

type StagePhase = "idle" | "running" | "revealing";

interface View {
  zoom: number;
  x: number;
  y: number;
}
const FIT: View = { zoom: 1, x: 0, y: 0 };

export default function GenerateWorkspace({ active }: { active: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const murm = useRef<MurmurationHandle | null>(null);
  const capsule = useRef<GenerateCapsuleHandle>(null);
  const [phase, setPhase] = useState<StagePhase>("idle");
  const [runAspect, setRunAspect] = useState(1);
  const [inspecting, setInspecting] = useState(false);
  const [view, setView] = useState<View>(FIT);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const current = useGenerateStore((s) => s.current);
  const batchItems = useGenerateStore((s) => s.batchItems);
  const enhancedNote = useGenerateStore((s) => s.enhancedNote);
  const pendingDrop = useGenerateStore((s) => s.pendingDrop);
  const requestDrop = useGenerateStore((s) => s.requestDrop);
  const ignoreGenerateDrop = useUiStore((s) => s.ignoreGenerateDrop);
  const width = useGenerateStore((s) => s.width);
  const height = useGenerateStore((s) => s.height);
  const capsuleH = useUiStore((s) => s.capsuleH.generate);

  const size = useStageSize(stageRef);
  const aspect = phase === "running" ? runAspect : current?.width && current.height ? current.width / current.height : width / height;
  const rect = useMemo(
    () => fitRect(size.w, size.h, aspect, { top: 24, left: 64, right: 64, bottom: capsuleH + 40 }),
    [size.w, size.h, aspect, capsuleH],
  );

  // Murmuration instance: created once, context created lazily on first begin().
  useEffect(() => {
    const m = createMurmuration(canvasRef.current!);
    murm.current = m;
    const unreg = registerMurmuration("generate", m);
    return () => {
      unreg();
      m.dispose();
      murm.current = null;
    };
  }, []);
  useEffect(() => murm.current?.setActive(active), [active]);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !murm.current || size.w === 0) return;
    const { stage, pane } = paneRects(el, rect);
    murm.current.layout(stage, pane);
  }, [rect, size.w, size.h]);

  const reveal = useCallback(async (item: OutputItem) => {
    const m = murm.current;
    const url = outputUrl(item);
    try {
      const blob = await fetchBlob(url);
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
      const pre = new Image();
      pre.src = url;
      await pre.decode().catch(() => {});
      // Final image goes underneath the canvas first, so the dissolve ends on identical pixels.
      flushSync(() => {
        useGenerateStore.getState().show(item);
        setPhase("revealing");
      });
      if (m) await m.complete(bmp);
      else bmp.close();
    } catch {
      useGenerateStore.getState().show(item);
      await m?.cancel();
    } finally {
      setPhase("idle");
    }
  }, []);

  // Job lifecycle (§11.3).
  useEffect(
    () =>
      registerJobHost("generate", {
        started: (e) => {
          const g = useGenerateStore.getState();
          if (!g.seedLocked) g.patch({ seed: e.seed });
          if (!e.replayed) {
            g.setBatch([]);
            g.setEnhancedNote(null);
          }
          const a = (e.width ?? g.width) / (e.height ?? g.height);
          flushSync(() => {
            setInspecting(false);
            setView(FIT);
            setRunAspect(a);
            setPhase("running");
          });
          const el = stageRef.current;
          if (el && murm.current) {
            const r = fitRect(el.clientWidth, el.clientHeight, a, {
              top: 24,
              left: 64,
              right: 64,
              bottom: useUiStore.getState().capsuleH.generate + 40,
            });
            const { stage, pane } = paneRects(el, r);
            murm.current.layout(stage, pane);
          }
          murm.current?.begin({ aspect: a, seed: e.seed });
        },
        progress: (e) => {
          const g = useGenerateStore.getState();
          if (e.output) g.addBatchItem(e.output);
          if (e.enhancedPrompt) g.setEnhancedNote(e.enhancedPrompt);
        },
        completed: (e) => {
          const g = useGenerateStore.getState();
          g.setBatch(e.outputs);
          if (e.outputs[0]) void reveal(e.outputs[0]);
          else void murm.current?.cancel().then(() => setPhase("idle"));
        },
        error: () => {
          void murm.current?.cancel().then(() => setPhase("idle"));
        },
        cancelled: () => {
          void murm.current?.cancel().then(() => setPhase("idle"));
        },
      }),
    [reveal],
  );

  // A job finished while another workspace was active: settle quietly.
  const jobActive = useJobStore((s) => s.active?.owner === "generate");
  useEffect(() => {
    if (!jobActive && phase === "running" && murm.current?.phase === "idle") setPhase("idle");
  }, [jobActive, phase]);

  const batchIdx = current ? batchItems.findIndex((b) => b.id === current.id) : -1;
  const step = useCallback((dir: number) => {
    const g = useGenerateStore.getState();
    if (g.batchItems.length > 1 && g.current) {
      const i = g.batchItems.findIndex((b) => b.id === g.current!.id);
      if (i >= 0) {
        const n = g.batchItems[(i + dir + g.batchItems.length) % g.batchItems.length];
        g.show(n);
        return;
      }
    }
    const strip = useLibraryStore.getState().items.filter((i) => i.kind === "image").slice(0, 24);
    if (!strip.length) return;
    const i = g.current ? strip.findIndex((s) => s.id === g.current!.id) : -1;
    const n = strip[Math.min(strip.length - 1, Math.max(0, i + dir))];
    if (n) g.show(n);
  }, []);

  const exitInspect = useCallback(() => {
    setInspecting(false);
    setView(FIT);
  }, []);

  // Commands + workspace keys (§9).
  useEffect(
    () =>
      registerCommands("generate", {
        run: () => capsule.current?.run(),
        enhance: () => capsule.current?.enhance(),
        focusPrompt: () => capsule.current?.focus(),
        escape: () => {
          if (inspecting) {
            exitInspect();
            return true;
          }
          return false;
        },
        key: (e, typing) => {
          if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
            capsule.current?.toggleNegative();
            return true;
          }
          if (typing) return false;
          const item = useGenerateStore.getState().current;
          const busy = phase !== "idle";
          if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "s" && item && !busy) {
            void saveCopy(item);
            return true;
          }
          if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c" && item && !busy && !window.getSelection()?.toString()) {
            void copyImage(item);
            return true;
          }
          if (e.ctrlKey || e.altKey || e.metaKey) return false;
          if (e.key === "Delete" && item && !busy) {
            void deleteItems([item]);
            return true;
          }
          if ((e.key === "e" || e.key === "E") && item && !busy) {
            openInEdit(item);
            return true;
          }
          if (e.key === "3" && item && !busy) {
            makeIn3D(item);
            return true;
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            step(e.key === "ArrowLeft" ? -1 : 1);
            return true;
          }
          return false;
        },
      }),
    [inspecting, exitInspect, phase, step],
  );

  // ───────── Inspect: zoom/pan with CSS transform ─────────
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const natural = current?.width ?? rect.w;
  const pct = Math.round(((view.zoom * rect.w) / Math.max(1, natural)) * 100);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !inspecting) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const sr = el.getBoundingClientRect();
      const cx = e.clientX - sr.left - (rect.x + rect.w / 2);
      const cy = e.clientY - sr.top - (rect.y + rect.h / 2);
      setView((v) => {
        const z = Math.min(8, Math.max(0.25, v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        const k = z / v.zoom;
        return { zoom: z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [inspecting, rect]);

  const onImgPointerDown = (e: RPointerEvent) => {
    if (phase !== "idle" || e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onImgPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || !inspecting) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onImgPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    if (!inspecting) setInspecting(true);
    else exitInspect();
  };
  const onImgDoubleClick = () => {
    if (!inspecting) return;
    setView((v) => {
      const hundred = natural / Math.max(1, rect.w);
      return Math.abs(v.zoom - 1) < 0.01 ? { zoom: Math.min(8, Math.max(0.25, hundred)), x: 0, y: 0 } : FIT;
    });
    setInspecting(true);
  };

  const showImg = current && phase !== "running";
  const showChrome = !inspecting;
  const empty = !current && phase === "idle";
  const meta = current && phase === "idle";

  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    if (ignoreGenerateDrop) {
      e.preventDefault();
      useDragStore.getState().end();
      return;
    }
    const f = imageFileFromEvent(e.dataTransfer);
    if (f) {
      e.preventDefault();
      useDragStore.getState().end();
      requestDrop({ blob: f, url: URL.createObjectURL(f), name: f.name, sourceId: null });
      return;
    }
    const drag = useDragStore.getState().item;
    if (drag) {
      e.preventDefault();
      useDragStore.getState().end();
      requestDrop({ url: drag.previewUrl || toUrl(drag.path), name: drag.name, sourceId: drag.item?.id ?? null });
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ cursor: inspecting ? (drag.current?.moved ? "grabbing" : "zoom-in") : undefined }}
        onDragOver={(e) => {
          if (hasStudioDrag(e.dataTransfer)) {
            e.preventDefault();
            if (!ignoreGenerateDrop) {
              setDragOver(true);
              useDragStore.getState().setHoverTarget("Drop image");
            }
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setDragOver(false);
            useDragStore.getState().setHoverTarget(null);
          }
        }}
        onDrop={onDrop}
      >
        {empty && (
          <div className="absolute inset-x-0 top-0 flex items-center justify-center" style={{ bottom: capsuleH + 56 }}>
            <EmptyState
              icon={<EmptyGenerateIcon size={56} className="text-ink-3" />}
              lead="Describe an image,"
              italic="then let it gather."
              sub="Ctrl+Enter to generate"
            />
          </div>
        )}

        {showImg && current && (
          <div className="group absolute" style={{ left: rect.x, top: rect.y, width: rect.w + 56, height: rect.h }}>
            <div
              className="absolute left-0 top-0 overflow-visible"
              style={{ width: rect.w, height: rect.h }}
              onPointerDown={onImgPointerDown}
              onPointerMove={onImgPointerMove}
              onPointerUp={onImgPointerUp}
              onDoubleClick={onImgDoubleClick}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              {current.hasAlpha && <Checker className="absolute inset-0 rounded-[var(--r-lg)]" />}
              <img
                src={outputUrl(current)}
                alt={truncate(current.params.prompt, 200)}
                decoding="async"
                draggable={phase === "idle"}
                onDragStart={(e) => {
                  if (phase !== "idle") return;
                  useDragStore.getState().start(
                    {
                      kind: current.kind,
                      path: current.path,
                      previewUrl: thumbUrl(current),
                      name: current.file,
                      item: current,
                    },
                    e.clientX,
                    e.clientY,
                    e.dataTransfer,
                  );
                }}
                className="absolute inset-0 h-full w-full rounded-[var(--r-lg)] object-contain"
                style={{
                  boxShadow: current.hasAlpha ? undefined : "var(--shadow-2)",
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                  transformOrigin: "50% 50%",
                  imageRendering: pct > 400 ? "pixelated" : "auto",
                  cursor: inspecting ? "grab" : "zoom-in",
                  transition: drag.current ? "none" : "transform var(--dur-fast) var(--ease-out)",
                }}
              />
            </div>
            {phase === "idle" && showChrome && (
              <div
                className="glass absolute flex flex-col gap-1 rounded-full p-1 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 focus-within:opacity-100"
                style={{ left: rect.w + 8, top: "50%", transform: "translateY(-50%)", zIndex: 20 }}
              >
                <IconButton icon={Download} label="Save a copy" shortcut="Ctrl+S" tooltipSide="right" onClick={() => void saveCopy(current)} />
                <IconButton icon={Copy} label="Copy image" shortcut="Ctrl+C" tooltipSide="right" onClick={() => void copyImage(current)} />
                <IconButton icon={Brush} label="Edit in canvas" shortcut="E" tooltipSide="right" onClick={() => openInEdit(current)} />
                <IconButton icon={Box} label="Make 3D" shortcut="3" tooltipSide="right" onClick={() => makeIn3D(current)} />
                <IconButton icon={Trash2} label="Delete" shortcut="Del" variant="danger" tooltipSide="right" onClick={() => void deleteItems([current])} />
              </div>
            )}
          </div>
        )}

        {meta && showChrome && current && (
          <div className="absolute flex flex-col gap-1.5" style={{ left: rect.x, top: rect.y + rect.h + 8, width: Math.max(rect.w, 320) }}>
            <div className="flex items-center gap-3">
              <span className="mono-sm text-ink-3">
                {formatDims(current.width, current.height)} ·{" "}
                <button type="button" className="mono-sm rounded px-0.5 text-ink-3 hover:bg-hover hover:text-ink" onClick={() => void copySeed(current.params.seed)}>
                  seed {current.params.seed}
                </button>
                {current.params.steps != null && ` · ${current.params.steps} steps`} · {formatDuration(current.elapsedMs)}
              </span>
              {batchItems.length > 1 && batchIdx >= 0 && (
                <span className="ml-auto flex items-center gap-1.5" role="tablist" aria-label="Batch">
                  {batchItems.map((b, i) => (
                    <button
                      key={b.id}
                      type="button"
                      role="tab"
                      aria-selected={i === batchIdx}
                      aria-label={`Image ${i + 1} of ${batchItems.length}`}
                      onClick={() => useGenerateStore.getState().show(b)}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: i === batchIdx ? "var(--accent)" : "var(--border-strong)" }}
                    />
                  ))}
                </span>
              )}
            </div>
            {enhancedNote && current.params.enhanced && (
              <button
                type="button"
                onClick={() => useGenerateStore.getState().patch({ prompt: enhancedNote })}
                className="t-caption flex items-start gap-1.5 text-left text-ink-3 hover:text-ink-2"
                title="Use the enhanced prompt"
              >
                <Sparkles size={12} strokeWidth={1.75} absoluteStrokeWidth className="mt-0.5 shrink-0" />
                <span className="line-clamp-2">{enhancedNote}</span>
              </button>
            )}
          </div>
        )}

        <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
        <LiveStatus ws="generate" />

        {dragOver && <div className="pointer-events-none absolute inset-4 rounded-[var(--r-xl)]" style={{ boxShadow: "inset 0 0 0 2px var(--accent-ring)", zIndex: 25 }} />}

        {pendingDrop && (
          <div className="anim-fade absolute inset-0 flex items-center justify-center bg-[var(--scrim)] px-4" style={{ zIndex: 30 }}>
            <div role="dialog" aria-modal="true" aria-label="Edit dropped image?" className="glass-strong anim-enter flex w-full max-w-[360px] flex-col gap-4 rounded-[var(--r-xl)] p-5">
              <div className="flex items-center gap-3">
                {pendingDrop.url && (
                  <img src={pendingDrop.url} alt="" className="h-14 w-14 shrink-0 rounded-[var(--r-md)] bg-sunken object-cover" draggable={false} />
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="t-subhead m-0 text-ink">This is the Generate tab</h2>
                  <p className="t-caption m-0 mt-0.5 text-ink-2">Would you like to edit this image?</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Pill
                  onClick={() => {
                    useUiStore.getState().setIgnoreGenerateDrop(true);
                    requestDrop(null);
                  }}
                >
                  Don&apos;t ask again
                </Pill>
                <Pill onClick={() => requestDrop(null)}>Dismiss</Pill>
                <button
                  type="button"
                  onClick={() => {
                    const drop = useGenerateStore.getState().pendingDrop;
                    if (!drop) return;
                    useEditStore.getState().requestOpen({ ...drop });
                    useGenerateStore.setState({ pendingDrop: null });
                    useUiStore.getState().setWorkspace("edit");
                  }}
                  className="t-ui inline-flex h-7 items-center rounded-full bg-accent px-3.5 text-on-accent hover:bg-[var(--accent-hover)]"
                >
                  Edit image
                </button>
              </div>
            </div>
          </div>
        )}

        <Menu
          open={!!ctxMenu}
          onClose={() => setCtxMenu(null)}
          anchor={ctxMenu ?? { x: 0, y: 0 }}
          ariaLabel="Image options"
          items={
            current
              ? [
                  { id: "edit", icon: Brush, label: "Edit in canvas", shortcut: "E", onSelect: () => openInEdit(current) },
                  { id: "3d", icon: Box, label: "Make 3D", shortcut: "3", onSelect: () => makeIn3D(current) },
                  "separator",
                  { id: "save", icon: Download, label: "Save a copy…", shortcut: "Ctrl+S", onSelect: () => void saveCopy(current) },
                  { id: "copy", icon: Copy, label: "Copy image", shortcut: "Ctrl+C", onSelect: () => void copyImage(current) },
                  { id: "seed", label: "Copy seed", onSelect: () => void copySeed(current.params.seed) },
                  { id: "reveal", icon: FolderOpen, label: "Reveal in Explorer", onSelect: () => void reveal(current) },
                  "separator",
                  { id: "delete", icon: Trash2, label: "Delete", shortcut: "Del", danger: true, onSelect: () => void deleteItems([current]) },
                ]
              : []
          }
        />

        {inspecting && (
          <div className="mono-sm pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full px-2 py-1 text-ink-3" style={{ bottom: 16 }}>
            {pct}%
          </div>
        )}

        <GenerateCapsule ref={capsule} hidden={inspecting} />
      </div>
      <Filmstrip hidden={inspecting} />
    </div>
  );
}
