import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Pipette } from "lucide-react";
import { useEditStore } from "../../stores/edit";
import { IconButton } from "../../components/ui/IconButton";
import { Popover } from "../../components/ui/Popover";
import { Slider } from "../../components/ui/Slider";
import { Tooltip } from "../../components/ui/Tooltip";
import { RailDivider } from "../../components/ui/misc";
import { addCustom, DEFAULT_BRUSH_COLOR, displayedSwatches, hexToHsv, hsvToHex, normalizeHex, type HSV } from "./color";

/** Top-centre glass pill, visible while B / M / E is active (§5.2.3). */
export function BrushBar({ visible, onEyedropper, eyedropping }: { visible: boolean; onEyedropper(): void; eyedropping: boolean }) {
  const tool = useEditStore((s) => s.tool);
  const size = useEditStore((s) => s.brushSize);
  const hardP = useEditStore((s) => s.hardnessPaint);
  const hardM = useEditStore((s) => s.hardnessMask);
  const opacity = useEditStore((s) => s.opacity);
  const color = useEditStore((s) => s.color) || DEFAULT_BRUSH_COLOR;
  const custom = useEditStore((s) => s.customColors);
  const patch = useEditStore((s) => s.patch);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isMask = tool === "mask";
  const hardness = isMask ? hardM : hardP;
  const previewD = Math.max(4, Math.min(22, 4 + Math.log2(Math.max(1, size)) * 2));

  return (
    <div
      className={`glass no-scrollbar absolute left-1/2 flex h-11 max-w-[calc(100%-124px)] items-center gap-2.5 overflow-x-auto rounded-full px-3 transition-opacity duration-[var(--dur-fast)] ${visible ? "" : "pointer-events-none opacity-0"}`}
      style={{ top: 16, transform: "translateX(-50%)", zIndex: 20 }}
      aria-hidden={!visible}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden>
        <span
          className="rounded-full"
          style={{
            width: previewD,
            height: previewD,
            background: `radial-gradient(circle, var(--text-primary) ${hardness * 0.7}%, transparent 72%)`,
          }}
        />
      </span>
      <Slider
        ariaLabel="Brush size"
        label="SIZE"
        micro
        compact
        log
        value={size}
        min={1}
        max={512}
        step={1}
        defaultValue={48}
        width={144}
        format={(v) => `${Math.round(v)}`}
        onChange={(v) => patch({ brushSize: v })}
      />
      <Slider
        ariaLabel="Hardness"
        label="HARD"
        micro
        compact
        value={hardness}
        min={0}
        max={100}
        step={1}
        defaultValue={isMask ? 100 : 80}
        width={148}
        format={(v) => `${v}%`}
        onChange={(v) => patch(isMask ? { hardnessMask: v } : { hardnessPaint: v })}
      />
      {!isMask && (
        <Slider
          ariaLabel="Opacity"
          label="OPAC"
          micro
          compact
          value={opacity}
          min={1}
          max={100}
          step={1}
          defaultValue={100}
          width={148}
          format={(v) => `${v}%`}
          onChange={(v) => patch({ opacity: v })}
        />
      )}
      {tool === "brush" && (
        <>
          <RailDivider vertical />
          <div className="flex items-center gap-1.5">
            {displayedSwatches(custom).map((c, i) => (
              <button
                key={`${c}-${i}`}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={c.toUpperCase() === color.toUpperCase()}
                onClick={() => patch({ color: c })}
                className="h-5 w-5 rounded-[var(--r-xs)]"
                style={{
                  background: c,
                  boxShadow:
                    c.toUpperCase() === color.toUpperCase()
                      ? "0 0 0 1.5px var(--surface-elevated), 0 0 0 3px var(--accent)"
                      : "inset 0 0 0 1px var(--border-strong)",
                }}
              />
            ))}
            <Tooltip label="Colour">
              <button
                ref={chipRef}
                type="button"
                aria-label="Pick colour"
                onClick={() => setPickerOpen((v) => !v)}
                className="ml-1 flex h-6 items-center gap-1.5 rounded-full bg-sunken pl-1 pr-2"
              >
                <span className="h-4 w-4 rounded-full" style={{ background: color, boxShadow: "inset 0 0 0 1px var(--border-strong)" }} />
                <span className="mono-sm text-ink-2">{color.toUpperCase()}</span>
              </button>
            </Tooltip>
          </div>
          <Popover open={pickerOpen} onClose={() => setPickerOpen(false)} anchor={chipRef} placement="bottom" width={240} surface="menu" ariaLabel="Colour picker">
            <ColorPicker
              value={color}
              eyedropping={eyedropping}
              onEyedropper={() => {
                setPickerOpen(false);
                onEyedropper();
              }}
              onChange={(c) => patch({ color: c })}
              onCommit={(c) => patch({ color: c, customColors: addCustom(useEditStore.getState().customColors, c) })}
            />
          </Popover>
        </>
      )}
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
  onCommit,
  onEyedropper,
  eyedropping,
}: {
  value: string;
  onChange(c: string): void;
  onCommit(c: string): void;
  onEyedropper(): void;
  eyedropping: boolean;
}) {
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(value));
  const [hex, setHex] = useState(value.toUpperCase());
  const sv = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const latest = useRef(value);

  useEffect(() => {
    if (value.toUpperCase() !== latest.current.toUpperCase()) {
      setHsv(hexToHsv(value));
      setHex(value.toUpperCase());
      latest.current = value;
    }
  }, [value]);

  const apply = (next: HSV) => {
    setHsv(next);
    const h = hsvToHex(next);
    latest.current = h;
    setHex(h);
    onChange(h);
  };

  const dragOn = (el: HTMLDivElement | null, e: RPointerEvent, fn: (x: number, y: number) => void) => {
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const update = (cx: number, cy: number) => fn(Math.min(1, Math.max(0, (cx - r.left) / r.width)), Math.min(1, Math.max(0, (cy - r.top) / r.height)));
    update(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => update(ev.clientX, ev.clientY);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      onCommit(latest.current);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div className="flex flex-col gap-3 p-2">
      <div
        ref={sv}
        role="slider"
        aria-label="Saturation and value"
        aria-valuetext={hex}
        tabIndex={0}
        className="relative h-36 w-full cursor-crosshair rounded-[var(--r-sm)]"
        style={{ background: `linear-gradient(to top, black, transparent), linear-gradient(to right, white, hsl(${hsv.h} 100% 50%))` }}
        onPointerDown={(e) => dragOn(sv.current, e, (x, y) => apply({ ...hsv, s: x, v: 1 - y }))}
      >
        <span
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, boxShadow: "0 0 0 1.5px white, 0 0 0 2.5px rgba(0,0,0,0.4)" }}
        />
      </div>
      <div
        ref={hue}
        role="slider"
        aria-label="Hue"
        aria-valuenow={Math.round(hsv.h)}
        tabIndex={0}
        className="relative h-3 w-full rounded-full"
        style={{
          background:
            "linear-gradient(to right, hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))",
        }}
        onPointerDown={(e) => dragOn(hue.current, e, (x) => apply({ ...hsv, h: x * 360 }))}
      >
        <span
          className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-elevated"
          style={{ left: `${(hsv.h / 360) * 100}%`, boxShadow: "var(--shadow-1), inset 0 0 0 1px var(--border-strong)" }}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          aria-label="Hex colour"
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onBlur={() => {
            const n = normalizeHex(hex);
            if (n) {
              setHsv(hexToHsv(n));
              latest.current = n;
              onChange(n);
              onCommit(n);
            } else setHex(latest.current.toUpperCase());
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="mono h-7 min-w-0 flex-1 rounded-[var(--r-sm)] bg-sunken px-2 text-ink outline-none"
        />
        <IconButton icon={Pipette} label="Eyedropper" shortcut="Alt" active={eyedropping} size={28} onClick={onEyedropper} />
      </div>
    </div>
  );
}
