package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

/** Regression coverage for detail-free walls/ceilings without inventing AR translation. */
public final class PanoramaRotationBridgeTest {
    private static final long START = 1_000_000_000L;
    private static final long SECOND = 1_000_000_000L;
    private static final float EPSILON = 0.00001f;

    @Test
    public void uncalibratedBridgeNeverProducesCaptureOrGuidance() {
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        assertNull(bridge.estimate(pose(identity()), START));
        assertNull(bridge.guidance(pose(identity()), START));
        assertNull(bridge.referenceCameraPose());
        assertEquals(Long.MAX_VALUE, bridge.ageNanos(START));
    }

    @Test
    public void nonIdentityCameraExtrinsicsAndGameHeadingProduceTheCorrectCameraRotation() {
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        float[] captureFromGame = rigid(23, -72, 17, 0, 0, 0);
        float[] gameFromSensor = rigid(-18, 43, 29, 0, 0, 0);
        float[] sensorFromCamera = rigid(180, 0, 90, 0, 0, 0);
        float[] sensorInCapture = multiply(captureFromGame, gameFromSensor);
        float[] cameraInCapture = withPosition(multiply(sensorInCapture, sensorFromCamera), 1, 2, 3);
        bridge.calibrate(pose(cameraInCapture), pose(sensorInCapture), pose(gameFromSensor), START);

        float[] changedSensor = rigid(58, 102, -21, 19, 20, 21);
        float[] expected = withPosition(
            multiply(multiply(captureFromGame, changedSensor), sensorFromCamera), 1, 2, 3);

        assertPoseEquals(expected, bridge.estimate(pose(changedSensor), START + SECOND));
    }

    @Test
    public void matrixRotationPassesThroughCeilingAndBeyondWithoutEulerSingularity() {
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        float[] extrinsic = rigid(0, 0, 90, 0, 0, 0);
        float[] gameReference = rigid(0, 31, 0, 0, 0, 0);
        bridge.calibrate(pose(extrinsic), pose(identity()), pose(gameReference), START);
        float[] gameFromCapture = gameReference;

        int[] pitchAngles = {0, 45, 89, 90, 91, 120, 179, 180, 220, 270, 359};
        for (int index = 0; index < pitchAngles.length; index++) {
            float[] cameraMotion = rigid(pitchAngles[index], 54, -36, 0, 0, 0);
            float[] sensor = multiply(gameFromCapture, cameraMotion);
            assertPoseEquals(multiply(cameraMotion, extrinsic),
                bridge.estimate(pose(sensor), START + index * 50_000_000L));
        }
    }

    @Test
    public void gameFrameGaugeChangeDoesNotChangeOutputAfterRecalibration() {
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        float[] game = rigid(24, 15, -8, 0, 0, 0);
        float[] captureFromGame = rigid(-16, 52, 37, 0, 0, 0);
        float[] extrinsic = rigid(180, 0, -90, 0, 0, 0);
        float[] sensor = multiply(captureFromGame, game);
        float[] camera = withPosition(multiply(sensor, extrinsic), 4, 5, 6);
        float[] nextGame = rigid(67, 71, 44, 0, 0, 0);
        bridge.calibrate(pose(camera), pose(sensor), pose(game), START);
        PanoramaPose expected = bridge.estimate(pose(nextGame), START + SECOND);

        float[] gameCorrection = rigid(-31, 119, 63, 0, 0, 0);
        bridge.calibrate(pose(camera), pose(sensor), pose(multiply(gameCorrection, game)), START + 2 * SECOND);
        assertPoseEquals(expected.transform,
            bridge.estimate(pose(multiply(gameCorrection, nextGame)), START + 3 * SECOND));
    }

    @Test
    public void reliableRecalibrationUpdatesCaptureSpaceWithoutCarryingOldTranslation() {
        PanoramaRotationBridge bridge = calibrated();
        float[] correctedSensor = rigid(16, 51, -20, 0, 0, 0);
        float[] extrinsic = rigid(180, 0, 90, 0, 0, 0);
        float[] correctedCamera = withPosition(multiply(correctedSensor, extrinsic), -2, 3, 4);
        float[] game = rigid(28, 11, 61, 0, 0, 0);
        bridge.calibrate(pose(correctedCamera), pose(correctedSensor), pose(game), START + SECOND);
        assertPoseEquals(correctedCamera, bridge.estimate(pose(game), START + SECOND));
        assertPoseEquals(correctedCamera, bridge.referenceCameraPose());
        assertEquals(0, bridge.ageNanos(START + SECOND));
    }

