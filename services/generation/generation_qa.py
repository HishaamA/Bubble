"""Read-only ERP inspection: perspective previews and descriptive seam statistics.

This does not certify spherical geometry, fidelity to a room, or image quality.
No model imports/downloads or automatic quality pass/fail decisions are made.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image


def _rgb(image: Image.Image) -> np.ndarray:
    if image.width != 2 * image.height or image.width > 8192 or image.height < 2:
        raise ValueError("Expected a bounded full 2:1 ERP image")
    return np.asarray(image.convert("RGB"))


def render_perspective(image: Image.Image, yaw: float = 0, pitch: float = 0,
                       *, size: int = 512, horizontal_fov: float = 90) -> Image.Image:
    """Render a square pinhole view using the app's front/right/up convention."""
    if (not isinstance(size, int) or isinstance(size, bool) or not 16 <= size <= 1024
            or not all(math.isfinite(value) for value in (yaw, pitch, horizontal_fov))
            or not -90 <= pitch <= 90 or not 0 < horizontal_fov < 180):
        raise ValueError("Invalid perspective preview settings")
    source = _rgb(image)
    height, width = source.shape[:2]
    azimuth, elevation = math.radians(yaw), math.radians(pitch)
    right = np.array([math.cos(azimuth), 0, -math.sin(azimuth)])
    up = np.array([-math.sin(elevation) * math.sin(azimuth), math.cos(elevation), -math.sin(elevation) * math.cos(azimuth)])
    forward = np.array([math.cos(elevation) * math.sin(azimuth), math.sin(elevation), math.cos(elevation) * math.cos(azimuth)])
    coordinate = ((np.arange(size) + .5) / size - .5) * 2 * math.tan(math.radians(horizontal_fov) / 2)
    x, y = np.meshgrid(coordinate, -coordinate)
    rays = x[..., None] * right + y[..., None] * up + forward
    rays /= np.linalg.norm(rays, axis=2, keepdims=True)
    sx = ((np.arctan2(rays[..., 0], rays[..., 2]) / (2 * math.pi) + .5) % 1) * width - .5
    sy = np.clip((.5 - np.arcsin(np.clip(rays[..., 1], -1, 1)) / math.pi) * height - .5, 0, height - 1)
    # Pixel-centre mapping plus periodic bilinear sampling crosses ±180 cleanly.
    x0, y0 = np.floor(sx).astype(np.int32), np.floor(sy).astype(np.int32)
    dx, dy = (sx - x0)[..., None], (sy - y0)[..., None]
    x1, y1 = (x0 + 1) % width, np.minimum(y0 + 1, height - 1)
    x0 %= width
    result = ((source[y0, x0] * (1 - dx) + source[y0, x1] * dx) * (1 - dy)
              + (source[y1, x0] * (1 - dx) + source[y1, x1] * dx) * dy)
    return Image.fromarray(np.clip(np.rint(result), 0, 255).astype(np.uint8))


def wrap_statistics(image: Image.Image) -> dict:
    """Report RGB 0–255 jumps, not a threshold-based quality verdict."""
    pixels = _rgb(image)
    left, right = pixels[:, :9].astype(np.float32), pixels[:, -9:].astype(np.float32)
    jump = np.abs(left[:, 0] - right[:, -1]).mean(axis=1)
    nearby = np.concatenate((np.abs(np.diff(left, axis=1)), np.abs(np.diff(right, axis=1))), axis=1)
    mean_nearby = float(nearby.mean())
    latitude = (.5 - (np.arange(image.height) + .5) / image.height) * math.pi
    return {
        "width": image.width, "height": image.height,
        "wrapRgbJumpMean": float(jump.mean()), "wrapRgbJumpP95": float(np.percentile(jump, 95)),
        "wrapRgbJumpMax": float(jump.max()),
        "wrapRgbJumpLatitudeWeightedMean": float(np.average(jump, weights=np.cos(latitude))),
        "nearbyHorizontalRgbJumpMean": mean_nearby,
        "wrapToNearbyJumpRatio": float(jump.mean()) / mean_nearby if mean_nearby > 1e-6 else None,
        "interpretation": "Descriptive only. Low seam difference and 2:1 shape do not prove spherical geometry or room fidelity.",
    }


def inspect_panorama(path: Path, *, size: int = 512) -> Path:
    """Write derivatives into a new sibling directory; preserve the input bytes."""
    path = Path(path).resolve(strict=True)
    with Image.open(path) as opened:
        if opened.width != 2 * opened.height or opened.width > 8192:
            raise ValueError("Expected a full 2:1 ERP image no wider than 8192 pixels")
        image = opened.convert("RGB")
    folder = path.parent / f"{path.stem}-qa"
    # Existing QA evidence is immutable too: never overwrite a previous inspection.
    suffix = 1
    while True:
        try:
            folder.mkdir()
            break
        except FileExistsError:
            folder = path.parent / f"{path.stem}-qa-{suffix}"
            suffix += 1
    views = [("front", 0, 0), ("right", 90, 0), ("back-wrap", 180, 0),
             ("left", 270, 0), ("up-pole", 0, 90), ("down-pole", 0, -90)]
    for name, yaw, pitch in views:
        render_perspective(image, yaw, pitch, size=size).save(folder / f"{name}.png")
    (folder / "wrap-statistics.json").write_text(json.dumps(wrap_statistics(image), indent=2) + "\n", encoding="utf-8")
    return folder


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("panorama", type=Path)
    parser.add_argument("--size", type=int, default=512)
    arguments = parser.parse_args()
    print(inspect_panorama(arguments.panorama, size=arguments.size))
