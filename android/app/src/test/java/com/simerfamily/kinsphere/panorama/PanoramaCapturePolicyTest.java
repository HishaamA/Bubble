package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;
import org.junit.Test;

public final class PanoramaCapturePolicyTest {
    @Test public void fullHoldNeverClaimsThePhotoHasAlreadyBeenSaved() {
        assertEquals(0.95f, PanoramaCapturePolicy.displayedHoldProgress(1.0f), 0.0f);
        assertEquals(0.95f, PanoramaCapturePolicy.displayedHoldProgress(2.0f), 0.0f);
    }

    @Test public void partialHoldAndInvalidValuesRemainBounded() {
        assertEquals(0.5f, PanoramaCapturePolicy.displayedHoldProgress(0.5f), 0.0f);
        assertEquals(0.0f, PanoramaCapturePolicy.displayedHoldProgress(-1.0f), 0.0f);
        assertEquals(0.0f, PanoramaCapturePolicy.displayedHoldProgress(Float.NaN), 0.0f);
    }
}
