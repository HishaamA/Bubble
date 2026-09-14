"""Pinned, ungated local panorama weights. Inference never fetches these URLs."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL_ROOT = ROOT / ".models" / "flux2-klein-panorama"
BASE_REPO = "black-forest-labs/FLUX.2-klein-base-4B"
BASE_REVISION = "a3b4f4849157f664bdbc776fd7453c2783562f4d"
LORA_REPO = "nomadoor/flux-2-klein-4B-360-erp-outpaint-lora"
LORA_REVISION = "124129f3ebce357c007ffca177d19567246f8bff"
LORA_FILE = "flux-2-klein-4B-360-erp-outpaint-lora_V1.safetensors"
BASE_FILES = (
    "LICENSE.md", "README.md", "model_index.json", "scheduler/scheduler_config.json",
    "text_encoder/config.json", "text_encoder/generation_config.json",
    "text_encoder/model-00001-of-00002.safetensors", "text_encoder/model-00002-of-00002.safetensors",
    "text_encoder/model.safetensors.index.json", "tokenizer/added_tokens.json",
    "tokenizer/chat_template.jinja", "tokenizer/merges.txt", "tokenizer/special_tokens_map.json",
    "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json", "tokenizer/vocab.json",
    "transformer/config.json", "transformer/diffusion_pytorch_model.safetensors",
    "vae/config.json", "vae/diffusion_pytorch_model.safetensors",
)
LORA_FILES = (LORA_FILE, "README.md", "TRAINING_NOTES.md")
TRIGGER = ("Fill the green spaces according to the image. Outpaint as a seamless 360 "
           "equirectangular panorama (2:1). Keep the horizon level. Match left and right edges.")
