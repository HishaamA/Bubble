package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;
import org.junit.Test;

public final class PanoramaCameraClockTest {
    private static final long BASE = 10_000_000_000L;
    private static final long STEP = 33_333_333L;
    private static final long IMAGE_OFFSET = 31_346_842L;
    private final PanoramaCameraClock clock = new PanoramaCameraClock();

    @Test public void currentCpuImageIsAcceptedDespiteAndroidClockOffset() {
        long androidCamera = 835_848_723_658_144L;
        long arFrame = androidCamera + 31_346_842L;
        assertTrue(PanoramaCameraClock.matchesArFrame(arFrame, arFrame));
        assertFalse(PanoramaCameraClock.matchesArFrame(arFrame, androidCamera));
    }
    @Test public void previousFrameCannotPretendToMatchThroughAnotherClock() {
        long arFrame = 1_000_000_000L;
        assertFalse(PanoramaCameraClock.matchesArFrame(arFrame - 33_333_333L, arFrame));
    }
    @Test public void androidOffsetIsNeverHardcodedOrSubtractedFromCpuImage() {
        long androidCamera = 2_000_000_000L;
        for (long offset : new long[] { 0, 31_346_842L, 32_797_724L, 90_000_000L }) {
            long arFrame = androidCamera + offset;
            assertTrue(PanoramaCameraClock.matchesArFrame(arFrame, arFrame));
        }
    }
    @Test public void uninitializedAndNegativeTimestampsFailClosed() {
        assertFalse(PanoramaCameraClock.matchesArFrame(0, 0));
        assertFalse(PanoramaCameraClock.matchesArFrame(-1, -1));
    }

    @Test public void trackingRefinementUpToObservedFourPointEightMillisDoesNotBlockImages() {
        for (int frame = 0; frame < 166; frame++) {
            long camera = BASE + frame * STEP;
            long image = camera + IMAGE_OFFSET;
            long imageArDifference = frame * 4_781_110L / 165;
            assertEquals("Frame " + frame, frame >= 2,
                clock.acceptFrame(image, image - imageArDifference, camera, camera + 80_000_000L, true));
        }
        assertEquals("accepted", clock.lastDecision());
    }

    @Test public void learnsThreeCoherentPairsWithoutAssumingAnAbsoluteOffset() {
        for (long offset : new long[] { 0, IMAGE_OFFSET, -90_000_000L, 8_000_000_000L }) {
            clock.reset();
            assertFalse(pair(0, offset));
            assertEquals("warming_up", clock.lastDecision());
            assertFalse(pair(1, offset));
            assertTrue(pair(2, offset));
            assertTrue(pair(3, offset));
        }
    }

    @Test public void varyingStartupOffsetsRequireThreePairsWithinOneBoundedRange() {
        assertFalse(pair(0, IMAGE_OFFSET));
        assertFalse(pair(1, IMAGE_OFFSET + 1_500_000L));
        assertFalse(pair(2, IMAGE_OFFSET + 3_000_000L));
        assertEquals("offset_changed", clock.lastDecision());
        assertFalse(pair(3, IMAGE_OFFSET + 3_700_000L));
        assertTrue(pair(4, IMAGE_OFFSET + 4_800_000L));
    }

    @Test public void duplicateImageFrameAndExposureCannotAdvanceWarmupOrAcceptedState() {
        assertFalse(pair(0, IMAGE_OFFSET));
        long camera = BASE + STEP;
        assertFalse(clock.acceptFrame(BASE + IMAGE_OFFSET, camera + IMAGE_OFFSET, camera,
            camera + 80_000_000L, true));
        assertEquals("duplicate_image", clock.lastDecision());
        assertFalse(pair(1, IMAGE_OFFSET));
        assertTrue(pair(2, IMAGE_OFFSET));
        camera = BASE + 3 * STEP;
        assertFalse(clock.acceptFrame(camera + IMAGE_OFFSET, BASE + 2 * STEP + IMAGE_OFFSET,
            camera, camera + 80_000_000L, true));
        assertEquals("duplicate_frame", clock.lastDecision());
        assertFalse(clock.acceptFrame(camera + IMAGE_OFFSET, camera + IMAGE_OFFSET,
            BASE + 2 * STEP, camera + 80_000_000L, true));
        assertEquals("duplicate_camera", clock.lastDecision());
        assertTrue(pair(3, IMAGE_OFFSET));
    }

    @Test public void olderImageInvalidatesCalibrationWithoutReplacingAcceptedWatermarks() {
        warmup();
        long camera = BASE + 3 * STEP;
        assertFalse(clock.acceptFrame(BASE + STEP + IMAGE_OFFSET, camera + IMAGE_OFFSET, camera,
            camera + 80_000_000L, true));
        assertEquals("timestamp_rollback", clock.lastDecision());
        assertFalse(pair(3, IMAGE_OFFSET));
        assertFalse(pair(4, IMAGE_OFFSET));
        assertTrue(pair(5, IMAGE_OFFSET));
    }

