# AI-assisted 360 reconstruction

This document describes the optional **computer-side worker for web/iOS**.
Android uses its bundled offline native engine instead, even if a worker URL is
configured. See [Android offline stitching](../../docs/android-offline-stitching.md).

The local worker uses pretrained **DISK + LightGlue** to match actual details
between camera photos, refine camera alignment, choose seams, and blend exposure.
It returns a metadata-free 4096 × 2048 JPEG and thumbnail to the existing Moment
review, save, and VR flow. Source photos stay on the stitching computer.

This reconstructs photographed content. It cannot restore severe blur, hidden
surfaces, or stitch unrelated photos into a faithful room. Translation and moving
subjects still cause parallax. Unreliable or incomplete sets are rejected.
Previously flattened panoramas need their original source photos for restitching.

## Setup

Use Python 3.12 and the project's Node/pnpm environment, from the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services/stitcher/requirements-dev.txt
pnpm install --frozen-lockfile
pnpm dev:ai
```

On macOS/Linux use `.venv/bin/python`. CPU processing is supported. For the
tested NVIDIA CUDA 12.8 runtime, install these **before** the requirements:

```powershell
.\.venv\Scripts\python.exe -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
```

The first worker start downloads official model weights to ignored `.models/`.
Photos are never sent to the model host. Health reports AI readiness only after
loading succeeds. `STITCHER_MATCHER=sift` explicitly selects the classical
fallback; its outputs do not claim AI matching.

`pnpm dev:ai` runs the worker at `127.0.0.1:8787` and the demo app on port 5173.
If Vite is already running, `pnpm stitch:server` starts only the worker. Ctrl+C
stops the launcher and its children. Vite forwards `/api/stitch` to the worker.
Normal web builds do not include Python, model weights, or an automatic worker.

## Use

In Moments, select the **360 camera**, then **Build from your photos**. Choose
8–64 overlapping JPEGs taken from one spot, including the whole sweep, upper and
lower views, ceiling, and floor. Keep the same lens/zoom. Review the result before
sharing. Progress describes actual upload, matching, alignment and blending work.
The selected source files are not modified.

Installed iOS builds can use this pipeline when
`VITE_STITCH_SERVICE_URL` is configured before building to a reachable endpoint
ending in `/api/stitch`. An empty value keeps native on-device assembly. A
phone's `localhost` refers to the phone, not the PC. Use an authenticated HTTPS
proxy for remote deployment and explicitly configure `STITCH_ALLOWED_ORIGINS`
and `STITCH_ALLOWED_HOSTS`; this loopback prototype is not a public hosted service.

Android no longer depends on `adb reverse`, USB, or this server for assembly.
Its foreground worker survives screen navigation; persisted originals and job
status allow recovery after a process restart. A quality rejection is shown
explicitly, never silently replaced by the old pose-only mosaic. Saving or
sharing a sphere does not delete its originals. Update APKs with `adb install -r`;
do not uninstall or clear app data.

## API and limits

- `GET /api/stitch/health`: model readiness, device and model name.
- `POST /api/stitch/jobs`: multipart `manifest` JSON and repeated `frames` JPEGs.
  Version-1 manifests contain `outputWidth` and ordered frame metadata matching
  `nativePanoramaCapture.ts`. Ordinary uploads use `projection: "unposed"`.
- `GET /api/stitch/jobs/:id`: status, actual stage/progress and quality report.
- `GET /api/stitch/jobs/:id/panorama` and `/thumbnail`: completed images.
- `DELETE /api/stitch/jobs/:id`: cancel and clean up the temporary job.

One worker processes a bounded queue. Format, size and decoded-pixel limits are
enforced. The worker does not touch family tables. Source copies are deleted
after completion, failure or cancellation; completed outputs expire after one
hour. The client also deletes the job after downloading its result.

## Verification

```powershell
.\.venv\Scripts\python.exe -m unittest services.stitcher.test_engine services.stitcher.test_matcher services.stitcher.test_server -v
pnpm vitest run src/services/media/aiPanorama.test.ts src/features/capture
pnpm build:demo
.\.venv\Scripts\python.exe scripts/check-stitcher.py
```

The last command requires `pnpm dev:ai`. It projects the bundled concept panorama
into 34 views, deliberately perturbs pose and brightness, uploads through the
real HTTP proxy and verifies a learned reconstruction with exact output size.
Generated fixtures/results stay in ignored `private-media/stitch-check/`.
`--unposed` tests estimation without native poses. Controlled fixtures do not
substitute for physical iPhone/Android tests with handheld capture sets.

References: [LightGlue](https://github.com/cvg/LightGlue),
[OpenCV stitching](https://docs.opencv.org/4.x/d8/d19/tutorial_stitcher.html),
[PyTorch](https://pytorch.org/get-started/locally/).
