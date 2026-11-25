import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import { Circle, Copy, Download, FolderOpen, Rotate3d, RotateCcw, Sun, type LucideIcon } from "lucide-react";
import type { MeshExportFormat, OutputItem, Stage3DId } from "../../shared/contract";
import { createMurmuration, registerMurmuration, type MurmurationHandle } from "../../murmuration";
import { hasStudioDrag, useDragStore } from "../../stores/drag";
import { emptyMilestones, STAGE_LABEL, STAGE_ORDER, useThreeStore, type Lighting, type Milestone, type Shading } from "../../stores/three";
import { useEngineStore } from "../../stores/engine";
import { useJobStore } from "../../stores/job";
import { useUiStore, say } from "../../stores/ui";
import { registerJobHost } from "../../lib/engine/jobs";
import { registerCommands } from "../../lib/commands";
import { copyText, reveal, sendToBlender } from "../../lib/actions";
import { whisperError } from "../../lib/errors";
import { toStudioError } from "../../lib/engine/http";
import { basename, formatCount, formatMeters } from "../../lib/format";
import { imageFileFromEvent, resolveAssetFile } from "../../lib/images";
import { studio, toUrl } from "../../lib/studio";
import { BlenderIcon, EmptyThreeIcon } from "../../components/ui/EmptyStateIcons";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { Pill } from "../../components/ui/Pill";
import { Popover } from "../../components/ui/Popover";
import { Slider } from "../../components/ui/Slider";
import { Tooltip } from "../../components/ui/Tooltip";
import { Checker, EmptyState, RailDivider } from "../../components/ui/misc";
import { LiveStatus } from "../LiveStatus";
import { paneRects, useStageSize, type Rect } from "../useStageRect";
import { MilestoneStrip } from "./MilestoneStrip";
import { ThreeCapsule, type ThreeCapsuleHandle } from "./ThreeCapsule";
import { viewportBus, type CameraPreset } from "./viewportBus";

// Three.js and the viewport live in their own chunk, fetched on the first visit to this workspace.
const Viewport3D = lazy(() => import("./Viewport3D"));

function milestonesFromItem(item: OutputItem): Record<Stage3DId, Milestone> {
  const out = emptyMilestones();
  for (const s of item.stages) {
    const file = resolveAssetFile(item, s.file);
    out[s.id] = { status: s.status, imageUrl: file ? toUrl(file) : null, step: 0, total: 0 };
  }
  return out;
}

function squarePane(w: number, h: number, capsuleH: number): Rect {
  const availH = h - 120 - capsuleH - 40;
  const s = Math.max(120, Math.min(w - 220, availH) * 0.8);
  return { x: Math.round((w - s) / 2), y: Math.round(96 + (availH - s) / 2 + 12), w: Math.round(s), h: Math.round(s) };
}