    @Test
    public void freezesTranslationWhileSensorRotationChanges() {
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        bridge.calibrate(pose(rigid(0, 0, 0, 1.25f, -0.5f, 3)),
            pose(rigid(0, 0, 0, 44, 55, 66)), pose(identity()), START);
        PanoramaPose result = bridge.estimate(pose(rigid(120, 80, 15, 700, -900, 2)), START + SECOND);
        assertArrayEquals(new float[] {1.25f, -0.5f, 3}, result.position, EPSILON);
    }

    @Test
    public void captureExpiresAfterThirtySecondsButGuidanceLastsNinety() {
        PanoramaRotationBridge bridge = calibrated();
        assertNotNull(bridge.estimate(pose(identity()), START + 30 * SECOND));
        assertNull(bridge.estimate(pose(identity()), START + 30 * SECOND + 1));
        assertNotNull(bridge.guidance(pose(identity()), START + 30 * SECOND + 1));
        assertNotNull(bridge.guidance(pose(identity()), START + 90 * SECOND));
        assertNull(bridge.guidance(pose(identity()), START + 90 * SECOND + 1));
    }

    @Test
    public void rejectsInvalidOlderAndOutOfOrderQueryTimestampsButAllowsSameFrameReads() {
        PanoramaRotationBridge bridge = calibrated();
        assertNull(bridge.estimate(pose(identity()), -1));
        assertNull(bridge.estimate(pose(identity()), 0));
        assertNull(bridge.estimate(pose(identity()), START - 1));
        assertNotNull(bridge.estimate(pose(identity()), START + SECOND));
        assertNotNull(bridge.guidance(pose(identity()), START + SECOND));
        assertNotNull(bridge.estimate(pose(identity()), START + SECOND));
        assertNull(bridge.estimate(pose(identity()), START + SECOND - 1));
        assertNull(bridge.guidance(pose(identity()), START + SECOND - 1));
        assertEquals(Long.MAX_VALUE, bridge.ageNanos(0));
        assertEquals(Long.MAX_VALUE, bridge.ageNanos(START - 1));
        assertEquals(SECOND, bridge.ageNanos(START + SECOND));
    }

    @Test
    public void repeatedCalibrationTimestampIsANoOpNotAFreshnessExtension() {
        PanoramaRotationBridge bridge = calibrated();
        bridge.calibrate(pose(rigid(45, 90, 23, 1, 2, 3)), pose(identity()), pose(identity()), START);
        assertPoseEquals(identity(), bridge.estimate(pose(identity()), START + SECOND));
        bridge.calibrate(pose(rigid(45, 90, 23, 1, 2, 3)), pose(identity()), pose(identity()), START);
        assertPoseEquals(identity(), bridge.estimate(pose(identity()), START + SECOND));
        assertNull(bridge.estimate(pose(identity()), START + 30 * SECOND + 1));
    }

    @Test
    public void invalidCalibrationDoesNotReplaceReliableCalibration() {
        PanoramaRotationBridge bridge = calibrated();
        assertThrows(IllegalArgumentException.class,
            () -> bridge.calibrate(pose(identity()), pose(identity()), pose(identity()), 0));
        assertThrows(IllegalArgumentException.class,
            () -> bridge.calibrate(pose(identity()), pose(identity()), pose(identity()), START - 1));
        assertThrows(IllegalArgumentException.class,
            () -> bridge.calibrate(null, pose(identity()), pose(identity()), START + SECOND));
        assertPoseEquals(identity(), bridge.estimate(pose(identity()), START + SECOND));
        assertThrows(IllegalArgumentException.class,
            () -> bridge.calibrate(pose(identity()), pose(identity()), pose(identity()), START + SECOND - 1));
        assertEquals(SECOND, bridge.ageNanos(START + SECOND));
    }

    @Test
    public void rejectsScaleShearReflectionPerspectiveAndMutatedNonFiniteMatrices() {
        float[][] malformed = new float[5][];
        for (int index = 0; index < malformed.length; index++) malformed[index] = identity();
        malformed[0][0] = 2;
        malformed[1][4] = 0.3f;
        malformed[2][0] = -1;
        malformed[3][3] = 0.5f;
        malformed[4][15] = 2;
        for (float[] matrix : malformed) {
            PanoramaRotationBridge bridge = calibrated();
            PanoramaPose invalid = pose(matrix);
            assertNull(bridge.estimate(invalid, START + SECOND));
            assertNull(bridge.guidance(invalid, START + SECOND));
            assertThrows(IllegalArgumentException.class,
                () -> bridge.calibrate(pose(identity()), invalid, pose(identity()), START + SECOND));
            assertThrows(IllegalArgumentException.class,
                () -> bridge.calibrate(invalid, pose(identity()), pose(identity()), START + SECOND));
            assertThrows(IllegalArgumentException.class,
                () -> bridge.calibrate(pose(identity()), pose(identity()), invalid, START + SECOND));
            assertPoseEquals(identity(), bridge.estimate(pose(identity()), START + SECOND));
        }
        PanoramaRotationBridge bridge = calibrated();
        PanoramaPose nonFinite = pose(identity());
        nonFinite.transform[6] = Float.NaN;
        assertNull(bridge.estimate(nonFinite, START + SECOND));
        assertThrows(IllegalArgumentException.class,
            () -> bridge.calibrate(nonFinite, pose(identity()), pose(identity()), START + SECOND));
        assertNull(bridge.estimate(null, START + SECOND));
    }

