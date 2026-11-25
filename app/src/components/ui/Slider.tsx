import { useId, type KeyboardEvent } from "react";

interface SliderProps {
  label?: string;
  /** Uppercase micro label (`STEPS`). */
  micro?: boolean;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue?: number;
  onChange(v: number): void;
  format?(v: number): string;
  /** Logarithmic mapping (brush size). */
  log?: boolean;
  width?: number | string;
  hideValue?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

const RES = 1000;

/** 4 px track, accent fill, 14 px thumb; value in mono at right. Arrows ±1 step, Shift ±10, dblclick resets (§4). */
export function Slider({ label, micro, value, min, max, step, defaultValue, onChange, format, log, width, hideValue, disabled, ariaLabel }: SliderProps) {
  const id = useId();
  const toPos = (v: number) => {
    if (log) return (Math.log(Math.max(v, min) / min) / Math.log(max / min)) * RES;
    return ((v - min) / (max - min)) * RES;
  };
  const fromPos = (p: number) => {
    const t = p / RES;
    const raw = log ? min * Math.pow(max / min, t) : min + t * (max - min);
    return quantize(raw);
  };
  const quantize = (v: number) => {
    const q = Math.round(v / step) * step;
    const clamped = Math.min(max, Math.max(min, q));
    return Number(clamped.toFixed(4));
  };
  const pos = toPos(value);
  const fill = `${(pos / RES) * 100}%`;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const mult = e.shiftKey ? 10 : 1;
    if (log) {
      const f = Math.pow(1.1, dir * mult);
      onChange(quantize(Math.max(min, value * f + dir)));
    } else onChange(quantize(value + dir * step * mult));
  };

  return (
    <div className="flex items-center gap-3" style={{ width }}>
      {label && (
        <label htmlFor={id} className={`${micro ? "t-micro" : "t-caption"} w-[76px] shrink-0 text-ink-3`}>
          {label}
        </label>
      )}
      <input
        id={id}
        type="range"
        className="studio-range min-w-0 flex-1"
        min={0}
        max={RES}
        step={1}
        value={pos}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-valuetext={format ? format(value) : String(value)}
        style={{ ["--fill" as string]: fill }}
        onChange={(e) => onChange(fromPos(Number(e.target.value)))}
        onKeyDown={onKey}
        onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
      />
      {!hideValue && <span className="mono w-[52px] shrink-0 text-right text-ink">{format ? format(value) : value}</span>}
    </div>
  );
}
