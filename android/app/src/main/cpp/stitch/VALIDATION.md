# Native validation — 2026-09-09

Built the official OpenCV 4.12.0 static modules with NDK 27 for arm64-v8a and
ran `bubble_stitch_tests` and `bubble_stitch_cli` on the connected Android phone.
All device files were isolated under `/data/local/tmp/bubble-native-stitch-check`;
original captures and previous results were preserved.

## Deterministic regression executable

Passed calibrated rays, rotation direction, substantial outliers, degenerate
correspondence rejection, global refinement, connected components, visual bootstrap,
cancellation, and connected missing regions across longitude wrap. Recovery tests
check the four-attempt per-frame and 96-total budgets, exclude existing edges and
opposite-facing cameras, skip a strong connected graph, and never guess absent poses.

Android JSON regressions passed escaped slashes, literal backslashes followed by
slashes, Unicode escapes and surrogate pairs, raw Java UTF-16 conversion, null,
booleans, numeric bounds, and privacy-safe malformed-input errors. This caught and
fixed the incompatibility between Android `JSONObject.toString()` and OpenCV's
configuration-oriented FileStorage JSON reader. The replacement uses the pinned,
MIT-licensed standard JSON parser documented in README.md.

## Controlled 34-view reconstruction

These views are sampled from the bundled reference panorama, with known calibration,
small pose perturbations and exposure variation. They are 512×684 with a 62° horizontal
field of view, **not** the narrower real phone calibration and **not** independent
handheld photos. Output resolution was 2048×1024.

| Matching source | Aligned | Validated pairs | Median / p95 residual | Output pixels, median / p95 |
| --- | --- | --- | --- | --- |
| Native SIFT | 33/34 | 140 | 0.0160° / 0.0687° | 0.091 / 0.391 |
| Desktop ONNX DISK + LightGlue | 34/34 | 68 | 0.0960° / 0.2135° | 0.546 / 1.215 |
| Phone ONNX DISK + LightGlue, plus native recovery | 34/34 | 74, including 4 recovered | 0.0931° / 0.2116° | 0.529 / 1.204 |

All three outputs had 100% measured spherical and pixel coverage, zero missing
components, and a median longitude-boundary channel difference of 0.667/255. The
SIFT run excluded one unconnected view; its remaining actual projections still
independently covered the complete sphere.

The phone-learned matches were copied verbatim from the instrumented ONNX run.
The native CLI accepted Android-style slash-escaped file paths, null, booleans and
Unicode in the manifest and completed successfully. This validates phone-generated
correspondences through native reconstruction; the app JNI/service lifecycle is
separately exercised by instrumentation, not inferred from the CLI.

Pulled full-resolution outputs were visually inspected. No visible frustum wedges,
black coverage bands, horizontal strip boundaries or wrap discontinuity appeared in
this controlled fixture. For the phone-learned output, mean absolute RGB channel
error against the resized reference was 5.116/255; the 95th percentile was 17/255.
Mean error on the strip boundary was 8.539, comparable to 8.489 in its neighboring
rows. Two naturally black rendered pixels are not missing coverage; coverage is
measured from source-observation masks, never inferred from image brightness.

An additional recovery regression removed **every learned pair touching frame 10**.
The bounded native pass added seven validated SIFT edges and restored all 34 frames
to the connected group: 71 total edges, 100% coverage, zero holes, median 0.0887°
and p95 0.2085° residual (0.505 / 1.186 output pixels). This tests actual visual
reconnection rather than only candidate selection; the unmodified quality gates passed.

## Incomplete real 33-photo capture

Original 1080×1920 JPEGs and recorded calibration/poses were tested with learned
matches plus bounded SIFT recovery. The engine **rejected** the set with
`quality_rejected / INSUFFICIENT_GEOMETRY`: only 19 validated pairs, including one
recovered edge, and a largest connected group of 6/33 frames. It did not blend a
pose-only fallback, invent missing views or overwrite originals/results.

Separately, the ideal initial 34-target grid with the recorded narrow calibration
(approximately 40.74° horizontal, 67.07° vertical FOV) covers only 99.6715% of
2048×1024 panorama pixels, leaving 6,890 pixels unobserved. Thus nominal target count
alone is insufficient: capture guidance needs measured adaptive coverage additions.
Thresholds must not be loosened to force this incomplete/poor-geometry set through.

