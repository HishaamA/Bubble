"""Photo-faithful full-sphere reconstruction for native and uploaded captures.

The learned model supplies correspondences; robust spherical geometry determines
where real pixels belong. Graph-cut ownership avoids averaging displaced objects,
and a narrow multiband seam handles exposure transitions. No generative filling,
super-resolution claims, or invented room geometry are used here.
"""

from __future__ import annotations

import math
import logging
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image, ImageOps
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix
from scipy.spatial.transform import Rotation

from .matcher import FeatureMatcher

MAX_FRAMES = 64
MATCH_LONG_EDGE = 1024
SOURCE_LONG_EDGE = 3072
SEAM_WIDTH = 1024


class StitchError(ValueError):
    """A recoverable capture/quality issue that should be shown to the user."""


def _check_cancel(cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise InterruptedError("Panorama processing was cancelled.")


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _first(frame: dict, *names: str, default=None):
    return next((float(frame[name]) for name in names if _finite(frame.get(name))), default)


def frame_basis(frame: dict) -> np.ndarray | None:
    """Exactly the right/up/forward convention of composeGuidedPanorama.ts.

    Native matrices are column-major, look down -Z, and use AR world coordinates.
    Reflecting world Z and negating the camera's forward column gives our +Z yaw
    origin. JPEGs are already upright; rotationDegrees rotates intrinsics only.
    """
    transform = frame.get("transform")
    if isinstance(transform, list) and len(transform) == 16 and all(map(_finite, transform)):
        t = transform
        basis = np.column_stack(([t[0], t[1], -t[2]],
                                 [t[4], t[5], -t[6]],
                                 [-t[8], -t[9], t[10]]))
        if np.linalg.norm(basis.T @ basis - np.eye(3)) > 0.15 or np.linalg.det(basis) < 0.8:
            raise StitchError("A camera pose is invalid. Retake this capture.")
        u, _, vt = np.linalg.svd(basis)
        return u @ vt
    yaw = _first(frame, "yawDegrees", "yaw", "targetYawDegrees", "targetYaw")
    pitch = _first(frame, "pitchDegrees", "pitch", "targetPitchDegrees", "targetPitch")
    if yaw is None or pitch is None:
        return None
    yaw, pitch, roll = np.radians([yaw, pitch, _first(frame, "rollDegrees", "roll", default=0)])
    forward = [np.cos(pitch) * np.sin(yaw), np.sin(pitch), np.cos(pitch) * np.cos(yaw)]
    right = np.array([np.cos(yaw), 0, -np.sin(yaw)])
    up = np.array([-np.sin(pitch) * np.sin(yaw), np.cos(pitch), -np.sin(pitch) * np.cos(yaw)])
    return np.column_stack((right * np.cos(roll) + up * np.sin(roll),
                            up * np.cos(roll) - right * np.sin(roll), forward))


def frame_calibration(frame: dict, width: int, height: int) -> np.ndarray:
    """Return fx, fy, cx, cy in upright decoded-image coordinates."""
    intrinsics = frame.get("intrinsics")
    source_w, source_h = frame.get("width", width), frame.get("height", height)
    if (isinstance(intrinsics, list) and len(intrinsics) >= 6
            and _finite(intrinsics[0]) and _finite(intrinsics[4])
            and intrinsics[0] > 0 and intrinsics[4] > 0
            and _finite(source_w) and _finite(source_h) and min(source_w, source_h) > 0):
        fx, fy = intrinsics[0], intrinsics[4]
        cx = intrinsics[2] if _finite(intrinsics[2]) else (source_w - 1) / 2
        cy = intrinsics[5] if _finite(intrinsics[5]) else (source_h - 1) / 2
        rotation = round(_first(frame, "rotationDegrees", default=0)) % 360
        if rotation == 90:
            fx, fy, cx, cy = fy, fx, source_h - 1 - cy, cx
            source_w, source_h = source_h, source_w
        elif rotation == 180:
            cx, cy = source_w - 1 - cx, source_h - 1 - cy
        elif rotation == 270:
            fx, fy, cx, cy = fy, fx, cy, source_w - 1 - cx
            source_w, source_h = source_h, source_w
        return np.array([fx * width / source_w, fy * height / source_h,
                         cx * width / source_w, cy * height / source_h], dtype=np.float64)
    equivalent = _first(frame, "focalLength35mm")
    if equivalent is not None and 8 <= equivalent <= 200:
        fx = math.hypot(width, height) * equivalent / math.hypot(36, 24)
    else:
        hfov = np.clip(_first(frame, "horizontalFovDegrees", default=68), 35, 110)
        fx = width / (2 * math.tan(math.radians(hfov) / 2))
    vfov = _first(frame, "verticalFovDegrees")
    fy = height / (2 * math.tan(math.radians(np.clip(vfov, 25, 110)) / 2)) if vfov else fx
    return np.array([fx, fy, (width - 1) / 2, (height - 1) / 2], dtype=np.float64)


def pixels_to_rays(points: np.ndarray, calibration: np.ndarray) -> np.ndarray:
    fx, fy, cx, cy = calibration
    rays = np.column_stack(((points[:, 0] - cx) / fx, -(points[:, 1] - cy) / fy,
                            np.ones(len(points))))
    return rays / np.linalg.norm(rays, axis=1, keepdims=True)


def _fit_rotation(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    u, _, vt = np.linalg.svd(target.T @ source)
    return u @ np.diag([1, 1, np.linalg.det(u @ vt)]) @ vt


def _angle_errors(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    # atan2 is stable even for very small residuals.
    return np.degrees(np.arctan2(np.linalg.norm(np.cross(first, second), axis=1),
                                 np.sum(first * second, axis=1)))


def _pair_edge(i: int, j: int, points0: np.ndarray, points1: np.ndarray,
               calibrations: list[np.ndarray], bases: list[np.ndarray] | None) -> dict | None:
    if len(points0) < 12:
        return None
    rays0, rays1 = pixels_to_rays(points0, calibrations[i]), pixels_to_rays(points1, calibrations[j])
    if bases is not None:
        nearby = _angle_errors(rays0 @ bases[i].T, rays1 @ bases[j].T) < 24
        points0, points1, rays0, rays1 = points0[nearby], points1[nearby], rays0[nearby], rays1[nearby]
    if len(points0) < 12:
        return None
    _, homography_inliers = cv2.findHomography(points0.astype(np.float32), points1.astype(np.float32),
                                             cv2.RANSAC, 3.5, maxIters=1500, confidence=0.995)
    if homography_inliers is None or int(homography_inliers.sum()) < 12:
        return None
    keep = homography_inliers.ravel().astype(bool)
    points0, points1, rays0, rays1 = points0[keep], points1[keep], rays0[keep], rays1[keep]
    rng = np.random.default_rng(i * 1009 + j)
    best = np.zeros(len(rays0), dtype=bool)
    # A homography can also align a translating camera/planar wall. The second
    # rotation-only RANSAC explicitly tests the spherical-camera assumption.
    for _ in range(100):
        sample = rng.choice(len(rays0), 3, replace=False)
        rotation = _fit_rotation(rays1[sample], rays0[sample])
        inliers = _angle_errors(rays1 @ rotation.T, rays0) < 1.25
        if inliers.sum() > best.sum():
            best = inliers
    if best.sum() < 12 or best.mean() < 0.35:
        return None
    rotation = _fit_rotation(rays1[best], rays0[best])
    errors = _angle_errors(rays1 @ rotation.T, rays0)
    best = errors < 1.25
    if best.sum() < 12:
        return None
    # A few points on the same narrow edge do not constrain 3D orientation.
    spread = np.std(rays0[best, :2], axis=0)
    if spread.min() < 0.025:
        return None
    selected = np.flatnonzero(best)
    if len(selected) > 100:
        selected = selected[np.linspace(0, len(selected) - 1, 100).astype(int)]
    return {"i": i, "j": j, "points0": points0[selected], "points1": points1[selected],
            "rotation": rotation, "count": int(best.sum()),
            "error": float(np.median(errors[best]))}


def _components(count: int, edges: list[dict]) -> list[list[int]]:
    neighbors = [set() for _ in range(count)]
    for edge in edges:
        neighbors[edge["i"]].add(edge["j"])
        neighbors[edge["j"]].add(edge["i"])
    unseen, components = set(range(count)), []
    while unseen:
        component, pending = [], [min(unseen)]
        while pending:
            current = pending.pop()
            if current not in unseen:
                continue
            unseen.remove(current)
            component.append(current)
            pending.extend(neighbors[current] & unseen)
        components.append(component)
    return sorted(components, key=len, reverse=True)


def _bootstrap(count: int, edges: list[dict]) -> list[np.ndarray]:
    rotations: list[np.ndarray | None] = [None] * count
    rotations[0] = np.eye(3)
    # Grow a maximum-confidence spanning tree. Global BA then closes loops,
    # including the pair crossing the -180/+180 degree meridian.
    ordered = sorted(edges, key=lambda edge: edge["count"] / (0.1 + edge["error"]), reverse=True)
    for _ in range(count):
        changed = False
        for edge in ordered:
            i, j = edge["i"], edge["j"]
            if rotations[i] is not None and rotations[j] is None:
                rotations[j] = rotations[i] @ edge["rotation"]
                changed = True
            elif rotations[j] is not None and rotations[i] is None:
                rotations[i] = rotations[j] @ edge["rotation"].T
                changed = True
        if not changed:
            break
    if any(rotation is None for rotation in rotations):
        raise StitchError("These photos do not connect into one sphere. Add overlapping photos between each view.")
    return rotations


def refine_rotations(bases: list[np.ndarray], calibrations: list[np.ndarray], edges: list[dict],
                     *, has_poses: bool, refine_focal: bool,
                     cancelled: Callable[[], bool] = lambda: False) -> tuple[list[np.ndarray], list[np.ndarray], float, float]:
    """Robust sparse bundle adjustment of every overlap and loop simultaneously."""
    count = len(bases)
    first = np.concatenate([np.full(len(edge["points0"]), edge["i"]) for edge in edges])
    second = np.concatenate([np.full(len(edge["points1"]), edge["j"]) for edge in edges])
    points0 = np.concatenate([edge["points0"] for edge in edges])
    points1 = np.concatenate([edge["points1"] for edge in edges])
    initial = np.stack(bases)
    calibration = np.stack(calibrations)
    nvars = (count - 1) * 3 + int(refine_focal)
    base_rows = len(first) * 3
    prior_rows = (count - 1) * 3 if has_poses else 0
    sparsity = lil_matrix((base_rows + prior_rows + int(refine_focal), nvars), dtype=np.uint8)
    for match, (i, j) in enumerate(zip(first, second)):
        for frame in (i, j):
            if frame:
                sparsity[match * 3:match * 3 + 3, (frame - 1) * 3:frame * 3] = 1
        if refine_focal:
            sparsity[match * 3:match * 3 + 3, -1] = 1
    if has_poses:
        for column in range((count - 1) * 3):
            sparsity[base_rows + column, column] = 1
    if refine_focal:
        sparsity[-1, -1] = 1

    def evaluate(parameters, raw=False):
        _check_cancel(cancelled)
        deltas = np.concatenate((np.zeros((1, 3)), parameters[:(count - 1) * 3].reshape(-1, 3)))
        rotations = Rotation.from_rotvec(deltas).as_matrix() @ initial
        scale = math.exp(parameters[-1]) if refine_focal else 1
        rays = []
        for indices, points in ((first, points0), (second, points1)):
            intrinsics = calibration[indices]
            camera = np.column_stack(((points[:, 0] - intrinsics[:, 2]) / (intrinsics[:, 0] * scale),
                                      -(points[:, 1] - intrinsics[:, 3]) / (intrinsics[:, 1] * scale),
                                      np.ones(len(points))))
            camera /= np.linalg.norm(camera, axis=1, keepdims=True)
            rays.append(np.einsum("nij,nj->ni", rotations[indices], camera))
        if raw:
            return rotations, scale, _angle_errors(*rays)
        residuals = [(rays[0] - rays[1]).ravel()]
        if has_poses:
            residuals.append(parameters[:(count - 1) * 3] * 0.08)
        if refine_focal:
            residuals.append(np.array([parameters[-1] * 0.025]))
        return np.concatenate(residuals)

    lower, upper = np.full(nvars, -np.inf), np.full(nvars, np.inf)
    if has_poses:
        lower[:(count - 1) * 3], upper[:(count - 1) * 3] = -0.35, 0.35
    if refine_focal:
        lower[-1], upper[-1] = math.log(0.7), math.log(1.4)
    fit = least_squares(evaluate, np.zeros(nvars), jac_sparsity=sparsity.tocsr(),
                        bounds=(lower, upper), loss="soft_l1", f_scale=0.006,
                        max_nfev=90, ftol=1e-6, xtol=1e-6, gtol=1e-6, x_scale="jac")
    rotations, scale, errors = evaluate(fit.x, raw=True)
    refined = [np.array([*values[:2] * scale, *values[2:]]) for values in calibrations]
    return list(rotations), refined, float(np.median(errors)), float(np.percentile(errors, 95))


def project_frame(image: np.ndarray, basis: np.ndarray, calibration: np.ndarray,
                  width: int, *, pad: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Inverse mapping gives every destination pixel a bilinear source sample.

    Longitude is periodic; rows are processed in chunks to bound peak memory.
    Return BGR pixels, valid pixels, and the source's centre confidence.
    """
    height, full_width = width // 2, width + 2 * pad
    warped = np.zeros((height, full_width, 3), dtype=np.uint8)
    valid = np.zeros((height, full_width), dtype=np.uint8)
    confidence = np.zeros((height, full_width), dtype=np.float32)
    yaw = ((np.arange(full_width, dtype=np.float32) - pad + 0.5) / width - 0.5) * (2 * np.pi)
    sx, sz = np.sin(yaw), np.cos(yaw)
    fx, fy, cx, cy = calibration
    source_h, source_w = image.shape[:2]
    for start in range(0, height, 128):
        end = min(height, start + 128)
        pitch = (0.5 - (np.arange(start, end, dtype=np.float32) + 0.5) / height) * np.pi
        sin_pitch, cos_pitch = np.sin(pitch)[:, None], np.cos(pitch)[:, None]
        world = np.stack(np.broadcast_arrays(cos_pitch * sx, sin_pitch, cos_pitch * sz), axis=-1)
        camera = world @ basis
        depth = np.maximum(camera[:, :, 2], 1e-6)
        x = (camera[:, :, 0] / depth * fx + cx).astype(np.float32)
        y = (-camera[:, :, 1] / depth * fy + cy).astype(np.float32)
        inside = ((camera[:, :, 2] > 0) & (x >= 1) & (x < source_w - 2)
                  & (y >= 1) & (y < source_h - 2))
        # Keep an edge-colour extension outside the valid camera footprint.
        # These pixels are NEVER observations (inside/valid stays false), but
        # Laplacian pyramid filters need a nonblack boundary condition. Zeroing
        # them creates dark triangular frustum silhouettes after multiband blend.
        warped[start:end] = cv2.remap(image, x, y, cv2.INTER_LINEAR,
                                     borderMode=cv2.BORDER_REPLICATE)
        valid[start:end] = inside.astype(np.uint8) * 255
        # A small floor lets graph cuts use a necessary border without giving
        # it preference over a sharp central region from another view.
        nx = np.abs((x - cx) / max(cx, source_w - 1 - cx))
        ny = np.abs((y - cy) / max(cy, source_h - 1 - cy))
        confidence[start:end] = np.where(inside, np.maximum(0.01, 1 - np.maximum(nx, ny)), 0)
    return warped, valid, confidence


def _exposure_gains(images: list[np.ndarray], masks: list[np.ndarray]) -> np.ndarray:
    equations, targets = [], []
    luma = [cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32) for image in images]
    for i in range(len(images)):
        for j in range(i + 1, len(images)):
            overlap = ((masks[i][::3, ::3] > 0) & (masks[j][::3, ::3] > 0)
                       & (luma[i][::3, ::3] > 15) & (luma[j][::3, ::3] > 15)
                       & (luma[i][::3, ::3] < 238) & (luma[j][::3, ::3] < 238))
            if overlap.sum() < 64:
                continue
            ratio = np.log(luma[j][::3, ::3][overlap] / luma[i][::3, ::3][overlap])
            median = np.median(ratio)
            if np.median(np.abs(ratio - median)) > 0.3:
                continue
            row = np.zeros(len(images))
            row[i], row[j] = 1, -1
            equations.append(row)
            targets.append(median)
    if not equations:
        return np.ones(len(images))
    equations.extend(np.eye(len(images)) * 0.05)
    targets.extend(np.zeros(len(images)))
    gains = np.linalg.lstsq(np.array(equations), np.array(targets), rcond=None)[0]
    gains -= np.median(gains)
    return np.exp(np.clip(gains, -0.35, 0.35))


def _find_seams(images: list[np.ndarray], masks: list[np.ndarray], scores: list[np.ndarray],
                gains: np.ndarray, warnings: list[str]) -> tuple[list[np.ndarray], str]:
    height, width = masks[0].shape
    # Lock each row's wrapping collar to one real source image. This supplies
    # periodic boundary ownership to OpenCV's otherwise planar graph solver.
    collar = 4
    collar_columns = np.r_[np.arange(collar), np.arange(width - collar, width)]
    minimum = np.stack([score[:, collar_columns].min(axis=1) for score in scores])
    owners = minimum.argmax(axis=0)
    available = minimum.max(axis=0) > 0
    ownership_masks = [mask.copy() for mask in masks]
    for i, mask in enumerate(ownership_masks):
        rows = available & (owners != i)
        mask[np.ix_(rows, collar_columns)] = 0
    pad = 48
    corners, crops, seam_masks = [], [], []
    boxes = []
    for image, mask, gain in zip(images, ownership_masks, gains):
        extended = np.pad(mask, ((0, 0), (pad, pad)), mode="wrap")
        points = cv2.findNonZero(extended)
        if points is None:
            raise StitchError("A photo has no valid spherical coverage.")
        x, y, w, h = cv2.boundingRect(points)
        # NumPy 2 promotes multiplication by a float64 scalar to float64;
        # OpenCV's graph-cut gradient kernel requires three-channel float32.
        corrected = np.clip(image.astype(np.float32) * np.float32(gain), 0, 255)
        corrected = np.pad(corrected, ((0, 0), (pad, pad), (0, 0)), mode="wrap")
        corners.append((x, y))
        crops.append(cv2.UMat(np.ascontiguousarray(corrected[y:y + h, x:x + w])))
        seam_masks.append(cv2.UMat(np.ascontiguousarray(extended[y:y + h, x:x + w])))
        boxes.append((x, y, w, h))
    try:
        finder = cv2.detail_GraphCutSeamFinder("COST_COLOR_GRAD")
        result = finder.find(crops, corners, seam_masks)
        if result is not None:
            seam_masks = result
        output = []
        for seam, (x, y, w, h), original in zip(seam_masks, boxes, masks):
            extended = np.zeros((height, width + 2 * pad), dtype=np.uint8)
            extended[y:y + h, x:x + w] = seam.get() if hasattr(seam, "get") else seam
            selected = extended[:, pad:pad + width]
            output.append(cv2.bitwise_and(selected, original))
        uncovered = (np.maximum.reduce(output) == 0) & (np.maximum.reduce(masks) > 0)
        if uncovered.any():
            winners = np.stack(scores).argmax(axis=0)
            for i in range(len(output)):
                output[i][uncovered & (winners == i)] = 255
        return output, "graph-cut + multiband"
    except cv2.error as error:
        logging.getLogger(__name__).warning("Graph-cut seam selection failed: %s", error)
        warnings.append("Graph-cut seams were unavailable; central-source seams were used.")
        winners = np.stack(scores).argmax(axis=0)
        return [np.where((winners == i) & (mask > 0), 255, 0).astype(np.uint8)
                for i, mask in enumerate(masks)], "central-source + multiband"


def blend_frames(images: list[np.ndarray], bases: list[np.ndarray], calibrations: list[np.ndarray],
                 seams: list[np.ndarray], gains: np.ndarray, output_width: int,
                 progress: Callable[[str, int, int], None] = lambda *_: None,
                 cancelled: Callable[[], bool] = lambda: False) -> np.ndarray:
    """Blend observed source pixels with periodic, colour-extended boundaries."""
    # Pyramid support grows with output resolution. More low-frequency bands
    # smooth exposure transitions; high-frequency detail retains seam ownership.
    bands = max(4, min(7, round(math.log2(output_width)) - 6))
    pad = 2 ** (bands + 1)
    blender = cv2.detail_MultiBandBlender(0, bands)
    blender.prepare((0, 0, output_width + 2 * pad, output_width // 2))
    complete_mask = np.zeros((output_width // 2, output_width + 2 * pad), dtype=np.uint8)
    for i in range(len(images)):
        _check_cancel(cancelled)
        projected, valid, _ = project_frame(images[i], bases[i], calibrations[i], output_width, pad=pad)
        complete_mask |= valid
        # Narrow high-frequency blending avoids averaging displaced objects.
        # Low-frequency exposure smoothing is handled by the pyramid itself.
        seam = np.pad(seams[i], ((0, 0), (3, 3)), mode="wrap")
        seam = cv2.dilate(seam, np.ones((3, 3), dtype=np.uint8))[:, 3:-3]
        seam = cv2.resize(seam, (output_width, output_width // 2), interpolation=cv2.INTER_NEAREST)
        seam = np.pad(seam, ((0, 0), (pad, pad)), mode="wrap")
        seam = cv2.bitwise_and(seam, valid)
        corrected = np.clip(projected.astype(np.float32) * np.float32(gains[i]), 0, 255).astype(np.int16)
        blender.feed(corrected, seam, (0, 0))
        progress("blending", i + 1, len(images))
    result, result_mask = blender.blend(None, None)
    result = np.clip(result[:, pad:pad + output_width], 0, 255).astype(np.uint8)
    observed = (complete_mask[:, pad:pad + output_width] > 0) & (result_mask[:, pad:pad + output_width] > 0)
    # Edge-colour extension only defines filter boundaries. Uncaptured content
    # is still masked out, so this does not fill a missing room or polar region.
    result[~observed] = 0
    return result


def stitch(frames: list[dict], paths: list[Path], output_dir: Path,
           progress: Callable[[str, int, int], None], cancelled: Callable[[], bool],
           output_width: int = 4096) -> dict:
    """Reconstruct a measured sphere or fail with an actionable capture issue."""
    count = len(frames)
    if count != len(paths) or not 8 <= count <= MAX_FRAMES:
        raise StitchError(f"Use 8–{MAX_FRAMES} overlapping photos covering the complete sphere.")
    if not isinstance(output_width, int) or output_width < 1024 or output_width > 6144 or output_width % 2:
        raise StitchError("Panorama width must be an even number between 1024 and 6144.")
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cv2.setNumThreads(min(8, __import__("os").cpu_count() or 2))
    warnings: list[str] = []
    images, match_images, calibrations, match_calibrations, bases = [], [], [], [], []
    sharpness = []
    for i, (metadata, path) in enumerate(zip(frames, paths)):
        _check_cancel(cancelled)
        frame = dict(metadata)
        with Image.open(path) as source:
            if source.width * source.height > 40_000_000:
                raise StitchError("A source photo is too large. Use photos below 40 megapixels.")
            if min(source.size) < 128:
                raise StitchError("A source photo is too small to align reliably.")
            exif = source.getexif()
            equivalent = exif.get(41989) or exif.get_ifd(34665).get(41989)
            if equivalent:
                frame.setdefault("focalLength35mm", float(equivalent))
            upright = ImageOps.exif_transpose(source).convert("RGB")
            upright.thumbnail((SOURCE_LONG_EDGE, SOURCE_LONG_EDGE), Image.Resampling.LANCZOS)
            image = cv2.cvtColor(np.array(upright), cv2.COLOR_RGB2BGR)
        images.append(image)
        h, w = image.shape[:2]
        intrinsic = frame_calibration(frame, w, h)
        calibrations.append(intrinsic)
        scale = min(1.0, MATCH_LONG_EDGE / max(w, h))
        matching = cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        match_images.append(matching)
        match_calibrations.append(intrinsic * np.array([matching.shape[1] / w, matching.shape[0] / h] * 2))
        sharpness.append(float(cv2.Laplacian(cv2.cvtColor(matching, cv2.COLOR_BGR2GRAY), cv2.CV_32F).var()))
        bases.append(frame_basis(frame))
        progress("reading", i + 1, count)
    has_poses = all(basis is not None for basis in bases)
    if not has_poses and any(basis is not None for basis in bases):
        raise StitchError("This set mixes photos with and without capture poses. Use one complete capture.")
    if not has_poses:
        warnings.append("Uploaded photos use estimated camera calibration; a guided capture provides more reliable geometry.")
    blurry = sum(value < 25 for value in sharpness)
    if blurry:
        warnings.append(f"{blurry} photo(s) have little sharp detail. Existing blur cannot be recovered reliably.")
    if has_poses:
        forwards = np.stack(bases)[:, :, 2]
        # Native guide captures overlap between neighboring rings as well as
        # within rings. Include true angular neighbors across longitude zero.
        angles = np.degrees(np.arccos(np.clip(forwards @ forwards.T, -1, 1)))
        candidates = [(i, j) for i in range(count) for j in range(i + 1, count) if angles[i, j] < 85]
    else:
        candidates = [(i, j) for i in range(count) for j in range(i + 1, count)]
    edges = []
    matcher = FeatureMatcher(match_images)
    try:
        if not matcher.status["aiAvailable"]:
            warnings.append("AI matching is unavailable; this result uses OpenCV SIFT feature alignment.")
        for done, (i, j) in enumerate(candidates):
            _check_cancel(cancelled)
            if has_poses:
                points0, points1 = matcher.match(i, j)
            else:
                # Fast mutual SIFT retrieval bounds expensive learned work for
                # unordered uploads. Weak retrieval pairs are still tried when
                # their sequence is adjacent, useful for low-texture captures.
                classical0, classical1 = matcher.classical_match(i, j)
                if len(classical0) < 10 and abs(i - j) not in (1, count - 1):
                    progress("matching", done + 1, len(candidates))
                    continue
                points0, points1 = matcher.match(i, j)
            edge = _pair_edge(i, j, points0, points1, match_calibrations, bases if has_poses else None)
            if edge is not None:
                edge["aiUsed"] = matcher.last_ai
                edges.append(edge)
            progress("matching", done + 1, len(candidates))
        ai_used, device = any(edge.get("aiUsed") for edge in edges), matcher.status["device"]
        if matcher.failures:
            warnings.append(f"{matcher.failures} image pair(s) used classical matching after a learned-matcher error.")
    finally:
        matcher.close()
    components = _components(count, edges)
    aligned = len({edge[key] for edge in edges for key in ("i", "j")})
    if len(edges) < max(4, count // 3) or aligned < math.ceil(count * 0.6):
        raise StitchError("Too few photos could be aligned reliably. Retake with more overlap, sharper photos, and a stationary camera position.")
    if len(components) > 1:
        if not has_poses:
            raise StitchError("The uploaded photos do not form one connected sphere. Add overlapping views between the missing directions.")
        warnings.append(f"{count - len(components[0])} photo(s) are outside the main visual match group and retain capture-pose guidance.")
    if not has_poses:
        bases = _bootstrap(count, edges)
    progress("aligning", 0, 1)
    bases, refined_matching, median_error, p95_error = refine_rotations(
        bases, match_calibrations, edges, has_poses=has_poses,
        refine_focal=not has_poses, cancelled=cancelled)
    for i in range(count):
        calibrations[i][:2] *= refined_matching[i][:2] / match_calibrations[i][:2]
    if not has_poses:
        # Upright phone JPEGs supply a useful aggregate gravity direction even
        # without AR poses. Level that consensus without flattening polar views.
        up = np.mean(np.stack(bases)[:, :, 1], axis=0)
        if np.linalg.norm(up) > 0.25:
            up /= np.linalg.norm(up)
            target = np.array([0., 1., 0.])
            axis = np.cross(up, target)
            sine, cosine = np.linalg.norm(axis), np.dot(up, target)
            if sine > 1e-7:
                level = Rotation.from_rotvec(axis / sine * np.arctan2(sine, cosine)).as_matrix()
                bases = [level @ basis for basis in bases]
            elif cosine < 0:
                level = Rotation.from_euler("x", 180, degrees=True).as_matrix()
                bases = [level @ basis for basis in bases]
        else:
            warnings.append("The uploaded camera orientations have no consistent upright direction; check the horizon in the viewer.")
    if median_error > 1.0 or p95_error > 3.0:
        raise StitchError("The photos disagree too much for a clean sphere. Keep the lens in one position while turning, and avoid moving people between shots.")
    if median_error > 0.35 or p95_error > 1.5:
        warnings.append("Some overlaps contain parallax or movement; inspect nearby objects and people for seam artifacts.")
    if has_poses:
        positions = [np.array(frame["transform"])[[12, 13, 14]] for frame in frames
                     if isinstance(frame.get("transform"), list) and len(frame["transform"]) == 16]
        if len(positions) > 1 and np.linalg.norm(np.ptp(positions, axis=0)) > 0.2:
            warnings.append("The camera moved while capturing. Nearby surfaces can still show parallax at seams.")
    progress("aligning", 1, 1)
    seam_width = min(SEAM_WIDTH, output_width)
    low_images, low_masks, low_scores = [], [], []
    for i in range(count):
        _check_cancel(cancelled)
        projected, mask, score = project_frame(images[i], bases[i], calibrations[i], seam_width)
        low_images.append(projected)
        low_masks.append(mask)
        low_scores.append(score)
        progress("projecting", i + 1, count)
    coverage_mask = np.maximum.reduce(low_masks) > 0
    latitude_weight = np.cos((0.5 - (np.arange(seam_width // 2) + 0.5) / (seam_width // 2)) * np.pi)
    coverage = float((coverage_mask * latitude_weight[:, None]).sum() / (latitude_weight.sum() * seam_width))
    image_coverage = float(coverage_mask.mean())
    if coverage < 0.985 or image_coverage < 0.97:
        raise StitchError(f"About {max(1, round((1 - coverage) * 100))}% of the sphere is missing. Add views above, below, and between existing photos; missing content will not be invented.")
    if image_coverage < 0.9995:
        warnings.append("Tiny uncaptured areas remain dark; no missing scene content was generated.")
    progress("seams", 0, 1)
    gains = _exposure_gains(low_images, low_masks)
    seams, seam_method = _find_seams(low_images, low_masks, low_scores, gains, warnings)
    del low_images, low_masks, low_scores
    progress("seams", 1, 1)
    _check_cancel(cancelled)
    result = blend_frames(images, bases, calibrations, seams, gains, output_width, progress, cancelled)
    progress("encoding", 0, 1)
    _check_cancel(cancelled)
    panorama_path, thumbnail_path = output_dir / "panorama.jpg", output_dir / "thumbnail.jpg"
    if not cv2.imwrite(str(panorama_path), result, [cv2.IMWRITE_JPEG_QUALITY, 95]):
        raise OSError("The assembled panorama could not be saved.")
    thumbnail = cv2.resize(result, (640, 320), interpolation=cv2.INTER_AREA)
    if not cv2.imwrite(str(thumbnail_path), thumbnail, [cv2.IMWRITE_JPEG_QUALITY, 88]):
        raise OSError("The panorama preview could not be saved.")
    progress("encoding", 1, 1)
    return {"panoramaPath": str(panorama_path), "thumbnailPath": str(thumbnail_path),
            "width": output_width, "height": output_width // 2,
            "report": {"method": "DISK + LightGlue" if ai_used else "OpenCV SIFT",
                       "aiUsed": ai_used, "device": device, "matchedPairs": len(edges),
                       "alignedFrames": aligned, "inputFrames": count,
                       "coverage": round(coverage, 6), "pixelCoverage": round(image_coverage, 6),
                       "alignmentErrorDegrees": round(median_error, 4),
                       "alignmentP95Degrees": round(p95_error, 4),
                       "seamMethod": seam_method, "generativeFill": False,
                       "warnings": warnings}}
