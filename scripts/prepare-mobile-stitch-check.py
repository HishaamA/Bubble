"""Generate a reproducible Android stitch fixture, never using private family photos.

The camera transforms deliberately contain small pose errors. Success measures
real mobile matching and reconstruction of a known rotation-only scene, not
handheld/parallax quality. Run OfflinePanoramaInstrumentedTest with stitchFixture
pointing to a copy of the printed directory inside the test app's private files.
"""
from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def arcore_transform(yaw_degrees: float, pitch_degrees: float) -> list[float]:
    yaw, pitch = math.radians(yaw_degrees), math.radians(pitch_degrees)
    # Same display-oriented, column-major ARCore camera convention as real JPEGs.
    right = [math.cos(yaw), 0, math.sin(yaw)]
    up = [-math.sin(pitch) * math.sin(yaw), math.cos(pitch), math.sin(pitch) * math.cos(yaw)]
    back = [-math.cos(pitch) * math.sin(yaw), -math.sin(pitch), math.cos(pitch) * math.cos(yaw)]
    return right + [0] + up + [0] + back + [0] + [0, 0, 0, 1]


def main() -> None:
    spec = importlib.util.spec_from_file_location("stitch_check", ROOT / "scripts/check-stitcher.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    directory = ROOT / "private-media/mobile-stitch-check"
    manifest = module.generate(directory, False)
    for frame in manifest["frames"]:
        frame["transform"] = arcore_transform(frame["yawDegrees"], frame["pitchDegrees"])
    manifest["targetCount"] = len(manifest["frames"])
    manifest["capturedCount"] = len(manifest["frames"])
    manifest["fixture"] = "Bundled concept panorama, synthetic rotation-only views with pose error"
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(directory)


if __name__ == "__main__":
    main()
