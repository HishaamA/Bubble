"""Local-only photo-conditioned panorama generation on an 8 GB NVIDIA GPU.

The undistilled Klein 4B model and ERP LoRA are loaded exclusively from the
verified local installation. Text encoding and diffusion never coexist in GPU
memory. NF4 quantization is an explicit memory/quality tradeoff, not a claim of
pixel-faithful reconstruction. All unseen scene content is generated.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import gc
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time

# Set before importing Hugging Face libraries: inference must never contact a hub.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
# Transformers' async loader can queue most BF16 weights on GPU before NF4
# conversion. Sequential materialization bounds that temporary 8 GB peak.
os.environ["HF_DEACTIVATE_ASYNC_LOAD"] = "1"
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")
if __package__:
    from .model_config import (BASE_FILES, BASE_REPO, BASE_REVISION, LORA_FILE, LORA_FILES,
                               LORA_REPO, LORA_REVISION, MODEL_ROOT, TRIGGER)
else:
    from model_config import (BASE_FILES, BASE_REPO, BASE_REVISION, LORA_FILE, LORA_FILES,
                              LORA_REPO, LORA_REVISION, MODEL_ROOT, TRIGGER)

MODEL_LABEL = "FLUX.2-klein-base-4B + 360 ERP Outpaint LoRA (local NF4)"
MIN_GPU_MEMORY_BYTES = 8_000_000_000
TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


@contextmanager
def exclusive_gpu_lock(path=MODEL_ROOT / "generation.lock"):
    """OS-owned lock survives a server restart but releases when its worker exits."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError("Another local panorama generation is already running. Wait for it to finish.") from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def reference_fovs(job, count):
    values = job.get("horizontalFovs") if "horizontalFovs" in job else [job.get("horizontalFovDegrees", 60.0)] * count
    if not isinstance(values, list) or len(values) != count:
        raise ValueError("Give one horizontal field of view per reference photo")
    if any(isinstance(value, bool) or not isinstance(value, (int, float))
           or not 25 <= value <= 110 or not math.isfinite(value) for value in values):
        raise ValueError("Horizontal fields of view must be finite numbers from 25 to 110 degrees")
    return [float(value) for value in values]


def installation_status(model_root=MODEL_ROOT):
    """Cheap stat verification; setup verifies SHA-256 before installing the manifest."""
    try:
        manifest_path = model_root / "installation.json"
        if manifest_path.stat().st_size > 100_000:
            raise ValueError("Invalid model installation manifest")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("baseRevision") != BASE_REVISION or manifest.get("loraRevision") != LORA_REVISION:
            raise ValueError("Model revision differs from the pinned installation")
        expected = {(folder, name) for folder, names in (("base", BASE_FILES), ("lora", LORA_FILES)) for name in names}
        actual = {(entry["folder"], entry["name"]) for entry in manifest["files"]}
        if actual != expected:
            raise ValueError("Model installation is incomplete")
        for entry in manifest["files"]:
            path = model_root / entry["folder"] / entry["name"]
            if not path.is_file() or path.stat().st_size != entry["size"]:
                raise ValueError("Model installation contains missing/incomplete files")
        return True, None
    except (OSError, ValueError, TypeError, KeyError):
        return False, "Run scripts/setup-local-generation.py --install-deps --download first."


