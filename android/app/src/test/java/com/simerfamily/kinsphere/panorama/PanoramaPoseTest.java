package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertEquals;
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
}
