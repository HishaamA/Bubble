"""Export and verify the offline Android DISK + LightGlue models (CPU ONNX opset 17).

Uses the pinned LightGlue dependency from services/stitcher/requirements.txt and
its existing official DISK-depth / DISK-LightGlue weights. No CUDA-only graph
optimizations or quantization are applied. Run with --verify-only to recheck the
bundled models. The report records inference/parity checks on the public demo.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

import cv2
import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn.functional as F
from lightglue import DISK, LightGlue
from mobile_adaptive_lightglue import AdaptiveLightGlue

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "android/app/src/main/assets/stitch-models"
KEYPOINTS = 1024
LONG_SIDE = 512


class DiskExport(torch.nn.Module):
    """Keep learned DISK inference, replacing variable-length top-k with masked top-k."""
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, image):
        heatmap, dense = self.model.heatmap_and_dense_descriptors(image)
        # Top-k has a fixed bounded output. Non-detections carry score -1 and are
        # removed before matching. Java must never treat padding as a feature.
        maxima = F.max_pool2d(heatmap, 5, stride=1, padding=2)
        valid = (heatmap == maxima) & (heatmap > 0)
        scores, indices = torch.topk(torch.where(valid, heatmap, -1.0).flatten(1), KEYPOINTS, dim=1)
        width = image.shape[-1]
        keypoints = torch.stack((indices % width, torch.div(indices, width, rounding_mode="floor")), -1).float()
        descriptors = dense.flatten(2).gather(2, indices[:, None, :].expand(-1, 128, -1)).transpose(1, 2)
        return keypoints, F.normalize(descriptors, p=2, dim=-1), scores


class LightGlueExport(torch.nn.Module):
    """Exact full-depth learned matcher; normalized points enter without image tensors."""
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, keypoints0, keypoints1, descriptors0, descriptors1):
        model = self.model
        desc0, desc1 = model.input_proj(descriptors0), model.input_proj(descriptors1)
        encoding0, encoding1 = self.encoding(keypoints0), self.encoding(keypoints1)
        for transformer in model.transformers:
            desc0 = self.self_attention(transformer.self_attn, desc0, encoding0)
            desc1 = self.self_attention(transformer.self_attn, desc1, encoding1)
            desc0, desc1 = self.cross_attention(transformer.cross_attn, desc0, desc1)
        assignment = model.log_assignment[-1]
        sim = torch.matmul(assignment.final_proj(desc0) / 4.0,
                           (assignment.final_proj(desc1) / 4.0).transpose(1, 2))
        scores = (F.log_softmax(sim, 2) + F.log_softmax(sim, 1) +
                  F.logsigmoid(assignment.matchability(desc0)) +
                  F.logsigmoid(assignment.matchability(desc1)).transpose(1, 2))
        max0, matches0 = scores.max(2)
        matches1 = scores.argmax(1)
        mutual = torch.arange(matches0.shape[1])[None] == matches1.gather(1, matches0)
        confidence0 = torch.where(mutual, max0.exp(), 0.0)
        return torch.where(mutual & (confidence0 > model.conf.filter_threshold), matches0, -1), confidence0

    def encoding(self, points):
        projected = self.model.posenc.Wr(points)
        cosine, sine = projected.cos(), projected.sin()
        return (torch.stack((cosine, cosine), -1).reshape(1, 1, -1, 64),
                torch.stack((sine, sine), -1).reshape(1, 1, -1, 64))

    @staticmethod
    def rotate(tensor):
        pairs = tensor.reshape(1, 4, -1, 32, 2)
        return torch.stack((-pairs[..., 1], pairs[..., 0]), -1).reshape(1, 4, -1, 64)

    def self_attention(self, block, descriptors, encoding):
        # Explicit reshape preserves rank in portable ONNX; learned parameters
        # and math are identical to upstream unflatten-based attention.
        qkv = block.Wqkv(descriptors).reshape(1, -1, 4, 64, 3).permute(0, 2, 1, 3, 4)
        q, k, v = qkv[..., 0], qkv[..., 1], qkv[..., 2]
        q = q * encoding[0] + self.rotate(q) * encoding[1]
        k = k * encoding[0] + self.rotate(k) * encoding[1]
        attention = (torch.matmul(q, k.transpose(2, 3)) / 8.0).softmax(-1)
        context = torch.matmul(attention, v).transpose(1, 2).reshape(1, -1, 256)
        return descriptors + block.ffn(torch.cat((descriptors, block.out_proj(context)), -1))

    @staticmethod
    def cross_attention(block, desc0, desc1):
        q0 = block.to_qk(desc0).reshape(1, -1, 4, 64).transpose(1, 2) * block.scale**0.5
        q1 = block.to_qk(desc1).reshape(1, -1, 4, 64).transpose(1, 2) * block.scale**0.5
        v0 = block.to_v(desc0).reshape(1, -1, 4, 64).transpose(1, 2)
        v1 = block.to_v(desc1).reshape(1, -1, 4, 64).transpose(1, 2)
        similarity = torch.matmul(q0, q1.transpose(2, 3))
        message0 = torch.matmul(similarity.softmax(-1), v1).transpose(1, 2).reshape(1, -1, 256)
        message1 = torch.matmul(similarity.transpose(2, 3).softmax(-1), v0).transpose(1, 2).reshape(1, -1, 256)
        return (desc0 + block.ffn(torch.cat((desc0, block.to_out(message0)), -1)),
                desc1 + block.ffn(torch.cat((desc1, block.to_out(message1)), -1)))


def working_image(image, long_side=LONG_SIDE):
    height, width = image.shape[:2]
    scale = min(1.0, long_side / max(width, height))
    size = (max(32, round(width * scale / 16) * 16), max(32, round(height * scale / 16) * 16))
    resized = cv2.resize(image, size, interpolation=cv2.INTER_LINEAR)
    return np.ascontiguousarray(resized[:, :, ::-1].transpose(2, 0, 1)[None] / 255.0, dtype=np.float32)


def normalize(points, image):
    size = np.array([image.shape[-1], image.shape[-2]], dtype=np.float32)
    return (points - size / 2) / (size.max() / 2)


def features(session, image, limit=KEYPOINTS):
    points, descriptors, scores = session.run(None, {"image": image})
    valid = (scores[0] > 0) & (np.arange(scores.shape[1]) < limit)
    return points[:, valid], descriptors[:, valid], scores[:, valid]


def signature(path):
    return {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def graph_nodes(graph):
    for node in graph.node:
        yield node
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                yield from graph_nodes(attribute.g)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--fixed-depth", action="store_true", help="Export the original full-nine-layer rollback model")
    parser.add_argument("--output-directory", type=Path, default=ASSETS)
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    destination = args.output_directory
    destination.mkdir(parents=True, exist_ok=True)
    extractor = DISK(max_num_keypoints=KEYPOINTS).eval().cpu()
    matcher = LightGlue(features="disk", flash=False, depth_confidence=-1 if args.fixed_depth else .95, width_confidence=-1).eval().cpu()
    disk_export = DiskExport(extractor.model).eval()
    glue_export = LightGlueExport(matcher).eval() if args.fixed_depth else torch.jit.script(AdaptiveLightGlue(matcher).eval())
    disk_path, glue_path = destination / "disk-1024.onnx", destination / "disk-lightglue.onnx"
    names = ["keypoints0", "keypoints1", "descriptors0", "descriptors1"]
    with torch.inference_mode():
        if not args.verify_only:
            torch.onnx.export(disk_export, (torch.rand(1, 3, 384, 288),), disk_path,
                              input_names=["image"], output_names=["keypoints", "descriptors", "scores"],
                              dynamic_axes={"image": {2: "height", 3: "width"}},
                              opset_version=17, dynamo=False)
            example = (torch.rand(1, 384, 2), torch.rand(1, 512, 2),
                       torch.rand(1, 384, 128), torch.rand(1, 512, 128))
            axes = {name: {1: "points0" if name.endswith("0") else "points1"} for name in names}
            axes.update({"matches0": {1: "points0"}, "confidence0": {1: "points0"}})
            torch.onnx.export(glue_export, example, glue_path, input_names=names,
                              output_names=["matches0", "confidence0"] + ([] if args.fixed_depth else ["layers"]), dynamic_axes=axes,
                              opset_version=17, dynamo=False)

        for path in (disk_path, glue_path):
            model = onnx.load(path)
            onnx.checker.check_model(model)
            domains = {node.domain for node in graph_nodes(model.graph)}
            if domains - {"", "ai.onnx"}:
                raise AssertionError(f"Nonportable operator domains in {path}: {domains}")
            if path == glue_path and not args.fixed_depth:
                if sum(node.op_type == "If" for node in graph_nodes(model.graph)) != 8:
                    raise AssertionError("Adaptive stopping must remain eight real ONNX branches")

        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.intra_op_num_threads = args.threads
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        disk = ort.InferenceSession(str(disk_path), options, providers=["CPUExecutionProvider"])
        glue = ort.InferenceSession(str(glue_path), options, providers=["CPUExecutionProvider"])
        source = cv2.imread(str(ROOT / "public/assets/panoramas/sunday-dinner-demo.jpg"))
        if source is None:
            raise RuntimeError("Public demo panorama missing; parity requires real image pixels.")
        # Two real overlapping crops, plus shifted/resized inputs and blank-image safety.
        height, width = source.shape[:2]
        views = [source[:, width // 5:3 * width // 5], source[:, width // 4:13 * width // 20],
                 cv2.rotate(source[:, width // 5:3 * width // 5], cv2.ROTATE_90_CLOCKWISE)]
        images = [working_image(view) for view in views]
        reports = []
        detected = []
        for image in images:
            started = time.perf_counter()
            actual = features(disk, image)
            elapsed = time.perf_counter() - started
            expected = disk_export(torch.from_numpy(image))
            valid = expected[2][0] > 0
            expected = tuple(value[:, valid].numpy() for value in expected)
            # Resolve features by coordinate: near-tied detector scores may reorder
            # top-k without changing a single feature or learned descriptor.
            actual_indices = {tuple(point): index for index, point in enumerate(actual[0][0])}
            expected_indices = {tuple(point): index for index, point in enumerate(expected[0][0])}
            common = sorted(actual_indices.keys() & expected_indices.keys())
            detector_agreement = len(common) / max(1, len(expected_indices))
            if detector_agreement < .995:
                raise AssertionError(f"DISK ONNX keypoint agreement {detector_agreement}")
            actual_order = [actual_indices[point] for point in common]
            expected_order = [expected_indices[point] for point in common]
            descriptor_error = float(np.max(np.abs(actual[1][:, actual_order] - expected[1][:, expected_order])))
            if descriptor_error > 2e-4:
                raise AssertionError(f"DISK ONNX descriptor error {descriptor_error}")
            original = extractor({"image": torch.from_numpy(image)})
            original_points = {tuple(point) for point in original["keypoints"][0].numpy()}
            exported_points = {tuple(point) for point in actual[0][0]}
            agreement = len(original_points & exported_points) / max(1, len(original_points))
            if agreement < .99:
                raise AssertionError(f"DISK original extraction agreement {agreement}")
            reports.append({"width": image.shape[-1], "height": image.shape[-2],
                            "keypoints": actual[0].shape[1], "cpuSeconds": elapsed,
                            "descriptorMaxError": descriptor_error, "originalKeypointAgreement": agreement,
                            "onnxKeypointAgreement": detector_agreement})
            detected.append(actual)

        pair_reports = []
        for i, j in ((0, 1), (0, 2)):
            a, b = detected[i], detected[j]
            inputs = {"keypoints0": normalize(a[0], images[i]), "keypoints1": normalize(b[0], images[j]),
                      "descriptors0": a[1], "descriptors1": b[1]}
            started = time.perf_counter()
            model_output = glue.run(None, inputs)
            actual_matches, actual_scores = model_output[:2]
            elapsed = time.perf_counter() - started
            original = matcher({"image0": {"keypoints": torch.from_numpy(a[0]), "descriptors": torch.from_numpy(a[1]),
                                           "image_size": torch.tensor([[images[i].shape[-1], images[i].shape[-2]]])},
                                "image1": {"keypoints": torch.from_numpy(b[0]), "descriptors": torch.from_numpy(b[1]),
                                           "image_size": torch.tensor([[images[j].shape[-1], images[j].shape[-2]]])}})
            np.testing.assert_array_equal(actual_matches, original["matches0"].numpy())
            if not args.fixed_depth and int(model_output[2][0]) != int(original["stop"]):
                raise AssertionError("Adaptive stopping differs from upstream")
            differences = np.abs(actual_scores - original["matching_scores0"].numpy())
            accepted = actual_matches >= 0
            error = float(np.max(differences[accepted])) if accepted.any() else 0.0
            if error > 2e-4:
                raise AssertionError(f"LightGlue ONNX confidence error {error}")
            matches = int((actual_matches >= 0).sum())
            if matches < 12:
                raise AssertionError(f"Only {matches} learned matches for known overlap")
            pair_reports.append({"i": i, "j": j, "matches": matches, "cpuSeconds": elapsed,
                                 "confidenceMaxError": error, "matchIndicesEqualPyTorch": True,
                                 "layers": int(model_output[2][0]) if not args.fixed_depth else 9})

        configurations = []
        for long_side, limit in ((384, 512), (512, 768), (640, 1024)):
            pair_images = [working_image(view, long_side) for view in views[:2]]
            started = time.perf_counter()
            pair_features = [features(disk, image, limit) for image in pair_images]
            extraction_seconds = time.perf_counter() - started
            started = time.perf_counter()
            matches = glue.run(None, {"keypoints0": normalize(pair_features[0][0], pair_images[0]),
                                         "keypoints1": normalize(pair_features[1][0], pair_images[1]),
                                         "descriptors0": pair_features[0][1], "descriptors1": pair_features[1][1]})[0]
            configurations.append({"longSide": long_side, "maxKeypoints": limit,
                                   "twoExtractionsCpuSeconds": extraction_seconds,
                                   "matchingCpuSeconds": time.perf_counter() - started,
                                   "features": [value[0].shape[1] for value in pair_features],
                                   "matches": int((matches >= 0).sum())})

        blank = np.zeros((1, 3, 192, 256), dtype=np.float32)
        blank_features = features(disk, blank)
        report = {"model": "DISK-depth + LightGlue-DISK", "provider": "CPUExecutionProvider",
                  "opset": 17, "torch": torch.__version__, "onnxruntime": ort.__version__,
                  "threads": args.threads, "maxKeypoints": KEYPOINTS, "workingLongSide": LONG_SIDE,
                  "precision": "float32", "adaptiveDepth": not args.fixed_depth,
                  "depthConfidence": -1 if args.fixed_depth else .95,
                  "adaptivePruning": False, "extractor": signature(disk_path),
                  "matcher": signature(glue_path), "featureChecks": reports, "pairChecks": pair_reports,
                  "configurationBenchmarks": configurations,
                  "blankImageKeypoints": blank_features[0].shape[1],
                  "limitations": "Desktop CPU parity/timing on public synthetic demo; device speed and handheld quality require device validation."}
        (destination / "model-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