def health():
    installed, reason = installation_status()
    missing = [name for name in ("torch", "diffusers", "transformers", "accelerate", "bitsandbytes", "peft", "PIL", "numpy")
               if importlib.util.find_spec(name) is None]
    result = {"ready": False, "model": MODEL_LABEL, "installed": installed, "localOnly": True,
              "accountRequired": False, "usageFee": 0, "missingDependencies": missing,
              "modelDirectory": str(MODEL_ROOT), "enoughGPU": False}
    if missing:
        result["error"] = "Install the local generation Python dependencies."
        return result
    import torch
    result["cudaAvailable"] = torch.cuda.is_available()
    if result["cudaAvailable"]:
        result["device"] = torch.cuda.get_device_name(0)
        result["gpuMemoryBytes"] = torch.cuda.get_device_properties(0).total_memory
        result["enoughGPU"] = result["gpuMemoryBytes"] >= MIN_GPU_MEMORY_BYTES
    result["ready"] = installed and result["cudaAvailable"] and result["enoughGPU"]
    if not result["ready"]:
        if not installed:
            result["error"] = reason
        elif not result["cudaAvailable"]:
            result["error"] = "A CUDA-capable NVIDIA GPU is required."
        else:
            result["error"] = "Local generation requires an NVIDIA GPU with at least 8 GB of total GPU memory."
    return result


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_job(job_dir):
    job_dir = Path(job_dir).resolve(strict=True)
    path = job_dir / "job.json"
    if path.resolve().parent != job_dir or path.stat().st_size > 64_000:
        raise ValueError("Invalid generation job file")
    job = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(job, dict):
        raise ValueError("Invalid generation job object")
    types = job.get("referenceTypes")
    if not isinstance(types, list) or not 1 <= len(types) <= 4 or any(not isinstance(kind, str) or kind not in TYPES for kind in types):
        raise ValueError("Job must contain one to four JPEG, PNG, or WebP references")
    prompt = job.get("prompt", "")
    if not isinstance(prompt, str) or len(prompt) > 2000:
        raise ValueError("Invalid generation prompt")
    reference_fovs(job, len(types))
    paths = []
    for index, kind in enumerate(types):
        candidates = [job_dir / f"reference-{index}", job_dir / f"reference-{index}.{TYPES[kind]}"]
        source = next((candidate for candidate in candidates if candidate.is_file()), None)
        if source is None or source.resolve().parent != job_dir or not 0 < source.stat().st_size <= 20 * 1024 * 1024:
            raise ValueError("Missing or unsafe reference image")
        paths.append(source)
    return job, paths


