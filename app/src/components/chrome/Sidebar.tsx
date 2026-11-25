import { Box, Brush, Image, LayoutGrid, Moon, PanelLeftClose, PanelLeftOpen, Sun, type LucideIcon } from "lucide-react";
import type { WorkspaceId } from "../../shared/contract";
import { useEngineStore } from "../../stores/engine";
import { useJobStore } from "../../stores/job";
import { useUiStore } from "../../stores/ui";
import { studio } from "../../lib/studio";
import { whisperError } from "../../lib/errors";
import { toStudioError } from "../../lib/engine/http";
import { IconButton } from "../ui/IconButton";
import { Tooltip } from "../ui/Tooltip";
import { MemoryPill } from "./MemoryPill";

const ROWS: { id: WorkspaceId; label: string; icon: LucideIcon; key: string }[] = [
  { id: "generate", label: "Generate", icon: Image, key: "Ctrl+1" },
  { id: "edit", label: "Edit", icon: Brush, key: "Ctrl+2" },
  { id: "three", label: "3D", icon: Box, key: "Ctrl+3" },
  { id: "library", label: "Library", icon: LayoutGrid, key: "Ctrl+4" },
];

/** Full-height glass sidebar, 212 ↔ 56 px (§3.4). */
export function Sidebar() {
  const collapsedPref = useUiStore((s) => s.sidebarCollapsed);
  const narrow = useUiStore((s) => s.narrow);
  const collapsed = collapsedPref || narrow;
  const workspace = useUiStore((s) => s.workspace);
  const setWorkspace = useUiStore((s) => s.setWorkspace);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const jobOwner = useJobStore((s) => s.active?.owner ?? null);
  const blender = useEngineStore((s) => s.blender);

  const blenderConnected = !!blender?.connected;
  const blenderTip = blenderConnected
    ? `Blender ${blender?.blenderVersion?.split(".").slice(0, 2).join(".") ?? ""} connected`.replace("  ", " ")
    : blender && !blender.installed
      ? "Blender not installed"
      : "Blender not running — click to open";

  const launchBlender = () => {
    if (blenderConnected) return;
    studio.blender.launch().catch((e) => whisperError(toStudioError(e)));
  };

  return (
    <nav
      aria-label="Workspaces"
      className="glass relative flex h-full shrink-0 flex-col border-y-0 border-l-0 transition-[width] duration-[var(--dur-base)] ease-[var(--ease-in-out)]"
      style={{ width: collapsed ? "var(--sidebar-rail-w)" : "var(--sidebar-w)", boxShadow: "inset 0 1px 0 var(--border-glass)", zIndex: 30 }}
    >
      <div className="drag flex h-[var(--titlebar-h)] shrink-0 items-center pl-3">
        <IconButton
          icon={collapsed ? PanelLeftOpen : PanelLeftClose}
          iconSize={18}
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          shortcut="Ctrl+\"
          tooltipSide="right"
          onClick={toggleSidebar}
          disabled={narrow}
        />
      </div>

      <ul className="m-0 mt-4 flex list-none flex-col gap-0.5 p-0 px-2">
        {ROWS.map((r) => {
          const active = r.id === workspace;
          const bg = jobOwner === r.id && !active;
          const Icon = r.icon;
          const row = (
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              aria-label={r.label}
              onClick={() => setWorkspace(r.id)}
              className={`t-ui flex h-9 w-full items-center gap-3 overflow-hidden rounded-[var(--r-sm)] px-[11px] text-left transition-colors duration-[var(--dur-instant)] ${
                active ? "bg-active text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
              }`}
            >
              <span className={`relative inline-flex shrink-0 ${active ? "text-accent" : ""}`}>
                <Icon size={18} strokeWidth={1.75} absoluteStrokeWidth />
                {bg && <span aria-label="Working" className="anim-pulse absolute -right-1 -top-1 h-[5px] w-[5px] rounded-full bg-accent" />}
              </span>
              <span
                className="truncate transition-opacity"
                style={{ opacity: collapsed ? 0 : 1, transitionDuration: collapsed ? "var(--dur-instant)" : "var(--dur-base)" }}
              >
                {r.label}
              </span>
            </button>
          );
          return (
            <li key={r.id}>
              {collapsed ? (
                <Tooltip label={r.label} shortcut={r.key} side="right" block>
                  {row}
                </Tooltip>
              ) : (
                row
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex-1" />

      <div className="flex flex-col gap-1.5 p-3">
        <MemoryPill collapsed={collapsed} />
        <Tooltip label={blenderTip} side="right" block>
          <button
            type="button"
            aria-label={blenderTip}
            onClick={launchBlender}
            className={`flex h-8 w-full items-center gap-2.5 rounded-[var(--r-sm)] px-3 text-ink-2 transition-colors ${
              blenderConnected ? "cursor-default" : "hover:bg-hover hover:text-ink"
            } ${collapsed ? "justify-center px-0" : ""}`}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={blenderConnected ? { background: "var(--sage)" } : { boxShadow: "inset 0 0 0 1px var(--text-faint)" }}
            />
            {!collapsed && <span className="t-ui">Blender</span>}
          </button>
        </Tooltip>
        <div className={collapsed ? "flex justify-center" : "flex"}>
          <IconButton
            icon={theme === "zen-dark" ? Sun : Moon}
            label={theme === "zen-dark" ? "Zen Light" : "Zen Dark"}
            shortcut="Ctrl+Shift+L"
            tooltipSide="right"
            onClick={toggleTheme}
          />
        </div>
      </div>
    </nav>
  );
}
