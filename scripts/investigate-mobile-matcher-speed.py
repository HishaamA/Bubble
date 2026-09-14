"""Measure upstream CPU adaptive matching on cached ONNX features without changing APK models.

Run benchmark-mobile-stitch-models.py first. This diagnostic intentionally uses
PyTorch CPU to compare available early-stop/pruning policies. It does not claim
these timings represent an adaptive ONNX model or Android device performance.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

import numpy as np
import torch
from lightglue import LightGlue

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from services.stitcher.engine import _pair_edge, frame_basis, frame_calibration


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "private-media/mobile-stitch-check")
    parser.add_argument("--pairs", type=int, default=10)
    args = parser.parse_args()
    directory = args.directory.resolve()
    baseline = json.loads((directory / "mobile-matches.json").read_text())
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        manifest_path = directory / "metadata.json"
    frames = json.loads(manifest_path.read_text(encoding="utf-8-sig"))["frames"]
    features = np.load(directory / "mobile-features.npz")
    ordered = sorted(baseline["pairs"], key=lambda pair: len(pair["points0"]))
    selected = [ordered[index] for index in np.linspace(0, len(ordered) - 1, min(args.pairs, len(ordered))).astype(int)]
    calibrations = [frame_calibration(frame, frame["width"], frame["height"]) for frame in frames]
    bases = [frame_basis(frame) for frame in frames]
    torch.set_num_threads(2)
    matcher = LightGlue(features="disk", flash=False, depth_confidence=-1, width_confidence=-1).eval().cpu()
    configurations = [("full9", -1, -1), ("earlyStop", .95, -1), ("earlyStopAndPruning", .95, .99)]
    measurements = []
    with torch.inference_mode():
        for selected_pair in selected:
            i, j = selected_pair["i"], selected_pair["j"]
            # image_size=[2,2], keypoints=normalized+1 reproduce precisely the
            # normalized positional inputs from the bundled ONNX matcher.
            data = {f"image{side}": {
                "keypoints": torch.from_numpy(features[f"normalized_{index}"] + 1),
                "descriptors": torch.from_numpy(features[f"descriptors_{index}"]),
                "image_size": torch.tensor([[2.0, 2.0]])}
                for side, index in enumerate((i, j))}
            reference = None
            pair_report = {"i": i, "j": j, "onnxBaselineMatches": len(selected_pair["points0"]), "configurations": []}
            for name, depth, width in configurations:
                matcher.conf.depth_confidence, matcher.conf.width_confidence = depth, width
                times = []
                for _ in range(2):
                    started = time.perf_counter()
                    output = matcher(data)
                    times.append(time.perf_counter() - started)
                matches = output["matches"][0].numpy()
                correspondence_set = {tuple(pair) for pair in matches}
                if reference is None:
                    reference = correspondence_set
                first = features[f"original_{i}"][0][matches[:, 0]]
                second = features[f"original_{j}"][0][matches[:, 1]]
                edge = _pair_edge(i, j, first, second, calibrations, bases)
                pair_report["configurations"].append({"name": name, "cpuSeconds": float(np.median(times)),
                    "layers": int(output["stop"]), "matches": len(matches),
                    "fullDepthMatchRecall": len(correspondence_set & reference) / max(1, len(reference)),
                    "fullDepthMatchPrecision": len(correspondence_set & reference) / max(1, len(correspondence_set)),
                    "verifiedInliers": edge["count"] if edge else 0,
                    "verifiedAngularErrorDegrees": edge["error"] if edge else None})
            measurements.append(pair_report)
            print(json.dumps(pair_report), flush=True)
    summary = []
    for name, _, _ in configurations:
        values = [next(config for config in pair["configurations"] if config["name"] == name) for pair in measurements]
        summary.append({"name": name, "medianCpuSeconds": float(np.median([value["cpuSeconds"] for value in values])),
                        "meanLayers": float(np.mean([value["layers"] for value in values])),
                        "meanFullDepthMatchRecall": float(np.mean([value["fullDepthMatchRecall"] for value in values])),
                        "acceptedEdges": sum(value["verifiedInliers"] >= 12 for value in values),
                        "totalVerifiedInliers": sum(value["verifiedInliers"] for value in values)})
    report = {"runtime": "PyTorch CPU", "threads": 2, "pairsTested": len(measurements), "summary": summary,
              "measurements": measurements,
              "limitations": "Representative pair study only. No APK model or production matching policy changed. ONNX/Android performance and full graph quality for adaptive inference remain unmeasured."}
    (directory / "mobile-adaptive-study.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