def generate(job_dir, *, width=2048, steps=20):
    from PIL import Image, PngImagePlugin
    if __package__:
        from .projection import make_erp_control
    else:
        from projection import make_erp_control
    import torch
    import psutil
    from diffusers import BitsAndBytesConfig as DiffusersBitsAndBytesConfig
    from diffusers import Flux2KleinPipeline, Flux2Transformer2DModel
    from transformers import BitsAndBytesConfig, Qwen2TokenizerFast, Qwen3ForCausalLM

    if width not in (1024, 1536, 2048) or not 1 <= steps <= 40:
        raise ValueError("Unsupported generation size or step count")
    installed, reason = installation_status()
    if not installed:
        raise RuntimeError(reason)
    if not torch.cuda.is_available():
        raise RuntimeError("Local generation requires a CUDA-capable NVIDIA GPU")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.cuda.reset_peak_memory_stats()
    job_dir = Path(job_dir).resolve(strict=True)
    job, paths = read_job(job_dir)
    started = time.perf_counter()

    def progress(stage, completed=0, total=1):
        if (job_dir / "cancel.requested").exists():
            raise InterruptedError("Generation cancelled")
        value = {"stage": stage, "completed": completed, "total": total}
        write_json(job_dir / "progress.json", value)
        print(json.dumps(value), flush=True)

    progress("prepare")
    images = []
    for source in paths:
        with Image.open(source) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError("Reference image exceeds the decoded pixel limit")
            image.load()
            images.append(image.copy())
    fovs = reference_fovs(job, len(paths))
    control = make_erp_control(images, job.get("azimuths"), width=width, height=width // 2,
                              horizontal_fov_degrees=fovs)
    control.save(job_dir / "control.png")
    del images
    prompt = TRIGGER + (" " + job.get("prompt", "").strip() if job.get("prompt", "").strip() else "")
    seed = int.from_bytes(hashlib.sha256(str(job.get("id", job_dir.name)).encode()).digest()[:4], "big")
    base = MODEL_ROOT / "base"
    dtype = torch.bfloat16

    # Stage 1: Qwen3's ~8GB BF16 checkpoint is quantized while loading, then freed.
    progress("encoding")
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                              bnb_4bit_compute_dtype=dtype, bnb_4bit_use_double_quant=True)
    text_encoder = Qwen3ForCausalLM.from_pretrained(base / "text_encoder", dtype=dtype,
                     quantization_config=quant, device_map={"": "cuda"}, local_files_only=True,
                     trust_remote_code=False, attn_implementation="sdpa")
    tokenizer = Qwen2TokenizerFast.from_pretrained(base / "tokenizer", local_files_only=True)
    text_pipe = Flux2KleinPipeline(scheduler=None, vae=None, transformer=None,
                                  text_encoder=text_encoder, tokenizer=tokenizer)
    with torch.inference_mode():
        prompt_embeds = text_pipe.encode_prompt(prompt, device="cuda")[0].cpu()
        negative_embeds = text_pipe.encode_prompt("", device="cuda")[0].cpu()
    del text_pipe, text_encoder, tokenizer
    gc.collect()
    torch.cuda.empty_cache()

    # Stage 2: quantized undistilled base transformer + author's 0.9-strength LoRA.
    progress("loading")
    transformer = Flux2Transformer2DModel.from_pretrained(base / "transformer", torch_dtype=dtype,
        quantization_config=DiffusersBitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=dtype, bnb_4bit_use_double_quant=True),
        device_map={"": "cuda"}, local_files_only=True, use_safetensors=True)
    pipe = Flux2KleinPipeline.from_pretrained(base, transformer=transformer, text_encoder=None,
                tokenizer=None, torch_dtype=dtype, local_files_only=True)
    pipe.load_lora_weights(MODEL_ROOT / "lora", weight_name=LORA_FILE,
                           adapter_name="erp", local_files_only=True)
    pipe.set_adapters(["erp"], adapter_weights=[0.9])
    pipe.vae.enable_tiling()
    pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)

    def step_done(_pipe, index, _timestep, callback_kwargs):
        progress("generating", index + 1, steps)
        return callback_kwargs

    progress("generating", 0, steps)
    with torch.inference_mode():
        image = pipe(image=control, width=width, height=width // 2,
            prompt_embeds=prompt_embeds.to("cuda"), negative_prompt_embeds=negative_embeds.to("cuda"),
            num_inference_steps=steps, guidance_scale=5.0,
            generator=torch.Generator(device="cuda").manual_seed(seed),
            callback_on_step_end=step_done, callback_on_step_end_tensor_inputs=[]).images[0].convert("RGB")
    progress("saving")
    if image.size != (width, width // 2):
        raise RuntimeError("Generator returned an unexpected panorama size")
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Software", MODEL_LABEL)
    metadata.add_text("Description", "AI-generated 360 memory from reference photos; unseen content is invented.")
    temporary = job_dir / "panorama.png.tmp"
    image.save(temporary, format="PNG", pnginfo=metadata)
    temporary.replace(job_dir / "panorama.png")
    memory = psutil.Process().memory_info()
    write_json(job_dir / "generation-report.json", {
        "model": MODEL_LABEL, "baseRevision": BASE_REVISION, "loraRevision": LORA_REVISION,
        "localOnly": True, "aiGenerated": True, "sourceCount": len(paths), "seed": seed,
        "width": width, "height": width // 2, "steps": steps, "guidanceScale": 5.0, "loraStrength": 0.9,
        "horizontalFovs": fovs,
        "quantization": "NF4 double quantization, BF16 compute; sequential text/diffusion stages",
        "elapsedSeconds": round(time.perf_counter() - started, 2),
        "peakGpuAllocatedBytes": torch.cuda.max_memory_allocated(),
        "peakGpuReservedBytes": torch.cuda.max_memory_reserved(),
        "peakProcessResidentBytes": getattr(memory, "peak_wset", memory.rss),
        "sources": {"base": BASE_REPO, "adapter": LORA_REPO},
    })
    progress("complete", 1, 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--health", "--check", dest="health", action="store_true")
    parser.add_argument("--job-dir", type=Path)
    parser.add_argument("--width", type=int, default=2048)
    parser.add_argument("--steps", type=int, default=20)
    args = parser.parse_args()
    if args.health:
        print(json.dumps(health()), flush=True)
    elif args.job_dir:
        owns_gpu = False
        try:
            with exclusive_gpu_lock():
                owns_gpu = True
                generate(args.job_dir, width=args.width, steps=args.steps)
        except Exception as error:
            # A rejected duplicate must not overwrite an active job's progress.
            if owns_gpu and args.job_dir.is_dir():
                write_json(args.job_dir / "progress.json", {"stage": "failed", "completed": 0, "total": 1,
                           "error": str(error)[:500]})
            print(f"Local generation failed: {error}", file=sys.stderr, flush=True)
            sys.exit(1)
    else:
        parser.error("Use --health or --job-dir")
