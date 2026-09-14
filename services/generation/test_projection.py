import math
import unittest

import numpy as np
from PIL import Image

from services.generation.projection import GREEN, make_erp_control

WIDTH, HEIGHT = 1024, 512


def pixel(canvas, yaw, pitch=0):
    x = int(((yaw / 360 + .5) % 1) * WIDTH)
    y = min(HEIGHT - 1, max(0, int((.5 - pitch / 180) * HEIGHT)))
    return tuple(np.asarray(canvas)[y, x])


class ProjectionTests(unittest.TestCase):
    def project(self, images, azimuths=None, **options):
        return make_erp_control(images, azimuths, width=WIDTH, height=HEIGHT, **options)

    def test_cardinal_centres_have_distinct_source_owners(self):
        colours = [(250, 0, 0), (0, 0, 250), (250, 250, 0), (250, 0, 250)]
        result = self.project([Image.new("RGB", (160, 100), colour) for colour in colours])
        for yaw, colour in zip((0, 90, 180, 270), colours):
            self.assertEqual(pixel(result, yaw), colour)
        self.assertEqual(result.size, (WIDTH, HEIGHT))
        self.assertEqual(result.mode, "RGB")

    def test_reference_right_and_up_remain_right_and_up(self):
        source = np.zeros((100, 200, 3), dtype=np.uint8)
        source[:50, :100] = (255, 0, 0)
        source[:50, 100:] = (0, 0, 255)
        source[50:, :100] = (255, 255, 0)
        source[50:, 100:] = (255, 0, 255)
        result = self.project([Image.fromarray(source)])
        for yaw, pitch, colour in [(-10, 5, (255, 0, 0)), (10, 5, (0, 0, 255)),
                                   (-10, -5, (255, 255, 0)), (10, -5, (255, 0, 255))]:
            self.assertEqual(pixel(result, yaw, pitch), colour)

    def test_back_view_wraps_without_leaking_onto_front(self):
        source = np.empty((100, 200, 3), dtype=np.uint8)
        source[:, :100], source[:, 100:] = (255, 0, 0), (0, 0, 255)
        result = self.project([Image.fromarray(source)], [180])
        self.assertEqual(pixel(result, 170), (255, 0, 0))
        self.assertEqual(pixel(result, -170), (0, 0, 255))
        self.assertEqual(pixel(result, 0), GREEN)
        self.assertNotEqual(pixel(result, 179.8), GREEN)
        self.assertNotEqual(pixel(result, -179.8), GREEN)

    def test_unobserved_directions_and_poles_stay_green(self):
        result = self.project([Image.new("RGB", (100, 100), "red")])
        for yaw, pitch in [(31, 0), (-31, 0), (90, 0), (180, 0), (0, 31), (0, -31), (0, 89), (0, -89)]:
            self.assertEqual(pixel(result, yaw, pitch), GREEN)
        self.assertEqual(pixel(result, 29, 0), (255, 0, 0))

    def test_aspect_ratio_changes_vertical_fov_not_horizontal_or_source_crop(self):
        portrait = self.project([Image.new("RGB", (100, 200), "red")])
        landscape = self.project([Image.new("RGB", (200, 100), "red")])
        # vfov=2 atan((height/width)*tan(hfov/2)): 98.21 vs32.20 degrees.
        for result in (portrait, landscape):
            self.assertEqual(pixel(result, 29, 0), (255, 0, 0))
            self.assertEqual(pixel(result, 31, 0), GREEN)
        self.assertEqual(pixel(portrait, 0, 40), (255, 0, 0))
        self.assertEqual(pixel(landscape, 0, 40), GREEN)
        self.assertEqual(pixel(landscape, 0, 15), (255, 0, 0))
        self.assertEqual(pixel(landscape, 0, 18), GREEN)

    def test_overlaps_choose_one_image_never_blend_sources(self):
        result = self.project([Image.new("RGB", (100, 100), "red"), Image.new("RGB", (100, 100), "blue")], [0, 20])
        self.assertEqual(pixel(result, 5), (255, 0, 0))
        self.assertEqual(pixel(result, 15), (0, 0, 255))
        colours = np.unique(np.asarray(result).reshape(-1, 3), axis=0)
        self.assertEqual({tuple(x) for x in colours}, {GREEN, (255, 0, 0), (0, 0, 255)})

    def test_per_photo_fovs_preserve_input_order_and_different_footprints(self):
        red, blue = Image.new("RGB", (100, 200), "red"), Image.new("RGB", (200, 100), "blue")
        result = self.project([red, blue], [0, 90], horizontal_fov_degrees=[40.6, 66.6])
        self.assertEqual(pixel(result, 19), (255, 0, 0))
        self.assertEqual(pixel(result, 22), GREEN)
        self.assertEqual(pixel(result, 120), (0, 0, 255))
        self.assertEqual(pixel(result, 125), GREEN)
        # Portrait and landscape still derive their own vertical fields of view.
        self.assertEqual(pixel(result, 0, 30), (255, 0, 0))
        self.assertEqual(pixel(result, 90, 30), GREEN)

    def test_scalar_and_repeated_sequence_are_pixel_identical(self):
        photos = [Image.new("RGB", (100, 150), "red"), Image.new("RGB", (150, 100), "blue")]
        scalar = self.project(photos, [0, 180], horizontal_fov_degrees=40.74)
        sequence = self.project(photos, [0, 180], horizontal_fov_degrees=(40.74, 40.74))
        np.testing.assert_array_equal(np.asarray(scalar), np.asarray(sequence))

    def test_per_photo_fovs_keep_wrapping_and_single_owner_overlap(self):
        photos = [Image.new("RGB", (100, 100), "red"), Image.new("RGB", (100, 100), "blue")]
        result = self.project(photos, [170, 190], horizontal_fov_degrees=[40, 80])
        self.assertEqual(pixel(result, 175), (255, 0, 0))
        self.assertEqual(pixel(result, -175), (0, 0, 255))
        self.assertEqual(pixel(result, 0), GREEN)
        colours = np.unique(np.asarray(result).reshape(-1, 3), axis=0)
        self.assertEqual({tuple(x) for x in colours}, {GREEN, (255, 0, 0), (0, 0, 255)})

    def test_rejects_mismatched_or_invalid_per_photo_fovs(self):
        photos = [Image.new("RGB", (10, 10))] * 2
        for fovs in ([], [40], [40, 50, 60], [40, 0], [40, 121], [40, math.nan],
                     [40, math.inf], [40, True], [40, "60"], [40, None]):
            with self.subTest(fovs=fovs), self.assertRaises(ValueError):
                self.project(photos, horizontal_fov_degrees=fovs)

    def test_exif_rotation_and_projection_leave_original_unchanged(self):
        original = Image.new("RGB", (160, 80), "red")
        original.getexif()[274] = 6
        before = original.tobytes()
        result = self.project([original])
        self.assertEqual(pixel(result, 0, 40), (255, 0, 0))
        self.assertEqual(original.size, (160, 80))
        self.assertEqual(original.getexif()[274], 6)
        self.assertEqual(original.tobytes(), before)

    def test_transparent_unknown_pixels_remain_green(self):
        result = self.project([Image.new("RGBA", (100, 100), (255, 0, 0, 0))])
        self.assertTrue(np.all(np.asarray(result) == GREEN))

    def test_explicit_pitch_moves_reference_centre_upward(self):
        result = self.project([Image.new("RGB", (200, 100), "red")], pitch_degrees=40)
        self.assertEqual(pixel(result, 0, 40), (255, 0, 0))
        self.assertEqual(pixel(result, 0, 0), GREEN)

    def test_rejects_duplicate_directions_invalid_sizes_and_parameters(self):
        photo = Image.new("RGB", (10, 10))
        for references, angles in [([], None), ([photo] * 5, None), ([photo, photo], [0, 360]),
                                    ([photo, photo], [-90, 270]), ([photo], []), ([photo], [math.nan])]:
            with self.assertRaises(ValueError):
                self.project(references, angles)
        for options in [dict(width=1024, height=500), dict(width=8192, height=4096), dict(width=True, height=512)]:
            with self.assertRaises(ValueError):
                make_erp_control([photo], **options)
        for options in [dict(horizontal_fov_degrees=0), dict(horizontal_fov_degrees=180), dict(pitch_degrees=91)]:
            with self.assertRaises(ValueError):
                self.project([photo], **options)


if __name__ == "__main__":
    unittest.main()
