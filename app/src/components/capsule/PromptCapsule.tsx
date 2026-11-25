import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dices, Lock, LockOpen, Sparkles } from "lucide-react";
import type { EnhanceStyle, WorkspaceId } from "../../shared/contract";
import { SEED_MAX } from "../../shared/contract";
import { enginePhase, useEngineStore, useInklingAvailable } from "../../stores/engine";
import { useJobStore } from "../../stores/job";
import { useUiStore } from "../../stores/ui";
import { randomSeed } from "../../stores/generate";
import { engineHttp, toStudioError } from "../../lib/engine/http";
import { whisperError } from "../../lib/errors";
import { copySeed } from "../../lib/actions";
import { IconButton } from "../ui/IconButton";
import { Menu } from "../ui/Menu";
import { Tooltip } from "../ui/Tooltip";

/* ───────── Shell ───────── */

const CapsuleWidth = createContext(760);
export const useCapsuleWidth = () => useContext(CapsuleWidth);

interface ShellProps {
  ws: WorkspaceId;
  bottom: number | string;
  children: ReactNode;
  hidden?: boolean;
  dimmed?: boolean;
}

/** Floating frosted capsule shared by Generate, Edit and 3D (§5.1.2). */
export function CapsuleShell({ ws, bottom, children, hidden, dimmed }: ShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const setH = useUiStore((s) => s.setCapsuleH);
  const [width, setWidth] = useState(760);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setH(ws, Math.round(el.offsetHeight));
      setWidth(el.offsetWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ws, setH]);
  return (
    <CapsuleWidth.Provider value={width}>
      <div
        ref={ref}
        className={`glass-strong absolute left-1/2 flex flex-col gap-2 rounded-[var(--r-xl)] px-3.5 py-3 transition-opacity duration-[var(--dur-fast)] ${
          hidden ? "pointer-events-none opacity-0" : dimmed ? "opacity-40" : "opacity-100"
        }`}
        style={{
          bottom,
          width: "min(var(--capsule-max-w), max(var(--capsule-min-w), calc(100% - 96px)))",
          transform: "translateX(-50%)",
          boxShadow: "inset 0 1px 0 var(--border-glass), var(--shadow-3)",
          zIndex: 20,
        }}
      >
        {children}
      </div>
    </CapsuleWidth.Provider>
  );
}

