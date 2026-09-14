package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

/** JVM-only coverage checks; no camera, Android runtime or model is required. */
public final class PanoramaCoveragePlannerTest {
    private static final double NARROW_FX = 1452.9169;
    private static final double NARROW_FY = 1447.7646;

    @Test
    public void actualNarrowPhoneNeedsOnlyGapFillViewsAfterItsStandard34() {
        PanoramaCoveragePlanner.Plan plan = PanoramaCoveragePlanner.plan(standard34(NARROW_FX, NARROW_FY, 0, 0), 12);

        assertTrue("The standard layout has real gaps: " + plan.initialPixelCoverage, plan.initialPixelCoverage < 0.998);
        assertTrue(plan.initialPixelCoverage > 0.995);
        assertTrue(plan.initialCoverage < 1);
        assertFalse(plan.extraTargets.isEmpty());
        assertTrue("Fill only gaps, not an extra full ring: " + plan.extraTargets.size(), plan.extraTargets.size() <= 6);
        assertEquals(0, plan.pixelGapFraction, 0.000001);
        assertEquals(1, plan.predictedCoverage, 0.000001);
        assertEquals(0, plan.largestHoleFraction, 0);
        assertFalse(plan.cancelled);
    }

    @Test
    public void widerPhoneCompletesWith34WithoutExtraDots() {
        PanoramaCoveragePlanner.Plan plan = PanoramaCoveragePlanner.plan(standard34(1100, 1100, 0, 0), 12);

        assertTrue(plan.extraTargets.isEmpty());
        assertEquals(1, plan.initialPixelCoverage, 0);
        assertEquals(1, plan.initialCoverage, 0.000001);
    }

    @Test
    public void acceptedPredictedViewsCloseGapsAndDoNotAskForTheSameFillAgain() {
        List<PanoramaCoveragePlanner.Frame> frames = standard34(NARROW_FX, NARROW_FY, 0, 0);
        PanoramaCoveragePlanner.Plan proposed = PanoramaCoveragePlanner.plan(frames, 12);
        for (PanoramaCoveragePlanner.Target target : proposed.extraTargets) frames.add(target.asFrame());

        PanoramaCoveragePlanner.Plan observed = PanoramaCoveragePlanner.plan(frames, 12);

        assertTrue(observed.extraTargets.isEmpty());
        assertEquals(0, observed.pixelGapFraction, 0);
        assertEquals(1, observed.initialCoverage, 0.000001);
    }

    @Test
    public void proposedDirectionsUseTheExistingPanoramaPoseYawAndPitchConvention() {
        PanoramaCoveragePlanner.Plan plan = PanoramaCoveragePlanner.plan(standard34(NARROW_FX, NARROW_FY, 179.5, 0), 12);

        assertFalse(plan.extraTargets.isEmpty());
        for (PanoramaCoveragePlanner.Target target : plan.extraTargets) {
            PanoramaPose pose = PanoramaPose.fromCameraTransform(target.asFrame().getTransform());
            assertEquals(target.yawDegrees, (pose.yawDegrees + 360) % 360, 0.00001);
            assertEquals(target.pitchDegrees, pose.pitchDegrees, 0.00001);
            assertEquals(0, pose.rollDegrees, 0.00001);
            assertTrue(target.yawDegrees >= 0 && target.yawDegrees < 360);
            assertTrue(Math.abs(target.pitchDegrees) <= 82);
        }
        assertEquals(0, plan.pixelGapFraction, 0);
    }

    @Test
    public void fillViewsHaveRoomForSmallAimErrorsInsteadOfTouchingOnlyTheExactHole() {
        List<PanoramaCoveragePlanner.Frame> frames = standard34(NARROW_FX, NARROW_FY, 0, 0);
        PanoramaCoveragePlanner.Plan proposed = PanoramaCoveragePlanner.plan(frames, 12);
        for (PanoramaCoveragePlanner.Target target : proposed.extraTargets) {
            frames.add(frame(target.yawDegrees + 1, target.pitchDegrees - 1, 0, NARROW_FX, NARROW_FY));
        }
        PanoramaCoveragePlanner.Plan actual = PanoramaCoveragePlanner.plan(frames, 0);
        assertEquals(0, actual.pixelGapFraction, 0);
    }