export default function ThreeWorkspace({ active }: { active: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const murmCanvas = useRef<HTMLCanvasElement>(null);
  const murm = useRef<MurmurationHandle | null>(null);
  const capsule = useRef<ThreeCapsuleHandle>(null);
  const current = useThreeStore((s) => s.current);
  const stageStill = useThreeStore((s) => s.stageStill);
  const inspectStage = useThreeStore((s) => s.inspectStage);
  const milestones = useThreeStore((s) => s.milestones);
  const running = useJobStore((s) => s.active?.owner === "three");
  const livePreviewUrl = useJobStore((s) => (s.livePreviewOwner === "three" ? s.livePreviewUrl : null));
  const capsuleH = useUiStore((s) => s.capsuleH.three);
  const [loaded, setLoaded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const rightStart = useRef<{ x: number; y: number } | null>(null);
  const rightMoved = useRef(false);
  const stage = useStageSize(stageRef);

  useEffect(() => {
    const m = createMurmuration(murmCanvas.current!);
    murm.current = m;
    const un = registerMurmuration("three", m);
    return () => {
      un();
      m.dispose();
    };
  }, []);
  useEffect(() => murm.current?.setActive(active), [active]);

  const layoutMurm = useCallback(() => {
    const el = stageRef.current;
    if (!el || !murm.current) return;
    const r = squarePane(el.clientWidth, el.clientHeight, useUiStore.getState().capsuleH.three);
    const { stage, pane } = paneRects(el, r);
    murm.current.layout(stage, pane);
  }, []);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(layoutMurm);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layoutMurm]);
  useEffect(layoutMurm, [capsuleH, layoutMurm]);

  // Milestones reflect the mesh in the viewport when no job is running.
  useEffect(() => {
    if (!current || useJobStore.getState().active?.owner === "three") return;
    const t = useThreeStore.getState();
    t.setMilestones(milestonesFromItem(current));
    t.setStripVisible(true);
  }, [current]);

  useEffect(
    () =>
      registerJobHost("three", {
        started: (e) => {
          const t = useThreeStore.getState();
          if (!t.seedLocked) t.patch({ seed: e.seed });
          if (!e.replayed) {
            t.resetMilestones();
            t.setStageStill(null);
          }
          t.setStripVisible(true);
          t.setMilestone("source", { status: "active" });
          layoutMurm();
          murm.current?.begin({ aspect: 1, seed: e.seed, crisp: e.mode !== "t23d" });
        },
        progress: (e) => {
          const id = e.stageId as Stage3DId;
          if (!STAGE_ORDER.includes(id)) return;
          const t = useThreeStore.getState();
          const m = t.milestones[id];
          if (m.status === "pending" || m.status === "active") {
            t.setMilestone(id, { status: "active", step: e.phase === "sampling" ? e.step : 0, total: e.phase === "sampling" ? e.totalSteps : 0 });
          }
          if (id === "structure" || id === "shape") murm.current?.setCrisp(true);
          if (id !== "source") murm.current?.setProgress(e.progress);
        },
        stagePreview: (e) => {
          const t = useThreeStore.getState();
          const url = e.imagePath ? toUrl(e.imagePath) : null;
          t.setMilestone(e.stageId, { status: e.status, imageUrl: url, step: 0, total: 0 });
          const next = STAGE_ORDER[STAGE_ORDER.indexOf(e.stageId) + 1];
          if (next && t.milestones[next].status === "pending") t.setMilestone(next, { status: "active" });
          if (url && e.stageId !== "mesh") {
            t.setStageStill({ stageId: e.stageId, url });
          }
          if (e.stageId === "source") {
            murm.current?.setCrisp(true);
          } else if (e.stageId === "shape") {
            void murm.current?.finish();
          }
        },
        completed: (e) => {
          const item = e.outputs[0];
          void murm.current?.finish();
          if (item) {
            setLoaded(false);
            useThreeStore.getState().setCurrent(item);
            useThreeStore.getState().setMilestones(milestonesFromItem(item));
          }
        },
        error: (e) => {
          const t = useThreeStore.getState();
          const id = e.stageIndex != null ? STAGE_ORDER[e.stageIndex] : STAGE_ORDER.find((s) => t.milestones[s].status === "active");
          if (id) t.setMilestone(id, { status: "error" });
          t.setStageStill(null);
          void murm.current?.cancel();
        },
        cancelled: () => {
          const t = useThreeStore.getState();
          t.setStageStill(null);
          if (t.current) t.setMilestones(milestonesFromItem(t.current));
          else t.setStripVisible(false);
          void murm.current?.cancel();
        },
      }),
    [layoutMurm],
  );

  // ───────── Export / Blender ─────────
  const blender = useEngineStore((s) => s.blender);
  const exportRef = useRef<HTMLButtonElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<MeshExportFormat | null>(null);
  const [sent, setSent] = useState(false);
  const [launching, setLaunching] = useState(false);

  const doExport = async (format: MeshExportFormat) => {
    if (!current) return;
    setExporting(format);
    try {
      const res = await studio.mesh.export({ path: current.path, format, suggestedName: current.file.replace(/\.glb$/i, "") });
      if (res) say(`Exported ${basename(res.output)}`, { action: { label: "Show", run: () => void studio.files.reveal(res.output).catch(() => {}) } });
    } catch (e) {
      whisperError(toStudioError(e));
    } finally {
      setExporting(null);
    }
  };

  const blenderAction = useCallback(async () => {
    const item = useThreeStore.getState().current;
    const b = useEngineStore.getState().blender;
    if (b?.connected) {
      if (!item) return;
      if (await sendToBlender(item)) {
        setSent(true);
        window.setTimeout(() => setSent(false), 2000);
      }
    } else {
      setLaunching(true);
      try {
        await studio.blender.launch();
      } catch (e) {
        whisperError(toStudioError(e));
      } finally {
        setLaunching(false);
      }
    }
  }, []);

  // ───────── Keys (§9 3D scope) ─────────
  useEffect(
    () =>
      registerCommands("three", {
        run: () => capsule.current?.run(),
        enhance: () => capsule.current?.enhance(),
        focusPrompt: () => capsule.current?.focus(),
        escape: () => {
          if (useThreeStore.getState().inspectStage) {
            useThreeStore.getState().setInspectStage(null);
            return true;
          }
          return false;
        },
        key: (e, typing) => {
          if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "b") {
            void blenderAction();
            return true;
          }
          if (typing || e.ctrlKey || e.altKey || e.metaKey) return false;
          const presets: Record<string, CameraPreset> = { "1": "front", "2": "side", "3": "top", "4": "iso", "0": "reset" };
          if (presets[e.key]) {
            viewportBus.preset(presets[e.key]);
            return true;
          }
          const shading: Record<string, Shading> = { l: "pbr", c: "clay", w: "wireframe", n: "normals" };
          const k = e.key.toLowerCase();
          if (shading[k]) {
            useThreeStore.getState().patch({ shading: shading[k] });
            return true;
          }
          if (k === "r") {
            const t = useThreeStore.getState();
            t.patch({ autoRotate: !t.autoRotate });
            return true;
          }
          return false;
        },
      }),
    [blenderAction],
  );

  const glbUrl = current ? toUrl(current.path) : null;
  const inspectedPreview = inspectStage && milestones[inspectStage]?.imageUrl ? { stageId: inspectStage, url: milestones[inspectStage].imageUrl! } : null;
  const centerStill = inspectedPreview ?? (!livePreviewUrl && stageStill ? stageStill : null);
  const empty = !current && !running && !centerStill && !livePreviewUrl;
  const mesh = current?.mesh;
  const blenderConnected = !!blender?.connected;
  const blenderInstalled = blender ? blender.installed : true;
  const stillRect = stage.w > 0 ? squarePane(stage.w, stage.h, capsuleH) : null;

  const onStageDrop = (e: DragEvent) => {
    setDragOver(false);
    const f = imageFileFromEvent(e.dataTransfer);
    if (f) {
      e.preventDefault();
      useDragStore.getState().end();
      capsule.current?.setSourceFile(f);
      return;
    }
    const drag = useDragStore.getState().item;
    if (drag) {
      e.preventDefault();
      useDragStore.getState().end();
      const t = useThreeStore.getState();
      if (drag.item?.kind === "3d") {
        t.setCurrent(drag.item);
      } else {
        t.patch({ mode: "i23d" });
        t.setSource({ path: drag.path, blob: null, url: drag.previewUrl || toUrl(drag.path), sourceId: drag.item?.id ?? null });
      }
    }
  };

  return (
    <div
      ref={stageRef}
      className="relative h-full min-h-0 overflow-hidden"
      style={{ background: "linear-gradient(to bottom, var(--viewport-bg-top), var(--viewport-bg-bottom))" }}
      onDragOver={(e) => {
        if (hasStudioDrag(e.dataTransfer)) {
          e.preventDefault();
          setDragOver(true);
          useDragStore.getState().setHoverTarget("Use in 3D");
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setDragOver(false);
          useDragStore.getState().setHoverTarget(null);
        }
      }}
      onDrop={onStageDrop}
      onPointerDown={(e: RPointerEvent<HTMLDivElement>) => {
        if (e.button === 2) {
          rightStart.current = { x: e.clientX, y: e.clientY };
          rightMoved.current = false;
        }
      }}
      onPointerMove={(e: RPointerEvent<HTMLDivElement>) => {
        if (rightStart.current && Math.hypot(e.clientX - rightStart.current.x, e.clientY - rightStart.current.y) > 4) {
          rightMoved.current = true;
        }
      }}
      onContextMenu={(e) => {
        if (!current) return;
        e.preventDefault();
        if (!rightMoved.current) setCtxMenu({ x: e.clientX, y: e.clientY });
        rightStart.current = null;
        rightMoved.current = false;
      }}
    >
      <Suspense fallback={null}>
        <Viewport3D
          glbUrl={glbUrl}
          active={active}
          dimmed={running || !!inspectedPreview}
          onLoaded={() => {
            setLoaded(true);
            useThreeStore.getState().setStageStill(null);
          }}
          onError={() => {
            useThreeStore.getState().setStageStill(null);
            say("Couldn't open that mesh.", { tone: "error" });
          }}
        />
      </Suspense>

      {centerStill && stillRect && (
        <div
          className="anim-fade pointer-events-none absolute flex items-center justify-center overflow-hidden rounded-[var(--r-lg)]"
          style={{ left: stillRect.x, top: stillRect.y, width: stillRect.w, height: stillRect.h, zIndex: 4 }}
        >
          {centerStill.stageId === "cutout" ? (
            <Checker className="h-full w-full rounded-[var(--r-lg)]">
              <img src={centerStill.url} alt={`${STAGE_LABEL[centerStill.stageId]} preview`} className="h-full w-full object-contain" />
            </Checker>
          ) : (
            <img src={centerStill.url} alt={`${STAGE_LABEL[centerStill.stageId]} preview`} className="h-full w-full rounded-[var(--r-lg)] object-contain" />
          )}
          <span className="glass mono-sm absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-ink">
            {STAGE_LABEL[centerStill.stageId]}{inspectedPreview ? " · Esc to close" : ""}
          </span>
        </div>
      )}

      <canvas ref={murmCanvas} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" style={{ zIndex: 6 }} />
      <LiveStatus ws="three" verb="Making 3D" />

      {empty && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-center" style={{ bottom: capsuleH + 40 }}>
          <EmptyState
            icon={<EmptyThreeIcon size={56} className="text-ink-3" />}
            lead="Give it a subject,"
            italic="get it in the round."
            sub="Text or a single image"
          />
        </div>
      )}
      {dragOver && <div className="pointer-events-none absolute inset-4 rounded-[var(--r-xl)]" style={{ boxShadow: "inset 0 0 0 2px var(--accent-ring)", zIndex: 25 }} />}

      <div className="absolute left-4 top-1/2 -translate-y-1/2" style={{ zIndex: 20 }}>
        <MilestoneStrip />
      </div>

      <div className="absolute right-4 top-4 flex items-center gap-2" style={{ zIndex: 20 }}>
        <Pill ref={exportRef} chevron disabled={!current || running} aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)}>
          {exporting ? "Exporting…" : "Export"}
        </Pill>
        <Menu
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          anchor={exportRef}
          placement="bottom"
          align="end"
          width={170}
          ariaLabel="Export"
          items={(["glb", "obj", "stl", "fbx", "blend"] as MeshExportFormat[]).map((f) => ({
            id: f,
            label: <span className="mono">.{f}</span>,
            busy: exporting === f,
            disabled: (f !== "glb" && !blenderInstalled) || (!!exporting && exporting !== f),
            disabledReason: f !== "glb" && !blenderInstalled ? "Needs Blender 5.3" : undefined,
            onSelect: () => void doExport(f),
          }))}
        />
        <Tooltip label={blenderConnected ? "Send to Blender" : "Open Blender"} shortcut="Ctrl+B">
          <button
            type="button"
            disabled={(blenderConnected && (!current || running)) || launching || !blenderInstalled}
            onClick={() => void blenderAction()}
            className={`t-ui inline-flex h-9 items-center gap-2 rounded-full pl-3 pr-3.5 transition-opacity hover:opacity-90 disabled:opacity-40 ${
              blenderConnected ? "bg-accent text-on-accent" : "glass text-ink"
            }`}
          >
            <BlenderIcon size={16} colored={!blenderConnected ? true : false} className="shrink-0" />
            <span>{sent ? "Sent" : blenderConnected ? "Send to Blender" : "Open Blender"}</span>
          </button>
        </Tooltip>
      </div>

      <Menu
        open={!!ctxMenu}
        onClose={() => setCtxMenu(null)}
        anchor={ctxMenu ?? { x: 0, y: 0 }}
        ariaLabel="3D options"
        items={
          current
            ? [
                {
                  id: "blender",
                  label: blenderConnected ? "Send to Blender" : "Open Blender",
                  disabled: !blenderInstalled || launching,
                  onSelect: () => void blenderAction(),
                },
                { id: "export-glb", icon: Download, label: "Export .glb", onSelect: () => void doExport("glb") },
                { id: "reset", icon: RotateCcw, label: "Reset view", shortcut: "0", onSelect: () => viewportBus.preset("reset") },
                "separator",
                ...(current.params.prompt
                  ? [{ id: "copy-prompt", icon: Copy, label: "Copy prompt", onSelect: () => void copyText(current.params.prompt, "Prompt copied") }]
                  : []),
                { id: "reveal", icon: FolderOpen, label: "Reveal in Explorer", onSelect: () => void reveal(current) },
              ]
            : []
        }
      />

      <ViewportRail disabled={!current} />

      {mesh && loaded && (
        <div className="mono-sm pointer-events-none absolute left-4 top-4 text-ink-3" style={{ zIndex: 20 }}>
          V {formatCount(mesh.vertices)} · T {formatCount(mesh.triangles)} · {formatMeters(mesh.size)}
        </div>
      )}

      <ThreeCapsule ref={capsule} />
    </div>
  );
}

