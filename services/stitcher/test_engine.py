"""Geometry and generated-photo reconstruction checks, no private family media."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from scipy.spatial.transform import Rotation

from .engine import (StitchError, blend_frames, frame_basis, frame_calibration, project_frame,
                     refine_rotations, stitch)


def reference_rotation(yaw: float, pitch: float, roll: float = 0) -> np.ndarray:
    return (Rotation.from_euler("y", yaw, degrees=True).as_matrix()
            @ Rotation.from_euler("x", -pitch, degrees=True).as_matrix()
            @ Rotation.from_euler("z", roll, degrees=True).as_matrix())


def reference_native_transform(rotation: np.ndarray) -> list[float]:
    reflected = np.diag([1, 1, -1]) @ rotation @ np.diag([1, 1, -1])
    matrix = np.eye(4)
    matrix[:3, :3] = reflected
    return matrix.flatten(order="F").tolist()


def capture_targets() -> list[tuple[float, float]]:
    targets = [(0, 82)]
    for pitch, count, start in [(55, 5, 36), (27, 7, 0), (0, 8, 22.5),
                                 (-27, 7, 360 / 14), (-55, 5, 0)]:
        targets.extend((start + i * 360 / count, pitch) for i in range(count))
    return targets + [(0, -82)]


def render_photo(panorama: np.ndarray, rotation: np.ndarray, width=640, height=480,
                 hfov=74) -> tuple[np.ndarray, np.ndarray]:
    focal = width / (2 * np.tan(np.radians(hfov) / 2))
    calibration = np.array([focal, focal, (width - 1) / 2, (height - 1) / 2])
    xs, ys = np.meshgrid(np.arange(width), np.arange(height))
    rays = np.stack(((xs - calibration[2]) / focal, -(ys - calibration[3]) / focal,
                     np.ones_like(xs)), axis=-1) @ rotation.T
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    x = ((np.arctan2(rays[:, :, 0], rays[:, :, 2]) / (2 * np.pi) + 0.5) * panorama.shape[1]).astype(np.float32)
    y = ((0.5 - np.arcsin(rays[:, :, 1]) / np.pi) * panorama.shape[0]).astype(np.float32)
    return cv2.remap(panorama, x, y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP), calibration


def textured_sphere() -> np.ndarray:
    rng = np.random.default_rng(21)
    noise = rng.integers(20, 230, (512, 1024, 3), dtype=np.uint8)
    texture = cv2.resize(cv2.GaussianBlur(noise, (3, 3), 0.6), (2048, 1024))
    for index in range(1200):
        x, y = rng.integers([0, 0], [2048, 1024])
        color = tuple(int(value) for value in rng.integers(5, 250, 3))
        cv2.circle(texture, (int(x), int(y)), int(rng.integers(2, 12)), color, -1)
    for y in range(100, 1000, 150):
        for x in range(80, 2000, 180):
            cv2.putText(texture, f"{x}:{y}", (x, y), cv2.FONT_HERSHEY_SIMPLEX,
                        0.45, (250, 245, 235), 1, cv2.LINE_AA)
    return texture


class GeometryTests(unittest.TestCase):
    def test_native_basis_matches_independent_rotation_including_roll_and_poles(self):
        for yaw, pitch, roll in [(0, 0, 0), (95, -30, 25), (-179, 82, -18), (182, -82, 11)]:
            rotation = reference_rotation(yaw, pitch, roll)
            np.testing.assert_allclose(frame_basis({"transform": reference_native_transform(rotation)}), rotation, atol=1e-12)
            np.testing.assert_allclose(frame_basis({"yawDegrees": yaw, "pitchDegrees": pitch,
                                                   "rollDegrees": roll}), rotation, atol=1e-12)

    def test_upright_intrinsics_rotation_is_not_applied_twice_to_pose(self):
        frame = {"width": 800, "height": 600, "rotationDegrees": 90,
                 "intrinsics": [700, 0, 390, 0, 710, 280, 0, 0, 1],
                 "transform": reference_native_transform(np.eye(3))}
        np.testing.assert_allclose(frame_calibration(frame, 300, 400), [355, 350, 159.5, 195])
        np.testing.assert_allclose(frame_basis(frame), np.eye(3))

    def test_inverse_projection_is_continuous_across_longitude_wrap(self):
        image = np.full((300, 400, 3), (32, 87, 219), dtype=np.uint8)
        calibration = frame_calibration({"horizontalFovDegrees": 74}, 400, 300)
        pixels, mask, _ = project_frame(image, reference_rotation(180, 0), calibration, 1024)
        self.assertTrue(np.all(mask[256, [0, 1023]] == 255))
        np.testing.assert_array_equal(pixels[256, 0], pixels[256, -1])
        np.testing.assert_array_equal(pixels[256, 0], [32, 87, 219])

    def test_global_bundle_adjustment_removes_pose_drift_and_closes_loop(self):
        rng = np.random.default_rng(9)
        count = 12
        true = [reference_rotation(i * 30, 0) for i in range(count)]
        intrinsics = [np.array([410., 410., 319.5, 239.5])] * count
        directions = rng.normal(size=(16000, 3))
        directions /= np.linalg.norm(directions, axis=1, keepdims=True)
        points, visible = [], []
        for rotation in true:
            rays = directions @ rotation
            z = np.maximum(1e-6, rays[:, 2])
            pixels = np.column_stack((rays[:, 0] / z * 410 + 319.5,
                                      -rays[:, 1] / z * 410 + 239.5))
            points.append(pixels)
            visible.append((rays[:, 2] > 0) & (pixels[:, 0] > 20) & (pixels[:, 0] < 620)
                           & (pixels[:, 1] > 20) & (pixels[:, 1] < 460))
        edges = []
        for i in range(count):
            j = (i + 1) % count
            selected = np.flatnonzero(visible[i] & visible[j])[:80]
            edges.append({"i": i, "j": j, "points0": points[i][selected], "points1": points[j][selected]})
        perturbed = [true[0]] + [Rotation.from_rotvec(rng.normal(0, np.radians(1.5), 3)).as_matrix() @ r for r in true[1:]]
        before = np.mean([np.degrees(Rotation.from_matrix(a @ b.T).magnitude()) for a, b in zip(perturbed, true)])
        result, _, median, p95 = refine_rotations(perturbed, intrinsics, edges,
                                                has_poses=True, refine_focal=False)
        after = np.mean([np.degrees(Rotation.from_matrix(a @ b.T).magnitude()) for a, b in zip(result, true)])
        self.assertGreater(before, 1)
        self.assertLess(after, 0.03)
        self.assertLess(median, 0.01)
        self.assertLess(p95, 0.02)

    def test_multiband_boundary_extension_does_not_create_dark_frustum_polygons(self):
        # A uniform photographed sphere must remain uniform even when every
        # source image has a different curved footprint and overlap seam.
        color = np.array([87, 143, 209], dtype=np.uint8)
        image = np.broadcast_to(color, (240, 320, 3)).copy()
        bases = [reference_rotation(yaw, pitch) for yaw, pitch in capture_targets()]
        intrinsic = frame_calibration({"horizontalFovDegrees": 74}, 320, 240)
        masks, scores = [], []
        for basis in bases:
            _, mask, score = project_frame(image, basis, intrinsic, 512)
            masks.append(mask)
            scores.append(score)
        # Retain arbitrary overlapping camera masks here, including their
        # frustum boundaries. This specifically exercises pyramid boundary
        # handling, independent of the graph-cut's preferred cut location.
        result = blend_frames([image] * len(bases), bases, [intrinsic] * len(bases),
                              masks, np.ones(len(bases)), 1024)
        error = np.abs(result.astype(float) - color)
        self.assertLess(error.mean(), 1.6)
        self.assertLessEqual(error.max(), 3)
        partial = blend_frames([image], bases[:1], [intrinsic], masks[:1], np.ones(1), 1024)
        self.assertGreater(partial[0].sum(), 0)
        self.assertTrue(np.all(partial[-1] == 0), "Colour extension must not fill an unobserved region")


class ReconstructionTests(unittest.TestCase):
    def test_generated_34_photo_capture_aligns_and_preserves_full_sphere(self):
        texture = textured_sphere()
        rng = np.random.default_rng(42)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"STITCHER_MATCHER": "sift"}):
            paths, frames = [], []
            for i, (yaw, pitch) in enumerate(capture_targets()):
                true_rotation = reference_rotation(yaw, pitch)
                image, calibration = render_photo(texture, true_rotation)
                path = Path(directory) / f"frame-{i}.jpg"
                cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, 96])
                measured = true_rotation if i == 0 else Rotation.from_rotvec(rng.normal(0, np.radians(0.8), 3)).as_matrix() @ true_rotation
                paths.append(path)
                fx, fy, cx, cy = calibration
                frames.append({"width": 640, "height": 480,
                               "intrinsics": [fx, 0, cx, 0, fy, cy, 0, 0, 1],
                               "transform": reference_native_transform(measured)})
            result = stitch(frames, paths, Path(directory) / "result", lambda *_: None,
                            lambda: False, output_width=1024)
            report = result["report"]
            self.assertFalse(report["aiUsed"])
            self.assertEqual(report["seamMethod"], "graph-cut + multiband")
            self.assertGreater(report["coverage"], 0.995)
            self.assertEqual(report["alignedFrames"], 34)
            self.assertLess(report["alignmentErrorDegrees"], 0.15)
            self.assertFalse(report["generativeFill"])
            panorama = cv2.imread(result["panoramaPath"])
            self.assertEqual(panorama.shape, (512, 1024, 3))
            expected = cv2.resize(texture, (1024, 512), interpolation=cv2.INTER_AREA)
            # Ignore polar stretching when measuring preservation of texture.
            error = np.abs(panorama[70:-70].astype(float) - expected[70:-70]).mean()
            self.assertLess(error, 19)

    def test_missing_coverage_is_rejected_without_inventing_content(self):
        texture = textured_sphere()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"STITCHER_MATCHER": "sift"}):
            paths, frames = [], []
            for i in range(8):
                rotation = reference_rotation(i * 45, 0)
                image, calibration = render_photo(texture, rotation)
                path = Path(directory) / f"frame-{i}.jpg"
                cv2.imwrite(str(path), image)
                paths.append(path)
                fx, fy, cx, cy = calibration
                frames.append({"width": 640, "height": 480,
                               "intrinsics": [fx, 0, cx, 0, fy, cy, 0, 0, 1],
                               "transform": reference_native_transform(rotation)})
            output = Path(directory) / "result"
            with self.assertRaisesRegex(StitchError, "missing"):
                stitch(frames, paths, output, lambda *_: None, lambda: False, output_width=1024)
            self.assertFalse((output / "panorama.jpg").exists())

    def test_cancellation_exits_before_decoding(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(InterruptedError):
                stitch([{}] * 8, [Path("missing.jpg")] * 8, Path(directory),
                       lambda *_: None, lambda: True)


if __name__ == "__main__":
    unittest.main()
