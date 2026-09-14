"""Focused tests for the exported matcher's exact upstream stopping boundary."""
import unittest
from types import SimpleNamespace

import torch
from torch import nn

from mobile_adaptive_lightglue import StopConfidence


class AdaptiveStoppingTest(unittest.TestCase):
    def setUp(self):
        self.stop = torch.jit.script(StopConfidence(SimpleNamespace(token=nn.Identity()), .8))

    def test_requires_strictly_more_than_95_percent_confident(self):
        values = torch.cat((torch.ones(95), torch.zeros(5))).reshape(1, 100, 1)
        self.assertFalse(bool(self.stop(values[:, :50], values[:, 50:])))
        values[0, 95, 0] = 1
        self.assertTrue(bool(self.stop(values[:, :50], values[:, 50:])))

    def test_threshold_equality_is_confident(self):
        values = torch.full((1, 8, 1), .8)
        self.assertTrue(bool(self.stop(values, values)))

    def test_counts_tokens_not_equal_weight_per_image(self):
        # A large easy image must not mask the fraction of uncertain tokens by
        # accidentally averaging two per-image confidence fractions.
        confident = torch.ones(1, 100, 1)
        uncertain = torch.zeros(1, 4, 1)
        self.assertTrue(bool(self.stop(confident, uncertain)))
        self.assertFalse(bool(self.stop(confident, torch.zeros(1, 6, 1))))


if __name__ == "__main__":
    unittest.main()