    @Test public void staleAndFutureRealtimeExposuresDoNotReplaceGoodCalibration() {
        warmup();
        long camera = BASE + 3 * STEP;
        assertFalse(clock.acceptFrame(camera + IMAGE_OFFSET, camera + IMAGE_OFFSET, camera,
            camera + 500_000_001L, true));
        assertEquals("stale_exposure", clock.lastDecision());
        assertFalse(clock.acceptFrame(camera + IMAGE_OFFSET, camera + IMAGE_OFFSET, camera,
            camera - 1, true));
        assertEquals("future_exposure", clock.lastDecision());
        assertTrue(clock.acceptFrame(camera + IMAGE_OFFSET, camera + IMAGE_OFFSET, camera,
            camera + 500_000_000L, true));
        camera += STEP;
        assertTrue(clock.acceptFrame(camera + IMAGE_OFFSET, camera + IMAGE_OFFSET, camera, camera, true));
    }

    @Test public void mixedImageClocksCannotPassUntilOneOffsetHasThreeCoherentPairs() {
        warmup();
        assertFalse(pair(3, 0));
        assertEquals("offset_changed", clock.lastDecision());
        assertFalse(pair(4, IMAGE_OFFSET));
        assertFalse(pair(5, 0));
        assertFalse(pair(6, IMAGE_OFFSET));
        assertFalse(pair(7, IMAGE_OFFSET));
        assertTrue(pair(8, IMAGE_OFFSET));
    }

    @Test public void rejectedFutureImageTimestampCannotPoisonAcceptedWatermarks() {
        warmup();
        long camera = BASE + 3 * STEP;
        assertFalse(clock.acceptFrame(camera + 20_000_000_000L, camera + IMAGE_OFFSET, camera,
            camera + 80_000_000L, true));
        assertEquals("clock_gap", clock.lastDecision());
        assertFalse(pair(4, IMAGE_OFFSET));
        assertEquals("timestamp_rollback", clock.lastDecision());
        assertFalse(pair(5, IMAGE_OFFSET));
        assertFalse(pair(6, IMAGE_OFFSET));
        assertTrue(pair(7, IMAGE_OFFSET));
    }

    @Test public void nonRealtimeCameraUsesMonotonicPairsWithoutAnAbsoluteExposureAge() {
        for (int frame = 0; frame < 4; frame++) {
            long camera = BASE + frame * STEP;
            assertEquals(frame >= 2, clock.acceptFrame(camera + IMAGE_OFFSET, camera + 7_000_000L,
                camera, 1, false));
        }
        long camera = BASE + 4 * STEP;
        assertFalse(clock.acceptFrame(camera + IMAGE_OFFSET, camera + 7_000_000L,
            BASE + 3 * STEP, 1, false));
        assertEquals("duplicate_camera", clock.lastDecision());
        assertFalse(clock.acceptFrame(camera + 10_000_000L, camera + 7_000_000L, camera, 0, false));
        assertEquals("offset_changed", clock.lastDecision());
    }

    @Test public void clockGapRequiresThreeFreshCoherentPairs() {
        warmup();
        assertFalse(pair(40, IMAGE_OFFSET));
        assertEquals("clock_gap", clock.lastDecision());
        assertFalse(pair(41, IMAGE_OFFSET));
        assertTrue(pair(42, IMAGE_OFFSET));
    }

    @Test public void arClockRollbackRequiresRewarmingWithoutChangingTheImageOffset() {
        warmup();
        long camera = BASE + 3 * STEP;
        assertFalse(clock.acceptFrame(camera + IMAGE_OFFSET, BASE + IMAGE_OFFSET, camera,
            camera + 80_000_000L, true));
        assertEquals("timestamp_rollback", clock.lastDecision());
        assertFalse(pair(3, IMAGE_OFFSET));
        assertFalse(pair(4, IMAGE_OFFSET));
        assertTrue(pair(5, IMAGE_OFFSET));
    }

    @Test public void sourceChangeAndExplicitResetRequireFreshCalibration() {
        warmup();
        for (int frame = 3; frame < 6; frame++) {
            long camera = BASE + frame * STEP;
            assertEquals(frame == 5, clock.acceptFrame(camera + IMAGE_OFFSET, camera + IMAGE_OFFSET,
                camera, 0, false));
            if (frame == 3) assertEquals("clock_source_changed", clock.lastDecision());
        }
        clock.reset();
        assertEquals("reset", clock.lastDecision());
        assertFalse(pair(0, -50_000_000L));
        assertFalse(pair(1, -50_000_000L));
        assertTrue(pair(2, -50_000_000L));
    }

    @Test public void invalidClockInputsFailWithoutAffectingGoodState() {
        warmup();
        long camera = BASE + 3 * STEP;
        assertFalse(clock.acceptFrame(0, camera, camera, camera, true));
        assertFalse(clock.acceptFrame(camera, -1, camera, camera, true));
        assertFalse(clock.acceptFrame(camera, camera, 0, camera, true));
        assertFalse(clock.acceptFrame(camera, camera, camera, 0, true));
        assertEquals("invalid_timestamp", clock.lastDecision());
        assertTrue(pair(3, IMAGE_OFFSET));
    }

    private boolean pair(int frame, long imageOffset) {
        long camera = BASE + frame * STEP;
        return clock.acceptFrame(camera + imageOffset, camera + IMAGE_OFFSET, camera,
            camera + 80_000_000L, true);
    }

    private void warmup() {
        assertFalse(pair(0, IMAGE_OFFSET));
        assertFalse(pair(1, IMAGE_OFFSET));
        assertTrue(pair(2, IMAGE_OFFSET));
    }
}
