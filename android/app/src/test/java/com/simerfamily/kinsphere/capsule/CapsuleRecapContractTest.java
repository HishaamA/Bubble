package com.simerfamily.kinsphere.capsule;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class CapsuleRecapContractTest {

    @Test
    public void matchesTheCrossPlatformVideoContract() {
        assertEquals(1080, CapsuleRecapContract.WIDTH);
        assertEquals(1920, CapsuleRecapContract.HEIGHT);
        assertEquals(30, CapsuleRecapContract.FRAME_RATE);
        assertEquals(6, CapsuleRecapContract.FRAMES_PER_IMAGE);
        assertEquals(200, CapsuleRecapContract.MILLISECONDS_PER_IMAGE);
        assertEquals(30_000, CapsuleRecapContract.durationMilliseconds(150));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsDurationCountsAboveTheSafetyLimit() {
        CapsuleRecapContract.durationMilliseconds(151);
    }

    @Test
    public void acceptsOnlyBase64ImageDataUrlHeaders() {
        assertTrue(CapsuleRecapContract.hasSupportedImageDataUrlHeader(
            "data:image/jpeg;base64,eA=="
        ));
        assertTrue(CapsuleRecapContract.hasSupportedImageDataUrlHeader(
            "data:image/png;charset=utf-8;base64,eA=="
        ));
        assertFalse(CapsuleRecapContract.hasSupportedImageDataUrlHeader(
            "data:text/plain;base64,eA=="
        ));
        assertFalse(CapsuleRecapContract.hasSupportedImageDataUrlHeader(
            "data:image/jpeg,eA=="
        ));
    }

    @Test
    public void centerCropAlwaysFillsThePortraitFrame() {
        float[] landscape = CapsuleRecapContract.coverDestination(1600, 900);
        assertTrue(landscape[0] < 0f);
        assertEquals(0f, landscape[1], 0.01f);
        assertTrue(landscape[2] > CapsuleRecapContract.WIDTH);
        assertEquals(CapsuleRecapContract.HEIGHT, landscape[3], 0.01f);

        float[] tallPortrait = CapsuleRecapContract.coverDestination(900, 1800);
        assertEquals(0f, tallPortrait[0], 0.01f);
        assertTrue(tallPortrait[1] < 0f);
        assertEquals(CapsuleRecapContract.WIDTH, tallPortrait[2], 0.01f);
        assertTrue(tallPortrait[3] > CapsuleRecapContract.HEIGHT);
    }
}
