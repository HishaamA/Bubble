package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Exercises capture safety with sensor timestamps, including repeated render callbacks. */
public final class PanoramaCaptureGateTest {
    private final PanoramaCaptureGate gate = new PanoramaCaptureGate();

    @Test
    public void stationaryPoseEarnsExactly650MillisOfFreshHold() {
        PanoramaCaptureGate.Sample sample = stationaryThrough(700);
        assertTrue(sample.freshFrame);
        assertTrue(sample.steady);
        assertFalse(sample.readyToCapture);
        assertEquals(600.0f / 650.0f, sample.progress, 0.0001f);
        assertTrue(update(750, pose(0, 0)).readyToCapture);
    }

    @Test
    public void duplicateCallbacksDoNotStarveTenToSixtyHertzCameras() {
        for (int hz : new int[] { 10, 15, 30, 60 }) {
            gate.reset();
            long frameNanos = 1_000_000_000L / hz;
            PanoramaPose stationary = pose(37.4, 0);
            PanoramaCaptureGate.Sample sample = null;
            for (int frame = 1; frame <= hz; frame++) {
                long time = frame * frameNanos;
                sample = gate.update(stationary, time, 1, 0, 6, 650, true);
                for (int duplicate = 0; duplicate < 8; duplicate++) {
                    PanoramaCaptureGate.Sample repeated = gate.update(stationary, time, 1, 0, 6, 650, true);
                    assertFalse(repeated.freshFrame);
                    assertFalse(repeated.readyToCapture);
                    assertEquals(sample.progress, repeated.progress, 0.0f);
                    assertEquals(sample.steady, repeated.steady);
                }
            }
            assertTrue("Camera frequency " + hz, sample.readyToCapture);
        }
    }

    @Test
    public void zeroOlderAndStalledTimestampsCannotAdvanceOrCapture() {
        float progress = stationaryThrough(700).progress;
        for (int repetition = 0; repetition < 1000; repetition++) {
            for (long time : new long[] { 0, 650, 700 }) {
                PanoramaCaptureGate.Sample sample = update(time, pose(0, 0));
                assertFalse(sample.freshFrame);
                assertFalse(sample.readyToCapture);
                assertEquals(progress, sample.progress, 0.0f);
            }
        }
        assertTrue(update(750, pose(0, 0)).readyToCapture);
    }

    @Test
    public void tenHertzTimingJitterCapsCreditWithoutStarvingTheHold() {
        PanoramaCaptureGate.Sample sample = null;
        for (long time = 101; time <= 1010; time += 101) {
            sample = update(time, pose(0, 0));
        }
        assertTrue(sample.readyToCapture);
        gate.reset();
        update(101, pose(0, 0));
        update(202, pose(0, 0));
        assertEquals(100.0f / 650.0f, update(303, pose(0, 0)).progress, 0.0001f);
    }

    @Test
    public void briefJitterPausesAndRecoversWithoutDiscardingTheHold() {
        float progress = stationaryThrough(500).progress;
        PanoramaCaptureGate.Sample spike = update(550, pose(0.8, 0));
        assertFalse(spike.steady);
        assertFalse(spike.readyToCapture);
        assertEquals(progress, spike.progress, 0.0f);
        assertFalse(update(600, pose(0, 0)).readyToCapture);
        assertEquals(progress, gate.getProgress(), 0.0f);
        PanoramaCaptureGate.Sample recovered = null;
        for (long time = 650; time <= 1050; time += 50) {
            recovered = update(time, pose(0, 0));
        }
        assertTrue(recovered.readyToCapture);
    }

    @Test
    public void finalFrameJoltMustSettleForFresh100MillisEvenWhenHoldWasComplete() {
        stationaryThrough(750);
        assertFalse(update(800, pose(0.6, 0)).readyToCapture);
        assertFalse(update(850, pose(0.6, 0)).readyToCapture);
        assertFalse(update(900, pose(0.6, 0)).readyToCapture);
        assertTrue(update(950, pose(0.6, 0)).readyToCapture);
    }

