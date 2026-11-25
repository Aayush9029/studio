import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Circle, Rotate3d, RotateCcw, Send, Sun, type LucideIcon } from "lucide-react";
import type { MeshExportFormat, OutputItem, Stage3DId } from "../../shared/contract";
import { createMurmuration, registerMurmuration, type MurmurationHandle } from "../../murmuration";
import { emptyMilestones, STAGE_ORDER, useThreeStore, type Lighting, type Milestone, type Shading } from "../../stores/three";
import { useEngineStore } from "../../stores/engine";
import { useJobStore } from "../../stores/job";
import { useUiStore, say } from "../../stores/ui";
import { registerJobHost } from "../../lib/engine/jobs";
import { registerCommands } from "../../lib/commands";
import { sendToBlender } from "../../lib/actions";
import { whisperError } from "../../lib/errors";
import { toStudioError } from "../../lib/engine/http";
import { basename, formatCount, formatMeters } from "../../lib/format";
import { imageFileFromEvent, resolveAssetFile } from "../../lib/images";
import { studio, toUrl } from "../../lib/studio";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { Pill } from "../../components/ui/Pill";
import { Popover } from "../../components/ui/Popover";
import { Slider } from "../../components/ui/Slider";
import { Tooltip } from "../../components/ui/Tooltip";
import { EmptyState, RailDivider } from "../../components/ui/misc";
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
  const shapeStill = useThreeStore((s) => s.shapeStill);
  const running = useJobStore((s) => s.active?.owner === "three");
  const capsuleH = useUiStore((s) => s.capsuleH.three);
  const [loaded, setLoaded] = useState(false);
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
            t.setShapeStill(null);
          }
          t.setStripVisible(true);
          t.setMilestone("source", { status: "active" });
          layoutMurm();
          murm.current?.begin({ aspect: 1, seed: e.seed });
        },
        progress: (e) => {
          const id = e.stageId as Stage3DId;
          if (!STAGE_ORDER.includes(id)) return;
          const t = useThreeStore.getState();
          const m = t.milestones[id];
          if (m.status === "pending" || m.status === "active") {
            t.setMilestone(id, { status: "active", step: e.phase === "sampling" ? e.step : 0, total: e.phase === "sampling" ? e.totalSteps : 0 });
          }
          if (id !== "source") murm.current?.setProgress(e.progress);
        },
        stagePreview: (e) => {
          const t = useThreeStore.getState();
          const url = e.imagePath ? toUrl(e.imagePath) : null;
          t.setMilestone(e.stageId, { status: e.status, imageUrl: url, step: 0, total: 0 });
          const next = STAGE_ORDER[STAGE_ORDER.indexOf(e.stageId) + 1];
          if (next && t.milestones[next].status === "pending") t.setMilestone(next, { status: "active" });
          if (e.stageId === "shape" && url) {
            t.setShapeStill(url);
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
          t.setShapeStill(null);
          void murm.current?.cancel();
        },
        cancelled: () => {
          const t = useThreeStore.getState();
          t.setShapeStill(null);
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
  const empty = !current && !running && !shapeStill;
  const mesh = current?.mesh;
  const blenderConnected = !!blender?.connected;
  const blenderInstalled = blender ? blender.installed : true;
  const stillRect = stage.w > 0 ? squarePane(stage.w, stage.h, capsuleH) : null;

  return (
    <div
      ref={stageRef}
      className="relative h-full min-h-0 overflow-hidden"
      style={{ background: "linear-gradient(to bottom, var(--viewport-bg-top), var(--viewport-bg-bottom))" }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const f = imageFileFromEvent(e.dataTransfer);
        if (!f) return;
        e.preventDefault();
        capsule.current?.setSourceFile(f);
      }}
    >
      <Suspense fallback={null}>
        <Viewport3D
          glbUrl={glbUrl}
          active={active}
          dimmed={running}
          onLoaded={() => {
            setLoaded(true);
            useThreeStore.getState().setShapeStill(null);
          }}
          onError={() => {
            useThreeStore.getState().setShapeStill(null);
            say("Couldn't open that mesh.", { tone: "error" });
          }}
        />
      </Suspense>

      {shapeStill && stillRect && (
        <img
          src={shapeStill}
          alt="Shape preview"
          className="anim-fade pointer-events-none absolute object-contain"
          style={{ left: stillRect.x, top: stillRect.y, width: stillRect.w, height: stillRect.h }}
        />
      )}

      <canvas ref={murmCanvas} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" style={{ zIndex: 5 }} />
      <LiveStatus ws="three" verb="Making 3D" />

      {empty && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-center" style={{ bottom: capsuleH + 40 }}>
          <EmptyState lead="Give it a subject," italic="get it in the round." sub="Text or a single image" />
        </div>
      )}

      <div className="absolute left-4 top-4" style={{ zIndex: 20 }}>
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
            className="t-ui inline-flex h-9 items-center gap-2 rounded-full bg-accent-soft pl-3 pr-3 text-accent transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {sent ? <Check size={16} strokeWidth={1.75} absoluteStrokeWidth /> : <Send size={16} strokeWidth={1.75} absoluteStrokeWidth />}
            <span>{sent ? "Sent" : blenderConnected ? "Send to Blender" : "Open Blender"}</span>
            <span
              aria-hidden
              className="ml-0.5 h-1.5 w-1.5 rounded-full"
              style={blenderConnected ? { background: "var(--sage)" } : { boxShadow: "inset 0 0 0 1px var(--text-faint)" }}
            />
          </button>
        </Tooltip>
      </div>

      <ViewportRail disabled={!current} />

      {mesh && loaded && (
        <div className="mono-sm pointer-events-none absolute left-4 text-ink-3" style={{ bottom: capsuleH + 36, zIndex: 20 }}>
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
