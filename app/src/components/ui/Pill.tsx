import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon;
  /** Custom leading glyph (e.g. aspect-ratio rectangle). */
  lead?: ReactNode;
  /** Trailing ChevronDown when the pill opens a popover. */
  chevron?: boolean;
  selected?: boolean;
  tone?: "default" | "danger" | "danger-solid" | "accent";
  mono?: boolean;
  height?: number;
}

/** 28 px pill (§4). */
export const Pill = forwardRef<HTMLButtonElement, PillProps>(function Pill(
  { icon: Icon, lead, chevron, selected, tone = "default", mono, height = 28, className, children, ...rest },
  ref,
) {
  const toneCls =
    tone === "danger-solid"
      ? "bg-danger text-on-accent hover:opacity-90"
      : tone === "danger"
        ? "bg-sunken text-danger hover:bg-danger-soft"
        : tone === "accent"
          ? "bg-accent-soft text-accent hover:opacity-90"
          : selected
            ? "bg-accent-soft text-accent"
            : "bg-sunken text-ink hover:bg-hover";
  return (
    <button
      ref={ref}
      type="button"
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 transition-[background-color,color,opacity] duration-[var(--dur-instant)] disabled:opacity-40 ${
        mono ? "mono" : "t-ui"
      } ${toneCls} ${className ?? ""}`}
      style={{ height }}
      {...rest}
    >
      {lead}
      {Icon && <Icon size={14} strokeWidth={1.75} absoluteStrokeWidth />}
      {children}
      {chevron && <ChevronDown size={12} strokeWidth={1.75} absoluteStrokeWidth className="-mr-0.5 opacity-70" />}
    </button>
  );
});
