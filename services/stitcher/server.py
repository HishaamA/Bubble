"""Bounded local HTTP jobs for matching and reconstructing camera photographs.

Run from the repository root with ``python -m services.stitcher.server``.
Photos are temporary, never added to a family account, and deleted on cancellation,
failure, shutdown, or expiry. Successful jobs retain only the output for one hour.
"""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import json
import logging
import math
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
from typing import Any, Callable
from uuid import uuid4
import warnings

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, UnidentifiedImageError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

LOGGER = logging.getLogger("bubble.stitcher")
TERMINAL = {"completed", "failed", "cancelled"}
DEFAULT_ORIGINS = {
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:4173", "http://127.0.0.1:4173",
    "http://localhost:8787", "http://127.0.0.1:8787",
    "http://localhost", "https://localhost", "capacitor://localhost",
}


@dataclass(frozen=True)
class Limits:
    min_frames: int = 8
    max_frames: int = 64
    max_frame_bytes: int = 12 * 1024 * 1024
    max_request_bytes: int = 180 * 1024 * 1024
    max_pixels: int = 32_000_000
    max_manifest_bytes: int = 256 * 1024
    max_active_jobs: int = 2
    max_retained_jobs: int = 8
    retention_seconds: float = 3600
    health_retry_seconds: float = 30


@dataclass
class Job:
    id: str
    directory: Path
    status: str = "uploading"
    phase: str = "uploading"
    completed: int = 0
    total: int = 0
    frames: list[dict] = field(default_factory=list)
    paths: list[Path] = field(default_factory=list)
    output_width: int = 4096
    cancelled: threading.Event = field(default_factory=threading.Event)
    executing: bool = False
    result: dict | None = None
    error: str | None = None
    error_code: str | None = None
    finished_at: float | None = None


def _engine_stitch(*args, **kwargs):
    from .engine import stitch
    return stitch(*args, **kwargs)


def _probe_matcher():
    from .matcher import warmup_matcher
    return warmup_matcher()


