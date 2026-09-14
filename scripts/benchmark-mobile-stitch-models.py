"""Run the APK's actual ONNX CPU models over a complete controlled capture fixture.

Matches and timing/connectedness reports are written beside its manifest. The
default uses ONNX CPU only; --experimental --torch-extractor permits original
DISK extraction on CPU for explicit resolution studies. CUDA is never used.
Default preprocessing, feature caps and pose-neighbor selection mirror
OnDeviceFeatureMatcher; JPEG/resize pixels can differ slightly between desktop
OpenCV and Android Bitmap decoders.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from services.stitcher.engine import _angle_errors, _components, _pair_edge, frame_basis, frame_calibration, pixels_to_rays


def forwards(frame):
    transform = frame.get("transform")
    if transform is not None and len(transform) == 16:
        direction = -np.array(transform[8:11], dtype=np.float64)
        norm = np.linalg.norm(direction)
        if np.isfinite(norm) and norm > .1:
            return direction / norm
    if "yawDegrees" in frame and "pitchDegrees" in frame:
        yaw, pitch = np.radians([frame["yawDegrees"], frame["pitchDegrees"]])
        return np.array([np.cos(pitch) * np.sin(yaw), np.sin(pitch), -np.cos(pitch) * np.cos(yaw)])
    return None


def neighbors(frames):
    directions = [forwards(frame) for frame in frames]
    selected = set()
    for i, direction in enumerate(directions):
        if direction is None:
            for offset in (-2, -1, 1, 2):
                j = (i + offset) % len(frames)
                if i != j:
                    selected.add(tuple(sorted((i, j))))
            continue
        candidates = []
        for j, other in enumerate(directions):
            if j == i or other is None:
                continue
            angle = np.degrees(np.arccos(np.clip(direction @ other, -1, 1)))
            if angle <= 85:
                candidates.append((angle, j))
        for _, j in sorted(candidates)[:6]:
            selected.add(tuple(sorted((i, j))))
    return sorted(selected)


def image_tensor(path, long_side):
    image = cv2.imread(str(path))
    if image is None:
        raise ValueError(f"Cannot decode fixture {path.name}")
    height, width = image.shape[:2]
    scale = min(1.0, long_side / max(width, height))
    target = (max(32, int(width * scale / 16 + .5) * 16), max(32, int(height * scale / 16 + .5) * 16))
    image = cv2.resize(image, target, interpolation=cv2.INTER_LINEAR)
    return np.ascontiguousarray(image[:, :, ::-1].transpose(2, 0, 1)[None] / 255, dtype=np.float32), (width, height)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "private-media/mobile-stitch-check")
    parser.add_argument("--long-side", type=int, default=512)
    parser.add_argument("--keypoints", type=int, default=768)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--matcher-model", type=Path)
    parser.add_argument("--extractor-model", type=Path)
    parser.add_argument("--torch-extractor", action="store_true", help="Experimental original DISK extraction on CPU; matching remains ONNX CPU")
    parser.add_argument("--feature-cache", type=Path)
    parser.add_argument("--experimental", action="store_true", help="Desktop-only 768px/1536-point investigation; does not change Android limits")
    parser.add_argument("--reuse-features", action="store_true")
    parser.add_argument("--output-prefix", default="mobile-matches")
    args = parser.parse_args()
    cv2.setNumThreads(args.threads)
    if args.torch_extractor and not args.experimental:
        parser.error("Original PyTorch extraction is restricted to the explicit desktop experiment")
    if args.experimental:
        if not 384 <= args.long_side <= 768 or not 256 <= args.keypoints <= 1536:
            parser.error("Experimental desktop bounds are 384–768 pixels and256–1536 keypoints")
    elif not 384 <= args.long_side <= 640 or not 256 <= args.keypoints <= 1024:
        parser.error("Use Android's supported 384–640 image edge and 256–1024 keypoints")
    directory = args.directory.resolve()
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        manifest_path = directory / "metadata.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    frames = manifest["frames"]
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    options.enable_mem_pattern = False
    options.enable_cpu_mem_arena = False
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    assets = ROOT / "android/app/src/main/assets/stitch-models"
    started = time.perf_counter()
    features, feature_timings = [], []
    if args.reuse_features:
        baseline = json.loads((directory / "mobile-matches.json").read_text())
        if baseline["featureLongSide"] != args.long_side or baseline["maxKeypoints"] != args.keypoints:
            raise ValueError("Cached features use different preprocessing settings")
        with np.load(directory / "mobile-features.npz") as cached:
            features = [tuple(cached[f"{name}_{index}"] for name in ("normalized", "descriptors", "original"))
                        for index in range(len(frames))]
        extraction_seconds = 0.0
    else:
        if args.torch_extractor:
            import torch
            from lightglue import DISK
            torch.set_num_threads(args.threads)
            torch.set_num_interop_threads(1)
            extractor = DISK(max_num_keypoints=args.keypoints).eval().cpu()
        else:
            extractor = ort.InferenceSession(str(args.extractor_model or assets / "disk-1024.onnx"), options, providers=["CPUExecutionProvider"])
        for index, frame in enumerate(frames):
            frame_started = time.perf_counter()
            source = Path(frame.get("filePath", ""))
            if not source.is_file():
                source = directory / frame.get("fileName", Path(frame.get("path", "")).name)
            image, original_size = image_tensor(source, args.long_side)
            if original_size != (frame["width"], frame["height"]):
                raise ValueError("Fixture dimensions do not match calibration")
            if args.torch_extractor:
                with torch.inference_mode():
                    extracted = extractor({"image": torch.from_numpy(image)})
                points, descriptors, scores = [extracted[key].numpy() for key in ("keypoints", "descriptors", "keypoint_scores")]
            else:
                points, descriptors, scores = extractor.run(None, {"image": image})
            valid = (scores[0] > 0) & (np.arange(scores.shape[1]) < args.keypoints)
            points, descriptors = points[:, valid], descriptors[:, valid]
            size = np.array([image.shape[-1], image.shape[-2]], dtype=np.float32)
            normalized = (points - size / 2) / (size.max() / 2)
            original = np.maximum(0, np.minimum(np.array(original_size) - 1, (points + .5) * np.array(original_size) / size - .5))
            features.append((normalized, descriptors, original))
            feature_timings.append(time.perf_counter() - frame_started)
            print(f"Extracted {index + 1}/{len(frames)}: {points.shape[1]} features, {feature_timings[-1]:.2f}s", flush=True)
        del extractor
        extraction_seconds = time.perf_counter() - started
        # Keep compact features for reproducible matcher-only investigations.
        np.savez_compressed(args.feature_cache or directory / "mobile-features.npz", **{
            f"{name}_{index}": value for index, feature in enumerate(features)
            for name, value in zip(("normalized", "descriptors", "original"), feature)})
    matcher_started = time.perf_counter()
    matcher_path = args.matcher_model or assets / "disk-lightglue.onnx"
    matcher = ort.InferenceSession(str(matcher_path), options, providers=["CPUExecutionProvider"])
    pairs, timings, layer_counts = [], [], []
    candidate_pairs = neighbors(frames)
    for pair_index, (i, j) in enumerate(candidate_pairs):
        pair_started = time.perf_counter()
        first, second = features[i], features[j]
        if min(first[0].shape[1], second[0].shape[1]) < 8:
            continue
        model_output = matcher.run(None, {"keypoints0": first[0], "keypoints1": second[0],
                                          "descriptors0": first[1], "descriptors1": second[1]})
        matches, confidence = model_output[:2]
        layer_counts.append(int(model_output[2][0]) if len(model_output) > 2 else 9)
        keep = (matches[0] >= 0) & (confidence[0] > .1)
        matched = matches[0][keep]
        pairs.append({"i": i, "j": j, "points0": first[2][0][keep].tolist(),
                      "points1": second[2][0][matched].tolist(), "scores": confidence[0][keep].tolist(),
                      "layers": layer_counts[-1]})
        timings.append(time.perf_counter() - pair_started)
        if pair_index % 10 == 0 or pair_index + 1 == len(candidate_pairs):
            print(f"Matched {pair_index + 1}/{len(candidate_pairs)}: {i}-{j}, {int(keep.sum())} matches, {timings[-1]:.2f}s", flush=True)
    matching_seconds = time.perf_counter() - matcher_started
    result = {"model": "DISK-depth + LightGlue-DISK (desktop CPU)", "torchExtractor": args.torch_extractor, "aiUsed": bool(pairs),
              "pairs": pairs, "featureLongSide": args.long_side, "maxKeypoints": args.keypoints,
              "featureCounts": [feature[0].shape[1] for feature in features],
              "candidatePairs": len(candidate_pairs), "inferencePairs": len(pairs),
              "extractionMillis": round(extraction_seconds * 1000), "matchingMillis": round(matching_seconds * 1000)}
    output = directory / (args.output_prefix + ".json")
    output.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    calibrations = [frame_calibration(frame, frame["width"], frame["height"]) for frame in frames]
    bases = [frame_basis(frame) for frame in frames]
    verified = []
    edge_diagnostics = []
    for pair in pairs:
        edge = _pair_edge(pair["i"], pair["j"], np.array(pair["points0"]), np.array(pair["points1"]), calibrations, bases)
        if edge is not None:
            verified.append(edge)
            i, j = edge["i"], edge["j"]
            rays0 = pixels_to_rays(edge["points0"], calibrations[i])
            rays1 = pixels_to_rays(edge["points1"], calibrations[j])
            pose_error = _angle_errors(rays0 @ bases[i].T, rays1 @ bases[j].T)
            predicted = bases[i].T @ bases[j]
            correction = np.degrees(np.arccos(np.clip((np.trace(edge["rotation"] @ predicted.T) - 1) / 2, -1, 1)))
            edge_diagnostics.append({"i": i, "j": j, "inliers": edge["count"],
                                     "fittedMedianAngularErrorDegrees": edge["error"],
                                     "poseMedianAngularErrorDegrees": float(np.median(pose_error)),
                                     "relativePoseCorrectionDegrees": float(correction)})
    raw_edges = [pair for pair in pairs if len(pair["points0"]) >= 12]
    ungated_edges = [edge for pair in pairs if (edge := _pair_edge(
        pair["i"], pair["j"], np.array(pair["points0"]), np.array(pair["points1"]), calibrations, None)) is not None]
    positions = np.array([frame["transform"][12:15] for frame in frames if len(frame.get("transform", [])) == 16])
    pose_diagnostics = {"withoutPosePriorVerifiedEdges": len(ungated_edges),
                        "withoutPosePriorComponentSizes": [len(component) for component in _components(len(frames), ungated_edges)]}
    if len(positions):
        pose_diagnostics.update({"maxRecordedTranslationSeparationMeters": float(np.linalg.norm(positions[:, None] - positions[None], axis=2).max()),
                                 "perAxisRecordedTranslationSpanMeters": np.ptp(positions, axis=0).tolist(),
                                 "firstLastRecordedTranslationMeters": float(np.linalg.norm(positions[-1] - positions[0]))})
    if edge_diagnostics:
        pose_diagnostics["medianRelativePoseCorrectionDegrees"] = float(np.median([edge["relativePoseCorrectionDegrees"] for edge in edge_diagnostics]))
    report = {"runtime": ort.__version__, "provider": "CPUExecutionProvider", "threads": args.threads,
              "torchExtractor": args.torch_extractor,
              "datasetKind": "native capture" if manifest_path.name == "metadata.json" else "controlled fixture",
              "frameCount": len(frames), "featureLongSide": args.long_side, "maxKeypoints": args.keypoints,
              "candidatePairs": len(candidate_pairs), "pairsWithAtLeast12Matches": len(raw_edges),
              "rawConnectedComponents": _components(len(frames), raw_edges),
              "geometricallyVerifiedEdges": len(verified), "verifiedConnectedComponents": _components(len(frames), verified),
              "verifiedInliers": sum(edge["count"] for edge in verified),
              "medianVerifiedAngularErrorDegrees": float(np.median([edge["error"] for edge in verified])) if verified else None,
              "extractionSeconds": extraction_seconds, "matchingSeconds": matching_seconds,
              "reusedFeatures": args.reuse_features,
              "averageMatcherLayers": float(np.mean(layer_counts)),
              "layerCounts": {str(layer): layer_counts.count(layer) for layer in sorted(set(layer_counts))},
              "totalSeconds": time.perf_counter() - started,
              "medianExtractionSeconds": float(np.median(feature_timings)) if feature_timings else None,
              "medianMatchingSeconds": float(np.median(timings)),
              "totalLearnedMatches": sum(len(pair["points0"]) for pair in pairs),
              "expectedFrameCount": manifest.get("targetCount", len(frames)),
              "captureComplete": len(frames) == manifest.get("targetCount", len(frames)),
              "missingTargetIndices": sorted(set(range(manifest.get("targetCount", len(frames)))) -
                                               {frame.get("targetIndex", index) for index, frame in enumerate(frames)}),
              "verifiedEdgeDiagnostics": edge_diagnostics,
              "recordedPoseDiagnostics": pose_diagnostics,
              "matchCounts": [{"i": pair["i"], "j": pair["j"], "matches": len(pair["points0"])} for pair in pairs],
              "limitations": "Desktop CPU diagnostics; Android pixel decoding/resize and device speed may differ. Geometric check uses existing desktop spherical-RANSAC verification; native engine must still verify independently. Recorded translation may include tracking drift."}
    (directory / (args.output_prefix + "-report.json")).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in ("matchCounts", "verifiedEdgeDiagnostics")}, indent=2), flush=True)
    print(f"Native engine input: {output}", flush=True)


if __name__ == "__main__":
    main()
