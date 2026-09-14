"""HTTP lifecycle tests use a small fake engine, not downloaded model weights."""

from dataclasses import replace
from io import BytesIO
import json
from pathlib import Path
import threading
import time
import unittest

from fastapi.testclient import TestClient
import httpx
from PIL import Image

from .server import Limits, create_app


def jpeg_bytes():
    buffer = BytesIO()
    Image.new("RGB", (128, 96), (120, 170, 200)).save(buffer, "JPEG")
    return buffer.getvalue()


def upload(client, count=8, *, manifest=None, image=None, headers=None):
    metadata = manifest or {"version": 1, "projection": "unposed", "outputWidth": 4096,
                            "frames": [{"fileName": f"photo-{index}.jpg"} for index in range(count)]}
    return client.post("/api/stitch/jobs", data={"manifest": json.dumps(metadata)},
                       files=[("frames", (f"photo-{index}.jpg", image or jpeg_bytes(), "image/jpeg")) for index in range(count)],
                       headers=headers)


def completed_engine(frames, paths, output_dir, progress, cancelled, output_width=4096):
    assert len(frames) == len(paths) == 8
    assert frames[0]["width"] == 128
    assert frames[0]["projection"] == "unposed"
    assert all(path.is_file() for path in paths)
    progress("matching", 4, 8)
    panorama = output_dir / "panorama.jpg"
    thumbnail = output_dir / "thumbnail.jpg"
    Image.new("RGB", (256, 128), (100, 120, 150)).save(panorama)
    Image.new("RGB", (128, 64)).save(thumbnail)
    return {"panoramaPath": panorama, "thumbnailPath": thumbnail, "width": 256, "height": 128,
            "report": {"aiUsed": True, "coverage": 0.99}}


