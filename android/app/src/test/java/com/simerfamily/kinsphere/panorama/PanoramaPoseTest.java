package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

/** Unit coverage for ARCore camera-to-world pose conversion. */
public final class PanoramaPoseTest {

    @Test
    public void usesTheSameForwardAxisAsArKit() {
        float[] cameraLookingRight = {
            0.0f, 0.0f, 1.0f, 0.0f,
            0.0f, 1.0f, 0.0f, 0.0f,
            -1.0f, 0.0f, 0.0f, 0.0f,
            1.25f, -0.5f, 2.0f, 1.0f,
        };

        PanoramaPose pose = PanoramaPose.fromCameraTransform(cameraLookingRight);

        assertEquals(90.0, pose.yawDegrees, 0.0001);
        assertEquals(0.0, pose.pitchDegrees, 0.0001);
        assertEquals(0.0, pose.rollDegrees, 0.0001);
        assertEquals(1.25, pose.position[0], 0.0001);
        assertEquals(-0.5, pose.position[1], 0.0001);
        assertEquals(2.0, pose.position[2], 0.0001);
    }

    @Test
    public void rejectsIncompleteCameraTransforms() {
        assertThrows(
            IllegalArgumentException.class,
            () -> PanoramaPose.fromCameraTransform(new float[15])
        );
    }

    @Test
    public void rejectsNonFiniteCameraTransforms() {
        float[] transform = {
            1.0f, 0.0f, 0.0f, 0.0f,
            0.0f, 1.0f, 0.0f, 0.0f,
            0.0f, 0.0f, Float.NaN, 0.0f,
            0.0f, 0.0f, 0.0f, 1.0f,
        };

        assertThrows(
            IllegalArgumentException.class,
            () -> PanoramaPose.fromCameraTransform(transform)
        );
    }

    @Test
    public void anchorRelativePoseKeepsInitialGravityAndYaw() {
        float[] camera = rigid(0, -35, 0, 2, 3, -4);
        float[] anchor = rigid(0, 0, 0, 2, 3, -4);
        PanoramaPose relative = PanoramaPose.relativeToAnchor(camera, anchor);
        assertEquals(35, relative.yawDegrees, .0001);
        assertArrayEquals(new float[] {0, 0, 0}, relative.position, .0001f);
    }

    @Test
    public void commonWorldRotationAndTranslationDoNotMoveTheCaptureReference() {
        float[] anchor = rigid(0, 0, 0, 2, 3, -4);
        float[] camera = rigid(24, -35, 17, 2.1f, 3.02f, -4.08f);
        float[] expected = PanoramaPose.relativeToAnchor(camera, anchor).transform;
        for (int i = 0; i < 20; i++) {
            float[] correction = rigid(i * 7, -i * 11, i * 3, i * .4f, -i * .3f, i * .2f);
            PanoramaPose corrected = PanoramaPose.relativeToAnchor(
                multiply(correction, camera), multiply(correction, anchor));
            assertArrayEquals(expected, corrected.transform, .00001f);
        }
    }

    @Test
    public void anchorRelativePoseStillMeasuresActualLensTravel() {
        float[] anchor = rigid(14, -35, 7, 2, 3, -4);
        float[] movement = rigid(0, 0, 0, .2f, -.1f, .05f);
        PanoramaPose moved = PanoramaPose.relativeToAnchor(multiply(anchor, movement), anchor);
        assertArrayEquals(new float[] {.2f, -.1f, .05f}, moved.position, .00001f);
    }

    @Test
    public void worldGaugeCorrectionsCannotResetAStationaryHold() {
        PanoramaCaptureGate gate = new PanoramaCaptureGate();
        float[] anchor = rigid(0, 0, 0, 2, 3, -4);
        float[] camera = rigid(0, -35, 0, 2, 3, -4);
        PanoramaCaptureGate.Sample sample = null;
        for (int i = 1; i <= 20; i++) {
            float[] correction = rigid(i * 7, -i * 11, i * 3, i * .4f, -i * .3f, i * .2f);
            PanoramaPose relative = PanoramaPose.relativeToAnchor(
                multiply(correction, camera), multiply(correction, anchor));
            sample = gate.update(relative, i * 50_000_000L, 0, 0, 4.5f, 650, true);
        }
        assertTrue(sample.readyToCapture);
    }

    @Test
    public void rejectsInvalidAnchorInsteadOfFallingBackToRawWorldSpace() {
        float[] camera = rigid(0, 0, 0, 0, 0, 0);
        assertThrows(IllegalArgumentException.class,
            () -> PanoramaPose.relativeToAnchor(camera, new float[15]));
        float[] invalidAnchor = camera.clone();
        invalidAnchor[12] = Float.NaN;
        assertThrows(IllegalArgumentException.class,
            () -> PanoramaPose.relativeToAnchor(camera, invalidAnchor));
    }

    private static float[] rigid(double xDegrees, double yDegrees, double zDegrees,
                                 float x, float y, float z) {
        double rx = Math.toRadians(xDegrees), ry = Math.toRadians(yDegrees), rz = Math.toRadians(zDegrees);
        float sx = (float) Math.sin(rx), cx = (float) Math.cos(rx);
        float sy = (float) Math.sin(ry), cy = (float) Math.cos(ry);
        float sz = (float) Math.sin(rz), cz = (float) Math.cos(rz);
        float[] mx = {1,0,0,0, 0,cx,sx,0, 0,-sx,cx,0, 0,0,0,1};
        float[] my = {cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1};
        float[] mz = {cz,sz,0,0, -sz,cz,0,0, 0,0,1,0, 0,0,0,1};
        float[] result = multiply(mz, multiply(my, mx));
        result[12] = x;
        result[13] = y;
        result[14] = z;
        return result;
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
