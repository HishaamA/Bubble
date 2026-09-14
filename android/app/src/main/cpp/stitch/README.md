# Native measured panorama reconstruction

`NativePanoramaStitcher.stitch(manifestJson, outputDirectory, matchesJson, width, callback)`
is synchronous and must run on a worker. The JNI boundary serializes native jobs.
The callback uses percent 0–100 and supports cancellation between geometry iterations,
graph-cut overlap pairs, projection row batches, source decodes, and blend strips.
An individual JPEG decode, OpenCV graph-cut pair, or encoding call is not interruptible.

The normalized manifest is `{ "frames": [...] }`. Each upright JPEG has `filePath`,
`width`, `height`, a row-major 3x3 `intrinsics`, and optionally a column-major 4x4
native Android camera-to-world `transform`. Intrinsics and correspondence coordinates
are in **original upright JPEG pixels**, not matcher thumbnail pixels. JPEG headers
are checked before decode; mismatched declared dimensions are rejected. EXIF rotation
is disabled because the caller must normalize orientation before matching.
Standard JSON is decoded with the vendored nlohmann JSON parser, not OpenCV
FileStorage. Android escaped slashes, literal backslashes, Unicode surrogate pairs,
null and booleans are preserved. Parse failures never echo private input metadata.

Matches are `{ "model": "…", "aiUsed": true, "pairs": [ { "i": 0, "j": 1,
"points0": [[x,y],…], "points1": [[x,y],…] } ] }`. An empty set uses mutual,
ratio-tested native SIFT matching, and reports `aiUsed:false`. There is no pose-only
assembly mode. Weak learned graphs also receive a bounded SIFT recovery pass: only
missing pose-neighbor pairs involving degree<2 frames or different components,
at most four attempts per frame and 96 total. Existing learned edges are retained;
new pairs must pass identical geometry validation. Hybrid use is explicitly reported.
Correspondences first pass 3.5-pixel homography RANSAC at a normalized
1024-pixel image scale, then calibrated rotation-only RANSAC and angular-spread checks.
Global robust rotation refinement closes visual loops using weak AR pose priors.
Missing poses require a connected visual bootstrap; focal lengths remain fixed, so
uncalibrated imports may correctly fail the residual gate.

Only the largest connected visual component is eligible. It must include at least
8 frames and 60% of inputs, then independently pass all coverage checks. Excluded
frame indices are reported. Geometry requires median angular residual ≤0.2° and
95th percentile ≤0.6°, additionally capped at 2 and 6 output pixels respectively.
Area-weighted sphere and equirectangular pixel coverage must each reach 99.98%, both
before seams and after full-resolution compositing. The largest connected missing
component (including connections across longitude wrap) must be ≤0.0025% of pixels,
with a 12-pixel raster tolerance. This is stricter than the older service and is not a guarantee that every local
object is aligned. The rotation model cannot reconstruct arbitrary camera translation
or moving subjects. Residuals, lens travel, low-detail images, and boundary differences
produce warnings for inspection.

Exposure gains are robust scalar overlap estimates, bounded to exp(±0.35).
OpenCV graph-cut color/gradient seams choose source ownership around parallax.
Periodic padding and a shared observed-source collar preserve longitude ownership.
Narrow mask dilation plus multiband blending avoids broad averaging of displaced
objects. No semantic generation, inpainting, or invented scene coverage is used.
Pixels outside real observed masks remain dark, including gaps near the poles.

Memory is bounded by at most 64 low-resolution projections and one decoded source
at a time. Source decode is capped to a 3072-pixel long edge using reduced JPEG decode
where possible. Final 1024–6144 output uses 512-row strips with pyramid-support halos;
strip origins share the same pyramid phase. Original photos are decoded again when
needed by another strip; this trades CPU time for bounded native memory. Full-resolution
images and pyramids for every source are never retained together. Output names are
unique within the caller's directory; originals and existing results are never deleted.

Success: `{ "state":"completed", "panoramaPath":…, "thumbnailPath":…, "width":…,
"height":…, "report": { "method":…, "aiUsed":…, "matchedPairs":…, "alignedFrames":…,
"excludedFrames":[…], "coverage":…, "pixelCoverage":…, "alignmentErrorDegrees":…,
"alignmentP95Degrees":…, "seamMethod":…, "generativeFill":false, "warnings":[…] } }`.
Failure: `{ "state":"failed", "code":"quality_rejected" | "out_of_memory" |
"stitch_failed", "reasonCode":…, "error":… }`. Cancellation uses `state:"cancelled"`.

## Dependency and build

Official [OpenCV 4.12.0 Android SDK](https://github.com/opencv/opencv/releases/tag/4.12.0):
`opencv-4.12.0-android-sdk.zip`, SHA256
`fd7f2332331b4eb8b67e55137281cfb16823c9399d90deb9cfa3476783b99e35`.
The dependency is Apache-2.0; retain the SDK's license/third-party notices in distribution.
Local path: `.native-deps/opencv-4.12.0/OpenCV-android-sdk` (ignored).
Pass `OpenCV_DIR=<sdk>/sdk/native/jni`, Android NDK 27+, and `ANDROID_STL=c++_shared`.
Selected OpenCV C++ modules are statically linked into `bubble_stitcher`; Java loads
only `bubble_stitcher`, plus the packaged C++ shared runtime. No `opencv_java4` loader
or Java OpenCV SDK is required.
The pipeline uses OpenCV's documented [graph-cut and multiband APIs](https://docs.opencv.org/4.12.0/d9/dd8/samples_2cpp_2stitching_detailed_8cpp-example.html).

`third_party/json.hpp` is the unmodified MIT-licensed official
[nlohmann JSON v3.12.0 single header](https://github.com/nlohmann/json/releases/tag/v3.12.0),
SHA256 `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`.
Its license is retained beside the header; no additional binary or Gradle dependency
is required.

`BUBBLE_STITCH_BUILD_TESTS=ON` builds `bubble_stitch_tests` (deterministic geometry
regressions) and `bubble_stitch_cli` for on-device fixture evaluation. The CLI accepts
manifest JSON path, matches JSON path (or `-` for SIFT), output directory, and width.
It emits structured result JSON to stdout and progress to stderr. Device tests must
also exercise real handheld scenes: near objects, repeated patterns, a complete wrap,
bright windows, low-detail ceilings, missing zenith/nadir, cancellation and memory retry.
Synthetic geometry passing is not evidence of perfect real-world stitching.
