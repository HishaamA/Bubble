package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

public final class PanoramaCaptureActivityTest {

    @Test
    public void standardTargetsMatchTheThirtyFourPointSphere() {
        List<PanoramaTarget> targets = PanoramaCaptureActivity.createTargets("standard");

        assertEquals(34, targets.size());
        assertEquals(1, countPitch(targets, 82.0));
        assertEquals(5, countPitch(targets, 55.0));
        assertEquals(7, countPitch(targets, 27.0));
        assertEquals(8, countPitch(targets, 0.0));
        assertEquals(7, countPitch(targets, -27.0));
        assertEquals(5, countPitch(targets, -55.0));
        assertEquals(1, countPitch(targets, -82.0));

        assertEquals(36.0, firstYawAtPitch(targets, 55.0), 0.0001);
        assertEquals(0.0, firstYawAtPitch(targets, 27.0), 0.0001);
        assertEquals(22.5, firstYawAtPitch(targets, 0.0), 0.0001);
        assertEquals(360.0 / 14.0, firstYawAtPitch(targets, -27.0), 0.0001);
        assertEquals(0.0, firstYawAtPitch(targets, -55.0), 0.0001);
    }

    @Test
    public void detailedTargetsContainFortySixUniqueDirections() {
        List<PanoramaTarget> targets = PanoramaCaptureActivity.createTargets("detailed");

        assertEquals(46, targets.size());
        Set<String> directions = new HashSet<>();
        for (PanoramaTarget target : targets) {
            directions.add(target.yawDegrees + ":" + target.pitchDegrees);
        }
        assertEquals(targets.size(), directions.size());
    }

    @Test
    public void portraitRotationAdjustsArCoreImageIntrinsicsLikeIos() {
        double[] intrinsics = PanoramaCaptureActivity.adjustedIntrinsics(
            new float[] { 500.0f, 510.0f },
            new float[] { 320.0f, 240.0f },
            new int[] { 640, 480 },
            640,
            480,
            90,
            240,
            320
        );

        assertEquals(255.0, intrinsics[0], 0.0001);
        assertEquals(119.5, intrinsics[2], 0.0001);
        assertEquals(250.0, intrinsics[4], 0.0001);
        assertEquals(160.0, intrinsics[5], 0.0001);
    }

    @Test
    public void nonFiniteBridgeOptionsFallBackToSafeDefaults() {
        assertEquals(
            0.92,
            PanoramaCaptureActivity.CaptureOptions.finiteClamp(
                Double.NaN,
                0.92,
                0.5,
                1.0
            ),
            0.0
        );
        assertEquals(
            1.0,
            PanoramaCaptureActivity.CaptureOptions.finiteClamp(2.0, 0.92, 0.5, 1.0),
            0.0
        );
        assertEquals(
            0.92,
            PanoramaCaptureActivity.CaptureOptions.finiteClamp(
                Double.POSITIVE_INFINITY,
                0.92,
                0.5,
                1.0
            ),
            0.0
        );
    }

    @Test
    public void rejectsMalformedCameraIntrinsics() {
        assertThrows(
            IllegalArgumentException.class,
            () -> PanoramaCaptureActivity.adjustedIntrinsics(
                new float[] { 500.0f, 510.0f },
                new float[] { 320.0f, 240.0f },
                new int[] { 640, 480 },
                640,
                480,
                45,
                240,
                320
            )
        );
    }

    private static int countPitch(List<PanoramaTarget> targets, double pitch) {
        int count = 0;
        for (PanoramaTarget target : targets) {
            if (Math.abs(target.pitchDegrees - pitch) < 0.0001) {
                count += 1;
            }
        }
        return count;
    }

    private static double firstYawAtPitch(List<PanoramaTarget> targets, double pitch) {
        for (PanoramaTarget target : targets) {
            if (Math.abs(target.pitchDegrees - pitch) < 0.0001) {
                return target.yawDegrees;
            }
        }
        throw new AssertionError("No target found at pitch " + pitch);
    }
}
