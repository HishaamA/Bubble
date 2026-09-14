# Free local AI 360 scenes

The optional **AI scene** workflow accepts one to four ordinary photos instead of
requiring a guided scan. A free, locally installed image model invents the missing
parts of a scene. This is an **AI reconstruction**, not an exact photographic
record, a verified scan, or a six-degree-of-freedom 3D model.

There is no paid API, account, subscription, or per-image fee. Generation runs
on the user's NVIDIA-equipped computer, **not inside the phone**. The computer
must remain on while generating. The phone keeps reference originals and saves
accepted results to Moments for subsequent viewing without the computer.

## Setup

Use Python 3.12 with CUDA-enabled PyTorch. This repository's existing `.venv`
already supplies PyTorch 2.8.0+cu128; the generation dependency file deliberately
does not replace it.

```powershell
cd C:\Data\Programs\Bubble
.\.venv\Scripts\python.exe scripts/setup-local-generation.py --install-deps --download
.\.venv\Scripts\python.exe -m services.generation.local_pipeline --check
corepack pnpm generate:server
```

Setup downloads approximately 16 GB of public, pinned safetensors and verifies
their published SHA-256 checksums. Weights stay in ignored `.models`, never Git
or the APK. Inference requires the installation manifest and uses offline mode
and `local_files_only=True`; it never downloads weights or sends photos to an
image-generation provider.

In another terminal, run `corepack pnpm dev`. The existing Vite preview proxies
`/api/generation` to this companion on port 8788. Open `#/capture?workflow=ai`,
or choose AI generation under **Other creation options** in Capture. Health checks
do not generate images. Missing weights, a disconnected computer, or an absent
GPU disable generation while retaining the ability to prepare local drafts.

### Connected Android demo

For a demo APK built with `VITE_DEMO_LOGIN_ENABLED=true`, the client defaults to
device loopback port 8788. Explicitly forward that port over USB:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" reverse tcp:8788 tcp:8788
```

Keep USB debugging authorized and the generation terminal running. Debug-only
Android network rules allow loopback HTTP; release builds do not. A release
build or iOS build needs a reachable trusted HTTPS endpoint supplied through
`VITE_GENERATION_SERVICE_URL`. The loopback companion is not a hosted service
and has not been validated as an iOS deployment. Do not expose it publicly.

## Capture and recovery

1. Stand roughly in one place. Take a front photo, then optionally right, back,
   and left photos. Select the correct rough direction for each; no AR tracking
   or dot-scanning is required. Use one photo per direction.
2. Add an optional description. Explicitly allow copies to be sent to your own
   generation computer. The original phone files remain in account-scoped
   IndexedDB; transfer copies are resized and metadata-free.
3. Generate once. A durable job ID prevents a lost acknowledgement from starting
   duplicate work. Only one GPU job runs at a time. Leaving Capture does not
   cancel the computer's process; return to recheck the saved job.
4. Review the actual spherical result, including the join behind you and the
   ceiling/floor. Add memory points if desired, then explicitly save to Moments.
   This does not automatically publish to the family.

Originals and generated results stay in the draft after saving. Deleting a
draft is an explicit confirmed action and does not remove a saved Moment.
Computer working copies remain in ignored `private-media/generation-jobs`;
there is no automatic source cleanup. Do not delete that directory if you need
job recovery. App data clearing/uninstalling can still remove local phone data.

A computer/process restart marks unfinished jobs interrupted, not successful.
Retry requires an explicit user action. Failed or malformed outputs are never
silently stretched into panoramas. The client decodes the actual image and
requires exact 2:1 dimensions between 1024×512 and 8192×4096. Those checks only
establish file compatibility: user review is still needed to assess geometry,
seams, faces, and other invented details.

The default `#/capture` screen now assembles guided photos on the phone with the
shared iOS/Android compositor. Existing AI drafts and generated results remain in
this optional workflow. The stricter assembler remains at
`#/capture?workflow=advanced&mode=manual`; its source files, saved spheres, and
native pipeline have not been deleted. Legacy links resolve to standard capture.

## Model and limitations

- Base: [FLUX.2-klein-base-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4B).
- Panorama adapter: [nomadoor's 360 ERP Outpaint LoRA](https://huggingface.co/nomadoor/flux-2-klein-4B-360-erp-outpaint-lora).
- Both are published under Apache-2.0. Pinned revisions and required files are
  in `model_config.py`; licenses/model cards are retained with the installation.
- The adapter expects photographs projected from pinhole views onto a green
  equirectangular canvas. `projection.py` implements this without cross-photo
  blending and preserving aspect ratios. Each photo's approximate field of view
  is estimated locally from its 35 mm-equivalent focal length when present,
  otherwise from a 74° diagonal camera assumption and the upright image shape
  (about 41° horizontal for a portrait phone photo). Only the numeric angle is
  transferred, never raw EXIF or GPS. Direction/FOV estimates are not camera
  calibration; use the main 1× camera and keep the phone level.
- The author's **undistilled base model** is used; the faster distilled variant
  is explicitly not recommended for this adapter. Qwen prompt encoding and
  diffusion run sequentially with NF4 weights to reduce GPU memory demand.
- Defaults: 2048×1024, 20 diffusion steps, CFG 5, adapter strength 0.9. A 2K
  panorama can still look soft in a headset. No pixel-faithfulness, perfect
  seams, photorealism, or mobile generation-time guarantee is made.
- This is a mono panorama. Cardboard can display it, but it does not contain
  stereo depth or let the user walk around objects.

## Checks

```powershell
corepack pnpm test:generation
.\.venv\Scripts\python.exe -m unittest services.generation.test_projection services.generation.test_local_pipeline services.generation.test_generation_qa
corepack pnpm exec vitest run src/features/capture/Generative360Page.test.tsx src/features/capture/generativeCaptureStore.test.ts src/services/media/generativePanorama.test.ts src/services/media/validateGeneratedPanorama.test.ts
```

These tests use fixtures or mocks. They are not evidence of model visual quality.
Real inference writes `generation-report.json` next to the generated panorama,
with exact model revisions, settings, GPU/process memory, and elapsed time.

### Local validation, 10 September 2026

A real one-photo kitchen run completed at 2048×1024 with 20 steps on the
RTX 4060 Laptop 8 GB, in 388 seconds after imports. Peak CUDA allocation was
7.83 GB and peak process resident memory was 8.61 GB. This leaves little GPU
headroom; the app serializes jobs and the worker also holds an OS process lock.

The six perspective checks showed a recognizable generated room, including
ceiling and floor, without empty green regions. It also repeated sinks and
appliances, altered source details, introduced a greenish colour cast, and had
a visible back-wrap mismatch. This is a feasibility result, **not acceptance of
photographic accuracy or perfect VR quality**. The later sequential checkpoint
loader flag is unit-tested but was not part of this timed GPU run. More reference
photos and different rooms still need real-device visual evaluation.

## Network boundary

The companion binds only to `127.0.0.1`, checks Host/Origin, bounds request sizes,
uses unguessable UUID capability paths, and does not offer a job-list endpoint.
It is for local development/USB testing. It does **not** implement production
authentication, TLS, remote account permissions, or a hardened multi-user GPU
queue. A publicly reachable deployment would require those separately.
