package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;
import org.junit.Test;

public final class PanoramaSensorHistoryTest {
    private static final long MS = 1_000_000L;

    @Test public void returnsExactCameraTimestampNotLatestSensorTimestamp() {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        history.addRotation(rotation(35, 1, 2, 3), 1_000 * MS);
        history.addRotation(rotation(45, 1, 2, 3), 1_020 * MS);
        PanoramaSensorHistory.Sample sample = history.at(1_012 * MS);
        assertNotNull(sample);
        assertEquals(1_012 * MS, sample.timestampNanos);
        assertRotationEquals(rotation(41, 1, 2, 3), sample.pose);
    }

    @Test public void interpolatesAcrossQuaternionSignBoundaryByShortestArc() {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        history.addRotation(rotation(239, 1, 1, 1), 1_000 * MS);
        history.addRotation(rotation(259, 1, 1, 1), 1_040 * MS);
        assertRotationEquals(rotation(249, 1, 1, 1), history.at(1_020 * MS).pose);
    }

    @Test public void wrapAroundDoesNotSpinThroughIdentity() {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        history.addRotation(rotation(175, 0, 1, 0), 1_000 * MS);
        history.addRotation(rotation(-175, 0, 1, 0), 1_040 * MS);
        assertRotationEquals(rotation(180, 0, 1, 0), history.at(1_020 * MS).pose);
    }

    @Test public void refusesStaleOrUnboundedInterpolationButAllowsNearNeighbour() {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        history.addRotation(rotation(30, 1, 1, 0), 1_000 * MS);
        history.addRotation(rotation(32, 1, 1, 0), 1_100 * MS);
        assertNull(history.at(1_050 * MS));
        assertNull(history.at(1_126 * MS));
        assertNull(history.at(974 * MS));
        assertNotNull(history.at(1_125 * MS));
        assertNotNull(history.at(975 * MS));
        assertNotNull(history.at(1_010 * MS));
    }

    @Test public void guidancePoseDoesNotPretendMissingAccelerationIsStationary() {
        PanoramaSensorHistory history = stillHistory(1_000);
        assertNotNull(history.at(1_000 * MS));
        assertFalse(history.at(1_000 * MS).motionQuiet);
        history.addAcceleration(0, 1_000 * MS);
        assertFalse(history.at(1_000 * MS).motionQuiet);
    }

    @Test public void quietNeedsFreshCoveredAccelerationWindow() {
        PanoramaSensorHistory history = stillHistory(1_000);
        quietAcceleration(history, 750, 1_000);
        assertTrue(history.at(1_000 * MS).motionQuiet);
    }

    @Test public void earlierMovementCannotBeHiddenByLastQuietReading() {
        PanoramaSensorHistory history = stillHistory(1_000);
        history.addAcceleration(0, 750 * MS);
        history.addAcceleration(1.2f, 850 * MS);
        history.addAcceleration(0, 950 * MS);
        history.addAcceleration(0, 1_000 * MS);
        assertFalse(history.at(1_000 * MS).motionQuiet);
    }

    @Test public void staleAccelerationAndMissingSamplesPreventCapture() {
        PanoramaSensorHistory history = stillHistory(1_000);
        quietAcceleration(history, 750, 800);
        assertFalse(history.at(1_000 * MS).motionQuiet);
        history.addAcceleration(0, 1_000 * MS);
        assertFalse(history.at(1_000 * MS).motionQuiet);
    }

    @Test public void futureAccelerationCannotCertifyEarlierCameraFrame() {
        PanoramaSensorHistory history = stillHistory(1_000);
        quietAcceleration(history, 1_010, 1_200);
        assertFalse(history.at(1_000 * MS).motionQuiet);
    }

    @Test public void gapsAndImpossibleRotationJumpsInvalidateCalibrationGeneration() {
        PanoramaSensorHistory history = stillHistory(1_000);
        long original = history.generation();
        history.addRotation(rotation(30, 0, 1, 0), 1_300 * MS);
        assertTrue(history.generation() > original);
        assertNull(history.at(1_000 * MS));
        long afterGap = history.generation();
        history.addRotation(rotation(160, 0, 1, 0), 1_310 * MS);
        assertTrue(history.generation() > afterGap);
        assertNull(history.at(1_000 * MS));
    }

    @Test public void resetAndMalformedSamplesRemoveEveryStalePose() {
        PanoramaSensorHistory history = stillHistory(1_000);
        assertFalse(history.addAcceleration(Float.NaN, 1_000 * MS));
        assertNull(history.at(1_000 * MS));
        history.addRotation(rotation(40, 1, 0, 0), 2_000 * MS);
        float[] bad = rotation(40, 1, 0, 0).transform.clone();
        bad[0] = 5;
        assertFalse(history.addRotation(PanoramaPose.fromCameraTransform(bad), 2_010 * MS));
        assertNull(history.at(2_000 * MS));
    }

    @Test public void posesAreDefensiveAndDoNotInventTranslation() {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        PanoramaPose pose = rotation(35, 1, 2, 3);
        pose.transform[12] = 7;
        history.addRotation(pose, 1_000 * MS);
        pose.transform[0] = 100;
        PanoramaSensorHistory.Sample sample = history.at(1_000 * MS);
        assertRotationEquals(rotation(35, 1, 2, 3), sample.pose);
        assertArrayEquals(new float[] {0, 0, 0}, sample.pose.position, 0);
        sample.pose.transform[0] = 100;
        assertRotationEquals(rotation(35, 1, 2, 3), history.at(1_000 * MS).pose);
    }

    @Test public void longRunningHistoryIsBoundedAndClearDoesNotLeakOldSession() {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        for (int i = 1; i < 1_000; i++) history.addRotation(rotation(32, 1, 1, 0), i * 10 * MS);
        assertNull(history.at(7_000 * MS));
        assertNotNull(history.at(9_990 * MS));
        long generation = history.generation();
        history.clear();
        assertTrue(history.generation() > generation);
        assertNull(history.at(9_990 * MS));
    }

    private static PanoramaSensorHistory stillHistory(long timeMs) {
        PanoramaSensorHistory history = new PanoramaSensorHistory();
        history.addRotation(rotation(35, 1, 2, 3), timeMs * MS);
        return history;
    }

    private static void quietAcceleration(PanoramaSensorHistory history, long startMs, long endMs) {
        for (long time = startMs; time <= endMs; time += 50) history.addAcceleration(.1f, time * MS);
    }

    private static void assertRotationEquals(PanoramaPose expected, PanoramaPose actual) {
        assertArrayEquals(expected.rotation, actual.rotation, .00001f);
    }

    private static PanoramaPose rotation(double degrees, double x, double y, double z) {
        double length = Math.sqrt(x*x + y*y + z*z);
        x /= length; y /= length; z /= length;
        double radians = Math.toRadians(degrees), c = Math.cos(radians), s = Math.sin(radians), t = 1-c;
        return PanoramaPose.fromCameraTransform(new float[] {
            (float)(t*x*x+c), (float)(t*x*y+s*z), (float)(t*x*z-s*y), 0,
            (float)(t*x*y-s*z), (float)(t*y*y+c), (float)(t*y*z+s*x), 0,
            (float)(t*x*z+s*y), (float)(t*y*z-s*x), (float)(t*z*z+c), 0,
            0, 0, 0, 1,
        });
    }
}