    @Test
    public void sustainedRotationAndTranslationResetTheHold() {
        for (boolean rotation : new boolean[] { true, false }) {
            gate.reset();
            stationaryThrough(400);
            PanoramaCaptureGate.Sample sample = null;
            for (int frame = 1; frame <= 6; frame++) {
                sample = update(400 + frame * 50L, pose(rotation ? frame : 0, rotation ? 0 : frame * 0.01));
                assertFalse(sample.readyToCapture);
                assertFalse(sample.steady);
            }
            assertEquals(0.0f, sample.progress, 0.0f);
        }
    }

    @Test
    public void trackingInterruptionCannotEarnTimeAndRequiresFreshConfirmation() {
        float progress = stationaryThrough(500).progress;
        gate.pauseTracking();
        assertEquals(progress, gate.getProgress(), 0.0f);
        assertFalse(update(500, pose(0, 0)).steady);
        PanoramaCaptureGate.Sample reacquired = update(650, pose(0, 0));
        assertFalse(reacquired.steady);
        assertFalse(reacquired.readyToCapture);
        assertEquals(progress, reacquired.progress, 0.0f);
        assertEquals(progress, update(700, pose(0, 0)).progress, 0.0f);
        for (long time = 750; time <= 950; time += 50) {
            update(time, pose(0, 0));
        }
        assertTrue(update(1000, pose(0, 0)).readyToCapture);
    }

    @Test
    public void longFrameOrTrackingGapResetsInsteadOfCountingUnseenTime() {
        for (boolean paused : new boolean[] { true, false }) {
            gate.reset();
            stationaryThrough(700);
            if (paused) {
                gate.pauseTracking();
            }
            PanoramaCaptureGate.Sample sample = update(1000, pose(0, 0));
            assertFalse(sample.steady);
            assertFalse(sample.readyToCapture);
            assertEquals(0.0f, sample.progress, 0.0f);
            assertFalse("A new baseline has no measured angular speed", Float.isFinite(sample.angularSpeed));
            assertFalse("A new baseline has no measured linear speed", Float.isFinite(sample.linearSpeed));
        }
    }

    @Test
    public void mediumFrameGapIsSkippedRatherThanAddedToTheHold() {
        float progress = stationaryThrough(700).progress;
        PanoramaCaptureGate.Sample sample = update(900, pose(0, 0));
        assertFalse(sample.readyToCapture);
        assertEquals(progress, sample.progress, 0.0f);
        assertFalse(update(950, pose(0, 0)).readyToCapture);
        assertFalse(update(1000, pose(0, 0)).readyToCapture);
        assertTrue(update(1050, pose(0, 0)).readyToCapture);
    }

    @Test
    public void aNewTargetCannotInheritAnotherTargetsProgress() {
        stationaryThrough(700);
        PanoramaCaptureGate.Sample sample = gate.update(pose(0, 0), 750_000_000L, 2, 0, 6, 650, true);
        assertEquals(0.0f, sample.progress, 0.0f);
        assertFalse(sample.readyToCapture);
    }

    @Test
    public void holdDriftRejectsSlowRotationAndTranslationDespiteSafeSpeeds() {
        for (boolean rotation : new boolean[] { true, false }) {
            gate.reset();
            stationaryThrough(100);
            PanoramaCaptureGate.Sample sample = null;
            for (int frame = 1; frame <= 12; frame++) {
                sample = update(100 + frame * 50L, pose(rotation ? frame * 0.27 : 0,
                    rotation ? 0 : frame * 0.0027));
                assertTrue(sample.steady);
                assertFalse(sample.readyToCapture);
            }
            assertEquals(0.0f, sample.progress, 0.0f);
        }
    }

