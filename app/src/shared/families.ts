/* Static family table — API_CONTRACT.md Appendix A + B.
   Used for the engine-offline view of the Models & Memory drawer and as defaults
   before `GET /api/models` has answered. Runtime figures always come from the engine. */

import type { FamilyDefaults, FamilyId, ModelFamilyStatus, ModelFileRole } from "./contract";

export interface StaticModelFile {
  role: ModelFileRole;
  relPath: string;
  bytes: number;
}

export interface StaticFamily {
  id: FamilyId;
  label: string;
  /** Short label used in pills and the titlebar (no "3D ·" prefix). */
  shortLabel: string;
  files: StaticModelFile[];
  defaults: FamilyDefaults | null;
  samplers: string[] | null;
  schedulers: string[] | null;
}

export const CURATED_SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "res_multistep"];
export const CURATED_SCHEDULERS = ["simple", "beta", "sgm_uniform", "normal"];

const SHAPE_VAE: StaticModelFile = { role: "vae", relPath: "vae/trellis_2_shape_vae_bf16.safetensors", bytes: 1_095_844_024 };
const TEXTURE_VAE: StaticModelFile = { role: "vae", relPath: "vae/trellis_2_texture_vae_bf16.safetensors", bytes: 948_461_364 };
const DINO: StaticModelFile = { role: "vision_encoder", relPath: "clip_vision/dino_v3_L_naf_fp32.safetensors", bytes: 1_215_214_176 };

export const FAMILIES: readonly StaticFamily[] = [
  {
    id: "z_image",
    label: "Z-Image Turbo",
    shortLabel: "Z-Image Turbo",
    files: [
      { role: "diffusion", relPath: "diffusion_models/z_image_turbo_bf16_nsfw_v2.safetensors", bytes: 12_566_033_952 },
      { role: "text_encoder", relPath: "text_encoders/qwen3_4b_z_image_abliterated.safetensors", bytes: 8_044_982_080 },
      { role: "vae", relPath: "vae/z_image_ae.safetensors", bytes: 335_304_388 },
      { role: "preview_decoder", relPath: "vae_approx/taef1_decoder.safetensors", bytes: 2_464_414 },
    ],
    defaults: { steps: 9, cfg: 1.0, sampler: "euler", scheduler: "simple", sizeMultiple: 16, minSize: 256, maxSize: 2048, maxReferenceImages: 0 },
    samplers: CURATED_SAMPLERS,
    schedulers: CURATED_SCHEDULERS,
  },
  {
    id: "qwen_image",
    label: "Qwen-Image 2.1",
    shortLabel: "Qwen-Image 2.1",
    files: [
      { role: "diffusion", relPath: "diffusion_models/chatrlabs_qwen_image21_step90000_bf16.safetensors", bytes: 14_230_284_680 },
      { role: "lora", relPath: "loras/chatrlabs-omni-turbo-8step-fp32.safetensors", bytes: 671_148_320 },
      { role: "text_encoder", relPath: "text_encoders/qwen3vl_8b_bf16.safetensors", bytes: 17_534_334_616 },
      { role: "vae", relPath: "vae/qwen_image_2.1_vae_bf16.safetensors", bytes: 675_509_688 },
    ],
    defaults: { steps: 8, cfg: 1.0, sampler: "euler", scheduler: "simple", sizeMultiple: 32, minSize: 256, maxSize: 2048, maxReferenceImages: 3 },
    samplers: CURATED_SAMPLERS,
    schedulers: CURATED_SCHEDULERS,
  },
  {
    id: "pixal3d",
    label: "3D · Pixal3D",
    shortLabel: "Pixal3D",
    files: [
      { role: "diffusion", relPath: "diffusion_models/pixal3d_bf16.safetensors", bytes: 10_999_317_704 },
      SHAPE_VAE,
      TEXTURE_VAE,
      DINO,
      { role: "geometry", relPath: "geometry_estimation/moge_2_vitl_normal_fp16.safetensors", bytes: 661_859_924 },
    ],
    defaults: null,
    samplers: null,
    schedulers: null,
  },
  {
    id: "trellis2",
    label: "3D · TRELLIS.2",
    shortLabel: "TRELLIS.2",
    files: [{ role: "diffusion", relPath: "diffusion_models/trellis_2_bf16.safetensors", bytes: 10_338_297_616 }, SHAPE_VAE, TEXTURE_VAE, DINO],
    defaults: null,
    samplers: null,
    schedulers: null,
  },
  {
    id: "birefnet",
    label: "BiRefNet",
    shortLabel: "BiRefNet",
    files: [{ role: "matting", relPath: "background_removal/birefnet.safetensors", bytes: 444_473_596 }],
    defaults: null,
    samplers: null,
    schedulers: null,
  },
];

export const FAMILY_ORDER: readonly FamilyId[] = ["z_image", "qwen_image", "pixal3d", "trellis2", "birefnet"];

export function staticFamily(id: FamilyId): StaticFamily {
  const f = FAMILIES.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown family ${id}`);
  return f;
}

export function familyShortLabel(id: FamilyId): string {
  return staticFamily(id).shortLabel;
}

/** Engine-offline representation: every family `cold`, files joined with the scan by relPath. */
export function offlineFamilyStatus(
  id: FamilyId,
  scanned?: Map<string, { path: string; bytes: number }>,
): ModelFamilyStatus {
  const f = staticFamily(id);
  const files = f.files.map((file) => {
    const s = scanned?.get(file.relPath);
    const sharedWith = FAMILIES.filter((o) => o.id !== id && o.files.some((of) => of.relPath === file.relPath)).map((o) => o.id);
    return {
      role: file.role,
      relPath: file.relPath,
      path: s?.path ?? "",
      bytes: s ? s.bytes : scanned ? 0 : file.bytes,
      exists: scanned ? !!s : true,
      sharedWith,
    };
  });
  const diskBytes = files.reduce((acc, x) => acc + (x.exists ? x.bytes : 0), 0);
  return {
    id,
    label: f.label,
    state: "cold",
    vramEstimateMb: Math.ceil((diskBytes / 1048576) * 1.1),
    diskBytes,
    complete: files.every((x) => x.exists),
    lastUsedAt: null,
    files,
    defaults: f.defaults,
    samplers: f.samplers,
    schedulers: f.schedulers,
  };
}

export const ROLE_LABEL: Record<ModelFileRole, string> = {
  diffusion: "Diffusion model",
  text_encoder: "Text encoder",
  vae: "VAE",
  lora: "LoRA",
  preview_decoder: "Preview decoder",
  vision_encoder: "Vision encoder",
  geometry: "Geometry",
  matting: "Matting",
};

/** Aspect presets — valid for both image models (Appendix B). */
export const ASPECT_PRESETS = [
  { id: "1:1", w: 1024, h: 1024 },
  { id: "2:3", w: 832, h: 1248 },
  { id: "3:2", w: 1248, h: 832 },
  { id: "9:16", w: 768, h: 1344 },
  { id: "16:9", w: 1344, h: 768 },
] as const;
export type AspectId = (typeof ASPECT_PRESETS)[number]["id"];

export const EDIT_RESOLUTIONS = [768, 1024, 1280, 1536] as const;
export const REMESH_RESOLUTIONS = [512, 768, 1024] as const;
export const AUTO_UNLOAD_OPTIONS = [0, 5, 10, 15, 30] as const;
