package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PanoramaCapturePolicyTest {

    @Test
    public void completionChevronAppearsOnlyForTheFinalSixTargets() {
        assertFalse(PanoramaCapturePolicy.shouldShowCompletionChevron(7));
        assertTrue(PanoramaCapturePolicy.shouldShowCompletionChevron(6));
        assertTrue(PanoramaCapturePolicy.shouldShowCompletionChevron(1));
        assertFalse(PanoramaCapturePolicy.shouldShowCompletionChevron(0));
    }

    @Test
    public void motionGateAllowsNormalMicroMovement() {
        assertTrue(PanoramaCapturePolicy.isMotionSteady(
            0.14f,
            0.09f,
            0.08f,
            0.05f
        ));
    }

    @Test
    public void motionGateRejectsAnAngularSpikeHiddenByTheMovingAverage() {
        assertFalse(PanoramaCapturePolicy.isMotionSteady(
            0.19f,
            0.02f,
            0.08f,
            0.02f
        ));
    }

    @Test
    public void motionGateRejectsALinearSpikeHiddenByTheMovingAverage() {
        assertFalse(PanoramaCapturePolicy.isMotionSteady(
            0.04f,
            0.13f,
            0.04f,
            0.05f
        ));
    }

    @Test
    public void motionGateStillRejectsSustainedMovement() {
        assertFalse(PanoramaCapturePolicy.isMotionSteady(
            0.10f,
            0.06f,
            0.13f,
            0.06f
        ));
    }

    @Test
    public void holdWindowAllowsThreeDegreesAndThreeCentimetersOfDrift() {
        assertTrue(PanoramaCapturePolicy.isWithinHoldDrift(3.0f, 0.03f));
    }

    @Test
    public void holdWindowRejectsCumulativeAngularDrift() {
        assertFalse(PanoramaCapturePolicy.isWithinHoldDrift(3.01f, 0.02f));
    }

    @Test
    public void holdWindowRejectsCumulativeLinearDrift() {
        assertFalse(PanoramaCapturePolicy.isWithinHoldDrift(2.0f, 0.031f));
    }
}
