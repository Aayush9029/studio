/* Pixel-square matrix meter graph rendered in pure SVG from recent telemetry history. */

import { memo, type ReactNode } from "react";

interface SquareMeterGraphProps {
  /** Recent percentage values in [0, 100] (null = unavailable). Oldest left, newest right. */
  samples: readonly (number | null)[];
  cols?: number;
  rows?: number;
  cellSize?: number;
  gap?: number;
  color: string;
  warnColor?: string;
  warnAt?: number;
  ariaLabel: string;
  className?: string;
}

export const SquareMeterGraph = memo(function SquareMeterGraph({
  samples,
  cols = 24,
  rows = 6,
  cellSize = 4,
  gap = 2,
  color,
  warnColor = "var(--warn)",
  warnAt = 90,
  ariaLabel,
  className,
}: SquareMeterGraphProps) {
  const width = cols * cellSize + Math.max(0, cols - 1) * gap;
  const height = rows * cellSize + Math.max(0, rows - 1) * gap;
  const start = Math.max(0, samples.length - cols);
  const pad = cols - (samples.length - start);
  const rx = cellSize <= 3 ? 0.6 : 1;

  const rects: ReactNode[] = [];
  for (let c = 0; c < cols; c++) {
    const val = c < pad ? null : (samples[start + (c - pad)] ?? null);
    const hasVal = val !== null && Number.isFinite(val);
    const pct = hasVal ? Math.max(0, Math.min(100, val as number)) : 0;
    const lit = hasVal ? (pct <= 0.2 ? 0 : Math.max(1, Math.min(rows, Math.round((pct / 100) * rows)))) : 0;
    const x = c * (cellSize + gap);
    const activeColor = hasVal && pct >= warnAt ? warnColor : color;

    for (let r = 0; r < rows; r++) {
      const y = (rows - 1 - r) * (cellSize + gap);
      const on = r < lit;
      rects.push(
        <rect
          key={c * rows + r}
          x={x}
          y={y}
          width={cellSize}
          height={cellSize}
          rx={rx}
          fill={on ? activeColor : "var(--text-primary)"}
          fillOpacity={on ? (r === lit - 1 ? 1 : 0.72) : hasVal ? 0.08 : 0.04}
        />,
      );
    }
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      className={`block shrink-0 ${className ?? ""}`}
    >
      {rects}
    </svg>
  );
});
