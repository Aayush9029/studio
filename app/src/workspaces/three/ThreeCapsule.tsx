import { forwardRef, useImperativeHandle, useRef, useState, type DragEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { ImagePlus, X } from "lucide-react";
import type { RemeshResolution, ThreeDRequest } from "../../shared/contract";
import { REMESH_RESOLUTIONS } from "../../shared/families";
import { useEngineStore, useInklingAvailable } from "../../stores/engine";
import { useThreeStore } from "../../stores/three";
import { engineHttp } from "../../lib/engine/http";
import { cancelActiveJob, submitJob } from "../../lib/engine/jobs";
import { blobToBase64, imageFileFromEvent, pathForFile, pickImages } from "../../lib/images";
import { formatCount } from "../../lib/format";
import {
  CapsuleRow,
  CapsuleShell,
  EnhanceButton,
  MicroLabel,
  PromptField,
  SeedPill,
  Spacer,
  enhanceInPlace,
  usePrimaryGate,
  type PromptFieldHandle,
} from "../../components/capsule/PromptCapsule";
import { FamilyPill, SegmentRow, engineOptions } from "../../components/capsule/pills";
import { IconButton } from "../../components/ui/IconButton";
import { Pill } from "../../components/ui/Pill";
import { Popover } from "../../components/ui/Popover";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { Segmented } from "../../components/ui/Segmented";
import { Slider } from "../../components/ui/Slider";
import { Switch } from "../../components/ui/misc";

export interface ThreeCapsuleHandle {
  run(): void;
  enhance(): void;
  focus(): void;
  setSourceFile(f: File): void;
}

export const ThreeCapsule = forwardRef<ThreeCapsuleHandle, { hidden?: boolean }>(function ThreeCapsule({ hidden }, ref) {
  // Only the fields this capsule renders: milestones, viewport settings and results don't re-render it.
  const t = useThreeStore(
    useShallow((s) => ({
      mode: s.mode,
      prompt: s.prompt,
      source: s.source,
      engine: s.engine,
      targetFaces: s.targetFaces,
      remesh: s.remesh,
      removeBg: s.removeBg,
      seed: s.seed,
      seedLocked: s.seedLocked,
      enhance: s.enhance,
      patch: s.patch,
      setSource: s.setSource,
    })),
  );
  const models = useEngineStore((s) => s.models);
  const inkling = useInklingAvailable();
  const promptRef = useRef<PromptFieldHandle>(null);
  const qualityRef = useRef<HTMLButtonElement>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const isText = t.mode === "t23d";
  const hasInput = isText ? t.prompt.trim().length > 0 : !!t.source;
  const gate = usePrimaryGate("three", hasInput, isText ? "Describe one object" : "Add an image first");

  const setSourceFile = (f: File) => {
    const p = pathForFile(f);
    t.setSource({ path: p, blob: p ? null : f, url: URL.createObjectURL(f), sourceId: null });
    t.patch({ mode: "i23d" });
  };

  const run = async () => {
    const s = useThreeStore.getState();
    if (gate.disabled || gate.running) return;
    const req: ThreeDRequest = {
      mode: s.mode,
      engine: s.engine,
      seed: s.seedLocked ? s.seed : -1,
      removeBackground: s.removeBg,
      targetFaces: s.targetFaces,
      remeshResolution: s.remesh,
    };
    if (s.mode === "t23d") {
      if (!s.prompt.trim()) return;
      req.prompt = s.prompt.trim();
      req.enhancePrompt = s.enhance && inkling;
    } else {
      const src = s.source;
      if (!src) return;
      if (src.path) req.imagePath = src.path;
      else if (src.blob) req.imageBase64 = await blobToBase64(src.blob);
      else return;
      if (src.sourceId) req.sourceId = src.sourceId;
    }
    await submitJob("three", () => engineHttp.threeD(req));
  };

  const enhanceNow = async () => {
    if (!inkling || enhancing || !isText) return;
    setEnhancing(true);
    await enhanceInPlace(promptRef.current, useThreeStore.getState().prompt, "3d");
    setEnhancing(false);
  };

  useImperativeHandle(ref, () => ({
    run: () => (gate.running ? void cancelActiveJob() : void run()),
    enhance: () => void enhanceNow(),
    focus: () => promptRef.current?.focus(),
    setSourceFile,
  }));

  const onDrop = (e: DragEvent) => {
    const f = imageFileFromEvent(e.dataTransfer);
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    setSourceFile(f);
  };

  const diskBytes = (id: "pixal3d" | "trellis2" | "z_image" | "qwen_image" | "birefnet") => models?.find((m) => m.id === id)?.diskBytes ?? null;

  return (
    <CapsuleShell ws="three" bottom={20} hidden={hidden}>
      <CapsuleRow>
        <Segmented
          ariaLabel="Source"
          value={t.mode}
          onChange={(m) => t.patch({ mode: m })}
          options={[
            { value: "t23d", label: "Text → 3D" },
            { value: "i23d", label: "Image → 3D" },
          ]}
        />
      </CapsuleRow>
      {isText ? (
        <PromptField ref={promptRef} ariaLabel="Prompt" value={t.prompt} onChange={(v) => t.patch({ prompt: v })} placeholder="Describe one object" />
      ) : (
        <div className="flex items-center gap-3" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {t.source ? (
            <div className="group relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-[var(--r-md)] checker">
              <img src={t.source.url} alt="Source" className="h-full w-full object-contain" draggable={false} />
              <span className="absolute right-0.5 top-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <IconButton icon={X} label="Remove source" variant="glass" size={20} iconSize={12} onClick={() => t.setSource(null)} />
              </span>
            </div>
          ) : (
            <button
              type="button"
              aria-label="Add source image"
              onClick={async () => {
                const [p] = await pickImages(false);
                if (p) t.setSource({ path: p.path, blob: p.blob, url: p.url, sourceId: null });
              }}
              className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[var(--r-md)] text-ink-3 hover:bg-hover hover:text-ink-2"
              style={{ border: "1px dashed var(--border-strong)" }}
            >
              <ImagePlus size={18} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
          )}
          <span className="t-body text-ink-3">One object, plain background works best</span>
        </div>
      )}
      <CapsuleRow>
        <FamilyPill ariaLabel="Engine" value={t.engine} options={engineOptions(diskBytes)} onChange={(v) => t.patch({ engine: v })} />
        <Pill ref={qualityRef} chevron aria-expanded={qualityOpen} onClick={() => setQualityOpen((v) => !v)}>
          Quality
        </Pill>
        <Popover open={qualityOpen} onClose={() => setQualityOpen(false)} anchor={qualityRef} width={280} align="start" ariaLabel="Quality">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <MicroLabel>TARGET FACES</MicroLabel>
              <Slider
                ariaLabel="Target faces"
                value={t.targetFaces}
                min={100000}
                max={700000}
                step={50000}
                defaultValue={300000}
                format={(v) => formatCount(v)}
                onChange={(v) => t.patch({ targetFaces: v })}
              />
            </div>
            <SegmentRow<RemeshResolution> label="REMESH" value={t.remesh} options={REMESH_RESOLUTIONS} onChange={(v) => t.patch({ remesh: v })} />
            {t.remesh === 1024 && <span className="t-caption -mt-1 text-ink-3">Uses the most memory — other models unload first</span>}
            <Switch checked={t.removeBg} onChange={(v) => t.patch({ removeBg: v })} label="Remove background" />
          </div>
        </Popover>
        <SeedPill seed={t.seed} locked={t.seedLocked} onSeed={(s) => t.patch({ seed: s })} onLock={(l) => t.patch({ seedLocked: l })} />
        <Spacer />
        {isText && <EnhanceButton on={t.enhance} busy={enhancing} onToggle={() => t.patch({ enhance: !t.enhance })} onEnhanceNow={() => void enhanceNow()} />}
        <PrimaryButton
          running={gate.running}
          progress={gate.progress}
          disabled={gate.disabled}
          pending={gate.pending}
          disabledReason={gate.reason}
          label="Generate 3D"
          shortcut="Ctrl+Enter"
          onRun={() => void run()}
          onStop={() => void cancelActiveJob()}
        />
      </CapsuleRow>
    </CapsuleShell>
  );
});
