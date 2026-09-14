"""Project reference photos onto an ERP control image; never invent unseen pixels.

The viewer convention is front yaw 0 at the image centre, right +90, back 180
at the wrapping edge, and up at the top. Green is an outpainting instruction,
not a captured colour/coverage claim. No ARCore poses are consumed here.
"""
from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np
from PIL import Image, ImageOps

GREEN = (0, 255, 0)
MAX_REFERENCE_PIXELS = 40_000_000


def _finite_number(value: object, name: str) -> float:
    if isinstance(value, (bool, str)):
        raise ValueError(f"{name} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError(f"{name} must be a finite number") from error
    if not math.isfinite(number):
        raise ValueError(f"{name} must be a finite number")
    return number


def _bilinear(image: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Sample inside the source footprint, clamping only the half-pixel border."""
    x = np.clip(x, 0, image.shape[1] - 1)
    y = np.clip(y, 0, image.shape[0] - 1)
    x0, y0 = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    x1, y1 = np.minimum(x0 + 1, image.shape[1] - 1), np.minimum(y0 + 1, image.shape[0] - 1)
    dx, dy = (x - x0)[:, None], (y - y0)[:, None]
    return ((image[y0, x0] * (1 - dx) + image[y0, x1] * dx) * (1 - dy)
            + (image[y1, x0] * (1 - dx) + image[y1, x1] * dx) * dy)


def make_erp_control(
    images: Sequence[Image.Image],
    azimuths: Sequence[float] | None = None,
    *,
    width: int = 2048,
    height: int = 1024,
    horizontal_fov_degrees: float | Sequence[float] = 60.0,
    pitch_degrees: float = 0.0,
) -> Image.Image:
    """Return an RGB control canvas with 1–4 pinhole views and green unknown areas.

    Azimuths default to the first N of front/right/back/left (0/90/180/270).
    Horizontal FOV may be one angle for all photos or one angle per input photo.
    Callers should supply aspect-aware estimates rather than the legacy 60 default.
    Square source pixels imply fy=fx; vertical FOV follows each image's actual
    upright aspect ratio. Overlap belongs wholly to the most central reference
    ray (earlier input wins an exact tie), never a blend of unrelated photos.
    Caller-owned PIL images, metadata, and original files are not modified.
    """
    if not 1 <= len(images) <= 4:
        raise ValueError("Choose one to four reference photos")
    if (isinstance(width, bool) or isinstance(height, bool)
            or not isinstance(width, int) or not isinstance(height, int)
            or width != 2 * height or width < 1024 or width > 4096):
        raise ValueError("The control canvas must be exact 2:1, from 1024×512 to 4096×2048")
    if isinstance(horizontal_fov_degrees, Sequence) and not isinstance(horizontal_fov_degrees, (str, bytes)):
        if len(horizontal_fov_degrees) != len(images):
            raise ValueError("Give exactly one horizontal FOV per reference photo")
        fovs = [_finite_number(value, "Horizontal FOV") for value in horizontal_fov_degrees]
    else:
        fovs = [_finite_number(horizontal_fov_degrees, "Horizontal FOV")] * len(images)
    pitch = _finite_number(pitch_degrees, "Pitch")
    if any(not 0 < fov <= 120 for fov in fovs) or not -90 <= pitch <= 90:
        raise ValueError("Horizontal FOV must be in (0,120] degrees and pitch in [-90,90]")
    headings = list((0, 90, 180, 270)[:len(images)] if azimuths is None else azimuths)
    if len(headings) != len(images):
        raise ValueError("Give exactly one azimuth per reference photo")
    headings = [_finite_number(value, "Azimuth") % 360 for value in headings]
    for index, heading in enumerate(headings):
        if any(abs((heading - earlier + 180) % 360 - 180) < 1e-6 for earlier in headings[:index]):
            raise ValueError("Use a unique direction for each reference photo")

    canvas = np.empty((height, width, 3), dtype=np.uint8)
    canvas[:] = GREEN
    owner_score = np.full((height, width), -np.inf, dtype=np.float32)
    longitude = ((np.arange(width, dtype=np.float64) + .5) / width - .5) * (2 * math.pi)
    sin_lon, cos_lon = np.sin(longitude)[None, :], np.cos(longitude)[None, :]
    elevation = math.radians(pitch)

    for image, heading, fov in zip(images, headings, fovs):
        if not isinstance(image, Image.Image) or min(image.size) < 2 or image.width * image.height > MAX_REFERENCE_PIXELS:
            raise ValueError("A reference photo is invalid or too large to project safely")
        # exif_transpose returns a copy, including when no rotation is required.
        upright = ImageOps.exif_transpose(image)
        rgba = np.asarray(upright.convert("RGBA"))
        source_height, source_width = rgba.shape[:2]
        focal = source_width / (2 * math.tan(math.radians(fov) / 2))
        centre_x, centre_y = (source_width - 1) / 2, (source_height - 1) / 2
        yaw = math.radians(heading)
        forward = np.array([math.cos(elevation) * math.sin(yaw), math.sin(elevation), math.cos(elevation) * math.cos(yaw)])
        right = np.array([math.cos(yaw), 0, -math.sin(yaw)])
        up = np.array([-math.sin(elevation) * math.sin(yaw), math.cos(elevation), -math.sin(elevation) * math.cos(yaw)])
        # Row blocks bound temporary projection memory independently of source size.
        for row in range(0, height, 128):
            end = min(height, row + 128)
            latitude = (.5 - (np.arange(row, end, dtype=np.float64) + .5) / height) * math.pi
            cos_lat, sin_lat = np.cos(latitude)[:, None], np.sin(latitude)[:, None]
            world_x, world_y, world_z = cos_lat * sin_lon, np.broadcast_to(sin_lat, (end - row, width)), cos_lat * cos_lon
            local_x = world_x * right[0] + world_z * right[2]
            local_y = world_x * up[0] + world_y * up[1] + world_z * up[2]
            local_z = world_x * forward[0] + world_y * forward[1] + world_z * forward[2]
            depth = np.maximum(local_z, 1e-12)
            source_x = centre_x + focal * local_x / depth
            source_y = centre_y - focal * local_y / depth
            selected = ((local_z > 0) & (source_x >= -.5) & (source_x <= source_width - .5)
                        & (source_y >= -.5) & (source_y <= source_height - .5)
                        & (local_z > owner_score[row:end] + 1e-7))
            if not np.any(selected):
                continue
            rows, columns = np.nonzero(selected)
            samples = _bilinear(rgba, source_x[selected], source_y[selected])
            # A transparent source pixel is unknown, not a coloured camera sample.
            opaque = samples[:, 3] >= 254.5
            rows, columns, samples = rows[opaque], columns[opaque], samples[opaque]
            canvas[row + rows, columns] = np.clip(np.rint(samples[:, :3]), 0, 255).astype(np.uint8)
            owner_score[row + rows, columns] = local_z[rows, columns]
    return Image.fromarray(canvas)