    @Test
    public void alignmentPaddingRetainsHoldButCaptureRequiresStrictEntryRadius() {
        stationaryThrough(700);
        PanoramaCaptureGate.Sample outside = gate.update(pose(0, 0), 750_000_000L, 1, 7, 6, 650, true);
        assertTrue(outside.aligned);
        assertFalse("The guide must request centering, not Hold still", outside.withinCaptureZone);
        assertEquals(1.0f, outside.progress, 0.0f);
        assertFalse(outside.readyToCapture);
        PanoramaCaptureGate.Sample centered = gate.update(pose(0, 0), 800_000_000L, 1, 6, 6, 650, true);
        assertTrue(centered.withinCaptureZone);
        assertTrue(centered.readyToCapture);
        gate.reset();
        gate.update(pose(0, 0), 50_000_000L, 1, 7, 6, 650, true);
        assertFalse(gate.update(pose(0, 0), 100_000_000L, 1, 7, 6, 650, true).aligned);
        assertEquals(0.0f, gate.getProgress(), 0.0f);
    }

    @Test
    public void captureInFlightAndCooldownClearHoldEvenOnDuplicateFrames() {
        stationaryThrough(700);
        PanoramaCaptureGate.Sample disabled = gate.update(pose(0, 0), 700_000_000L, 1, 0, 6, 650, false);
        assertEquals(0.0f, disabled.progress, 0.0f);
        assertFalse(disabled.readyToCapture);
        assertEquals(0.0f, update(750, pose(0, 0)).progress, 0.0f);
    }

    @Test
    public void finalThreeOrFourTargetsUseTheSameHoldEligibility() {
        for (int target : new int[] { 0, 31, 32, 33, 34 }) {
            gate.reset();
            PanoramaCaptureGate.Sample sample = null;
            for (long time = 50; time <= 750; time += 50) {
                sample = gate.update(pose(0, 0), time * 1_000_000L, target, 0, 6, 650, true);
            }
            assertTrue("Target index " + target, sample.readyToCapture);
        }
    }

    @Test
    public void stationaryCeilingAndNadirPosesWithRollCanCapture() {
        for (double pitch : new double[] { 82, -82 }) {
            for (double roll : new double[] { 89, 91, -89 }) {
                gate.reset();
                PanoramaPose stationary = orientedPose(37.4, pitch, roll);
                assertEquals(pitch, stationary.pitchDegrees, 0.001);
                PanoramaCaptureGate.Sample sample = null;
                for (long time = 50; time <= 750; time += 50) {
                    sample = gate.update(stationary, time * 1_000_000L, 33, 0, 6, 650, true);
                }
                assertTrue("Pitch " + pitch + " roll " + roll, sample.readyToCapture);
            }
        }
    }

    @Test
    public void smallBoundedPoseNoiseDoesNotStarveSupportedFrameRates() {
        for (int hz : new int[] { 10, 30, 60 }) {
            gate.reset();
            PanoramaCaptureGate.Sample sample = null;
            for (int frame = 1; frame <= hz; frame++) {
                int sign = frame % 2 == 0 ? 1 : -1;
                sample = update(Math.round(frame * 1000.0 / hz), pose(sign * .04, sign * .0004));
            }
            assertTrue("Small pose noise at " + hz + "Hz", sample.readyToCapture);
        }
    }

    @Test
    public void persistentFastPoseNoiseIsRejectedButDoesNotPermanentlyLatchTheGate() {
        // These are synthetic AR estimates, not measured physical phone motion.
        // Pose-only evidence cannot distinguish this jitter from actual movement.
        for (int hz : new int[] { 30, 60 }) {
            for (boolean rotation : new boolean[] { true, false }) {
                gate.reset();
                double amplitude = rotation ? (hz == 30 ? .15 : .10) : (hz == 30 ? .002 : .001);
                for (int frame = 1; frame <= 5 * hz; frame++) {
                    int sign = frame % 2 == 0 ? 1 : -1;
                    PanoramaCaptureGate.Sample noisy = update(Math.round(frame * 1000.0 / hz),
                        pose(rotation ? sign * amplitude : 0, rotation ? 0 : sign * amplitude));
                    assertFalse(noisy.readyToCapture);
                }
                PanoramaCaptureGate.Sample recovered = null;
                for (int frame = 1; frame <= hz; frame++) {
                    recovered = update(5000 + Math.round(frame * 1000.0 / hz), pose(0, 0));
                }
                assertTrue("Recovery after " + hz + "Hz pose noise", recovered.readyToCapture);
            }
        }
    }

