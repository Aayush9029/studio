import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { EDIT_RESOLUTIONS } from "../../shared/families";
import { editDefaultSteps, useEditStore, type EditUiMode } from "../../stores/edit";
import { cancelActiveJob } from "../../lib/engine/jobs";
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
import { SegmentRow, SettingsButton } from "../../components/capsule/pills";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { Segmented } from "../../components/ui/Segmented";
import { Slider } from "../../components/ui/Slider";
import { useInklingAvailable } from "../../stores/engine";

const PLACEHOLDER: Record<EditUiMode, string> = {
  qwen_edit: "Describe the change",
  inpaint: "Describe what belongs in the masked area",
  img2img: "Describe the image you want",
};

export interface EditCapsuleHandle {
  enhance(): void;
  focus(): void;
}

export const EditCapsule = forwardRef<EditCapsuleHandle, { disabled: boolean; onRun(): void }>(function EditCapsule({ disabled, onRun }, ref) {
  // Only the fields this capsule renders: brush, tool, zoom and canvas-doc churn don't re-render it.
  const e = useEditStore(
    useShallow((s) => ({
      mode: s.mode,
      instruction: s.instruction,
      denoiseInpaint: s.denoiseInpaint,
      denoiseImg2img: s.denoiseImg2img,
      steps: s.steps,
      seed: s.seed,
      seedLocked: s.seedLocked,
      cfg: s.cfg,
      sampler: s.sampler,
      scheduler: s.scheduler,
      resolution: s.resolution,
      negative: s.negative,
      enhance: s.enhance,
      patch: s.patch,
      hasDoc: s.doc.hasDoc,
      maskEmpty: s.doc.maskEmpty,
    })),
  );
  const inkling = useInklingAvailable();
  const promptRef = useRef<PromptFieldHandle>(null);
  const negRef = useRef<PromptFieldHandle>(null);
  const [enhancing, setEnhancing] = useState(false);
  const needMask = e.mode === "inpaint" && e.maskEmpty;
  const gate = usePrimaryGate(
    "edit",
    e.hasDoc && e.instruction.trim().length > 0 && !needMask,
    !e.hasDoc ? "Drop an image first" : needMask ? "Paint a mask first · M" : "Describe the change",
  );

  const defSteps = editDefaultSteps(e.mode);
  const steps = e.steps ?? defSteps;
  const denoise = e.mode === "inpaint" ? e.denoiseInpaint : e.denoiseImg2img;

  const enhanceNow = async () => {
    if (!inkling || enhancing) return;
    setEnhancing(true);
    await enhanceInPlace(promptRef.current, useEditStore.getState().instruction, "edit");
    setEnhancing(false);
  };

  useImperativeHandle(ref, () => ({
    enhance: () => void enhanceNow(),
    focus: () => promptRef.current?.focus(),
  }));

  return (
    <CapsuleShell ws="edit" bottom={20} dimmed={disabled}>
      <CapsuleRow>
        <Segmented<EditUiMode>
          ariaLabel="Edit mode"
          value={e.mode}
          onChange={(m) => e.patch({ mode: m, steps: null })}
          options={[
            { value: "qwen_edit", label: "Smart edit", tooltip: "Qwen-Image 2.1 — edit by instruction" },
            { value: "inpaint", label: "Inpaint", tooltip: "Z-Image Turbo — repaint the masked area" },
            { value: "img2img", label: "Img2Img", tooltip: "Z-Image Turbo — reinterpret the whole image" },
          ]}
        />
        <Spacer />
        {e.mode !== "qwen_edit" && (
          <div className="flex w-[260px] items-center gap-2">
            <MicroLabel>DENOISE</MicroLabel>
            <div className="flex-1">
              <Slider
                ariaLabel="Denoise"
                value={denoise}
                min={0.05}
                max={1}
                step={0.01}
                defaultValue={e.mode === "inpaint" ? 0.85 : 0.6}
                format={(v) => v.toFixed(2)}
                onChange={(v) => e.patch(e.mode === "inpaint" ? { denoiseInpaint: v } : { denoiseImg2img: v })}
              />
            </div>
          </div>
        )}
      </CapsuleRow>
      <PromptField ref={promptRef} ariaLabel="Instruction" value={e.instruction} onChange={(v) => e.patch({ instruction: v })} placeholder={PLACEHOLDER[e.mode]} />
      <CapsuleRow>
        <SeedPill seed={e.seed} locked={e.seedLocked} onSeed={(s) => e.patch({ seed: s })} onLock={(l) => e.patch({ seedLocked: l })} />
        <SettingsButton
          value={{ steps, cfg: e.cfg, sampler: e.sampler, scheduler: e.scheduler }}
          defaults={{ steps: defSteps, cfg: 1, sampler: "euler", scheduler: "simple" }}
          onChange={(p) => e.patch(p)}
          onReset={() => e.patch({ steps: null, cfg: 1, sampler: "euler", scheduler: "simple", resolution: 1024, negative: "" })}
          extraDiffers={(e.mode === "qwen_edit" && e.resolution !== 1024) || !!e.negative.trim()}
          extra={
            <>
              {e.mode === "qwen_edit" && (
                <SegmentRow label="RESOLUTION" value={e.resolution as (typeof EDIT_RESOLUTIONS)[number]} options={EDIT_RESOLUTIONS} onChange={(r) => e.patch({ resolution: r })} />
              )}
              <div className="flex flex-col gap-1.5">
                <MicroLabel>EXCLUDED</MicroLabel>
                <div className="rounded-[var(--r-sm)] bg-sunken px-2 py-1">
                  <PromptField ref={negRef} ariaLabel="Exclude" variant="body" maxLines={3} value={e.negative} onChange={(v) => e.patch({ negative: v })} placeholder="Leave out…" />
                </div>
                {e.cfg <= 1 && <span className="t-caption text-ink-3">Applies when CFG is above 1</span>}
              </div>
            </>
          }
        />
        <Spacer />
        <EnhanceButton on={e.enhance} busy={enhancing} onToggle={() => e.patch({ enhance: !e.enhance })} onEnhanceNow={() => void enhanceNow()} />
        <PrimaryButton
          running={gate.running}
          progress={gate.progress}
          disabled={gate.disabled}
          pending={gate.pending}
          disabledReason={gate.reason}
          label="Run"
          shortcut="Ctrl+Enter"
          onRun={onRun}
          onStop={() => void cancelActiveJob()}
        />
      </CapsuleRow>
    </CapsuleShell>
  );
});
