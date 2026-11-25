import { useRef, useState, type ReactNode } from "react";
import { Link2, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { FamilyId, ImageModel } from "../../shared/contract";
import { ASPECT_PRESETS, CURATED_SAMPLERS, CURATED_SCHEDULERS, staticFamily, type AspectId } from "../../shared/families";
import { useEngineStore } from "../../stores/engine";
import { snapSize } from "../../stores/generate";
import { formatBytes } from "../../lib/format";
import { IconButton } from "../ui/IconButton";
import { NumberField } from "../ui/NumberField";
import { Pill } from "../ui/Pill";
import { Popover } from "../ui/Popover";
import { Segmented } from "../ui/Segmented";
import { Slider } from "../ui/Slider";
import { StateBadge } from "../ui/misc";

/* ───────── Family picker pill (image models, 3D engines) ───────── */

interface FamilyOption {
  id: FamilyId;
  label: string;
  detail: string;
}

export function FamilyPill<T extends FamilyId>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: (FamilyOption & { id: T })[];
  onChange(v: T): void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const models = useEngineStore((s) => s.models);
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <>
      <Pill ref={ref} chevron aria-haspopup="dialog" aria-expanded={open} aria-label={`${ariaLabel}: ${current.label}`} onClick={() => setOpen((v) => !v)}>
        {current.label}
      </Pill>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={264} align="start" padding={6} ariaLabel={ariaLabel}>
        <div role="listbox" aria-label={ariaLabel} className="flex flex-col gap-0.5">
          {options.map((o) => {
            const st = models?.find((m) => m.id === o.id)?.state ?? "cold";
            const selected = o.id === value;
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className={`flex flex-col gap-0.5 rounded-[var(--r-sm)] px-2.5 py-2 text-left transition-colors hover:bg-hover ${selected ? "bg-accent-soft" : ""}`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className={`t-ui ${selected ? "text-accent" : "text-ink"}`}>{o.label}</span>
                  <StateBadge state={st} />
                </span>
                <span className="mono-sm text-ink-3">{o.detail}</span>
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

export const IMAGE_MODEL_OPTIONS: (FamilyOption & { id: ImageModel })[] = [
  { id: "z_image", label: "Z-Image Turbo", detail: "9 steps · 16 px grid" },
  { id: "qwen_image", label: "Qwen-Image 2.1", detail: "8 steps · 32 px grid" },
];

export function engineOptions(diskBytes: (id: FamilyId) => number | null): (FamilyOption & { id: "pixal3d" | "trellis2" })[] {
  const d = (id: FamilyId) => {
    const b = diskBytes(id) ?? staticFamily(id).files.reduce((a, f) => a + f.bytes, 0);
    return `${formatBytes(b)} on disk`;
  };
  return [
    { id: "pixal3d", label: "Pixal3D", detail: d("pixal3d") },
    { id: "trellis2", label: "TRELLIS.2", detail: d("trellis2") },
  ];
}

/* ───────── Aspect pill ───────── */

function RatioGlyph({ w, h, size = 14 }: { w: number; h: number; size?: number }) {
  const s = size - 2;
  const k = s / Math.max(w, h);
  const gw = Math.max(4, w * k);
  const gh = Math.max(4, h * k);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <rect x={(size - gw) / 2} y={(size - gh) / 2} width={gw} height={gh} rx={1.5} fill="none" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  );
}

interface AspectPillProps {
  width: number;
  height: number;
  aspect: AspectId | "custom";
  multiple: number;
  ratioLocked: boolean;
  onSize(w: number, h: number, aspect: AspectId | "custom"): void;
  onRatioLocked(v: boolean): void;
}

export function AspectPill({ width, height, aspect, multiple, ratioLocked, onSize, onRatioLocked }: AspectPillProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const snap = (v: number) => snapSize(v, multiple);
  const label = aspect === "custom" ? <span className="mono">{`${width} × ${height}`}</span> : aspect;
  return (
    <>
      <Pill
        ref={ref}
        chevron
        lead={<RatioGlyph w={width} h={height} />}
        aria-label={`Aspect ${aspect === "custom" ? `${width} by ${height}` : aspect}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </Pill>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={300} align="start" ariaLabel="Aspect ratio">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-5 gap-1.5">
            {ASPECT_PRESETS.map((p) => {
              const sel = aspect === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={sel}
                  onClick={() => {
                    onSize(snap(p.w), snap(p.h), p.id);
                    setOpen(false);
                  }}
                  className={`flex flex-col items-center gap-1 rounded-[var(--r-sm)] px-1 py-2 transition-colors hover:bg-hover ${sel ? "bg-accent-soft text-accent" : "text-ink-2"}`}
                >
                  <RatioGlyph w={p.w} h={p.h} size={20} />
                  <span className="t-caption">{p.id}</span>
                  <span className="mono-sm text-ink-3">
                    {p.w}×{p.h}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="h-px bg-hairline" />
          <div className="flex items-center gap-2">
            <span className="t-micro text-ink-3">W</span>
            <NumberField
              ariaLabel="Width"
              value={width}
              min={256}
              max={2048}
              step={multiple}
              normalize={snap}
              onCommit={(w) => onSize(w, ratioLocked ? snap((w * height) / width) : height, "custom")}
            />
            <IconButton
              icon={Link2}
              label={ratioLocked ? "Unlock ratio" : "Lock ratio"}
              pressed={ratioLocked}
              active={ratioLocked}
              size={28}
              iconSize={14}
              onClick={() => onRatioLocked(!ratioLocked)}
            />
            <span className="t-micro text-ink-3">H</span>
            <NumberField
              ariaLabel="Height"
              value={height}
              min={256}
              max={2048}
              step={multiple}
              normalize={snap}
              onCommit={(h) => onSize(ratioLocked ? snap((h * width) / height) : width, h, "custom")}
            />
          </div>
          <span className="t-caption text-ink-3">Snapped to a {multiple} px grid · 256–2048</span>
        </div>
      </Popover>
    </>
  );
}

/* ───────── Settings popover ───────── */

export interface SamplingSettings {
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}

interface SettingsButtonProps {
  value: SamplingSettings;
  defaults: SamplingSettings;
  samplers?: string[] | null;
  schedulers?: string[] | null;
  onChange(p: Partial<SamplingSettings>): void;
  onReset(): void;
  /** Extra rows (BATCH, RESOLUTION, negative prompt…). */
  extra?: ReactNode;
  extraDiffers?: boolean;
}

export function SettingsButton({ value, defaults, samplers, schedulers, onChange, onReset, extra, extraDiffers }: SettingsButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const differs =
    !!extraDiffers ||
    value.steps !== defaults.steps ||
    Math.abs(value.cfg - defaults.cfg) > 1e-6 ||
    value.sampler !== defaults.sampler ||
    value.scheduler !== defaults.scheduler;
  const sm = samplers?.length ? samplers : CURATED_SAMPLERS;
  const sc = schedulers?.length ? schedulers : CURATED_SCHEDULERS;
  return (
    <>
      <IconButton ref={ref} icon={SlidersHorizontal} label="Settings" tone={differs ? "accent" : "default"} aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={280} align="start" ariaLabel="Generation settings">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="t-subhead text-ink">Settings</span>
            <IconButton icon={RotateCcw} label="Reset to model defaults" size={28} iconSize={14} onClick={onReset} />
          </div>
          <Slider label="STEPS" micro value={value.steps} min={1} max={50} step={1} defaultValue={defaults.steps} onChange={(v) => onChange({ steps: v })} />
          <Slider label="CFG" micro value={value.cfg} min={1} max={10} step={0.1} defaultValue={defaults.cfg} format={(v) => v.toFixed(1)} onChange={(v) => onChange({ cfg: v })} />
          <SelectRow label="SAMPLER" value={value.sampler} options={sm} onChange={(v) => onChange({ sampler: v })} />
          <SelectRow label="SCHEDULER" value={value.scheduler} options={sc} onChange={(v) => onChange({ scheduler: v })} />
          {extra}
        </div>
      </Popover>
    </>
  );
}

export function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange(v: string): void }) {
  return (
    <label className="flex items-center gap-3">
      <span className="t-micro w-[76px] shrink-0 text-ink-3">{label}</span>
      <span className="relative flex-1">
        <select className="studio-select w-full" value={value} onChange={(e) => onChange(e.target.value)}>
          {(options.includes(value) ? options : [value, ...options]).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3" width={10} height={10} viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth={1.4} />
        </svg>
      </span>
    </label>
  );
}

export function SegmentRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange(v: T): void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="t-micro w-[76px] shrink-0 text-ink-3">{label}</span>
      <Segmented<T> ariaLabel={label} mono value={value} onChange={onChange} options={options.map((o) => ({ value: o, label: String(o) }))} />
    </div>
  );
}