class JobManager:
    def __init__(self, stitch: Callable, probe: Callable, limits: Limits):
        self.stitch = stitch
        self.probe = probe
        self.limits = limits
        self.root = Path(tempfile.mkdtemp(prefix="bubble-stitch-")).resolve()
        self.jobs: dict[str, Job] = {}
        self.pending: deque[str] = deque()
        self.condition = threading.Condition(threading.RLock())
        self.stopping = threading.Event()
        self.health: dict[str, Any] = {
            "status": "ok", "aiAvailable": False, "device": "cpu",
            "model": "LightGlue + DISK", "loading": True,
        }
        self.next_health_probe = 0.0
        self.worker = threading.Thread(target=self._work, name="panorama-worker", daemon=True)
        self.janitor = threading.Thread(target=self._sweep, name="panorama-cleanup", daemon=True)

    def start(self):
        self.worker.start()
        self.janitor.start()

    def close(self):
        self.stopping.set()
        with self.condition:
            for job in self.jobs.values():
                job.cancelled.set()
            self.condition.notify_all()
        self.worker.join(timeout=10)
        self.janitor.join(timeout=2)
        # The worker owns final cleanup if a native computation is still finishing.
        if not self.worker.is_alive():
            self._remove_directory(self.root)

    def _remove_directory(self, directory: Path):
        resolved = directory.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise RuntimeError("Refusing cleanup outside the private job directory.")
        shutil.rmtree(resolved, ignore_errors=True)

    def reserve(self) -> Job:
        with self.condition:
            active = sum(job.executing or job.status not in TERMINAL for job in self.jobs.values())
            if active >= self.limits.max_active_jobs or self.stopping.is_set():
                raise HTTPException(429, "The stitcher is busy. Please finish or cancel another job first.", headers={"Retry-After": "10"})
            job_id = uuid4().hex
            directory = self.root / job_id
            directory.mkdir(mode=0o700)
            job = Job(id=job_id, directory=directory)
            self.jobs[job_id] = job
            return job

    def abandon(self, job: Job):
        with self.condition:
            self.jobs.pop(job.id, None)
            self._remove_directory(job.directory)

    def submit(self, job: Job, frames: list[dict], paths: list[Path], output_width: int):
        with self.condition:
            job.frames, job.paths, job.output_width = frames, paths, output_width
            job.status = job.phase = "queued"
            job.total = len(frames)
            self.pending.append(job.id)
            self.condition.notify()

    def _get(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if job is None or job.status == "uploading":
            raise HTTPException(404, "This stitching job was not found or has expired.")
        return job

    def snapshot(self, job_id: str) -> dict:
        with self.condition:
            job = self._get(job_id)
            snapshot = {"id": job.id, "status": job.status, "phase": job.phase,
                        "completed": job.completed, "total": job.total}
            if job.error:
                snapshot["error"] = job.error
                snapshot["errorCode"] = job.error_code
            if job.result and job.status == "completed":
                snapshot.update({"report": job.result.get("report", {}),
                                 "width": job.result["width"], "height": job.result["height"]})
            return snapshot

    def cancel(self, job_id: str) -> dict:
        with self.condition:
            job = self._get(job_id)
            was_running = job.executing
            job.cancelled.set()
            job.status = job.phase = "cancelled"
            job.finished_at = None if was_running else time.monotonic()
            job.result = None
            if job_id in self.pending:
                self.pending.remove(job_id)
            if not was_running:
                self._remove_directory(job.directory)
            return self.snapshot(job_id)

    def output(self, job_id: str, kind: str) -> Path:
        with self.condition:
            job = self._get(job_id)
            if job.status != "completed" or not job.result:
                raise HTTPException(409, "The panorama is not ready to download.")
            path = Path(job.result[kind + "Path"]).resolve()
            if job.directory not in path.parents or not path.is_file():
                raise HTTPException(404, "The panorama output has expired.")
            return path

    def _progress(self, job: Job, phase: str, completed: int, total: int):
        with self.condition:
            if job.status == "running":
                job.phase = str(phase)
                job.total = max(0, int(total))
                job.completed = min(max(0, int(completed)), job.total)

    def _refresh_health(self):
        """Retry unavailable weights on the idle worker, never on a HTTP request."""
        try:
            health = self.probe()
        except Exception:
            LOGGER.exception("Learned matcher could not be loaded")
            health = {"aiAvailable": False, "device": "cpu", "method": "OpenCV SIFT",
                      "warning": "AI matching is unavailable; geometric matching will be used."}
        with self.condition:
            self.health.update({"aiAvailable": bool(health.get("aiAvailable")),
                                "device": health.get("device", "cpu"),
                                "model": health.get("model", health.get("method", "LightGlue + DISK")),
                                "loading": False})
            if health.get("warning"):
                self.health["warning"] = str(health["warning"])
            else:
                self.health.pop("warning", None)
            retry_after = health.get("retryAfterSeconds", 0)
            if not isinstance(retry_after, (int, float)) or not math.isfinite(retry_after):
                retry_after = 0
            self.next_health_probe = time.monotonic() + max(0.01, self.limits.health_retry_seconds, retry_after)

    def _work(self):
        try:
            self._refresh_health()
            while not self.stopping.is_set():
                with self.condition:
                    timeout = None if self.health["aiAvailable"] else max(0, self.next_health_probe - time.monotonic())
                    self.condition.wait_for(lambda: bool(self.pending) or self.stopping.is_set(), timeout=timeout)
                    if self.stopping.is_set():
                        break
                    job = self.jobs[self.pending.popleft()] if self.pending else None
                    if job is not None:
                        job.executing = True
                        job.status = "running"
                        job.phase = "preparing"
                if job is None:
                    self._refresh_health()
                    continue
                try:
                    output_dir = job.directory / "output"
                    output_dir.mkdir(exist_ok=True)
                    result = self.stitch(job.frames, job.paths, output_dir,
                                         lambda phase, completed, total: self._progress(job, phase, completed, total),
                                         job.cancelled.is_set, output_width=job.output_width)
                    with self.condition:
                        if not job.cancelled.is_set():
                            for key in ("panoramaPath", "thumbnailPath"):
                                output = Path(result[key]).resolve()
                                if output_dir not in output.parents or not output.is_file():
                                    raise RuntimeError("The stitcher did not produce a valid panorama file.")
                            job.result = result
                            job.status = job.phase = "completed"
                            job.completed = job.total
                except Exception as error:
                    with self.condition:
                        if not job.cancelled.is_set():
                            LOGGER.exception("Stitching job %s failed", job.id)
                            # Engine quality errors are actionable; don't expose private filesystem paths.
                            job.error = str(error) if isinstance(error, ValueError) else "Stitching could not finish. Try sharper overlapping photos taken from one position."
                            job.error_code = "quality_rejected" if isinstance(error, ValueError) else "processing_failed"
                            job.status = job.phase = "failed"
                finally:
                    with self.condition:
                        if job.cancelled.is_set():
                            job.status = job.phase = "cancelled"
                        job.finished_at = time.monotonic()
                        job.executing = False
                        if job.status == "completed":
                            for path in job.paths:
                                path.unlink(missing_ok=True)
                            job.paths.clear()
                            job.frames.clear()
                        else:
                            self._remove_directory(job.directory)
        finally:
            if self.stopping.is_set():
                self._remove_directory(self.root)

    def _sweep(self):
        while not self.stopping.wait(30):
            self.expire()

    def expire(self):
        with self.condition:
            finished = sorted((job for job in self.jobs.values() if job.finished_at is not None),
                              key=lambda job: job.finished_at)
            excess = max(0, len(finished) - self.limits.max_retained_jobs)
            now = time.monotonic()
            for index, job in enumerate(finished):
                if index < excess or now - job.finished_at > self.limits.retention_seconds:
                    self.jobs.pop(job.id, None)
                    self._remove_directory(job.directory)


class UploadBoundaryMiddleware:
    """Reject unexpected browser origins and cap streamed multipart bodies too."""
    def __init__(self, app, origins: set[str], max_bytes: int):
        self.app, self.origins, self.max_bytes = app, origins, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        origin = headers.get(b"origin", b"").decode("latin-1")
        if origin and origin not in self.origins:
            return await JSONResponse({"detail": "This origin is not allowed to use the local stitcher."}, status_code=403)(scope, receive, send)
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "Invalid content length."}, status_code=400)(scope, receive, send)
        if length > self.max_bytes:
            return await JSONResponse({"detail": "These photos exceed the 180 MB upload limit."}, status_code=413)(scope, receive, send)
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    # Starlette closes every spooled upload on MultiPartException.
                    scope["stitch_body_limit_exceeded"] = True
                    raise MultiPartException("These photos exceed the upload limit.")
            return message

        await self.app(scope, limited_receive, send)


