import { useLayoutEffect, useState, type RefObject } from "react";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Largest rect of `aspect` (w/h) that fits inside the stage minus insets (§5.1.1).
    The single source of truth for the <img>, the Murmuration pane and the hover rail. */
export function fitRect(stageW: number, stageH: number, aspect: number, ins: Insets): Rect {
  const availW = Math.max(1, stageW - ins.left - ins.right);
  const availH = Math.max(1, stageH - ins.top - ins.bottom);
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  let w = availW;
  let h = w / a;
  if (h > availH) {
    h = availH;
    w = h * a;
  }
  const x = ins.left + (availW - w) / 2;
  const y = ins.top + (availH - h) / 2;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function useStageSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Viewport-space DOMRects for Murmuration.layout(). */
export function paneRects(stageEl: HTMLElement, rect: Rect): { stage: DOMRect; pane: DOMRect } {
  const sr = stageEl.getBoundingClientRect();
  return { stage: sr, pane: new DOMRect(sr.left + rect.x, sr.top + rect.y, rect.w, rect.h) };
}