function ViewportRail({ disabled }: { disabled: boolean }) {
  const shading = useThreeStore((s) => s.shading);
  const lighting = useThreeStore((s) => s.lighting);
  const exposure = useThreeStore((s) => s.exposure);
  const autoRotate = useThreeStore((s) => s.autoRotate);
  const patch = useThreeStore((s) => s.patch);
  const shadeRef = useRef<HTMLButtonElement>(null);
  const lightRef = useRef<HTMLButtonElement>(null);
  const [shadeOpen, setShadeOpen] = useState(false);
  const [lightOpen, setLightOpen] = useState(false);

  const letter = (l: string, label: string, key: string, p: CameraPreset) => (
    <Tooltip key={l} label={label} shortcut={key} side="left">
      <button
        type="button"
        aria-label={label}
        onClick={() => viewportBus.preset(p)}
        className="mono-sm inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"
      >
        {l}
      </button>
    </Tooltip>
  );

  const SHADINGS: { id: Shading; label: string; key: string }[] = [
    { id: "pbr", label: "Lit PBR", key: "L" },
    { id: "clay", label: "Clay", key: "C" },
    { id: "wireframe", label: "Wireframe", key: "W" },
    { id: "normals", label: "Normals", key: "N" },
  ];
  const LIGHTS: { id: Lighting; label: string }[] = [
    { id: "studio", label: "Studio" },
    { id: "warm", label: "Warm" },
    { id: "rim", label: "Rim" },
  ];
  const ShadeIcon: LucideIcon = Circle;

  return (
    <div
      className={`glass absolute flex w-10 flex-col items-center gap-0.5 rounded-full py-1 ${disabled ? "pointer-events-none opacity-40" : ""}`}
      style={{ right: 16, top: "50%", transform: "translateY(-50%)", zIndex: 20 }}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Viewport"
    >
      {letter("F", "Front", "1", "front")}
      {letter("S", "Side", "2", "side")}
      {letter("T", "Top", "3", "top")}
      {letter("I", "Iso", "4", "iso")}
      <IconButton icon={RotateCcw} label="Reset view" shortcut="0" tooltipSide="left" onClick={() => viewportBus.preset("reset")} />
      <RailDivider />
      <IconButton ref={shadeRef} icon={ShadeIcon} label="Shading" tooltipSide="left" aria-expanded={shadeOpen} onClick={() => setShadeOpen((v) => !v)} />
      <IconButton ref={lightRef} icon={Sun} label="Lighting" tooltipSide="left" aria-expanded={lightOpen} onClick={() => setLightOpen((v) => !v)} />
      <IconButton icon={Rotate3d} label="Auto-rotate" shortcut="R" tooltipSide="left" pressed={autoRotate} active={autoRotate} onClick={() => patch({ autoRotate: !autoRotate })} />
      <Menu
        open={shadeOpen}
        onClose={() => setShadeOpen(false)}
        anchor={shadeRef}
        placement="left"
        width={190}
        ariaLabel="Shading"
        items={SHADINGS.map((s) => ({ id: s.id, label: s.label, shortcut: s.key, selected: shading === s.id, onSelect: () => patch({ shading: s.id }) }))}
      />
      <Popover open={lightOpen} onClose={() => setLightOpen(false)} anchor={lightRef} placement="left" width={240} surface="menu" padding={4} ariaLabel="Lighting">
        <div className="flex flex-col">
          {LIGHTS.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={lighting === l.id}
              onClick={() => patch({ lighting: l.id })}
              className={`t-ui flex h-8 items-center rounded-[var(--r-sm)] px-2.5 text-left hover:bg-hover ${lighting === l.id ? "text-accent" : "text-ink"}`}
            >
              {l.label}
            </button>
          ))}
          <div className="mx-2 my-1 h-px bg-hairline" />
          <div className="px-2.5 py-2">
            <Slider label="EXPOSURE" micro value={exposure} min={0.25} max={2.5} step={0.01} defaultValue={1} format={(v) => v.toFixed(2)} onChange={(v) => patch({ exposure: v })} />
          </div>
        </div>
      </Popover>
    </div>
  );
}