    @Test
    public void releaseBandCanRetainFullProgressWithoutBeingCaptureAligned() {
        for (int frame = 1; frame <= 20; frame++) {
            gate.update(pose(0, 0), frame * 50_000_000L, 1, 0, 4.5f, 650, true);
        }
        for (int frame = 21; frame <= 600; frame++) {
            PanoramaCaptureGate.Sample releaseBand = gate.update(pose(0, 0), frame * 50_000_000L,
                1, 5.5f, 4.5f, 650, true);
            assertTrue(releaseBand.aligned);
            assertTrue(releaseBand.steady);
            assertEquals(1.0f, releaseBand.progress, 0);
            assertFalse(releaseBand.readyToCapture);
        }
        assertTrue(gate.update(pose(0, 0), 30_050_000_000L, 1, 4.5f, 4.5f, 650, true).readyToCapture);
    }

    @Test
    public void pausedDuplicateAndOlderFramesCannotReusePreviouslyReadyState() {
        assertTrue(stationaryThrough(750).readyToCapture);
        gate.pauseTracking();
        for (long timestamp : new long[] { 0, 700, 750, 749, 750 }) {
            PanoramaCaptureGate.Sample paused = update(timestamp, pose(0, 0));
            assertFalse(paused.freshFrame);
            assertFalse(paused.steady);
            assertFalse(paused.readyToCapture);
            assertEquals(1.0f, paused.progress, 0);
        }
        assertFalse(update(800, pose(0, 0)).readyToCapture);
        assertFalse(update(850, pose(0, 0)).readyToCapture);
        assertFalse(update(900, pose(0, 0)).readyToCapture);
        assertTrue(update(950, pose(0, 0)).readyToCapture);
    }

    @Test
    public void outOfOrderPoseDoesNotPoisonNextFreshMotionEstimate() {
        stationaryThrough(700);
        PanoramaCaptureGate.Sample delayed = update(650, pose(170, 100));
        assertFalse(delayed.freshFrame);
        assertFalse(delayed.readyToCapture);
        assertTrue(update(750, pose(0, 0)).readyToCapture);
    }

    private PanoramaCaptureGate.Sample stationaryThrough(long endMillis) {
        PanoramaCaptureGate.Sample sample = null;
        for (long time = 50; time <= endMillis; time += 50) {
            sample = update(time, pose(0, 0));
        }
        return sample;
    }

    private PanoramaCaptureGate.Sample update(long millis, PanoramaPose pose) {
        return gate.update(pose, millis * 1_000_000L, 1, 0, 6, 650, true);
    }

    private static PanoramaPose pose(double yawDegrees, double translation) {
        float cosine = (float) Math.cos(Math.toRadians(yawDegrees));
        float sine = (float) Math.sin(Math.toRadians(yawDegrees));
        return PanoramaPose.fromCameraTransform(new float[] {
            cosine, 0, sine, 0,
            0, 1, 0, 0,
            -sine, 0, cosine, 0,
            (float) translation, 0, 0, 1,
        });
    }

    private static PanoramaPose orientedPose(double yaw, double pitch, double roll) {
        float cy = (float) Math.cos(Math.toRadians(yaw));
        float sy = (float) Math.sin(Math.toRadians(yaw));
        float cp = (float) Math.cos(Math.toRadians(pitch));
        float sp = (float) Math.sin(Math.toRadians(pitch));
        float cr = (float) Math.cos(Math.toRadians(roll));
        float sr = (float) Math.sin(Math.toRadians(roll));
        return PanoramaPose.fromCameraTransform(new float[] {
            cy * cr - sy * sp * sr, cp * sr, sy * cr + cy * sp * sr, 0,
            -cy * sr - sy * sp * cr, cp * cr, -sy * sr + cy * sp * cr, 0,
            -sy * cp, -sp, cy * cp, 0,
            0, 0, 0, 1,
        });
    }
}
