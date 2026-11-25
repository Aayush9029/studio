import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CircleMinus } from "lucide-react";
import { staticFamily } from "../../shared/families";
import { useEngineStore } from "../../stores/engine";
import { sizeMultiple, useGenerateStore } from "../../stores/generate";
import { useInklingAvailable } from "../../stores/engine";
import { engineHttp } from "../../lib/engine/http";
import { submitJob, cancelActiveJob } from "../../lib/engine/jobs";
import {
  CapsuleRow,
  CapsuleShell,
  EnhanceButton,
  PromptField,
  SeedPill,
  Spacer,
  enhanceInPlace,
  usePrimaryGate,
  type PromptFieldHandle,
} from "../../components/capsule/PromptCapsule";
import { AspectPill, FamilyPill, IMAGE_MODEL_OPTIONS, SegmentRow, SettingsButton } from "../../components/capsule/pills";
import { IconButton } from "../../components/ui/IconButton";
import { PrimaryButton } from "../../components/ui/PrimaryButton";

export interface GenerateCapsuleHandle {
  run(): void;
  enhance(): void;
  focus(): void;
  toggleNegative(): void;
}

export const GenerateCapsule = forwardRef<GenerateCapsuleHandle, { hidden: boolean }>(function GenerateCapsule({ hidden }, ref) {
  // Only the fields this capsule renders: gallery/result churn doesn't re-render it.
  const g = useGenerateStore(
    useShallow((s) => ({
      prompt: s.prompt,
      negative: s.negative,
      negativeOpen: s.negativeOpen,
      model: s.model,
      width: s.width,
      height: s.height,
      aspect: s.aspect,
      ratioLocked: s.ratioLocked,
      seed: s.seed,
      seedLocked: s.seedLocked,
      steps: s.steps,
      cfg: s.cfg,
      sampler: s.sampler,
      scheduler: s.scheduler,
      batch: s.batch,
      enhance: s.enhance,
      patch: s.patch,
      setModel: s.setModel,
      setSize: s.setSize,
    })),
  );
  const models = useEngineStore((s) => s.models);
  const inkling = useInklingAvailable();
  const promptRef = useRef<PromptFieldHandle>(null);
  const negRef = useRef<PromptFieldHandle>(null);
  const [enhancing, setEnhancing] = useState(false);
  const gate = usePrimaryGate("generate", g.prompt.trim().length > 0, "Describe an image");

  const fam = models?.find((m) => m.id === g.model);
  const defaults = fam?.defaults ?? staticFamily(g.model).defaults!;
  const mult = sizeMultiple(g.model);

  const run = () => {
    const s = useGenerateStore.getState();
    if (!s.prompt.trim() || gate.disabled || gate.running) return;
    void submitJob("generate", () =>
      engineHttp.t2i({
        prompt: s.prompt.trim(),
        negativePrompt: s.negative.trim(),
        model: s.model,
        width: s.width,
        height: s.height,
        seed: s.seedLocked ? s.seed : -1,
        steps: s.steps,
        cfg: s.cfg,
        sampler: s.sampler,
        scheduler: s.scheduler,
        batchSize: s.batch,
        enhancePrompt: s.enhance && inkling,
      }),
    );
  };

  const enhanceNow = async () => {
    if (!inkling || enhancing) return;
    setEnhancing(true);
    await enhanceInPlace(promptRef.current, useGenerateStore.getState().prompt, "photo");
    setEnhancing(false);
  };

  const toggleNegative = () => {
    const open = !useGenerateStore.getState().negativeOpen;
    g.patch({ negativeOpen: open });
    if (open) requestAnimationFrame(() => negRef.current?.focus());
  };

  useImperativeHandle(ref, () => ({
    run: () => (gate.running ? void cancelActiveJob() : run()),
    enhance: () => void enhanceNow(),
    focus: () => promptRef.current?.focus(),
    toggleNegative,
  }));

  const bottom = 16; // stage ends at the filmstrip, so this is filmstrip-h + 16 in the content column
  return (
    <CapsuleShell ws="generate" bottom={bottom} hidden={hidden}>
      <PromptField
        ref={promptRef}
        ariaLabel="Prompt"
        value={g.prompt}
        onChange={(v) => g.patch({ prompt: v })}
        placeholder="Describe an image"
        trailing={
          <IconButton
            icon={CircleMinus}
            label="Exclude"
            shortcut="Ctrl+Shift+N"
            pressed={g.negativeOpen}
            tone={g.negative.trim() ? "accent" : "default"}
            size={28}
            onClick={toggleNegative}
          />
        }
      />
      {g.negativeOpen && (
        <div className="anim-enter flex flex-col border-t border-hairline pt-2">
          <PromptField
            ref={negRef}
            ariaLabel="Exclude"
            variant="body"
            maxLines={3}
            value={g.negative}
            onChange={(v) => g.patch({ negative: v })}
            placeholder="Leave out…"
            trailing={g.cfg <= 1 ? <span className="t-caption shrink-0 self-center pr-1 text-ink-3">Applies when CFG is above 1</span> : undefined}
          />
        </div>
      )}
      <CapsuleRow>
        <FamilyPill
          ariaLabel="Model"
          value={g.model}
          options={IMAGE_MODEL_OPTIONS}
          onChange={(m) => {
            const d = models?.find((x) => x.id === m)?.defaults ?? undefined;
            g.setModel(m, d ?? undefined);
          }}
        />
        <AspectPill
          width={g.width}
          height={g.height}
          aspect={g.aspect}
          multiple={mult}
          ratioLocked={g.ratioLocked}
          onSize={(w, h, a) => g.setSize(w, h, a)}
          onRatioLocked={(v) => g.patch({ ratioLocked: v })}
        />
        <SeedPill seed={g.seed} locked={g.seedLocked} onSeed={(s) => g.patch({ seed: s })} onLock={(l) => g.patch({ seedLocked: l })} />
        <SettingsButton
          value={{ steps: g.steps, cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler }}
          defaults={defaults}
          samplers={fam?.samplers}
          schedulers={fam?.schedulers}
          onChange={(p) => g.patch(p)}
          onReset={() => g.patch({ steps: defaults.steps, cfg: defaults.cfg, sampler: defaults.sampler, scheduler: defaults.scheduler, batch: 1 })}
          extraDiffers={g.batch !== 1}
          extra={<SegmentRow label="BATCH" value={g.batch} options={[1, 2, 3, 4] as const} onChange={(b) => g.patch({ batch: b })} />}
        />
        <Spacer />
        <EnhanceButton on={g.enhance} busy={enhancing} onToggle={() => g.patch({ enhance: !g.enhance })} onEnhanceNow={() => void enhanceNow()} />
        <PrimaryButton
          running={gate.running}
          progress={gate.progress}
          disabled={gate.disabled}
          pending={gate.pending}
          disabledReason={gate.reason}
          label="Generate"
          shortcut="Ctrl+Enter"
          onRun={run}
          onStop={() => void cancelActiveJob()}
        />
      </CapsuleRow>
    </CapsuleShell>
  );
});