export function CapsuleRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-w-0 items-center gap-2 ${className ?? ""}`}>{children}</div>;
}

/* ───────── Prompt field ───────── */

export interface PromptFieldHandle {
  focus(): void;
  /** Replace the text through the native undo stack (Ctrl+Z restores). */
  replace(text: string): void;
  el(): HTMLTextAreaElement | null;
}

interface PromptFieldProps {
  value: string;
  onChange(v: string): void;
  placeholder: string;
  maxLines?: number;
  variant?: "prompt" | "body";
  disabled?: boolean;
  ariaLabel: string;
  trailing?: ReactNode;
}

export const PromptField = forwardRef<PromptFieldHandle, PromptFieldProps>(function PromptField(
  { value, onChange, placeholder, maxLines = 6, variant = "prompt", disabled, ariaLabel, trailing },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const lineH = variant === "prompt" ? 24 : 22;

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    el: () => ta.current,
    replace: (text: string) => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.select();
      // execCommand keeps the browser's undo stack intact.
      const ok = document.execCommand("insertText", false, text);
      if (!ok) onChange(text);
    },
  }));

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    const h = Math.min(el.scrollHeight, lineH * maxLines);
    el.style.height = `${Math.max(lineH, h)}px`;
    el.style.overflowY = el.scrollHeight > lineH * maxLines ? "auto" : "hidden";
  }, [value, lineH, maxLines]);

  return (
    <div className="flex min-w-0 items-start gap-2">
      <textarea
        ref={ta}
        rows={1}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck
        onChange={(e) => onChange(e.target.value)}
        className={`${variant === "prompt" ? "t-prompt" : "t-body"} min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-0 text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none disabled:opacity-60`}
        style={{ lineHeight: `${lineH}px` }}
      />
      {trailing}
    </div>
  );
});

/* ───────── Seed pill ───────── */

interface SeedPillProps {
  seed: number;
  locked: boolean;
  onSeed(s: number): void;
  onLock(l: boolean): void;
}

/** Dice · editable mono seed · lock toggle (§5.1.2). Collapses to the dice below 700 px capsule width. */
export function SeedPill({ seed, locked, onSeed, onLock }: SeedPillProps) {
  const width = useCapsuleWidth();
  const compact = width < 700;
  const [text, setText] = useState(String(seed));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => setText(String(seed)), [seed]);

  const commit = () => {
    const n = Number(text.trim());
    if (Number.isInteger(n) && n >= 0 && n <= SEED_MAX) onSeed(n);
    else setText(String(seed));
  };

  if (compact) {
    return (
      <IconButton
        icon={Dices}
        label={`Seed ${seed}${locked ? " (locked)" : ""} — randomize`}
        onClick={() => onSeed(randomSeed())}
        tone={locked ? "accent" : "default"}
        onContextMenu={(e) => {
          e.preventDefault();
          onLock(!locked);
        }}
      />
    );
  }

  return (
    <div className="flex h-7 shrink-0 items-center rounded-full bg-sunken pl-0.5 pr-0.5" onContextMenu={(e) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    }}>
      <IconButton icon={Dices} label="Randomize seed" size={24} iconSize={14} onClick={() => onSeed(randomSeed())} />
      <input
        type="text"
        inputMode="numeric"
        aria-label="Seed"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "c" && e.ctrlKey && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
            void copySeed(seed);
          }
        }}
        className="mono w-[88px] border-0 bg-transparent px-1 text-ink outline-none"
      />
      <IconButton
        icon={locked ? Lock : LockOpen}
        label={locked ? "Seed locked" : "Seed changes each run"}
        pressed={locked}
        size={24}
        iconSize={14}
        tone={locked ? "accent" : "default"}
        onClick={() => onLock(!locked)}
      />
      <Menu
        open={!!menu}
        onClose={() => setMenu(null)}
        anchor={menu ?? { x: 0, y: 0 }}
        ariaLabel="Seed"
        placement="top"
        width={160}
        items={[{ id: "copy", label: "Copy seed", onSelect: () => void copySeed(seed) }]}
      />
    </div>
  );
}

/* ───────── Enhance ───────── */

interface EnhanceProps {
  on: boolean;
  onToggle(): void;
  busy: boolean;
  onEnhanceNow(): void;
}

/** Sparkles: rendered only while Inkling is reachable. Click toggles auto-enhance; Shift-click / Ctrl+E enhances in place. */
export function EnhanceButton({ on, onToggle, busy, onEnhanceNow }: EnhanceProps) {
  const available = useInklingAvailable();
  if (!available) return null;
  return (
    <IconButton
      icon={Sparkles}
      label="Enhance prompt"
      shortcut="Ctrl+E"
      pressed={on}
      active={on}
      iconClassName={busy ? "anim-spin" : ""}
      onClick={(e) => (e.shiftKey ? onEnhanceNow() : onToggle())}
    />
  );
}

/** Enhances `text` in place via POST /api/enhance-prompt. */
export async function enhanceInPlace(field: PromptFieldHandle | null, text: string, style: EnhanceStyle): Promise<void> {
  const idea = text.trim();
  if (!idea || !field) return;
  try {
    const res = await engineHttp.enhance({ idea: idea.slice(0, 2000), style });
    if (res.enhanced && res.prompt) field.replace(res.prompt);
    else useUiStore.getState().say("Enhance is unavailable right now.");
  } catch (e) {
    whisperError(toStudioError(e));
  }
}

/* ───────── Primary gate ───────── */

export interface PrimaryGate {
  running: boolean;
  progress: number;
  disabled: boolean;
  reason?: string;
  pending: boolean;
}

/** Shared enable/disable rules for each workspace's primary action (§8.1). */
export function usePrimaryGate(ws: WorkspaceId, hasInput: boolean, inputReason: string): PrimaryGate {
  const phase = useEngineStore((s) => enginePhase(s));
  // Primitive, per-workspace selectors: a hidden capsule doesn't re-render on another workspace's
  // step progress — only when its own job's progress or the coarse busy/submitting flags change.
  const running = useJobStore((s) => s.active?.owner === ws);
  const progress = useJobStore((s) => (s.active?.owner === ws ? s.active.progress : 0));
  const busyElsewhere = useJobStore((s) => !!s.active && s.active.owner !== ws);
  const submitBlocked = useJobStore((s) => !!s.submitting && s.submitting !== ws);
  const pending = useJobStore((s) => s.submitting === ws);
  let reason: string | undefined;
  if (phase === "starting") reason = "Engine is starting";
  else if (phase === "stopped") reason = "Engine stopped";
  else if (busyElsewhere) reason = "Busy — one thing at a time";
  else if (!hasInput) reason = inputReason;
  return { running, progress, disabled: !!reason || submitBlocked, reason, pending };
}

export function MicroLabel({ children }: { children: ReactNode }) {
  return <span className="t-micro text-ink-3">{children}</span>;
}

export function Spacer() {
  return <div className="min-w-0 flex-1" />;
}

export { Tooltip };
