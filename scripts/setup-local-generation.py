"""Explicit one-time setup: public Apache-2.0 models, no account, no paid API.

Use --install-deps to install the pinned Python dependencies and --download to
download only the ~16 GB Diffusers components (not duplicate monolithic weights).
Model files remain outside the APK, in the ignored .models directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "generation"))
from model_config import (BASE_FILES, BASE_REPO, BASE_REVISION, LORA_FILES, LORA_REPO,
                          LORA_REVISION, MODEL_ROOT)


def setup(download=False):
    from huggingface_hub import HfApi, hf_hub_download
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    # Two downloads at most are unnecessary here: sequential downloads keep memory bounded.
    os.environ["HF_XET_NUM_CONCURRENT_RANGE_GETS"] = "4"
    entries = []
    for repo, revision, folder, names in (
        (BASE_REPO, BASE_REVISION, "base", BASE_FILES),
        (LORA_REPO, LORA_REVISION, "lora", LORA_FILES),
    ):
        info = HfApi(token=False).model_info(repo, revision=revision, files_metadata=True)
        if info.gated or info.sha != revision:
            raise RuntimeError("Expected an ungated immutable public model revision")
        available = {item.rfilename: item for item in info.siblings}
        for name in names:
            item = available[name]
            entries.append({"repo": repo, "revision": revision, "folder": folder,
                            "name": name, "size": item.size,
                            "sha256": item.lfs.sha256 if item.lfs else None})
    total = sum(item["size"] for item in entries)
    if total > 20_000_000_000:
        raise RuntimeError("Model download exceeds the authorized 20 GB limit")
    print(json.dumps({"downloadBytes": total, "modelDirectory": str(MODEL_ROOT),
                      "accountRequired": False, "usageFee": 0}), flush=True)
    if not download:
        return
    if shutil.disk_usage(ROOT).free < total + 2_000_000_000:
        raise RuntimeError("Not enough disk space for the model installation")
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    for index, item in enumerate(entries):
        print(f"Downloading/verifying {index + 1}/{len(entries)}: {item['folder']}/{item['name']}", flush=True)
        path = Path(hf_hub_download(repo_id=item["repo"], revision=item["revision"],
                    filename=item["name"], local_dir=MODEL_ROOT / item["folder"], token=False))
        if path.stat().st_size != item["size"]:
            raise RuntimeError(f"Incomplete model file: {item['name']}")
        if item["sha256"]:
            with path.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if digest != item["sha256"]:
                raise RuntimeError(f"Model checksum failed: {item['name']}")
    manifest = {"baseRevision": BASE_REVISION, "loraRevision": LORA_REVISION,
                "downloadBytes": total, "files": entries,
                "license": "Apache-2.0 (base LICENSE.md and LoRA model-card declaration)"}
    temporary = MODEL_ROOT / "installation.json.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(MODEL_ROOT / "installation.json")
    print("Local model installation verified. Inference uses local files only.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-deps", action="store_true")
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    if args.install_deps:
        subprocess.run([sys.executable, "-m", "pip", "install", "-r",
                        str(ROOT / "services/generation/requirements.txt")], check=True)
    setup(args.download)
