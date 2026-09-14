# Offline Android matching models

The APK bundles two Apache-2.0 models: DISK-depth feature extraction and the
DISK-trained LightGlue matcher. Java uses ONNX Runtime Android 1.23.2 on CPU.
Models contain only standard ONNX opset 17 operators; they need no CUDA, server,
download, API key, or additional custom operator library at inference time.

The exporter uses the LightGlue revision already pinned by the Python stitcher.
From the repository root with its Python environment active:

```powershell
.\.venv\Scripts\python.exe -m pip install onnx==1.19.0 onnxruntime==1.23.2
.\.venv\Scripts\python.exe scripts/export-mobile-stitch-models.py
.\.venv\Scripts\python.exe scripts/export-mobile-stitch-models.py --verify-only
.\.venv\Scripts\python.exe scripts/test_mobile_adaptive_lightglue.py
.\.venv\Scripts\python.exe scripts/benchmark-mobile-stitch-models.py --directory private-media/mobile-stitch-check
.\.venv\Scripts\python.exe scripts/investigate-mobile-matcher-speed.py --directory private-media/mobile-stitch-check
```

Official PyTorch weights are downloaded into PyTorch's cache on the first export
if absent. Subsequent exports reuse them. Exported ONNX files, checksums, test
report, attribution and licenses live in `android/app/src/main/assets/stitch-models`.
The matcher retains all nine layers and their trained weights. Exact upstream
token-confidence early stopping (`depth_confidence=0.95`) runs inside one portable
ONNX graph with eight standard `If` branches. Point pruning remains disabled.
Unused later layers are not executed; this is not three duplicated models.
The adaptive matcher is 47.84 MB versus 45.62 MB for full depth, because each
possible exit needs its original learned assignment head. DISK's variable feature
selection becomes a fixed 1024-capacity top-k with negative-score padding.
Java discards padding before matching. The matcher accepts variable counts.

`OnDeviceFeatureMatcher.match(Context, JSONObject, Progress)` must run on a worker.
Manifest `frames` have validated absolute `filePath`, original `width`/`height`,
and the existing column-major camera `transform`. Source images are read only.
Results contain `{model, aiUsed, pairs: [{i,j,points0,points1,scores}], ...}`.
Correspondences use original image pixel centers, not working-resolution pixels.
The caller still must robustly reject geometric outliers and disconnected scans.
The model output alone is not proof of reliable geometry.

Default processing uses a 512-pixel long edge and at most 768 features per frame.
Internal manifest options `featureLongSide` (384–640) and `maxKeypoints`
(256–1024) permit device benchmarks and higher-quality configurations without
another export. Both dimensions are rounded to multiples of 16, and points are
mapped back with each axis's actual resize scale. At most 64 frames are accepted.
Extraction happens once per image; only compact feature arrays survive between
stages. Extractor and matcher sessions are opened sequentially, and all bitmaps,
inference outputs, and tensors are released. Matching uses at most six nearest
camera directions per image, unioned as unique pairs within 85 degrees, including
loop closure and poles. Missing poses use bounded adjacent pairs instead.

Cancellation is checked during decode preprocessing, asset copying, between
inferences, and after inferences; one ongoing native inference finishes before
cancellation returns. The progress callback receives 0–100 for the matching
stage; a composing caller should map this into its overall progress range.
Results include each pair's evaluated `layers` and `averageMatcherLayers` to
support honest device benchmarks. Full-depth rollback models remain compatible.

The checked-in report compares portable CPU output with original PyTorch on
overlapping and 90-degree rotated crops of the public demo panorama. It checks
model/operator validity, >99.5% detector-coordinate agreement, learned descriptor
error, exact LightGlue match-index and stopping-layer agreement, and accepted
confidence error. Rejected mutual-neighbor ties can have slightly different
low scores without changing any accepted/rejected match. Detector
roundoff can move a near-tied peak by one pixel. It also benchmarks 384/512,
512/768 and 640/1024 settings. These are desktop measurements on a public scene,
not an Android performance or real handheld-capture quality claim.

The separate full-fixture benchmark runs the same two bundled ONNX models on CPU
with the Java neighbor/resize/feature settings. It writes `mobile-matches.json`
in original pixel coordinates for the native engine, `mobile-matches-report.json`
with graph connectedness and desktop spherical-RANSAC checks, and compact cached
features under the fixture directory. This benchmark does not load PyTorch or
perform CUDA inference. OpenCV and Android JPEG/resize implementations can differ
slightly; the on-device pipeline still needs its own execution and output checks.
It accepts either a normalized `manifest.json` or native `metadata.json` plus
local JPEGs, reports incomplete target sets, and compares geometry with and
without pose-prior gating. Recorded camera translations can include AR drift.
Use `--reuse-features --matcher-model PATH --output-prefix mobile-adaptive-matches`
for matcher-only comparisons without changing the baseline outputs. The separate
`export-adaptive-mobile-matcher.py` script stages a candidate outside APK assets
and checks 32 cached controlled/real pairs against original adaptive PyTorch on
CPU, including exact match indices and stopping layers. The stopping-boundary
unit tests cover strict 95% confidence and variable image token counts.

Desktop full-fixture checks kept all 34 controlled frames connected with 68
verified edges: adaptive 11,688 inliers versus full-depth 11,745. Matcher-stage
time including session creation was 58.49 s versus 114.87 s, averaging 3.51 layers.
The incomplete real 33-frame scan remained disconnected and rejected; adaptive
matching took 70.90 s versus 88.01 s, averaging 5.54 layers. Extraction is unchanged.
These are desktop CPU results, not Android timing or a guarantee for other rooms.

For a reproducible full-depth rollback without touching production assets:

```powershell
.\.venv\Scripts\python.exe scripts/export-mobile-stitch-models.py --fixed-depth --output-directory private-media/mobile-model-rollback
```

Candidate promotion must copy its matching `model-report.json` with the model;
Java verifies each model's reported SHA-256 before cached use and repairs corrupt
entries from the verified bundled asset. A changed hash always selects a new
cache path, even when an APK update reuses the same asset name. Keep the
known-working full-depth APK/model outside the assets directory until device
inference and final geometric verification pass. Do not bundle both matchers.

Primary upstream references:

- https://github.com/cvg/LightGlue
- https://github.com/cvlab-epfl/disk
- https://github.com/fabio-sim/LightGlue-ONNX
- https://onnxruntime.ai/docs/get-started/with-java.html
