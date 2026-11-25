import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import type { EditRequest, JobMode, OutputItem } from "../../shared/contract";
import { createMurmuration, registerMurmuration, type MurmurationHandle } from "../../murmuration";
import { editDefaultSteps, useEditStore } from "../../stores/edit";
import { useJobStore } from "../../stores/job";
import { useUiStore, say } from "../../stores/ui";
import { useInklingAvailable } from "../../stores/engine";
import { engineHttp } from "../../lib/engine/http";
import { registerJobHost, submitJob } from "../../lib/engine/jobs";
import { registerCommands } from "../../lib/commands";
import { blobToBase64, canvasToPng, dataUrlToBlob, decodeFitted, fetchBlob, imageFileFromEvent, outputUrl, pickImages } from "../../lib/images";
import { studio } from "../../lib/studio";
import { EmptyState } from "../../components/ui/misc";
import { LiveStatus } from "../LiveStatus";
import { BrushBar } from "./BrushBar";
import { DEFAULT_BRUSH_COLOR } from "./color";
import { EditCapsule, type EditCapsuleHandle } from "./EditCapsule";
import { EditorDocument } from "./EditorDocument";
import { CompareOverlay, ReferenceStrip, ToolRail, ViewCluster } from "./EditRails";

export default function EditWorkspace({ active }: { active: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const murmCanvasRef = useRef<HTMLCanvasElement>(null);
  const capsule = useRef<EditCapsuleHandle>(null);
  const murm = useRef<MurmurationHandle | null>(null);
  const docRef = useRef<EditorDocument | null>(null);
  if (!docRef.current) docRef.current = new EditorDocument();
  const doc = docRef.current;

  const [contentVersion, setContentVersion] = useState(0);
  const [viewTick, setViewTick] = useState(0);
  const [panningActive, setPanningActive] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const [eyedropMode, setEyedropMode] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const jobMode = useRef<JobMode | null>(null);
  const clipForJob = useRef<ImageBitmap | null>(null);

  const tool = useEditStore((s) => s.tool);
  const mode = useEditStore((s) => s.mode);
  const hasDoc = useEditStore((s) => s.doc.hasDoc);
  const compare = useEditStore((s) => s.compare);
  const split = useEditStore((s) => s.split);
  const maskVisible = useEditStore((s) => s.maskVisible);
  const pendingOpen = useEditStore((s) => s.pendingOpen);
  const capsuleH = useUiStore((s) => s.capsuleH.edit);
  const running = useJobStore((s) => s.active?.owner === "edit");
  const busyAny = useJobStore((s) => !!s.active);
  const inkling = useInklingAvailable();

  const refsVisible = mode === "qwen_edit" && hasDoc;
  const insets = useMemo(() => ({ top: 72, left: 80, right: refsVisible ? 112 : 72, bottom: capsuleH + 44 }), [refsVisible, capsuleH]);

  // ───────── Document + canvas wiring ─────────
  useEffect(() => {
    doc.attach(canvasRef.current!);
    doc.onChange((c) => {
      useEditStore.getState().setDoc({
        hasDoc: c.hasDoc,
        width: c.width,
        height: c.height,
        maskEmpty: c.maskEmpty,
        canUndo: c.canUndo,
        canRedo: c.canRedo,
        hasBefore: c.hasBefore,
        zoom: c.zoom,
      });
      setContentVersion(c.contentVersion);
      setViewTick((t) => t + 1);
      if (!c.hasBefore && useEditStore.getState().compare) useEditStore.getState().setCompare(false);
    });
    const obs = new MutationObserver(() => doc.refreshTheme());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      obs.disconnect();
      doc.dispose();
    };
  }, [doc]);

  // Canvas client rect, cached between layout changes (pointer moves read it per event).
  const canvasRect = useRef<DOMRect | null>(null);
  const getCanvasRect = () => (canvasRect.current ??= canvasRef.current!.getBoundingClientRect());

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      canvasRect.current = null;
      doc.resize(el.clientWidth, el.clientHeight, insets);
    });
    ro.observe(el);
    doc.setInsets(insets);
    return () => ro.disconnect();
  }, [doc, insets]);

  useEffect(() => doc.setOverlay({ maskVisible, compare, split }), [doc, maskVisible, compare, split]);

  // Brush params → document
  const brushSize = useEditStore((s) => s.brushSize);
  const hardP = useEditStore((s) => s.hardnessPaint);
  const hardM = useEditStore((s) => s.hardnessMask);
  const opacity = useEditStore((s) => s.opacity);
  const color = useEditStore((s) => s.color) || DEFAULT_BRUSH_COLOR;
  useEffect(() => {
    doc.setBrush({
      size: brushSize,
      hardness: (tool === "mask" ? hardM : hardP) / 100,
      opacity: tool === "mask" ? 1 : opacity / 100,
      color,
    });
  }, [doc, brushSize, hardP, hardM, opacity, color, tool]);

  // ───────── Murmuration ─────────
  useEffect(() => {
    const m = createMurmuration(murmCanvasRef.current!);
    murm.current = m;
    const unreg = registerMurmuration("edit", m);
    return () => {
      unreg();
      m.dispose();
      clipForJob.current?.close();
      clipForJob.current = null;
    };
  }, []);
  useEffect(() => murm.current?.setActive(active), [active]);

  const layoutMurm = useCallback(() => {
    const el = stageRef.current;
    if (!el || !murm.current || !doc.hasDoc) return;
    const sr = el.getBoundingClientRect();
    const r = doc.docRect();
    murm.current.layout(sr, new DOMRect(sr.left + r.x, sr.top + r.y, r.w, r.h));
  }, [doc]);
  useLayoutEffect(() => {
    if (running) layoutMurm();
  }, [running, viewTick, layoutMurm]);

  // Pans bypass React entirely; only the pieces that track the document rect follow along.
  useEffect(() => {
    doc.onView(() => {
      if (useJobStore.getState().active?.owner === "edit") layoutMurm();
      if (useEditStore.getState().compare) setViewTick((t) => t + 1);
    });
    return () => doc.onView(null);
  }, [doc, layoutMurm]);

  // ───────── Opening images ─────────
  const openBlob = useCallback(
    async (blob: Blob, name: string, sourceId: string | null) => {
      try {
        const { bitmap, fitted } = await decodeFitted(blob, 2048);
        await doc.replaceBase(bitmap, { open: true });
        useEditStore.getState().setDoc({ name, sourceId });
        useEditStore.getState().setCompare(false);
        if (fitted) say("Fitted to 2048 px");
      } catch {
        say("That file isn't an image Studio can read.", { tone: "error" });
      }
    },
    [doc],
  );

  useEffect(() => {
    if (!pendingOpen) return;
    useEditStore.getState().requestOpen(null);
    void (async () => {
      try {
        const blob = pendingOpen.blob ?? (await fetchBlob(pendingOpen.url ?? ""));
        await openBlob(blob, pendingOpen.name, pendingOpen.sourceId ?? null);
      } catch {
        say("That file isn't an image Studio can read.", { tone: "error" });
      }
    })();
  }, [pendingOpen, openBlob]);

  const openPicker = useCallback(async () => {
    const [p] = await pickImages(false);
    if (!p) return;
    const blob = p.blob ?? (await fetchBlob(p.url));
    await openBlob(blob, p.name, null);
  }, [openBlob]);

  const pasteFromClipboard = useCallback(async () => {
    const data = await studio.clipboard.readImage().catch(() => null);
    if (data) await openBlob(await dataUrlToBlob(data), "Pasted image", null);
  }, [openBlob]);

  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      const f = imageFileFromEvent(e.clipboardData);
      e.preventDefault();
      if (f) void openBlob(f, f.name || "Pasted image", null);
      else void pasteFromClipboard();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [active, openBlob, pasteFromClipboard]);

  // ───────── Running jobs ─────────
  const run = useCallback(async () => {
    const s = useEditStore.getState();
    const js = useJobStore.getState();
    if (js.active) return;
    if (!doc.hasDoc) return;
    if (s.mode === "inpaint" && s.doc.maskEmpty) {
      s.setTool("mask");
      say("Paint a mask first · M");
      return;
    }
    if (!s.instruction.trim()) {
      capsule.current?.focus();
      return;
    }
    // Snapshot base+paint, mask and clip synchronously, before any await: pointer input that
    // lands while PNGs encode can't leak into (or mix revisions of) this request.
    const mode = s.mode;
    const cap = doc.captureSubmission({ mask: mode === "inpaint", clip: mode === "inpaint" });
    if (!cap) return;
    const req: EditRequest = {
      mode,
      imageBase64: "",
      prompt: s.instruction.trim(),
      negativePrompt: s.negative.trim(),
      seed: s.seedLocked ? s.seed : -1,
      steps: s.steps ?? editDefaultSteps(mode),
      cfg: s.cfg,
      sampler: s.sampler,
      scheduler: s.scheduler,
      enhancePrompt: s.enhance && inkling,
      ...(s.doc.sourceId ? { sourceId: s.doc.sourceId } : {}),
    };
    if (mode === "inpaint") {
      req.denoise = s.denoiseInpaint;
    } else if (mode === "img2img") {
      req.denoise = s.denoiseImg2img;
    } else {
      req.resolution = s.resolution;
      const refs = s.references.filter((r): r is NonNullable<typeof r> => !!r).map((r) => r.path);
      if (refs.length) req.referenceImages = refs;
    }
    let clip: ImageBitmap | null = null;
    try {
      const [img, msk, clp] = await Promise.allSettled([
        canvasToPng(cap.image).then(blobToBase64),
        cap.mask ? canvasToPng(cap.mask).then(blobToBase64) : Promise.resolve(null),
        cap.clip ? createImageBitmap(cap.clip) : Promise.resolve(null),
      ]);
      if (clp.status === "fulfilled") clip = clp.value;
      if (img.status === "rejected") throw img.reason;
      if (msk.status === "rejected") throw msk.reason;
      req.imageBase64 = img.value;
      if (msk.value) req.maskBase64 = msk.value;
      if (useJobStore.getState().active) return;
      // Hand the clip to the job binding; `started` passes it on to the Murmuration.
      clipForJob.current?.close();
      clipForJob.current = clip;
      clip = null;
      const jobId = await submitJob("edit", () => engineHttp.edit(req));
      if (!jobId && clipForJob.current) {
        clipForJob.current.close();
        clipForJob.current = null;
      }
    } catch {
      say("Couldn't prepare the image.", { tone: "error" });
    } finally {
      clip?.close();
    }
  }, [doc, inkling]);

  const removeBg = useCallback(async () => {
    if (!doc.hasDoc || useJobStore.getState().active) return;
    const s = useEditStore.getState();
    const cap = doc.captureSubmission();
    if (!cap) return;
    let imageBase64: string;
    try {
      imageBase64 = await blobToBase64(await canvasToPng(cap.image));
    } catch {
      say("Couldn't prepare the image.", { tone: "error" });
      return;
    }
    await submitJob("edit", () => engineHttp.edit({ mode: "remove_bg", imageBase64, ...(s.doc.sourceId ? { sourceId: s.doc.sourceId } : {}) }));
  }, [doc]);

  const applyResult = useCallback(
    async (item: OutputItem, mode: JobMode | null) => {
      const m = murm.current;
      // Every bitmap below is either handed off (doc / Murmuration take ownership) or closed in `finally`.
      let decoded: ImageBitmap | null = null;
      let reveal: ImageBitmap | null = null;
      try {
        const blob = await fetchBlob(outputUrl(item));
        decoded = await createImageBitmap(blob, { premultiplyAlpha: "none" }); // decode once
        // Only a visible reveal transition consumes a second bitmap (copied, not re-decoded).
        const wantsReveal = mode !== "remove_bg" && !!m && m.phase !== "idle";
        if (wantsReveal) reveal = await createImageBitmap(decoded);
        const forDoc = decoded;
        decoded = null;
        await doc.replaceBase(forDoc, { asResult: true, keepMask: mode === "remove_bg" });
        if (mode !== "remove_bg") doc.clearPaintAndMask();
        useEditStore.getState().setDoc({ sourceId: item.id });
        layoutMurm();
        if (reveal && m) {
          const r = reveal;
          reveal = null;
          await m.complete(r);
        } else await m?.finish();
        say("Saved to Library");
      } catch {
        await m?.cancel();
        say("Something went wrong.", { tone: "error" });
      } finally {
        decoded?.close();
        reveal?.close();
      }
    },
    [doc, layoutMurm],
  );

  useEffect(
    () =>
      registerJobHost("edit", {
        started: (e) => {
          jobMode.current = e.mode;
          const s = useEditStore.getState();
          if (!s.seedLocked && e.mode !== "remove_bg") s.patch({ seed: e.seed });
          s.setCompare(false);
          layoutMurm();
          const pendingClip = clipForJob.current;
          clipForJob.current = null;
          const clip = e.mode === "inpaint" ? pendingClip : null;
          if (pendingClip && !clip) pendingClip.close();
          murm.current?.begin({ aspect: doc.width / Math.max(1, doc.height), seed: e.seed || 1, ...(clip ? { clipMask: clip } : {}) });
        },
        progress: (e) => {
          if (jobMode.current === "remove_bg") murm.current?.setProgress(e.progress);
        },
        completed: (e) => {
          const item = e.outputs[0];
          if (item) void applyResult(item, jobMode.current);
          else void murm.current?.cancel();
        },
        error: () => void murm.current?.cancel(),
        cancelled: () => void murm.current?.cancel(),
      }),
    [doc, applyResult, layoutMurm],
  );

  // ───────── Pointer input ─────────
  const panning = useRef<{ x: number; y: number } | null>(null);
  const effectiveTool = spaceHeld ? "select" : tool;
  const eyedrop = eyedropMode || (altHeld && tool === "brush");
  const canPaint = hasDoc && !compare && !running;

  const localPoint = (e: { clientX: number; clientY: number }, r: DOMRect = getCanvasRect()) => ({ x: e.clientX - r.left, y: e.clientY - r.top });

  const updateCursor = (p: { x: number; y: number } | null) => {
    const paintTool = effectiveTool === "brush" || effectiveTool === "mask" || effectiveTool === "eraser";
    doc.setCursor(paintTool && canPaint && !eyedrop ? p : null, (useEditStore.getState().brushSize / 2) * doc.view.scale);
  };

  const onPointerDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!hasDoc) return;
    canvasRect.current = null; // re-read once per gesture: catches layout shifts a resize wouldn't report
    const p = localPoint(e);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || effectiveTool === "select" || compare) {
      panning.current = { x: e.clientX, y: e.clientY };
      setPanningActive(true);
      return;
    }
    if (!canPaint) return;
    const d = doc.toDoc(p.x, p.y);
    if (eyedrop) {
      const c = doc.pick(d.x, d.y);
      if (c) useEditStore.getState().patch({ color: c });
      setEyedropMode(false);
      return;
    }
    const pressure = e.pointerType === "pen" ? 0.5 + 0.5 * e.pressure : 1;
    const flip = e.altKey;
    const eraseTarget = flip ? (doc.lastTarget === "paint" ? "mask" : "paint") : doc.lastTarget;
    const kind = effectiveTool === "brush" ? "paint" : effectiveTool === "mask" ? "mask" : "erase";
    doc.beginStroke(kind, d.x, d.y, pressure, e.shiftKey, eraseTarget);
  };

  const onPointerMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const r = getCanvasRect();
    const p = localPoint(e, r);
    if (panning.current) {
      doc.panBy(e.clientX - panning.current.x, e.clientY - panning.current.y);
      panning.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (doc.isStroking) {
      const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
      const list = events.length ? events : [e.nativeEvent];
      for (const ev of list) {
        const d = doc.toDoc(ev.clientX - r.left, ev.clientY - r.top);
        doc.moveStroke(d.x, d.y, ev.pointerType === "pen" ? 0.5 + 0.5 * ev.pressure : 1);
      }
    }
    updateCursor(p);
  };

  const onPointerUp = () => {
    panning.current = null;
    setPanningActive(false);
    if (doc.isStroking) doc.endStroke();
  };

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!doc.hasDoc) return;
      e.preventDefault();
      if (e.ctrlKey) {
        const r = (canvasRect.current ??= el.getBoundingClientRect());
        doc.zoomBy(Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
      }
      else if (e.shiftKey) doc.panBy(-e.deltaY, 0);
      else doc.panBy(-e.deltaX, -e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [doc]);

  // ───────── Keyboard (§9 Edit scope) ─────────
  useEffect(
    () =>
      registerCommands("edit", {
        run: () => void run(),
        enhance: () => capsule.current?.enhance(),
        focusPrompt: () => capsule.current?.focus(),
        escape: () => {
          if (eyedropMode) {
            setEyedropMode(false);
            return true;
          }
          if (useEditStore.getState().compare) {
            useEditStore.getState().setCompare(false);
            return true;
          }
          return false;
        },
        keyUp: (e) => {
          if (e.key === " ") setSpaceHeld(false);
          if (e.key === "Alt") setAltHeld(false);
        },
        key: (e, typing) => {
          const s = useEditStore.getState();
          const k = e.key.toLowerCase();
          if (e.ctrlKey) {
            if (k === "o" && !e.shiftKey) return void openPicker(), true;
            if (k === "b" && e.shiftKey) return void removeBg(), true;
            if (typing) return false;
            if (k === "z" && !e.shiftKey) return doc.undo(), true;
            if (k === "y" || (k === "z" && e.shiftKey)) return doc.redo(), true;
            if (k === "i" && !e.shiftKey) return doc.invertMask(), true;
            if (k === "x" && e.shiftKey) return doc.clearMask(), true;
            if (e.key === "0" && e.altKey) return doc.setZoom(1), true;
            if (e.key === "0") return doc.fit(), true;
            if (e.key === "=" || e.key === "+") return doc.zoomBy(1.25), true;
            if (e.key === "-") return doc.zoomBy(0.8), true;
            return false;
          }
          if (typing) return false;
          if (e.key === " ") {
            setSpaceHeld(true);
            return true;
          }
          if (e.key === "Alt") {
            setAltHeld(true);
            return true;
          }
          if (e.altKey || e.metaKey) return false;
          if (k === "v") return s.setTool("select"), true;
          if (k === "b") return s.setTool("brush"), true;
          if (k === "m") return s.setTool("mask"), true;
          if (k === "e") return s.setTool("eraser"), true;
          if (k === "h") return s.setMaskVisible(!s.maskVisible), true;
          if (e.key === "[" || e.key === "]") {
            const f = e.key === "]" ? 1.1 : 1 / 1.1;
            s.patch({ brushSize: Math.min(512, Math.max(1, Math.round(s.brushSize * f + (e.key === "]" ? 0.5 : -0.5)))) });
            return true;
          }
          if (e.key === "\\") {
            if (s.doc.hasBefore) s.setCompare(!s.compare);
            return true;
          }
          if (s.compare && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            s.setSplit(s.split + (e.key === "ArrowLeft" ? -0.02 : 0.02));
            return true;
          }
          return false;
        },
      }),
    [doc, run, removeBg, openPicker, eyedropMode],
  );

  useEffect(() => {
    if (!active) {
      setSpaceHeld(false);
      setAltHeld(false);
    }
  }, [active]);

  // ───────── Drag & drop ─────────
  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    const f = imageFileFromEvent(e.dataTransfer);
    if (!f) return;
    e.preventDefault();
    void openBlob(f, f.name, null);
  };

  const brushVisible = hasDoc && (tool === "brush" || tool === "mask" || tool === "eraser") && !compare;
  const cursor =
    !hasDoc
      ? "default"
      : panningActive
        ? "grabbing"
        : effectiveTool === "select" || compare
          ? "grab"
          : eyedrop
            ? "copy"
            : (brushSize / 2) * doc.view.scale < 2
              ? "crosshair"
              : "none";
  void viewTick;
  const rect = doc.docRect();

  return (
    <div
      ref={stageRef}
      className="relative h-full min-h-0 overflow-hidden"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => doc.setCursor(null, 0)}
        onContextMenu={(e) => e.preventDefault()}
      />
      <canvas ref={murmCanvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" style={{ zIndex: 12 }} />
      <LiveStatus ws="edit" verb="Editing" />

      {!hasDoc && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-center" style={{ bottom: capsuleH + 40 }}>
          <EmptyState lead="Drop an image" italic="to begin." sub="or paste, or press Ctrl+O" />
        </div>
      )}
      {dragOver && <div className="pointer-events-none absolute inset-4 rounded-[var(--r-xl)]" style={{ boxShadow: "inset 0 0 0 2px var(--accent-ring)", zIndex: 25 }} />}

      {compare && hasDoc && <CompareOverlay rect={rect} split={split} onSplit={(v) => useEditStore.getState().setSplit(v)} />}

      <BrushBar visible={brushVisible} eyedropping={eyedrop} onEyedropper={() => setEyedropMode(true)} />
      <ToolRail doc={doc} disabled={!hasDoc} busy={busyAny} onRemoveBg={() => void removeBg()} />
      <ViewCluster doc={doc} disabled={!hasDoc} />
      <ReferenceStrip doc={doc} contentVersion={contentVersion} visible={refsVisible} />
      <EditCapsule ref={capsule} disabled={!hasDoc} onRun={() => void run()} />
    </div>
  );
}
