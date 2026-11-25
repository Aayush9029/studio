/* Escape-layer stack: popovers, menus and drawers push a close function; Esc closes the topmost.
   Workspaces register an Esc handler for their own modes (inspect, select) underneath. */

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type Closer = () => void;

const stack: { id: number; close: Closer }[] = [];
let seq = 0;

export function pushLayer(close: Closer): () => void {
  const id = ++seq;
  stack.push({ id, close });
  return () => {
    const i = stack.findIndex((l) => l.id === id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Closes the topmost layer; returns false when there is none. */
export function closeTopLayer(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return type !== "range" && type !== "checkbox" && type !== "radio" && type !== "button";
  }
  return false;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Keeps Tab focus inside `root`. */
export function trapTab(e: KeyboardEvent | ReactKeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const els = focusables(root);
  if (!els.length) {
    e.preventDefault();
    return;
  }
  const first = els[0];
  const last = els[els.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}
