"""Deterministic checks for model-host and accelerator failure recovery."""

import os
import sys
import types
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from . import matcher


class WarmupTests(unittest.TestCase):
    def run_warmup(self, disk, *, cuda=False):
        torch = types.SimpleNamespace(set_num_threads=Mock(),
                                      cuda=types.SimpleNamespace(is_available=lambda: cuda,
                                                                 empty_cache=Mock()))
        lightglue = types.SimpleNamespace(DISK=disk, LightGlue=Mock(return_value=self.model()))
        return patch.dict(sys.modules, {"torch": torch, "lightglue": lightglue})

    @staticmethod
    def model():
        model = Mock()
        model.eval.return_value = model
        model.to.return_value = model
        model.cpu.return_value = model
        return model

    def setUp(self):
        self.state = patch.multiple(matcher, _models=None, _model_error=None,
                                    _model_warning=None, _retry_after=0.0)
        self.state.start()
        self.environment = patch.dict(os.environ, {"STITCHER_MATCHER": ""})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.state.stop()

    def test_transient_model_host_failures_are_retried_then_cached(self):
        unavailable = HTTPError("https://example.invalid/weights", 503, "Unavailable", {}, None)
        disk = Mock(side_effect=[unavailable, unavailable, self.model()])
        with self.run_warmup(disk), patch.object(matcher.time, "sleep") as sleep:
            result = matcher.warmup_matcher()
            self.assertTrue(result["aiAvailable"])
            self.assertEqual(disk.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])
            self.assertTrue(matcher.warmup_matcher()["aiAvailable"])
            self.assertEqual(disk.call_count, 3)

    def test_failed_download_can_recover_after_cooldown(self):
        unavailable = HTTPError("https://example.invalid/weights", 503, "Unavailable", {}, None)
        disk = Mock(side_effect=unavailable)
        with self.run_warmup(disk), patch.object(matcher.time, "sleep"), patch.object(matcher.time, "monotonic", return_value=100):
            self.assertFalse(matcher.warmup_matcher()["aiAvailable"])
            self.assertEqual(matcher.warmup_matcher()["retryAfterSeconds"], 30)
            self.assertEqual(disk.call_count, 3)
            disk.side_effect = None
            disk.return_value = self.model()
            with patch.object(matcher.time, "monotonic", return_value=131):
                self.assertTrue(matcher.warmup_matcher()["aiAvailable"])

    def test_gpu_allocation_failure_keeps_cpu_learned_models(self):
        model = self.model()
        model.to.side_effect = RuntimeError("GPU unavailable")
        with self.run_warmup(Mock(return_value=model), cuda=True):
            result = matcher.warmup_matcher()
            self.assertTrue(result["aiAvailable"])
            self.assertEqual(result["device"], "cpu")
            self.assertIn("CPU", result["warning"])
            model.cpu.assert_called_once()


if __name__ == "__main__":
    unittest.main()