class ServerTests(unittest.TestCase):
    def client(self, *, stitch=completed_engine, limits=None, probe=None):
        app = create_app(stitch=stitch,
                         probe=probe or (lambda: {"aiAvailable": True, "device": "cpu", "method": "LightGlue + DISK"}),
                         limits=limits, hosts=["testserver"])
        client = self.enterContext(TestClient(app))
        return client, app.state.manager

    def wait_status(self, client, job_id, status):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            snapshot = client.get(f"/api/stitch/jobs/{job_id}").json()
            if snapshot["status"] == status:
                return snapshot
            time.sleep(0.01)
        self.fail(f"Expected {status}, received {snapshot}")

    def test_upload_real_jpeg_download_and_expiry(self):
        client, manager = self.client()
        response = upload(client)
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["id"]
        snapshot = self.wait_status(client, job_id, "completed")
        self.assertTrue(snapshot["report"]["aiUsed"])
        self.assertNotIn("Path", json.dumps(snapshot))
        self.assertEqual(client.get(f"/api/stitch/jobs/{job_id}/panorama").status_code, 200)
        self.assertEqual(client.get(f"/api/stitch/jobs/{job_id}/thumbnail").headers["content-type"], "image/jpeg")
        self.assertFalse(list(manager.jobs[job_id].directory.glob("frame-*.jpg")))
        manager.jobs[job_id].finished_at -= 3601
        manager.expire()
        self.assertEqual(client.get(f"/api/stitch/jobs/{job_id}").status_code, 404)
        self.assertFalse((manager.root / job_id).exists())

    def test_health_only_claims_ai_when_probe_succeeds(self):
        ready = threading.Event()
        def probe():
            ready.wait(3)
            return {"aiAvailable": True, "device": "cpu", "method": "LightGlue + DISK"}
        client, _ = self.client(probe=probe)
        health = client.get("/api/stitch/health").json()
        self.assertFalse(health["aiAvailable"])
        self.assertTrue(health["loading"])
        ready.set()
        for _ in range(100):
            health = client.get("/api/stitch/health").json()
            if not health["loading"]:
                break
            time.sleep(0.01)
        self.assertTrue(health["aiAvailable"])

    def test_health_recovers_after_transient_model_failure_without_a_job(self):
        probes = []
        def probe():
            probes.append(time.monotonic())
            if len(probes) == 1:
                return {"aiAvailable": False, "device": "cpu", "method": "OpenCV SIFT",
                        "warning": "Model download temporarily unavailable."}
            return {"aiAvailable": True, "device": "cuda", "method": "DISK + LightGlue"}
        client, manager = self.client(probe=probe, limits=replace(Limits(), health_retry_seconds=0.1))
        initial = client.get("/api/stitch/health").json()
        self.assertFalse(initial["aiAvailable"])
        self.assertIn("warning", initial)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            health = client.get("/api/stitch/health").json()
            if health["aiAvailable"]:
                break
            time.sleep(0.01)
        self.assertTrue(health["aiAvailable"])
        self.assertEqual(health["device"], "cuda")
        self.assertEqual(health["model"], "DISK + LightGlue")
        self.assertNotIn("warning", health)
        self.assertEqual(len(probes), 2)
        self.assertGreaterEqual(probes[1] - probes[0], 0.09)
        self.assertEqual(manager.jobs, {})

    def test_queue_bound_cancel_and_private_cleanup(self):
        started = threading.Event()
        release = threading.Event()
        def held_engine(frames, paths, output_dir, progress, cancelled, output_width=4096):
            progress("matching", 2, len(frames))
            started.set()
            release.wait(3)
            if cancelled():
                raise ValueError("Cancelled")
            return completed_engine(frames, paths, output_dir, progress, cancelled, output_width)
        client, manager = self.client(stitch=held_engine)
        first = upload(client).json()["id"]
        self.assertTrue(started.wait(1))
        snapshot = client.get(f"/api/stitch/jobs/{first}").json()
        self.assertEqual((snapshot["phase"], snapshot["completed"], snapshot["total"]), ("matching", 2, 8))
        self.assertEqual(client.get(f"/api/stitch/jobs/{first}/panorama").status_code, 409)
        second = upload(client).json()["id"]
        self.assertEqual(upload(client).status_code, 429)
        self.assertEqual(client.delete(f"/api/stitch/jobs/{second}").json()["status"], "cancelled")
        self.assertFalse(manager.jobs[second].directory.exists())
        self.assertEqual(client.delete(f"/api/stitch/jobs/{first}").json()["status"], "cancelled")
        # A running native operation keeps its own files until it observes cancellation.
        self.assertTrue(manager.jobs[first].directory.exists())
        manager.expire()
        self.assertTrue(manager.jobs[first].directory.exists())
        release.set()
        for _ in range(100):
            if not manager.jobs[first].executing:
                break
            time.sleep(0.01)
        self.assertFalse(manager.jobs[first].directory.exists())
        self.assertEqual(client.get(f"/api/stitch/jobs/{first}").json()["status"], "cancelled")

    def test_failure_keeps_actionable_error_and_removes_source_photos(self):
        def rejected(*args, **kwargs):
            raise ValueError("These photos do not overlap enough. Capture the missing side of the room.")
        client, manager = self.client(stitch=rejected)
        job_id = upload(client).json()["id"]
        snapshot = self.wait_status(client, job_id, "failed")
        self.assertIn("do not overlap", snapshot["error"])
        self.assertEqual(snapshot["errorCode"], "quality_rejected")
        self.assertFalse(manager.jobs[job_id].directory.exists())

    def test_rejects_invalid_upload_and_releases_reservation(self):
        client, manager = self.client()
        self.assertEqual(upload(client, count=7).status_code, 400)
        self.assertEqual(upload(client, image=b"not a photo").status_code, 400)
        mismatch = {"version": 1, "frames": [{}] * 9}
        self.assertEqual(upload(client, manifest=mismatch).status_code, 400)
        wrong_width = {"version": 1, "frames": [{}] * 8, "outputWidth": 100_000}
        self.assertEqual(upload(client, manifest=wrong_width).status_code, 400)
        self.assertEqual(manager.jobs, {})
        self.assertEqual(list(manager.root.iterdir()), [])

    def test_native_rotated_calibration_dimensions_survive_upload(self):
        captured_frames = []
        def inspect_engine(frames, paths, output_dir, progress, cancelled, output_width=4096):
            captured_frames.extend(frames)
            panorama = output_dir / "panorama.jpg"
            thumbnail = output_dir / "thumbnail.jpg"
            Image.new("RGB", (256, 128)).save(panorama)
            Image.new("RGB", (128, 64)).save(thumbnail)
            return {"panoramaPath": panorama, "thumbnailPath": thumbnail,
                    "width": 256, "height": 128, "report": {}}
        client, _ = self.client(stitch=inspect_engine)
        intrinsics = [90, 0, 48, 0, 90, 64, 0, 0, 1]
        manifest = {"version": 1, "frames": [
            {"width": 96, "height": 128, "rotationDegrees": 90, "intrinsics": intrinsics}
            for _ in range(8)
        ]}
        response = upload(client, manifest=manifest)
        self.assertEqual(response.status_code, 202)
        self.wait_status(client, response.json()["id"], "completed")
        self.assertEqual((captured_frames[0]["width"], captured_frames[0]["height"]), (96, 128))
        self.assertEqual(captured_frames[0]["intrinsics"], intrinsics)
        self.assertEqual(captured_frames[0]["rotationDegrees"], 90)

    def test_frame_and_total_upload_limits(self):
        client, manager = self.client(limits=replace(Limits(), max_frame_bytes=100))
        self.assertEqual(upload(client).status_code, 413)
        self.assertEqual(manager.jobs, {})
        limited, limited_manager = self.client(limits=replace(Limits(), max_request_bytes=100))
        self.assertEqual(upload(limited).status_code, 413)
        self.assertEqual(limited_manager.jobs, {})

    def test_streamed_upload_is_bounded_without_content_length(self):
        client, manager = self.client(limits=replace(Limits(), max_request_bytes=400))
        prepared = httpx.Request("POST", "http://testserver/api/stitch/jobs",
                                 data={"manifest": json.dumps({"version": 1, "frames": [{}] * 8})},
                                 files=[("frames", ("source.jpg", jpeg_bytes(), "image/jpeg"))] * 8)
        body = prepared.read()
        response = client.post("/api/stitch/jobs", content=iter([body[:350], body[350:]]),
                               headers={"Content-Type": prepared.headers["content-type"]})
        self.assertEqual(response.status_code, 413)
        self.assertEqual(manager.jobs, {})
        self.assertEqual(list(manager.root.iterdir()), [])

    def test_browser_origins_and_hosts_are_explicit(self):
        client, manager = self.client()
        self.assertEqual(upload(client, headers={"Origin": "https://unrelated.example"}).status_code, 403)
        self.assertEqual(manager.jobs, {})
        allowed = client.get("/api/stitch/health", headers={"Origin": "capacitor://localhost"})
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers["access-control-allow-origin"], "capacitor://localhost")
        self.assertEqual(client.get("/api/stitch/health", headers={"Host": "unrelated.example"}).status_code, 400)

    def test_delete_completed_job_erases_outputs(self):
        client, manager = self.client()
        job_id = upload(client).json()["id"]
        self.wait_status(client, job_id, "completed")
        self.assertEqual(client.delete(f"/api/stitch/jobs/{job_id}").status_code, 200)
        self.assertFalse(manager.jobs[job_id].directory.exists())
        self.assertEqual(client.get(f"/api/stitch/jobs/{job_id}/panorama").status_code, 409)


if __name__ == "__main__":
    unittest.main()
