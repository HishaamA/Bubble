package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertEquals;

import java.util.List;
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
