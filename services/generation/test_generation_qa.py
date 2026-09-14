import unittest

import numpy as np
from PIL import Image

from services.generation.generation_qa import render_perspective, wrap_statistics


def direction_fixture():
    width, height = 256, 128
    yaw = ((np.arange(width) + .5) / width - .5) * 2 * np.pi
    pitch = (.5 - (np.arange(height) + .5) / height) * np.pi
    x = np.cos(pitch)[:, None] * np.sin(yaw)[None]
    y = np.broadcast_to(np.sin(pitch)[:, None], (height, width))
    z = np.cos(pitch)[:, None] * np.cos(yaw)[None]
    return Image.fromarray(np.rint((np.stack((x, y, z), axis=2) + 1) * 127.5).astype(np.uint8))


class GenerationQaTests(unittest.TestCase):
    def test_cardinal_and_pole_views_decode_correct_direction_colours(self):
        fixture = direction_fixture()
        for yaw, pitch, expected in [(0, 0, (128, 128, 255)), (90, 0, (255, 128, 128)),
                                     (180, 0, (128, 128, 0)), (270, 0, (0, 128, 128)),
                                     (0, 90, (128, 255, 128)), (0, -90, (128, 0, 128))]:
            image = render_perspective(fixture, yaw, pitch, size=65)
            self.assertTrue(np.all(np.abs(np.asarray(image)[32, 32].astype(int) - expected) <= 2))

    def test_back_wrap_sampling_is_periodic_and_source_is_unchanged(self):
        fixture = direction_fixture()
        before = fixture.tobytes()
        positive = render_perspective(fixture, 180, size=64)
        negative = render_perspective(fixture, -180, size=64)
        self.assertTrue(np.array_equal(np.asarray(positive), np.asarray(negative)))
        self.assertEqual(fixture.tobytes(), before)

    def test_descriptive_stats_do_not_claim_that_a_flat_image_is_valid(self):
        uniform = Image.new("RGB", (256, 128), "red")
        stats = wrap_statistics(uniform)
        self.assertEqual(stats["wrapRgbJumpMean"], 0)
        self.assertIsNone(stats["wrapToNearbyJumpRatio"])
        self.assertNotIn("passed", stats)
        broken = np.zeros((128, 256, 3), dtype=np.uint8)
        broken[:, -1] = 255
        self.assertEqual(wrap_statistics(Image.fromarray(broken))["wrapRgbJumpMean"], 255)


if __name__ == "__main__":
    unittest.main()
