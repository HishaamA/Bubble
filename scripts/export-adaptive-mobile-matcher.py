"""Export a candidate adaptive LightGlue ONNX and check it against upstream CPU.

By default candidates stay outside APK assets. This script never overwrites the
known-working production matcher. Its matching interface adds a layers output.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import onnx
import onnxruntime as ort
import torch
from lightglue import LightGlue

from mobile_adaptive_lightglue import AdaptiveLightGlue

ROOT = Path(__file__).resolve().parent.parent


def nodes(graph):
    for node in graph.node:
        yield node
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                yield from nodes(attribute.g)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "private-media/mobile-model-candidate/disk-lightglue-adaptive.onnx")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--pairs", type=int, default=16)
    parser.add_argument("--only-pair", type=int, nargs=2)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    original = LightGlue(features="disk", flash=False, depth_confidence=.95, width_confidence=-1).eval().cpu()
    wrapped = AdaptiveLightGlue(original).eval()
    names = ["keypoints0", "keypoints1", "descriptors0", "descriptors1"]
    with torch.inference_mode():
        if not args.verify_only:
            scripted = torch.jit.script(wrapped)
            example = (torch.rand(1, 384, 2), torch.rand(1, 512, 2),
                       torch.rand(1, 384, 128), torch.rand(1, 512, 128))
            axes = {name: {1: "points0" if name.endswith("0") else "points1"} for name in names}
            axes.update({"matches0": {1: "points0"}, "confidence0": {1: "points0"}})
            torch.onnx.export(scripted, example, args.output, input_names=names,
                              output_names=["matches0", "confidence0", "layers"], dynamic_axes=axes,
                              opset_version=17, dynamo=False)
        graph = onnx.load(args.output)
        onnx.checker.check_model(graph)
        all_nodes = list(nodes(graph.graph))
        domains = {node.domain for node in all_nodes}
        if domains - {"", "ai.onnx"}:
            raise AssertionError(f"Nonportable nodes: {domains}")
        branches = sum(node.op_type == "If" for node in all_nodes)
        if branches < 8:
            raise AssertionError("Early stopping was frozen during export")
        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.enable_mem_pattern = False
        options.enable_cpu_mem_arena = False
        session = ort.InferenceSession(str(args.output), options, providers=["CPUExecutionProvider"])
        measurements = []
        for directory in (ROOT / "private-media/mobile-stitch-check",
                          ROOT / "private-media/phone-inspection-20260909/6ff41186-35b3-46fd-93e1-7ac0f8637803"):
            features = np.load(directory / "mobile-features.npz")
            baseline = json.loads((directory / "mobile-matches.json").read_text())
            ordered = sorted(baseline["pairs"], key=lambda pair: len(pair["points0"]))
            selected = [ordered[index] for index in np.linspace(0, len(ordered) - 1, args.pairs).astype(int)]
            for pair in selected:
                i, j = pair["i"], pair["j"]
                if args.only_pair and [i, j] != args.only_pair:
                    continue
                # Both implementations receive exactly the same normalized float32
                # values; the original API computes those from an equivalent 2x2 size.
                points0 = features[f"normalized_{i}"] + 1
                points1 = features[f"normalized_{j}"] + 1
                data = {"image0": {"keypoints": torch.from_numpy(points0),
                                   "descriptors": torch.from_numpy(features[f"descriptors_{i}"]),
                                   "image_size": torch.tensor([[2., 2.]])},
                        "image1": {"keypoints": torch.from_numpy(points1),
                                   "descriptors": torch.from_numpy(features[f"descriptors_{j}"]),
                                   "image_size": torch.tensor([[2., 2.]])}}
                inputs = {"keypoints0": points0 - 1, "keypoints1": points1 - 1,
                          "descriptors0": features[f"descriptors_{i}"], "descriptors1": features[f"descriptors_{j}"]}
                expected = original(data)
                started = time.perf_counter()
                matches, confidence, layers = session.run(None, inputs)
                elapsed = time.perf_counter() - started
                np.testing.assert_array_equal(matches, expected["matches0"].numpy())
                if int(layers[0]) != int(expected["stop"]):
                    raise AssertionError(f"Stop mismatch: {layers} versus {expected['stop']}")
                differences = np.abs(confidence - expected["matching_scores0"].numpy())
                raw_error = float(np.max(differences))
                accepted = matches >= 0
                # Mutual-neighbor ties can switch a rejected score between zero
                # and a tiny nonzero value. Validate the actual accepted confidence
                # values separately; exact match indices above validate rejection.
                error = float(np.max(differences[accepted])) if accepted.any() else 0.0
                if error > 2e-4:
                    manual = wrapped(*(torch.from_numpy(inputs[name]) for name in names))
                    print({"pair": [i, j], "layers": int(layers[0]),
                           "onnxVsScript": float(np.max(np.abs(confidence - manual[1].numpy()))),
                           "scriptVsUpstream": float(np.max(np.abs(manual[1].numpy() - expected['matching_scores0'].numpy()))),
                           "meanError": float(np.mean(np.abs(confidence - expected['matching_scores0'].numpy())))}, flush=True)
                    raise AssertionError(f"Confidence error {error}")
                measurements.append({"dataset": directory.name, "i": i, "j": j,
                                     "keypoints": [points0.shape[1], points1.shape[1]],
                                     "layers": int(layers[0]), "matches": int((matches >= 0).sum()),
                                     "cpuSeconds": elapsed, "acceptedConfidenceMaxError": error,
                                     "allConfidenceMaxError": raw_error})
                print(f"Parity {directory.name} {i}-{j}: {layers[0]} layers, {elapsed:.3f}s", flush=True)
        report = {"adaptiveDepth": True, "depthConfidence": .95, "widthConfidence": -1,
                  "opset": 17, "provider": "CPUExecutionProvider", "ifNodes": branches,
                  "bytes": args.output.stat().st_size, "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                  "checkedPairs": len(measurements), "matchIndicesEqualUpstream": True,
                  "stoppingLayersEqualUpstream": True, "measurements": measurements}
        args.output.with_suffix(".report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: value for key, value in report.items() if key != "measurements"}, indent=2), flush=True)


if __name__ == "__main__":
    main()
