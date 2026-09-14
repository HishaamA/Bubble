package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;
import org.junit.Test;

public final class PanoramaImageCalibrationTest {
    private static final float[] FOCAL = { 500, 510 }, CENTRE = { 320, 240 };
    private static final int[] RESOLUTION = { 640, 480 };

    @Test public void wholeImageMatchesPreviousPortraitContract() {
        assertArrayEquals(new double[] { 255, 0, 119.5, 0, 250, 160, 0, 0, 1 },
            k(640, 480, 0, 0, 640, 480, 90, 240, 320), 1e-9);
    }

    @Test public void subtractsCropOffsetWithoutChangingFocalLength() {
        assertArrayEquals(new double[] { 500, 0, 240, 0, 510, 210, 0, 0, 1 },
            k(640, 480, 80, 30, 400, 300, 0, 400, 300), 1e-9);
    }

    @Test public void scalesToFullImageBeforeRemovingCropOrigin() {
        assertArrayEquals(new double[] { 1000, 0, 480, 0, 1020, 420, 0, 0, 1 },
            k(1280, 960, 160, 60, 800, 600, 0, 800, 600), 1e-9);
    }

    @Test public void cropThenEachQuarterTurnAndResizePreservesPrincipalPoint() {
        assertArrayEquals(new double[] { 255, 0, 44.5, 0, 250, 120, 0, 0, 1 },
            k(640, 480, 80, 30, 400, 300, 90, 150, 200), 1e-9);
        assertArrayEquals(new double[] { 250, 0, 79.5, 0, 255, 44.5, 0, 0, 1 },
            k(640, 480, 80, 30, 400, 300, 180, 200, 150), 1e-9);
        assertArrayEquals(new double[] { 255, 0, 105, 0, 250, 79.5, 0, 0, 1 },
            k(640, 480, 80, 30, 400, 300, -90, 150, 200), 1e-9);
    }

    @Test public void oddCropOriginAndDimensionsStayExact() {
        double[] result = k(640, 480, 81, 31, 399, 299, 90, 299, 399);
        assertEquals(89, result[2], 0);
        assertEquals(239, result[5], 0);
    }

    @Test public void rejectsInvalidCropRotationAndCalibration() {
        assertThrows(IllegalArgumentException.class, () -> k(640, 480, 500, 0, 400, 300, 0, 400, 300));
        assertThrows(IllegalArgumentException.class, () -> k(640, 480, -1, 0, 400, 300, 0, 400, 300));
        assertThrows(IllegalArgumentException.class, () -> k(640, 480, 0, 0, 400, 300, 45, 400, 300));
        assertThrows(IllegalArgumentException.class, () -> PanoramaImageCalibration.adjustedIntrinsics(
            new float[] { Float.NaN, 510 }, CENTRE, RESOLUTION, 640, 480, 0, 0, 400, 300, 0, 400, 300));
    }

    private static double[] k(int iw, int ih, int x, int y, int w, int h, int rotation, int ow, int oh) {
        return PanoramaImageCalibration.adjustedIntrinsics(FOCAL, CENTRE, RESOLUTION, iw, ih, x, y, w, h, rotation, ow, oh);
    }
}