def _validate_manifest(value: Any, limits: Limits) -> tuple[list[dict], int, str]:
    if not isinstance(value, str) or len(value.encode("utf-8")) > limits.max_manifest_bytes:
        raise HTTPException(400, "A valid capture manifest is required.")
    try:
        manifest = json.loads(value, parse_constant=lambda _: None)
    except (ValueError, TypeError):
        raise HTTPException(400, "The capture manifest is not valid JSON.") from None
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise HTTPException(400, "This capture manifest version is not supported.")
    frames = manifest.get("frames")
    if not isinstance(frames, list) or not limits.min_frames <= len(frames) <= limits.max_frames:
        raise HTTPException(400, f"Choose {limits.min_frames}–{limits.max_frames} overlapping source photos.")
    if any(not isinstance(frame, dict) for frame in frames):
        raise HTTPException(400, "Each source photo needs a metadata entry.")
    width = manifest.get("outputWidth", 4096)
    if type(width) is not int or width not in (2048, 4096, 6144):
        raise HTTPException(400, "Choose an output width of 2048, 4096, or 6144 pixels.")
    projection = manifest.get("projection", "posed")
    if projection not in ("posed", "unposed", "perspective", "equirectangular"):
        raise HTTPException(400, "This capture projection is not supported.")
    for frame in frames:
        for key, item in frame.items():
            if isinstance(item, (int, float)) and not math.isfinite(item):
                raise HTTPException(400, f"Photo metadata contains an invalid {key} value.")
    return frames, width, projection


def _inspect_photo(path: Path, metadata: dict, projection: str, limits: Limits) -> dict:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format != "JPEG":
                    raise HTTPException(400, "Source photos must be JPEG images.")
                width, height = image.size
                if width * height > limits.max_pixels or min(width, height) < 64:
                    raise HTTPException(400, "Each source photo must be at least 64 pixels per side and no larger than 32 megapixels.")
                exif = image.getexif()
                focal_35mm = exif.get(41989) or exif.get_ifd(34665).get(41989)
                image.verify()
            # Decode now to reject truncated images before reserving expensive work.
            with Image.open(path) as image:
                image.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(400, "A source photo is damaged or too large. Choose valid JPEG photos.") from None
    clean = {key: value for key, value in metadata.items() if key not in {"path", "uri", "fileUrl", "fileName"}}
    calibration_width, calibration_height = metadata.get("width"), metadata.get("height")
    preserve_calibration = (
        projection != "unposed" and isinstance(metadata.get("intrinsics"), list)
        and len(metadata["intrinsics"]) >= 6
        and type(calibration_width) is int and type(calibration_height) is int
        and min(calibration_width, calibration_height) >= 64
        and calibration_width * calibration_height <= limits.max_pixels
    )
    # Legacy native captures express intrinsics in the sensor image dimensions
    # and provide rotationDegrees separately. The engine rotates/scales those
    # together; replacing dimensions with the upright JPEG would miscalibrate it.
    clean.update({"width": calibration_width if preserve_calibration else width,
                  "height": calibration_height if preserve_calibration else height,
                  "projection": projection})
    if focal_35mm and "focalLength35mm" not in clean:
        clean["focalLength35mm"] = float(focal_35mm)
    return clean


