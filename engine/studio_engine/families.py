"""Model families - normative mapping from API_CONTRACT.md Appendix A / B."""
from __future__ import annotations

FAMILY_ORDER = ("z_image", "qwen_image", "pixal3d", "trellis2", "birefnet")

CURATED_SAMPLERS = ("euler", "euler_ancestral", "dpmpp_2m", "res_multistep")
CURATED_SCHEDULERS = ("simple", "beta", "sgm_uniform", "normal")

FAMILIES: dict[str, dict] = {
    "z_image": {
        "label": "Z-Image Turbo",
        "files": [
            ("diffusion", "diffusion_models/z_image_turbo_bf16_nsfw_v2.safetensors"),
            ("text_encoder", "text_encoders/qwen3_4b_z_image_abliterated.safetensors"),
            ("vae", "vae/z_image_ae.safetensors"),
            ("preview_decoder", "vae_approx/taef1_decoder.safetensors"),
        ],
        "defaults": {"steps": 9, "cfg": 1.0, "sampler": "euler", "scheduler": "simple",
                     "sizeMultiple": 16, "minSize": 256, "maxSize": 2048, "maxReferenceImages": 0},
    },
    "qwen_image": {
        "label": "Qwen-Image 2.1",
        "files": [
            ("diffusion", "diffusion_models/chatrlabs_qwen_image21_step90000_bf16.safetensors"),
            ("lora", "loras/chatrlabs-omni-turbo-8step-fp32.safetensors"),
            ("text_encoder", "text_encoders/qwen3vl_8b_bf16.safetensors"),
            ("vae", "vae/qwen_image_2.1_vae_bf16.safetensors"),
        ],
        "defaults": {"steps": 8, "cfg": 1.0, "sampler": "euler", "scheduler": "simple",
                     "sizeMultiple": 32, "minSize": 256, "maxSize": 2048, "maxReferenceImages": 3},
    },
    "pixal3d": {
        "label": "3D · Pixal3D",
        "files": [
            ("diffusion", "diffusion_models/pixal3d_bf16.safetensors"),
            ("vae", "vae/trellis_2_shape_vae_bf16.safetensors"),
            ("vae", "vae/trellis_2_texture_vae_bf16.safetensors"),
            ("vision_encoder", "clip_vision/dino_v3_L_naf_fp32.safetensors"),
            ("geometry", "geometry_estimation/moge_2_vitl_normal_fp16.safetensors"),
        ],
        "defaults": None,
    },
    "trellis2": {
        "label": "3D · TRELLIS.2",
        "files": [
            ("diffusion", "diffusion_models/trellis_2_bf16.safetensors"),
            ("vae", "vae/trellis_2_shape_vae_bf16.safetensors"),
            ("vae", "vae/trellis_2_texture_vae_bf16.safetensors"),
            ("vision_encoder", "clip_vision/dino_v3_L_naf_fp32.safetensors"),
        ],
        "defaults": None,
    },
    "birefnet": {
        "label": "BiRefNet",
        "files": [
            ("matting", "background_removal/birefnet.safetensors"),
        ],
        "defaults": None,
    },
}

def shared_with(family_id: str, rel_path: str) -> list[str]:
    return [fid for fid in FAMILY_ORDER if fid != family_id and any(rp == rel_path for _, rp in FAMILIES[fid]["files"])]


def files_of(family_id: str) -> list[str]:
    return [rp for _, rp in FAMILIES[family_id]["files"]]

