"""Private CPU experiments for adaptive matcher startup; never changes APK assets."""
import json
from pathlib import Path
import time

import numpy as np
import onnx
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
CANDIDATES = ROOT / "private-media/mobile-model-candidate"
ORIGINAL = ROOT / "android/app/src/main/assets/stitch-models/disk-lightglue.onnx"


def options(level, output=None):
    value = ort.SessionOptions()
    value.log_severity_level = 3
    value.intra_op_num_threads = 2
    value.inter_op_num_threads = 1
    value.enable_mem_pattern = False
    value.enable_cpu_mem_arena = False
    value.graph_optimization_level = level
    if output is not None:
        value.optimized_model_filepath = str(output)
    return value


def nodes(graph):
    for node in graph.node:
        yield node
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                yield from nodes(attribute.g)


def sample_inputs():
    result = []
    for directory in (ROOT / "private-media/mobile-stitch-check",
                      ROOT / "private-media/phone-inspection-20260909/6ff41186-35b3-46fd-93e1-7ac0f8637803"):
        with np.load(directory / "mobile-features.npz") as features:
            pairs = json.loads((directory / "mobile-matches.json").read_text())["pairs"]
            pairs = sorted(pairs, key=lambda pair: len(pair["points0"]))
            for index in np.linspace(0, len(pairs) - 1, 16).astype(int):
                pair = pairs[index]
                i, j = pair["i"], pair["j"]
                result.append({"dataset": directory.name, "i": i, "j": j,
                               "inputs": {"keypoints0": features[f"normalized_{i}"],
                                          "keypoints1": features[f"normalized_{j}"],
                                          "descriptors0": features[f"descriptors_{i}"],
                                          "descriptors1": features[f"descriptors_{j}"]}})
    return result


def measure(name, path, level, samples, reference=None):
    started = time.perf_counter()
    session = ort.InferenceSession(str(path), options(level), providers=["CPUExecutionProvider"])
    startup = time.perf_counter() - started
    measured, outputs = [], []
    for index, sample in enumerate(samples):
        started = time.perf_counter()
        actual = session.run(None, sample["inputs"])
        elapsed = time.perf_counter() - started
        outputs.append(actual)
        measurement = {key: sample[key] for key in ("dataset", "i", "j")}
        measurement.update({"seconds": elapsed, "layers": int(actual[2][0]),
                            "matches": int((actual[0] >= 0).sum())})
        if reference is not None:
            expected = reference[index]
            accepted = expected[0] >= 0
            error = float(np.max(np.abs(actual[1] - expected[1])[accepted])) if accepted.any() else 0.0
            measurement.update({"indicesEqual": bool(np.array_equal(actual[0], expected[0])),
                                "layersEqual": bool(np.array_equal(actual[2], expected[2])),
                                "acceptedConfidenceMaxError": error})
        measured.append(measurement)
    report = {"name": name, "path": str(path.relative_to(ROOT)), "startupSeconds": startup,
              "inferenceSeconds": sum(value["seconds"] for value in measured),
              "medianPairSeconds": float(np.median([value["seconds"] for value in measured])),
              "measurements": measured}
    report["totalSeconds"] = report["startupSeconds"] + report["inferenceSeconds"]
    if reference is not None:
        report["parityPass"] = all(value["indicesEqual"] and value["layersEqual"] and
                                  value["acceptedConfidenceMaxError"] < 2e-4 for value in measured)
    print(json.dumps({key: value for key, value in report.items() if key != "measurements"}), flush=True)
    del session
    return report, outputs


def main():
    CANDIDATES.mkdir(exist_ok=True, parents=True)
    samples = sample_inputs()
    reference_report, reference = measure("original-all", ORIGINAL, ort.GraphOptimizationLevel.ORT_ENABLE_ALL, samples)
    reports = [reference_report]
    # Basic output keeps standard ONNX operators. Extended fusion can introduce
    # ORT built-ins; identify these explicitly rather than claiming portability.
    for name, level in (("basic", ort.GraphOptimizationLevel.ORT_ENABLE_BASIC),
                        ("extended", ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED)):
        path = CANDIDATES / f"optimized-{name}.onnx"
        started = time.perf_counter()
        generated = ort.InferenceSession(str(ORIGINAL), options(level, path), providers=["CPUExecutionProvider"])
        conversion_seconds = time.perf_counter() - started
        del generated
        graph = onnx.load(path)
        try:
            onnx.checker.check_model(graph)
        except onnx.checker.ValidationError as error:
            reports.append({"name": name, "conversionSeconds": conversion_seconds,
                            "validationError": str(error), "parityPass": False})
            print(name + " graph rejected: " + str(error), flush=True)
            continue
        domains = sorted({node.domain for node in nodes(graph.graph)})
        report, _ = measure(name + "-no-opt", path, ort.GraphOptimizationLevel.ORT_DISABLE_ALL, samples, reference)
        report.update({"conversionSeconds": conversion_seconds, "bytes": path.stat().st_size,
                       "operatorDomains": domains, "ifNodes": sum(node.op_type == "If" for node in nodes(graph.graph))})
        reports.append(report)
        if name == "basic":
            report, _ = measure("basic-runtime-all", path, ort.GraphOptimizationLevel.ORT_ENABLE_ALL, samples, reference)
            reports.append(report)
    (CANDIDATES / "startup-study.json").write_text(json.dumps({"runtime": ort.__version__, "threads": 2,
        "provider": "CPUExecutionProvider", "samples": len(samples), "reports": reports,
        "limitations": "Desktop CPU only. Extended ORT fusions are not claimed portable to Android until device checks. No production assets or model policy changed."}, indent=2) + "\n")


if __name__ == "__main__":
    main()
