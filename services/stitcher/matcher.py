"""Learned image correspondences, with an explicitly labelled classical fallback.

DISK extracts local features once per image; LightGlue predicts correspondences.
The models are the upstream, pretrained cvg/LightGlue models, not an image
generator. No photographed content leaves this process.
"""

from __future__ import annotations

import os
import math
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError

import cv2
import numpy as np

_model_lock = threading.Lock()
_models: tuple[Any, Any, Any, str] | None = None
_model_error: str | None = None
_model_warning: str | None = None
_retry_after = 0.0


def warmup_matcher() -> dict:
    """Load/download official weights once. Never runs implicitly at import."""
    global _models, _model_error, _model_warning, _retry_after
    if os.getenv("STITCHER_MATCHER", "").lower() == "sift":
        return {"aiAvailable": False, "device": "cpu", "method": "OpenCV SIFT"}
    with _model_lock:
        if _models is None and (_model_error is None or time.monotonic() >= _retry_after):
            for attempt in range(3):
                try:
                    import torch
                    from lightglue import DISK, LightGlue

                    torch.set_num_threads(min(8, os.cpu_count() or 2))
                    # Finish weight loading on CPU first: a GPU allocation
                    # failure must not discard otherwise usable learned models.
                    extractor = DISK(max_num_keypoints=2048).eval()
                    network = LightGlue(features="disk", depth_confidence=0.95,
                                        width_confidence=0.99).eval()
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                    if device == "cuda":
                        try:
                            extractor.to(device)
                            network.to(device)
                        except RuntimeError:
                            extractor.cpu()
                            network.cpu()
                            torch.cuda.empty_cache()
                            device = "cpu"
                            _model_warning = "GPU acceleration is unavailable; learned matching runs on CPU."
                    _models = torch, extractor, network, device
                    _model_error = None
                    break
                except (HTTPError, URLError, TimeoutError, ConnectionError) as exc:
                    # Public model hosts can return transient 503s. Retry only
                    # during background warmup, with a bounded total backoff.
                    if attempt < 2:
                        time.sleep(attempt + 1)
                        continue
                    _model_error = f"Learned model download is temporarily unavailable ({type(exc).__name__})."
                    _retry_after = time.monotonic() + 30
                except Exception as exc:
                    _model_error = f"Learned matcher unavailable ({type(exc).__name__})."
                    _retry_after = time.monotonic() + 60
                    break
        if _models is not None:
            return {"aiAvailable": True, "device": _models[3],
                    "method": "DISK + LightGlue", "warning": _model_warning}
        return {"aiAvailable": False, "device": "cpu", "method": "OpenCV SIFT",
                "warning": _model_error,
                "retryAfterSeconds": max(0, math.ceil(_retry_after - time.monotonic()))}


class FeatureMatcher:
    """Per-job feature caches; inputs are upright BGR images, <=1200 px."""

    def __init__(self, images: list[np.ndarray]):
        self.images = images
        self.status = warmup_matcher()
        self.ai_used = False
        self.last_ai = False
        self.failures = 0
        self._sift = cv2.SIFT_create(nfeatures=2400, contrastThreshold=0.025)
        self._classical: dict[int, tuple] = {}
        self._learned: dict[int, dict] = {}

    def classical_features(self, index: int) -> tuple[np.ndarray, np.ndarray | None]:
        if index not in self._classical:
            points, descriptors = self._sift.detectAndCompute(
                cv2.cvtColor(self.images[index], cv2.COLOR_BGR2GRAY), None)
            self._classical[index] = (
                np.array([point.pt for point in points], dtype=np.float32).reshape(-1, 2),
                descriptors,
            )
        return self._classical[index]

    def classical_match(self, first: int, second: int) -> tuple[np.ndarray, np.ndarray]:
        points0, descriptors0 = self.classical_features(first)
        points1, descriptors1 = self.classical_features(second)
        if descriptors0 is None or descriptors1 is None or min(len(points0), len(points1)) < 4:
            return np.empty((0, 2)), np.empty((0, 2))
        matcher = cv2.BFMatcher(cv2.NORM_L2)
        forward = matcher.knnMatch(descriptors0, descriptors1, k=2)
        reverse = matcher.knnMatch(descriptors1, descriptors0, k=2)
        reverse_pairs = {(pair[0].trainIdx, pair[0].queryIdx)
                         for pair in reverse if len(pair) == 2
                         and pair[0].distance < 0.76 * pair[1].distance}
        good = [pair[0] for pair in forward if len(pair) == 2
                and pair[0].distance < 0.76 * pair[1].distance
                and (pair[0].queryIdx, pair[0].trainIdx) in reverse_pairs]
        return (points0[[match.queryIdx for match in good]],
                points1[[match.trainIdx for match in good]])

    def _features(self, index: int) -> dict:
        if index not in self._learned:
            torch, extractor, _, device = _models
            pixels = np.ascontiguousarray(self.images[index][:, :, ::-1].transpose(2, 0, 1))
            tensor = torch.from_numpy(pixels).to(device).float().div_(255)
            with torch.inference_mode():
                self._learned[index] = extractor.extract(tensor, resize=None)
        return self._learned[index]

    def match(self, first: int, second: int) -> tuple[np.ndarray, np.ndarray]:
        self.last_ai = False
        if self.status["aiAvailable"]:
            try:
                torch, _, network, _ = _models
                with torch.inference_mode():
                    features0, features1 = self._features(first), self._features(second)
                    output = network({"image0": features0, "image1": features1})
                    pairs = output["matches"][0]
                    points0 = features0["keypoints"][0][pairs[:, 0]].cpu().numpy()
                    points1 = features1["keypoints"][0][pairs[:, 1]].cpu().numpy()
                self.ai_used = True
                self.last_ai = True
                return points0, points1
            except Exception:
                self.failures += 1
                # Do not turn one failed pair into an unhandled job failure.
                # The quality report exposes fallback use and the geometry
                # checks still reject bad/unconnected correspondences.
        return self.classical_match(first, second)

    def close(self) -> None:
        self._learned.clear()
        self._classical.clear()
        if _models is not None and _models[3] == "cuda":
            _models[0].cuda.empty_cache()