    @Test
    public void calibrationAndReturnedPosesAreDetachedFromCallerArrays() {
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        PanoramaPose camera = pose(rigid(0, 0, 0, 1, 2, 3));
        PanoramaPose sensor = pose(identity());
        PanoramaPose game = pose(identity());
        float[] cameraBefore = camera.transform.clone();
        float[] sensorBefore = sensor.transform.clone();
        float[] gameBefore = game.transform.clone();
        bridge.calibrate(camera, sensor, game, START);
        assertArrayEquals(cameraBefore, camera.transform, 0);
        assertArrayEquals(sensorBefore, sensor.transform, 0);
        assertArrayEquals(gameBefore, game.transform, 0);
        camera.transform[12] = 99;
        sensor.transform[0] = 7;
        game.transform[0] = 7;
        PanoramaPose reference = bridge.referenceCameraPose();
        reference.transform[12] = 77;
        reference.position[1] = 99;
        PanoramaPose estimate = bridge.estimate(pose(identity()), START + SECOND);
        estimate.transform[12] = 88;
        estimate.rotation[0] = 7;
        assertPoseEquals(cameraBefore, bridge.referenceCameraPose());
        assertPoseEquals(cameraBefore, bridge.estimate(pose(identity()), START + SECOND));
    }

    @Test
    public void resetInvalidatesAllEstimatesAndAllowsANewClockEpoch() {
        PanoramaRotationBridge bridge = calibrated();
        bridge.estimate(pose(identity()), START + SECOND);
        bridge.reset();
        assertNull(bridge.estimate(pose(identity()), START + SECOND));
        assertNull(bridge.guidance(pose(identity()), START + SECOND));
        assertNull(bridge.referenceCameraPose());
        assertEquals(Long.MAX_VALUE, bridge.ageNanos(START + SECOND));
        bridge.calibrate(pose(identity()), pose(identity()), pose(identity()), 1);
        assertPoseEquals(identity(), bridge.estimate(pose(identity()), 1));
    }

    private static PanoramaRotationBridge calibrated() {
        PanoramaRotationBridge bridge = new PanoramaRotationBridge();
        bridge.calibrate(pose(identity()), pose(identity()), pose(identity()), START);
        return bridge;
    }

    private static PanoramaPose pose(float[] transform) {
        return PanoramaPose.fromCameraTransform(transform);
    }

    private static void assertPoseEquals(float[] expected, PanoramaPose actual) {
        assertNotNull(actual);
        assertArrayEquals(expected, actual.transform, EPSILON);
    }

    private static float[] identity() {
        return new float[] {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    }

    private static float[] withPosition(float[] transform, float x, float y, float z) {
        float[] copy = transform.clone();
        copy[12] = x;
        copy[13] = y;
        copy[14] = z;
        return copy;
    }

    private static float[] rigid(double xDegrees, double yDegrees, double zDegrees,
                                 float x, float y, float z) {
        double rx = Math.toRadians(xDegrees), ry = Math.toRadians(yDegrees), rz = Math.toRadians(zDegrees);
        float sx = (float) Math.sin(rx), cx = (float) Math.cos(rx);
        float sy = (float) Math.sin(ry), cy = (float) Math.cos(ry);
        float sz = (float) Math.sin(rz), cz = (float) Math.cos(rz);
        float[] mx = {1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1};
        float[] my = {cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1};
        float[] mz = {cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        return withPosition(multiply(mz, multiply(my, mx)), x, y, z);
    }

    private static float[] multiply(float[] first, float[] second) {
        float[] result = new float[16];
        for (int column = 0; column < 4; column++) {
            for (int row = 0; row < 4; row++) {
                for (int k = 0; k < 4; k++) result[column * 4 + row] += first[k * 4 + row] * second[column * 4 + k];
            }
        }
        return result;
    }
}
