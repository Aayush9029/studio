import { useEffect, useRef, useState, type DragEvent } from "react";
import { Box, Brush, Image, LayoutGrid, Moon, PanelLeftClose, PanelLeftOpen, Sun, type LucideIcon } from "lucide-react";
import type { WorkspaceId } from "../../shared/contract";
import { hasStudioDrag, useDragStore } from "../../stores/drag";
import { useEditStore } from "../../stores/edit";
import { useEngineStore } from "../../stores/engine";
import { useGenerateStore } from "../../stores/generate";
import { useJobStore } from "../../stores/job";
import { useThreeStore } from "../../stores/three";
import { useUiStore } from "../../stores/ui";
import { makeIn3D, openInEdit, showIn3D } from "../../lib/actions";
import { toStudioError } from "../../lib/engine/http";
import { whisperError } from "../../lib/errors";
import { imageFileFromEvent, pathForFile } from "../../lib/images";
import { studio, toUrl } from "../../lib/studio";
import { BlenderIcon } from "../ui/EmptyStateIcons";
import { IconButton } from "../ui/IconButton";
import { Tooltip } from "../ui/Tooltip";
import { MemoryPill } from "./MemoryPill";

const ROWS: { id: WorkspaceId; label: string; icon: LucideIcon; key: string }[] = [
  { id: "generate", label: "Generate", icon: Image, key: "Ctrl+1" },
  { id: "edit", label: "Edit", icon: Brush, key: "Ctrl+2" },
  { id: "three", label: "3D", icon: Box, key: "Ctrl+3" },
  { id: "library", label: "Library", icon: LayoutGrid, key: "Ctrl+4" },
];

const SPRING_OPEN_MS = 1000;

/** Full-height glass sidebar, 212 ↔ 56 px (§3.4), with spring-loaded drag-hover switching. */
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

  const [hoverWs, setHoverWs] = useState<WorkspaceId | null>(null);
  const springTimer = useRef<number>(0);

  const clearSpring = () => {
    if (springTimer.current) {
      window.clearTimeout(springTimer.current);
      springTimer.current = 0;
    }
    setHoverWs(null);
  };

  useEffect(() => () => clearSpring(), []);

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

  const onTabDragOver = (ws: WorkspaceId) => (e: DragEvent) => {
    if (!hasStudioDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    useDragStore.getState().setHoverTarget(`Open ${ROWS.find((r) => r.id === ws)?.label ?? ws}`);
    if (hoverWs !== ws) {
      if (springTimer.current) window.clearTimeout(springTimer.current);
      setHoverWs(ws);
      springTimer.current = window.setTimeout(() => {
        springTimer.current = 0;
        setWorkspace(ws);
        setHoverWs(null);
      }, SPRING_OPEN_MS);
    }
  };

  const onTabDragLeave = (ws: WorkspaceId) => (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (hoverWs === ws) clearSpring();
    useDragStore.getState().setHoverTarget(null);
  };

  const onTabDrop = (ws: WorkspaceId) => (e: DragEvent) => {
    if (!hasStudioDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    clearSpring();
    const drag = useDragStore.getState().item;
    useDragStore.getState().end();
    const file = imageFileFromEvent(e.dataTransfer);

    if (ws === "edit") {
      if (drag?.item) openInEdit(drag.item);
      else if (drag) {
        useEditStore.getState().requestOpen({ url: toUrl(drag.path), name: drag.name });
        setWorkspace("edit");
      } else if (file) {
        useEditStore.getState().requestOpen({ blob: file, name: file.name });
        setWorkspace("edit");
      } else setWorkspace("edit");
      return;
    }

    if (ws === "three") {
      if (drag?.item?.kind === "3d") showIn3D(drag.item);
      else if (drag?.item) makeIn3D(drag.item);
      else if (drag) {
        const t = useThreeStore.getState();
        t.patch({ mode: "i23d" });
        t.setSource({ path: drag.path, blob: null, url: toUrl(drag.path), sourceId: null });
        setWorkspace("three");
      } else if (file) {
        const p = pathForFile(file);
        const t = useThreeStore.getState();
        t.patch({ mode: "i23d" });
        t.setSource({ path: p, blob: p ? null : file, url: URL.createObjectURL(file), sourceId: null });
        setWorkspace("three");
      } else setWorkspace("three");
      return;
    }

    if (ws === "generate") {
      setWorkspace("generate");
      if (useUiStore.getState().ignoreGenerateDrop) return;
      if (drag) {
        useGenerateStore.getState().requestDrop({ url: drag.previewUrl || toUrl(drag.path), name: drag.name, sourceId: drag.item?.id ?? null });
      } else if (file) {
        useGenerateStore.getState().requestDrop({ blob: file, url: URL.createObjectURL(file), name: file.name, sourceId: null });
      }
      return;
    }

    setWorkspace(ws);
  };

  return (
    <nav
      aria-label="Workspaces"
      className="glass relative flex h-full shrink-0 flex-col border-y-0 border-l-0 transition-[width] duration-[360ms] ease-[var(--ease-out)]"
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
          const draggingOver = hoverWs === r.id;
          const Icon = r.icon;
          const row = (
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              aria-label={r.label}
              onClick={() => setWorkspace(r.id)}
              onDragOver={onTabDragOver(r.id)}
              onDragLeave={onTabDragLeave(r.id)}
              onDrop={onTabDrop(r.id)}
              className={`t-ui relative flex h-9 w-full items-center gap-3 overflow-hidden rounded-[var(--r-sm)] px-[11px] text-left transition-colors duration-[var(--dur-instant)] ${
                active ? "bg-active text-ink" : draggingOver ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
              }`}
              style={draggingOver ? { boxShadow: "inset 0 0 0 1px var(--accent-ring)" } : undefined}
            >
              <span className={`relative inline-flex shrink-0 ${active || draggingOver ? "text-accent" : ""}`}>
                <Icon size={18} strokeWidth={1.75} absoluteStrokeWidth />
                {bg && <span aria-label="Working" className="anim-pulse absolute -right-1 -top-1 h-[5px] w-[5px] rounded-full bg-accent" />}
              </span>
              <span
                className="truncate transition-opacity"
                style={{ opacity: collapsed ? 0 : 1, transitionDuration: collapsed ? "var(--dur-instant)" : "300ms" }}
              >
                {r.label}
              </span>
              {draggingOver && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-accent"
                  style={{ animation: `studio-spring ${SPRING_OPEN_MS}ms linear forwards` }}
                />
              )}
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
        {workspace === "three" && (
          <Tooltip label={blenderTip} side="right" block>
            <button
              type="button"
              aria-label={blenderTip}
              onClick={launchBlender}
              className={`anim-enter flex h-8 w-full items-center gap-2.5 rounded-[var(--r-sm)] px-3 text-ink-2 transition-colors ${
                blenderConnected ? "cursor-default text-ink" : "hover:bg-hover hover:text-ink"
              } ${collapsed ? "justify-center px-0" : ""}`}
            >
              <BlenderIcon size={16} colored={blenderConnected} className="shrink-0" />
              {!collapsed && <span className="t-ui truncate">{blenderConnected ? "Blender" : "Open Blender"}</span>}
            </button>
          </Tooltip>
        )}
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