## Limits of this evidence

No claim of perfect handheld reconstruction follows from synthetic fixture success.
Nearby objects, moving people, strong camera translation, blur, weak texture and
inaccurate calibration can still cause rejection or visible local seam artifacts.
The engine reports residuals and warnings and never invents absent scene content.
Native reconstruction elapsed time was not independently timed in these CLI runs;
use the instrumented service run for end-to-end timing and memory evidence.

## Subsequent 4K service evidence and profiling next steps

The foreground-service run with phone ONNX matching completed 4096×2048 output
in 352.27 seconds. Reported extraction was 122.326 seconds and matching 79.164
seconds, leaving approximately 150.8 seconds for native reconstruction **plus other
overhead**, not an isolated graph-cut timing. All 34 views connected through 73
validated pairs, including four recovered SIFT edges. Coverage was 100%, with no
holes; median/p95 residuals were 1.0485/2.3752 output pixels and median wrap color
difference 0.333/255. Observed memory reached approximately 365 MB PSS, 488 MB RSS
and 38 MB swap. These are sampled observations, not a proven process peak. The
service continued with the screen off while holding its wake lock.

A subsequent **read-only** seam review found the following opportunities, not
measured speedups. Production code was not changed during or after this run.

- Seam images remain fixed at 1024×512 even for 4K output. Final-resolution blending
  is separate, so increasing output resolution does not itself enlarge seam graphs.
- A local model of the controlled fixture's initial, unrefined projection masks
  found 200 candidate pairs and approximately 18.27 million graph vertices before
  sequential ownership cuts. Repeated float-input area was 62.12 million pixels
  versus 5.20 million unique pixels, approximately 12× repeated preprocessing.
  These estimates omit collar locking and refined rotations; they are not runtime
  counts, and later mask pruning can skip pairs.
- The largest modeled overlap was 1120×217 including periodic padding: OpenCV
  creates 270,180 graph vertices including its margin although only 19,569 pixels
  had joint source coverage. Longitude-split and pole-spanning bounding boxes can
  therefore include substantial empty space.
- The wrapper repeats border expansion, float conversion and Mat-to-UMat copies.
  OpenCV 4.12's GraphCutSeamFinder also recomputes both source gradients each time
  `find` is called. Its Sobel outputs are CPU Mats, and graph construction/max-flow
  are CPU operations. UMat allocator/transfer or OpenCL initialization cost is a
  profiling question, not an established explanation for the observed duration.
- Progress currently depends on the outer frame index. Several early pair batches
  share the same percentage and stage, which JNI intentionally deduplicates. A
  long unchanged displayed percentage is therefore not evidence of a hung solver.

First add monotonic aggregate timers for source validation, fallback feature
extraction/matching, geometry refinement, coverage projection, exposure, seam
preparation, seam solver calls, final blending, and encoding. Within seams, record
candidate/solved counts, total and maximum ROI vertices, preprocessing/copy time,
total `finder.find` time, and the slowest pair's duration and numeric frame indices.
Do not log filenames, manifests or image data. The opaque `finder.find` duration
still includes gradient construction and max-flow; attribution between those
requires a later profiler or deliberately instrumented dependency build.

Only after attribution, benchmark strictly equivalent bounded improvements such
as reusing the outer frame's immutable float conversion, reducing redundant CPU
UMat copies, and explicitly testing CPU-only UMat behavior. Verify identical seam
masks/output, coverage, residuals, memory and cancellation behavior. Caching all
float projections and gradients would add substantial retained memory (roughly
104 MB for the modeled fixture before allocator overhead), so it is not an
automatic improvement on this phone.

Cropping to current mask bounds, solving disconnected overlap components, changing
pair order, parallelizing pairs, lowering seam resolution or replacing graph-cut
can change seam topology or quality. These are **not** established safe quick
optimizations: masks mutate sequentially, and OpenCV's 10-pixel graph context and
terminal/edge costs must be preserved and tested. No such tradeoff is approved or
implemented here.