def create_app(*, stitch: Callable = _engine_stitch, probe: Callable = _probe_matcher,
               limits: Limits | None = None, origins: set[str] | None = None,
               hosts: list[str] | None = None) -> FastAPI:
    limits = limits or Limits()
    allowed_origins = origins if origins is not None else DEFAULT_ORIGINS | {
        value.strip().rstrip("/") for value in os.environ.get("STITCH_ALLOWED_ORIGINS", "").split(",") if value.strip()
    }
    allowed_hosts = hosts if hosts is not None else ["localhost", "127.0.0.1", "[::1]"] + [
        value.strip() for value in os.environ.get("STITCH_ALLOWED_HOSTS", "").split(",") if value.strip()
    ]

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        manager = JobManager(stitch, probe, limits)
        application.state.manager = manager
        manager.start()
        try:
            yield
        finally:
            await asyncio.to_thread(manager.close)

    application = FastAPI(title="Bubble local panorama stitcher", lifespan=lifespan, docs_url=None, redoc_url=None)
    application.add_middleware(UploadBoundaryMiddleware, origins=allowed_origins, max_bytes=limits.max_request_bytes)
    application.add_middleware(CORSMiddleware, allow_origins=list(allowed_origins),
                               allow_methods=["GET", "POST", "DELETE", "OPTIONS"], allow_headers=["Content-Type"])
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

    @application.get("/api/stitch/health")
    async def health(request: Request):
        manager = request.app.state.manager
        with manager.condition:
            return dict(manager.health)

    @application.post("/api/stitch/jobs", status_code=202)
    async def create_job(request: Request):
        if "multipart/form-data" not in request.headers.get("content-type", ""):
            raise HTTPException(415, "Upload a capture manifest and its JPEG source photos together.")
        manager = request.app.state.manager
        job = manager.reserve()
        try:
            async with request.form(max_files=limits.max_frames, max_fields=1, max_part_size=limits.max_manifest_bytes) as form:
                if any(key not in {"manifest", "frames"} for key in form):
                    raise HTTPException(400, "Unexpected upload fields.")
                frames, output_width, projection = _validate_manifest(form.get("manifest"), limits)
                uploads = form.getlist("frames")
                if len(uploads) != len(frames) or any(not isinstance(photo, UploadFile) for photo in uploads):
                    raise HTTPException(400, "The source photos do not match the capture manifest.")
                paths, normalized = [], []
                for index, (upload, metadata) in enumerate(zip(uploads, frames)):
                    if upload.size is not None and upload.size > limits.max_frame_bytes:
                        raise HTTPException(413, "Each source photo must be smaller than 12 MB.")
                    path = job.directory / f"frame-{index:03d}.jpg"
                    byte_count = 0
                    with path.open("wb") as output:
                        while chunk := await upload.read(1024 * 1024):
                            byte_count += len(chunk)
                            if byte_count > limits.max_frame_bytes:
                                raise HTTPException(413, "Each source photo must be smaller than 12 MB.")
                            output.write(chunk)
                    normalized.append(await asyncio.to_thread(_inspect_photo, path, metadata, projection, limits))
                    paths.append(path)
            manager.submit(job, normalized, paths, output_width)
            return {"id": job.id}
        except BaseException:
            manager.abandon(job)
            if request.scope.get("stitch_body_limit_exceeded"):
                raise HTTPException(413, "These photos exceed the upload limit.") from None
            raise

    @application.get("/api/stitch/jobs/{job_id}")
    async def job_status(job_id: str, request: Request):
        return request.app.state.manager.snapshot(job_id)

    @application.delete("/api/stitch/jobs/{job_id}")
    async def cancel_job(job_id: str, request: Request):
        return request.app.state.manager.cancel(job_id)

    @application.get("/api/stitch/jobs/{job_id}/panorama")
    async def panorama(job_id: str, request: Request):
        return FileResponse(request.app.state.manager.output(job_id, "panorama"), media_type="image/jpeg",
                            filename="bubble-panorama.jpg", headers={"Cache-Control": "no-store"})

    @application.get("/api/stitch/jobs/{job_id}/thumbnail")
    async def thumbnail(job_id: str, request: Request):
        return FileResponse(request.app.state.manager.output(job_id, "thumbnail"), media_type="image/jpeg",
                            headers={"Cache-Control": "no-store"})

    return application


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("STITCH_HOST", "127.0.0.1"), port=int(os.environ.get("STITCH_PORT", "8787")))