    @Test
    public void periodicWrapDoesNotDuplicateOneHoleIntoTwoFillViews() {
        // The largest narrow-camera hole spans the -180/+180 seam. Rotating the complete
        // camera set by 90 degrees moves it off the seam without changing its component size.
        List<PanoramaCoveragePlanner.Frame> frames = standard34(NARROW_FX, NARROW_FY, 0, 0);
        List<PanoramaCoveragePlanner.Frame> shifted = standard34(NARROW_FX, NARROW_FY, 90, 0);
        PanoramaCoveragePlanner.Plan plan = PanoramaCoveragePlanner.plan(frames, 0);
        PanoramaCoveragePlanner.Plan shiftedPlan = PanoramaCoveragePlanner.plan(shifted, 0);
        assertEquals(plan.initialPixelCoverage, shiftedPlan.initialPixelCoverage, 0.00001);
        assertEquals(plan.largestHoleFraction, shiftedPlan.largestHoleFraction, 0);
        PanoramaCoveragePlanner.Plan fill = PanoramaCoveragePlanner.plan(frames, 12);
        PanoramaCoveragePlanner.Plan shiftedFill = PanoramaCoveragePlanner.plan(shifted, 12);
        assertEquals(fill.extraTargets.size(), shiftedFill.extraTargets.size());
        assertEquals(0, fill.pixelGapFraction, 0);
        assertEquals(0, shiftedFill.pixelGapFraction, 0);
    }

    @Test
    public void missingPoleViewsAreCoveredWithoutAimingAtExactPoles() {
        List<PanoramaCoveragePlanner.Frame> frames = standard34(NARROW_FX, NARROW_FY, 0, 0);
        frames.remove(frames.size() - 1);
        frames.remove(0);
        PanoramaCoveragePlanner.Plan plan = PanoramaCoveragePlanner.plan(frames, 12);

        assertTrue(plan.initialPixelCoverage < 0.98);
        assertFalse(plan.extraTargets.isEmpty());
        for (PanoramaCoveragePlanner.Target target : plan.extraTargets) assertTrue(Math.abs(target.pitchDegrees) <= 82);
        assertEquals(0, plan.pixelGapFraction, 0);
    }

    @Test
    public void actualRollChangesCoverageAndIsNotReplacedWithIntendedUprightPoses() {
        PanoramaCoveragePlanner.Plan upright = PanoramaCoveragePlanner.plan(
            Collections.singletonList(frame(0, 0, 0, NARROW_FX, NARROW_FY)), 0);
        PanoramaCoveragePlanner.Plan rolled = PanoramaCoveragePlanner.plan(
            Collections.singletonList(frame(0, 0, 90, NARROW_FX, NARROW_FY)), 0);
        // Same physical spherical area, different equirectangular footprint for portrait versus landscape.
        assertEquals(upright.initialCoverage, rolled.initialCoverage, 0.0006);
        assertTrue(Math.abs(upright.initialPixelCoverage - rolled.initialPixelCoverage) > 0.001);
        PanoramaCoveragePlanner.Plan allRolled = PanoramaCoveragePlanner.plan(standard34(NARROW_FX, NARROW_FY, 0, 22), 12);
        assertTrue(allRolled.predictedCoverage >= allRolled.initialCoverage);
        assertEquals(0, allRolled.pixelGapFraction, 0);
    }

    @Test
    public void proposedViewsRetainCalibrationIncludingOffCenterPrincipalPoint() {
        double[] intrinsics = {NARROW_FX, 0, 497, 0, NARROW_FY, 923, 0, 0, 1};
        PanoramaCoveragePlanner.Frame source = new PanoramaCoveragePlanner.Frame(
            1080, 1920, intrinsics, frame(0, 0, 0, NARROW_FX, NARROW_FY).getTransform());
        PanoramaCoveragePlanner.Plan plan = PanoramaCoveragePlanner.plan(Collections.singletonList(source), 1);

        assertEquals(1, plan.extraTargets.size());
        assertEquals(497, plan.extraTargets.get(0).asFrame().getIntrinsics()[2], 0);
        assertEquals(923, plan.extraTargets.get(0).asFrame().getIntrinsics()[5], 0);
        intrinsics[2] = 0;
        source.getIntrinsics()[2] = 0;
        source.getTransform()[0] = 0;
        assertEquals(497, source.getIntrinsics()[2], 0);
        assertEquals(1, source.getTransform()[0], 0);
    }

