"""Read-only calibrated overlap diagnostics for locally retained Android captures.

Reports geometric shared image area from recorded rotations, not proof of actual
feature matches or translation-free capture. No photos leave the machine.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def basis(frame: dict) -> np.ndarray:
    t = frame["transform"]
    return np.column_stack(([t[0], t[1], -t[2]],
                            [t[4], t[5], -t[6]],
                            [-t[8], -t[9], t[10]]))


def analyze(frames: list[dict]) -> dict:
    bases = [basis(frame) for frame in frames]
    fractions = np.zeros((len(frames), len(frames)))
    for i, frame in enumerate(frames):
        k = frame["intrinsics"]
        x, y = np.meshgrid(np.linspace(2, frame["width"] - 3, 72),
                           np.linspace(2, frame["height"] - 3, 128))
        rays = np.column_stack(((x.ravel() - k[2]) / k[0],
                                -(y.ravel() - k[5]) / k[4],
                                np.ones(x.size))) @ bases[i].T
        for j, other in enumerate(frames):
            if i == j:
                continue
            local = rays @ bases[j]
            ok = other["intrinsics"]
            forward = local[:, 2]
            safe_z = np.where(np.abs(forward) < 1e-12, 1e-12, forward)
            u = local[:, 0] / safe_z * ok[0] + ok[2]
            v = -local[:, 1] / safe_z * ok[4] + ok[5]
            fractions[i, j] = np.mean((forward > 0) & (u >= 2) &
                (u < other["width"] - 2) & (v >= 2) & (v < other["height"] - 2))
    results = []
    for i, frame in enumerate(frames):
        neighbors = sorted(range(len(frames)), key=lambda j: -fractions[i, j])[:4]
        results.append({"frame": i, "target": frame.get("targetIndex"),
            "neighbors": [{"frame": j, "sharedAreaPercent": round(float(fractions[i, j] * 100), 2)}
                          for j in neighbors],
            "neighborsAbove20Percent": int(np.count_nonzero(fractions[i] >= .2)),
            "neighborsAbove30Percent": int(np.count_nonzero(fractions[i] >= .3))})
    return {"frames": len(frames), "perFrame": results,
        "minBestOverlapPercent": round(float(np.max(fractions, axis=1).min() * 100), 2),
        "medianBestOverlapPercent": round(float(np.median(np.max(fractions, axis=1)) * 100), 2)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("metadata", type=Path)
    args = parser.parse_args()
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    frames = metadata["frames"]
    print(json.dumps({"initialViews": analyze(frames[:metadata.get("initialTargetCount", 34)]),
                      "allViews": analyze(frames)}, indent=2))


if __name__ == "__main__":
    main()
