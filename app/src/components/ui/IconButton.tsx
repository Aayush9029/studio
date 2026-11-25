import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { Tooltip, type TooltipSide } from "./Tooltip";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: LucideIcon;
  /** Tooltip text; also the aria-label (§10.1). */
  label: string;
  shortcut?: string;
  variant?: "ghost" | "glass" | "danger";
  /** Selected/active (accent glyph on accent-soft). */
  active?: boolean;
  /** Toggle state → aria-pressed. */
  pressed?: boolean;
  size?: number;
  iconSize?: number;
  tooltipSide?: TooltipSide;
  /** Glyph colour override (e.g. accent when a value differs from default). */
  tone?: "default" | "accent";
  iconClassName?: string;
  /** Tooltip copy when disabled (e.g. "Paint a mask first"). */
  disabledLabel?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon: Icon,
    label,
    shortcut,
    variant = "ghost",
    active,
    pressed,
    size = 32,
    iconSize = 16,
    tooltipSide = "top",
    tone = "default",
    className,
    iconClassName,
    disabledLabel,
    disabled,
    ...rest
  },
  ref,
) {
  const base =
    "group relative inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,color,opacity] duration-[var(--dur-instant)] disabled:opacity-40";
  const variantCls =
    variant === "glass"
      ? "glass text-ink-2 hover:text-ink"
      : variant === "danger"
        ? "text-ink-2 hover:bg-hover hover:text-danger active:bg-active"
        : "text-ink-2 hover:bg-hover hover:text-ink active:bg-active";
  const activeCls = active ? "!bg-accent-soft !text-accent" : tone === "accent" ? "!text-accent" : "";
  const tip = disabled && disabledLabel ? disabledLabel : label;
  return (
    <Tooltip label={tip} shortcut={disabled && disabledLabel ? undefined : shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        className={`${base} ${variantCls} ${activeCls} ${className ?? ""}`}
        style={{ width: size, height: size }}
        {...rest}
      >
        <Icon size={iconSize} strokeWidth={1.75} absoluteStrokeWidth className={iconClassName} />
      </button>
    </Tooltip>
  );
});
