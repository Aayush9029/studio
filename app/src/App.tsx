import { useEffect, type ComponentType } from "react";
import type { WorkspaceId } from "./shared/contract";
import { useUiStore } from "./stores/ui";
import { useJobStore } from "./stores/job";
import { useInklingAvailable } from "./stores/engine";
import { applyTheme } from "./lib/boot";
import { commandsFor } from "./lib/commands";
import { cancelActiveJob } from "./lib/engine/jobs";
import { closeTopLayer, isTypingTarget } from "./lib/layers";
import { Sidebar } from "./components/chrome/Sidebar";
import { Titlebar } from "./components/chrome/Titlebar";
import { ModelsDrawer } from "./components/chrome/ModelsDrawer";
import { QueueDrawer } from "./components/chrome/QueueDrawer";
import { DragOverlay } from "./components/chrome/DragOverlay";
import { WhisperHost } from "./components/chrome/WhisperHost";
import GenerateWorkspace from "./workspaces/generate/GenerateWorkspace";
import EditWorkspace from "./workspaces/edit/EditWorkspace";
import ThreeWorkspace from "./workspaces/three/ThreeWorkspace";
import LibraryWorkspace from "./workspaces/library/LibraryWorkspace";

const WORKSPACES: { id: WorkspaceId; Component: ComponentType<{ active: boolean }> }[] = [
  { id: "generate", Component: GenerateWorkspace },
  { id: "edit", Component: EditWorkspace },
  { id: "three", Component: ThreeWorkspace },
  { id: "library", Component: LibraryWorkspace },
];
const ORDER: WorkspaceId[] = ["generate", "edit", "three", "library"];
const NARROW_PX = 1200;

function useGlobalKeys(): void {
  const inkling = useInklingAvailable();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUiStore.getState();
      const ws = ui.workspace;
      const typing = isTypingTarget(e.target);
      const cmds = commandsFor(ws);
      const key = e.key.toLowerCase();

      if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        ui.setWorkspace(ORDER[Number(e.key) - 1]);
        return;
      }
      if (e.ctrlKey && e.key === "\\") {
        e.preventDefault();
        ui.toggleSidebar();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && key === "m") {
        e.preventDefault();
        ui.toggleModels();
        return;
      }
      if (e.ctrlKey && e.shiftKey && key === "l") {
        e.preventDefault();
        ui.toggleTheme();
        return;
      }
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        cmds?.run?.();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && key === "e" && ws !== "library") {
        e.preventDefault();
        if (inkling) cmds?.enhance?.();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && key === "l") {
        e.preventDefault();
        cmds?.focusPrompt?.();
        return;
      }
      if (e.key === "Escape") {
        if (closeTopLayer()) {
          e.preventDefault();
          return;
        }
        if (cmds?.escape?.()) {
          e.preventDefault();
          return;
        }
        const job = useJobStore.getState().active;
        if (job && job.owner === ws && !typing) {
          e.preventDefault();
          void cancelActiveJob();
          return;
        }
        if (typing) (e.target as HTMLElement).blur();
        return;
      }
      if (e.repeat && (e.key === " " || e.key === "Alt")) {
        e.preventDefault();
        return;
      }
      if (cmds?.key?.(e, typing)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => commandsFor(useUiStore.getState().workspace)?.keyUp?.(e);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [inkling]);
}

export default function App() {
  const workspace = useUiStore((s) => s.workspace);
  const visited = useUiStore((s) => s.visited);
  const theme = useUiStore((s) => s.theme);
  const material = useUiStore((s) => s.material);
  const setNarrow = useUiStore((s) => s.setNarrow);

  useEffect(() => applyTheme(theme, material), [theme, material]);
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < NARROW_PX);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [setNarrow]);
  useGlobalKeys();

  return (
    <div className="flex h-full w-full overflow-hidden text-ink">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <Titlebar />
        <div className="relative min-h-0 flex-1">
          {WORKSPACES.map(({ id, Component }) =>
            visited[id] ? (
              <section key={id} aria-label={id} className="absolute inset-0" style={{ display: workspace === id ? "block" : "none" }}>
                <Component active={workspace === id} />
              </section>
            ) : null,
          )}
          <WhisperHost />
        </div>
      </main>
      <ModelsDrawer />
      <QueueDrawer />
      <DragOverlay />
    </div>
  );
}