Cancellation is checked before every pair, including skipped pairs, but one
OpenCV `finder.find` call cannot currently be interrupted internally. Record maximum
pair duration and test cancellation during that slowest pair. Extra checks around
preprocessing and after the solver can improve response boundaries but cannot
interrupt max-flow. Likewise, JPEG decode/encode and individual blender calls
remain non-interruptible. Prefer pair-count progress and elapsed-stage reporting
over promises of a fixed cancellation latency.

Implementation evidence: the wrapper is in `stitch_engine.cpp`; OpenCV's
[seam implementation](https://github.com/opencv/opencv/blob/4.12.0/modules/stitching/src/seam_finders.cpp#L1048)
and [Sobel dispatch](https://github.com/opencv/opencv/blob/4.12.0/modules/imgproc/src/deriv.cpp#L308)
show the repeated gradient work and CPU graph path.

## Real 44-photo rejection and capture-reference audit (2026-09-09)

The subsequent real handheld session saved 34 initial directions plus 10 coverage
fill directions. Its old raw-AR-world metadata reported complete coverage, but
assembly correctly rejected the disconnected visual graph. This is not a passing
real-room reconstruction, and its metadata coverage is not reliable physical
coverage evidence.

Concrete reference failure: photos 23 and 39 visibly depict the same distinctive
sink, air fryer, towel and floor drain. Their saved yaw values are 179.63 and
103.10 degrees despite a small actual view change. Independent native-configured
SIFT extraction at a 1024-pixel long edge found 443 mutual-ratio matches, 335
homography inliers and 335 calibrated rotation inliers. Without the pose-prior
filter, their fitted relative rotation differs from the saved relative pose by
77.75 degrees; saved world-ray disagreement is 73.08 degrees median. These are
hundreds of matches on real objects, not a weak repeated-ceiling hypothesis.
Recorded translation excursions must therefore not be presented as measured
physical arm travel: changing AR world references contaminate those numbers too.

ARCore explicitly says raw world coordinates are frame-local and recommends a
nearby persistent anchor for cross-frame coordinates. The capture fix uses one
same-frame anchor-relative camera pose for guidance, hold, coverage and saved
metadata, retaining strong tracking gates. Its full-3D gauge-invariance unit tests
check the mathematics, not real-world ARCore accuracy. Fresh physical testing
through texture loss and relocalization remains necessary. See the official
[Pose coordinate-space contract](https://developers.google.com/ar/reference/java/com/google/ar/core/Pose#world-coordinate-space)
and [Anchor pose lifetime](https://developers.google.com/ar/reference/java/com/google/ar/core/Anchor#getPose()).

Broader recovery checks kept all production geometry thresholds unchanged:

| Diagnostic input | Pose-neighbor pairs | Accepted SIFT edges | Largest SIFT component |
| --- | ---: | ---: | ---: |
| Desktop 1024-pixel SIFT, 3000 features | 408 | 13 | 3 of 44 |
| Desktop original-1920 SIFT, 6000 features | 408 | 15 | 4 of 44 |
| Exact Android native validation of original-1920 SIFT pairs | 408 | 16 | 6 of 44 |

Desktop checks use OpenCV 4.11 and NumPy random sampling; the phone uses OpenCV
4.12 and native random sampling. This explains why diagnostic counts are not
bit-for-bit native counts. All use homography residuals at a **1024-pixel long
edge**, not the original 1920-pixel grid. An initial learned-match diagnostic used
the wrong pixel scale and was corrected before drawing conclusions.

At original resolution, 365 of 408 SIFT pairs had fewer than 12 mutual-ratio
matches. Combining the broader SIFT edges with baseline learned edges still gave
a largest desktop component of only 7 of 44. The extra useful SIFT edges outside
the existing four-attempt recovery selection were 4–5 and 39–40; neither bridges
the graph globally. A diagnostic removing the pose prior produced only 20 SIFT
edges and an 11-photo largest component, so this is not evidence for safely
salvaging the full sphere by disabling priors or increasing recovery budgets.

The exact Android CLI check took 0.90 seconds including invocation and rejected
with `quality_rejected` / `INSUFFICIENT_GEOMETRY`, 16 matched pairs and 6 aligned
frames. It used copied inputs under the isolated native-check directory, skipped
redundant SIFT extraction, never reached seam/render stages, and produced no
panorama. All source photographs and original session metadata were preserved.
No native thresholds, recovery budgets or production matching code were changed
for this investigation.
