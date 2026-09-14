"""Offline boundary tests; no weights, network, or GPU inference required."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from services.generation.local_pipeline import exclusive_gpu_lock, health, installation_status, read_job, reference_fovs, write_json
from services.generation.model_config import BASE_FILES, BASE_REVISION, LORA_FILES, LORA_REVISION


class LocalPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def mocked_health(self, memory, *, cuda=True, installed=True):
        def properties(_index):
            if not cuda:
                raise AssertionError("Unavailable CUDA must not initialize a device")
            return SimpleNamespace(total_memory=memory)
        fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: cuda,
            get_device_name=lambda _index: "Mock NVIDIA GPU", get_device_properties=properties))
        with patch.dict(sys.modules, {"torch": fake_torch}), \
             patch("services.generation.local_pipeline.importlib.util.find_spec", return_value=object()), \
             patch("services.generation.local_pipeline.installation_status", return_value=(installed, "Models missing")):
            return health()

    def test_health_rejects_small_gpu_even_with_cuda_and_models(self):
        for memory in (2_000_000_000, 7_999_999_999):
            with self.subTest(memory=memory):
                result = self.mocked_health(memory)
                self.assertFalse(result["ready"])
                self.assertFalse(result["enoughGPU"])
                self.assertTrue(result["cudaAvailable"])
                self.assertEqual(memory, result["gpuMemoryBytes"])
                self.assertIn("at least 8 GB", result["error"])

    def test_health_accepts_decimal_8gb_boundary_and_actual_device_capacity(self):
        for memory in (8_000_000_000, 8_585_216_000):
            with self.subTest(memory=memory):
                result = self.mocked_health(memory)
                self.assertTrue(result["ready"])
                self.assertTrue(result["enoughGPU"])
                self.assertNotIn("error", result)

    def test_health_still_requires_cuda(self):
        result = self.mocked_health(16_000_000_000, cuda=False)
        self.assertFalse(result["ready"])
        self.assertFalse(result["enoughGPU"])
        self.assertIn("CUDA-capable", result["error"])

    def test_health_still_requires_installed_models(self):
        result = self.mocked_health(8_000_000_000, installed=False)
        self.assertFalse(result["ready"])
        self.assertTrue(result["enoughGPU"])
        self.assertEqual("Models missing", result["error"])

    def job(self, **changes):
        data = {"id": "offline-test", "prompt": "A room", "referenceTypes": ["image/jpeg"], "azimuths": [0]}
        data.update(changes)
        write_json(self.root / "job.json", data)
        return data

    def installation(self):
        files = []
        for folder, names in (("base", BASE_FILES), ("lora", LORA_FILES)):
            for name in names:
                path = self.root / folder / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture")
                files.append({"folder": folder, "name": name, "size": 7})
        value = {"baseRevision": BASE_REVISION, "loraRevision": LORA_REVISION, "files": files}
        write_json(self.root / "installation.json", value)
        return value

    def test_reads_exact_server_file_names(self):
        expected = self.job()
        source = self.root / "reference-0"
        source.write_bytes(b"local photo fixture")
        actual, paths = read_job(self.root)
        self.assertEqual(expected, actual)
        self.assertEqual([source], paths)
        self.assertEqual(b"local photo fixture", source.read_bytes())

    def test_optional_image_extension(self):
        self.job(referenceTypes=["image/png"])
        (self.root / "reference-0.png").write_bytes(b"png")
        self.assertEqual("reference-0.png", read_job(self.root)[1][0].name)

    def test_missing_or_empty_reference_rejected(self):
        self.job()
        with self.assertRaisesRegex(ValueError, "reference image"):
            read_job(self.root)
        (self.root / "reference-0").touch()
        with self.assertRaisesRegex(ValueError, "reference image"):
            read_job(self.root)

    def test_untrusted_paths_do_not_override_local_reference(self):
        self.job(filePath="C:/secret.jpg", referencePaths=["../../secret.jpg"])
        with self.assertRaisesRegex(ValueError, "reference image"):
            read_job(self.root)

    def test_invalid_type_or_count_rejected(self):
        for kinds in ([], ["image/jpeg"] * 5, ["image/svg+xml"], [{}], "image/jpeg"):
            with self.subTest(kinds=kinds):
                self.job(referenceTypes=kinds)
                with self.assertRaisesRegex(ValueError, "one to four"):
                    read_job(self.root)

    def test_invalid_json_object_and_prompt_rejected(self):
        for data in ([], None, {"referenceTypes": ["image/jpeg"], "prompt": 4},
                     {"referenceTypes": ["image/jpeg"], "prompt": "x" * 2001}):
            write_json(self.root / "job.json", data)
            with self.assertRaises(ValueError):
                read_job(self.root)

    def test_fov_list_and_legacy_scalar(self):
        self.assertEqual([40.74, 67.0], reference_fovs({"horizontalFovs": [40.74, 67]}, 2))
        self.assertEqual([40.74, 40.74], reference_fovs({"horizontalFovDegrees": 40.74}, 2))
        self.assertEqual([60.0], reference_fovs({}, 1))

    def test_fov_list_takes_precedence_over_legacy_scalar(self):
        self.assertEqual([40.0], reference_fovs({"horizontalFovs": [40], "horizontalFovDegrees": 99}, 1))

    def test_invalid_fov_data_rejected_at_job_boundary(self):
        for value in ([], [40, 60], [True], ["60"], [24.9], [110.1], [10 ** 500], [float("nan")], [float("inf")], None, 60):
            self.job(horizontalFovs=value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                read_job(self.root)

    def test_inference_offline_and_memory_bounded_loader_flags(self):
        for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "HF_DEACTIVATE_ASYNC_LOAD"):
            self.assertEqual("1", os.environ[name])

    def test_gpu_lock_rejects_another_process_then_releases(self):
        path = self.root / "test.lock"
        code = ("from pathlib import Path\n"
                "from services.generation.local_pipeline import exclusive_gpu_lock\n"
                "import sys\n"
                "try:\n"
                "    with exclusive_gpu_lock(Path(sys.argv[1])): print('acquired')\n"
                "except RuntimeError: print('busy')\n")
        def child():
            result = subprocess.run([sys.executable, "-c", code, str(path)], capture_output=True, text=True, timeout=10)
            self.assertEqual(0, result.returncode, result.stderr)
            return result.stdout.strip()
        with exclusive_gpu_lock(path):
            self.assertEqual("busy", child())
        self.assertEqual("acquired", child())

    def test_gpu_lock_releases_after_failure(self):
        path = self.root / "test.lock"
        with self.assertRaisesRegex(ValueError, "fixture"):
            with exclusive_gpu_lock(path):
                raise ValueError("fixture")
        with exclusive_gpu_lock(path):
            pass

    def test_missing_installation_is_not_ready(self):
        self.assertFalse(installation_status(self.root)[0])

    def test_exact_verified_installation_is_ready(self):
        self.installation()
        self.assertEqual((True, None), installation_status(self.root))

    def test_wrong_revision_is_not_ready(self):
        manifest = self.installation()
        manifest["baseRevision"] = "different"
        write_json(self.root / "installation.json", manifest)
        self.assertFalse(installation_status(self.root)[0])

    def test_missing_or_truncated_weight_is_not_ready(self):
        self.installation()
        weight = self.root / "base" / "transformer/diffusion_pytorch_model.safetensors"
        weight.write_bytes(b"short")
        self.assertFalse(installation_status(self.root)[0])
        weight.unlink()
        self.assertFalse(installation_status(self.root)[0])

    def test_unexpected_manifest_path_is_not_ready(self):
        manifest = self.installation()
        manifest["files"][0]["name"] = "../../outside"
        write_json(self.root / "installation.json", manifest)
        self.assertFalse(installation_status(self.root)[0])

    def test_atomic_json_leaves_no_temporary_file(self):
        path = self.root / "progress.json"
        write_json(path, {"stage": "encoding"})
        write_json(path, {"stage": "generating", "completed": 1, "total": 20})
        self.assertEqual("generating", json.loads(path.read_text())["stage"])
        self.assertFalse((self.root / "progress.json.tmp").exists())

    def test_module_cli_exposes_check_alias_without_importing_models(self):
        result = subprocess.run([sys.executable, "-m", "services.generation.local_pipeline", "--help"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("--check", result.stdout)


if __name__ == "__main__":
    unittest.main()
