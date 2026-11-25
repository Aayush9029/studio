/* Per-workspace command registry, driven by the global keyboard map (§9). */

import type { WorkspaceId } from "../shared/contract";

export interface WorkspaceCommands {
  /** Ctrl+Enter — run the primary action. */
  run?(): void;
  /** Ctrl+E — enhance the prompt in place. */
  enhance?(): void;
  /** Ctrl+L — focus the prompt / instruction field. */
  focusPrompt?(): void;
  /** Esc before stopping a job (inspect mode, select mode…). Return true when handled. */
  escape?(): boolean;
  /** Workspace-scoped keys. Return true when handled (the event is then prevented). */
  key?(e: KeyboardEvent, typing: boolean): boolean;
  /** Key-up for hold modifiers (Space pan, Alt eyedropper). */
  keyUp?(e: KeyboardEvent): void;
}

const registry: Partial<Record<WorkspaceId, WorkspaceCommands>> = {};

export function registerCommands(ws: WorkspaceId, cmds: WorkspaceCommands): () => void {
  registry[ws] = cmds;
  return () => {
    if (registry[ws] === cmds) delete registry[ws];
  };
}

export function commandsFor(ws: WorkspaceId): WorkspaceCommands | undefined {
  return registry[ws];
}
