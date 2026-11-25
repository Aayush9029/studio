/* Cross-workspace actions shared by Generate, the filmstrip, Library and the Inspector. */

import type { OutputItem } from "../shared/contract";
import { useEditStore } from "../stores/edit";
import { useGenerateStore, sizeMultiple, snapSize } from "../stores/generate";
import { useLibraryStore } from "../stores/library";
import { useThreeStore } from "../stores/three";
import { say, useUiStore } from "../stores/ui";
import { whisperError } from "./errors";
import { toStudioError } from "./engine/http";
import { basename, stem } from "./format";
import { imagePathOf, outputUrl } from "./images";
import { studio, toUrl } from "./studio";

export function showInGenerate(item: OutputItem): void {
  const g = useGenerateStore.getState();
  g.show(item);
  if (!g.batchItems.some((b) => b.id === item.id)) g.setBatch([]);
  useUiStore.getState().setWorkspace("generate");
}

export function openInEdit(item: OutputItem): void {
  const path = imagePathOf(item);
  if (!path) return;
  useEditStore.getState().requestOpen({ url: toUrl(path), name: basename(path), sourceId: item.id });
  useUiStore.getState().setWorkspace("edit");
}

export function makeIn3D(item: OutputItem): void {
  const path = imagePathOf(item);
  if (!path) return;
  const t = useThreeStore.getState();
  t.patch({ mode: "i23d" });
  t.setSource({ path, blob: null, url: toUrl(path), sourceId: item.id });
  useUiStore.getState().setWorkspace("three");
}

export function showIn3D(item: OutputItem): void {
  useThreeStore.getState().setCurrent(item);
  useUiStore.getState().setWorkspace("three");
}

/** Double-click / inspector preview: open the item in its home workspace. */
export function openHome(item: OutputItem): void {
  if (item.kind === "image") showInGenerate(item);
  else if (item.kind === "edit") openInEdit(item);
  else showIn3D(item);
}

export function reusePromptAndSeed(item: OutputItem): void {
  const p = item.params;
  const ui = useUiStore.getState();
  if (item.kind === "image") {
    const g = useGenerateStore.getState();
    const model = item.model.family === "qwen_image" ? "qwen_image" : "z_image";
    const mult = sizeMultiple(model);
    g.patch({
      prompt: p.prompt,
      negative: p.negativePrompt,
      negativeOpen: !!p.negativePrompt,
      model,
      width: snapSize(item.width ?? g.width, mult),
      height: snapSize(item.height ?? g.height, mult),
      aspect: "custom",
      seed: p.seed,
      seedLocked: true,
      steps: p.steps ?? g.steps,
      cfg: p.cfg ?? g.cfg,
      sampler: p.sampler ?? g.sampler,
      scheduler: p.scheduler ?? g.scheduler,
    });
    ui.setWorkspace("generate");
  } else if (item.kind === "edit") {
    const e = useEditStore.getState();
    const mode = item.mode === "inpaint" || item.mode === "img2img" ? item.mode : "qwen_edit";
    e.patch({
      mode,
      instruction: p.prompt,
      negative: p.negativePrompt,
      seed: p.seed,
      seedLocked: true,
      ...(p.denoise != null && mode === "inpaint" ? { denoiseInpaint: p.denoise } : {}),
      ...(p.denoise != null && mode === "img2img" ? { denoiseImg2img: p.denoise } : {}),
      ...(p.resolution != null ? { resolution: p.resolution } : {}),
    });
    ui.setWorkspace("edit");
  } else {
    const t = useThreeStore.getState();
    t.patch({
      mode: item.mode === "i23d" ? "i23d" : "t23d",
      prompt: p.prompt || t.prompt,
      seed: p.seed,
      seedLocked: true,
      ...(item.mesh ? { engine: item.mesh.engine, targetFaces: item.mesh.targetFaces, remesh: item.mesh.remeshResolution, removeBg: item.mesh.removeBackground } : {}),
    });
    if (item.mode === "i23d" && item.inputs.imagePath) {
      t.setSource({ path: item.inputs.imagePath, blob: null, url: toUrl(item.inputs.imagePath), sourceId: item.inputs.sourceId });
    }
    ui.setWorkspace("three");
  }
}

export async function deleteItems(items: OutputItem[]): Promise<boolean> {
  if (!items.length) return false;
  try {
    const res = await studio.library.delete(items.map((i) => i.sidecarPath));
    const ids = res.deleted.map((d) => d.id);
    useLibraryStore.getState().remove(ids);
    const g = useGenerateStore.getState();
    if (g.current && ids.includes(g.current.id)) {
      const rest = g.batchItems.filter((b) => !ids.includes(b.id));
      g.setBatch(rest);
      g.show(rest[0] ?? null);
    }
    const t = useThreeStore.getState();
    if (t.current && ids.includes(t.current.id)) t.setCurrent(null);
    if (res.failed.length && !ids.length) {
      say("Something went wrong.", { tone: "error" });
      return false;
    }
    say("Moved to Recycle Bin");
    return true;
  } catch (e) {
    whisperError(toStudioError(e));
    return false;
  }
}

export async function copyImage(item: OutputItem): Promise<void> {
  const p = imagePathOf(item);
  if (!p) return;
  try {
    await studio.clipboard.writeImage(p);
    say("Copied");
  } catch (e) {
    whisperError(toStudioError(e));
  }
}

export async function saveCopy(item: OutputItem): Promise<void> {
  try {
    const dest = await studio.files.saveCopy(item.path, item.file);
    if (dest) say(`Saved ${basename(dest)}`);
  } catch (e) {
    whisperError(toStudioError(e));
  }
}

export async function reveal(item: OutputItem): Promise<void> {
  try {
    await studio.files.reveal(item.path);
  } catch (e) {
    whisperError(toStudioError(e));
  }
}

export async function copySeed(seed: number): Promise<void> {
  try {
    await studio.clipboard.writeText(String(seed));
  } catch {
    await navigator.clipboard?.writeText(String(seed)).catch(() => {});
  }
  say("Seed copied");
}

export async function copyText(text: string, message = "Copied"): Promise<void> {
  try {
    await studio.clipboard.writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => {});
  }
  say(message);
}

export async function toggleFavorite(item: OutputItem): Promise<void> {
  try {
    const updated = await studio.library.setFavorite(item.sidecarPath, !item.favorite);
    useLibraryStore.getState().upsert(updated);
  } catch (e) {
    whisperError(toStudioError(e));
  }
}

export async function sendToBlender(item: OutputItem): Promise<boolean> {
  if (item.kind !== "3d") return false;
  try {
    await studio.blender.import({ path: item.path, name: stem(item.file).split("_").slice(-1)[0] || stem(item.file), autoGround: true, smoothShade: true });
    return true;
  } catch (e) {
    whisperError(toStudioError(e));
    return false;
  }
}

export { outputUrl };