    @Test
    public void callerRoundAndTotalLimitsAreHardBoundsEvenForVeryPoorCoverage() {
        PanoramaCoveragePlanner.Frame source = frame(0, 0, 0, NARROW_FX, NARROW_FY);
        PanoramaCoveragePlanner.Plan round = PanoramaCoveragePlanner.plan(Collections.singletonList(source), 100);
        assertTrue(round.extraTargets.size() <= 12);
        assertTrue(round.pixelGapFraction > 0);
        List<PanoramaCoveragePlanner.Frame> nearlyFull = new ArrayList<>(Collections.nCopies(63, source));
        PanoramaCoveragePlanner.Plan last = PanoramaCoveragePlanner.plan(nearlyFull, 12);
        assertEquals(1, last.extraTargets.size());
        nearlyFull.add(source);
        assertTrue(PanoramaCoveragePlanner.plan(nearlyFull, 12).extraTargets.isEmpty());
        nearlyFull.add(source);
        assertThrows(IllegalArgumentException.class, () -> PanoramaCoveragePlanner.plan(nearlyFull, 12));
        assertTrue(PanoramaCoveragePlanner.plan(Collections.singletonList(source), -1).extraTargets.isEmpty());
    }

    @Test
    public void cancellationReturnsPromptlyAndCannotLookLikeSuccessfulCompletion() {
        AtomicInteger checks = new AtomicInteger();
        PanoramaCoveragePlanner.Plan plan = PanoramaCoveragePlanner.plan(
            standard34(NARROW_FX, NARROW_FY, 0, 0), 12, () -> checks.incrementAndGet() >= 4);

        assertTrue(plan.cancelled);
        assertTrue(plan.extraTargets.isEmpty());
        assertTrue(plan.remainingGapFraction > 0);
        assertTrue(checks.get() < 10);
    }

    @Test
    public void emptyAndInvalidFramesNeverPretendToHaveCoverage() {
        PanoramaCoveragePlanner.Plan empty = PanoramaCoveragePlanner.plan(Collections.emptyList(), 12);
        assertEquals(0, empty.predictedCoverage, 0);
        assertEquals(1, empty.remainingGapFraction, 0);
        assertTrue(empty.extraTargets.isEmpty());
        assertThrows(IllegalArgumentException.class, () -> new PanoramaCoveragePlanner.Frame(1080, 1920, new double[9], new float[16]));
        float[] broken = frame(0, 0, 0, NARROW_FX, NARROW_FY).getTransform();
        broken[0] = Float.NaN;
        assertThrows(IllegalArgumentException.class, () -> new PanoramaCoveragePlanner.Frame(
            1080, 1920, new double[] {1000, 0, 540, 0, 1000, 960, 0, 0, 1}, broken));
    }

    private static List<PanoramaCoveragePlanner.Frame> standard34(double fx, double fy, double yawOffset, double roll) {
        List<PanoramaCoveragePlanner.Frame> frames = new ArrayList<>();
        frames.add(frame(yawOffset, 82, roll, fx, fy));
        ring(frames, 55, 5, 36 + yawOffset, roll, fx, fy);
        ring(frames, 27, 7, yawOffset, roll, fx, fy);
        ring(frames, 0, 8, 22.5 + yawOffset, roll, fx, fy);
        ring(frames, -27, 7, 360.0 / 14 + yawOffset, roll, fx, fy);
        ring(frames, -55, 5, yawOffset, roll, fx, fy);
        frames.add(frame(yawOffset, -82, roll, fx, fy));
        return frames;
    }

    private static void ring(List<PanoramaCoveragePlanner.Frame> frames, double pitch, int count, double firstYaw, double roll, double fx, double fy) {
        for (int index = 0; index < count; index++) frames.add(frame(firstYaw + index * 360.0 / count, pitch, roll, fx, fy));
    }

    private static PanoramaCoveragePlanner.Frame frame(double yawDegrees, double pitchDegrees, double rollDegrees, double fx, double fy) {
        double yaw = Math.toRadians(yawDegrees), pitch = Math.toRadians(pitchDegrees), roll = Math.toRadians(rollDegrees);
        double sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch), sr = Math.sin(roll), cr = Math.cos(roll);
        double[] right = {cy, 0, sy};
        double[] up = {-sp * sy, cp, sp * cy};
        float[] transform = new float[16];
        for (int index = 0; index < 3; index++) {
            transform[index] = (float) (right[index] * cr + up[index] * sr);
            transform[4 + index] = (float) (up[index] * cr - right[index] * sr);
        }
        transform[8] = (float) (-sy * cp);
        transform[9] = (float) -sp;
        transform[10] = (float) (cy * cp);
        transform[15] = 1;
        return new PanoramaCoveragePlanner.Frame(1080, 1920, new double[] {fx, 0, 540, 0, fy, 960, 0, 0, 1}, transform);
    }
}
