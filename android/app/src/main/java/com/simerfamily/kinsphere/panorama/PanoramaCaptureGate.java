package com.simerfamily.kinsphere.panorama;

/** Accumulates a safe hold from distinct AR frames, independently of render frequency. */
final class PanoramaCaptureGate {
    private static final long MILLIS = 1_000_000L;
    private static final long MAX_INTERVAL = 150L * MILLIS;
    private static final long MAX_INTERVAL_CREDIT = 100L * MILLIS;
    private static final long MAX_GAP = 250L * MILLIS;
    private static final long NOISE_GRACE = 150L * MILLIS;
    private static final long SETTLING_TIME = 100L * MILLIS;
    private static final float ALIGNMENT_RELEASE_PADDING = 1.5f;

    static final class Sample {
        final boolean freshFrame;
        final boolean aligned;
        final boolean withinCaptureZone;
        final boolean steady;
        final boolean readyToCapture;
        final float progress;

        final float angularSpeed;
        final float linearSpeed;
        final float smoothedAngularSpeed;
        final float smoothedLinearSpeed;

        Sample(boolean freshFrame, boolean aligned, boolean withinCaptureZone, boolean steady,
               boolean ready, float progress, float angularSpeed, float linearSpeed,
               float smoothedAngularSpeed, float smoothedLinearSpeed) {
            this.freshFrame = freshFrame;
            this.aligned = aligned;
            this.withinCaptureZone = withinCaptureZone;
            this.steady = steady;
            this.readyToCapture = ready;
            this.progress = progress;
            this.angularSpeed = angularSpeed;
            this.linearSpeed = linearSpeed;
            this.smoothedAngularSpeed = smoothedAngularSpeed;
            this.smoothedLinearSpeed = smoothedLinearSpeed;
        }
    }

    private PanoramaPose previousPose;
    private PanoramaPose holdStartPose;
    private long previousTimestamp;
    private long heldNanos;
    private long requiredNanos = 650L * MILLIS;
    private long stableNanos;
    private long badSince = -1L;
    private int activeTarget = -1;
    private float smoothedAngularSpeed = Float.POSITIVE_INFINITY;
    private float smoothedLinearSpeed = Float.POSITIVE_INFINITY;
    private boolean aligned;
    private boolean withinCaptureZone;
    private float angularSpeed = Float.POSITIVE_INFINITY;
    private float linearSpeed = Float.POSITIVE_INFINITY;
    private boolean steady;
    private boolean previousEligible;
    private boolean trackingPaused;

    /** Only fresh, continuous, aligned and steady frame intervals can advance the hold. */
    Sample update(PanoramaPose pose, long timestampNanos, int targetIndex,
                  float angularDistanceDegrees, float alignmentDegrees,
                  long requiredHoldMillis, boolean captureAllowed) {
        requiredNanos = Math.max(1L, requiredHoldMillis) * MILLIS;
        if (targetIndex != activeTarget) {
            clearHold();
            aligned = false;
            withinCaptureZone = false;
            activeTarget = targetIndex;
        }
        if (!captureAllowed || targetIndex < 0) {
            clearHold();
        }
        if (pose == null) {
            pauseTracking();
        }
        if (pose == null || timestampNanos <= 0L || timestampNanos <= previousTimestamp) {
            return sample(false, false);
        }

        PanoramaPose previous = previousPose;
        long elapsed = timestampNanos - previousTimestamp;
        boolean interrupted = trackingPaused || elapsed > MAX_INTERVAL;
        previousPose = pose;
        previousTimestamp = timestampNanos;
        trackingPaused = false;
        boolean strictlyAligned = targetIndex >= 0 && Float.isFinite(angularDistanceDegrees) &&
            angularDistanceDegrees >= 0.0f && angularDistanceDegrees <= alignmentDegrees;
        withinCaptureZone = strictlyAligned;
        aligned = strictlyAligned || (aligned && targetIndex >= 0 &&
            Float.isFinite(angularDistanceDegrees) && angularDistanceDegrees >= 0.0f &&
            angularDistanceDegrees <= alignmentDegrees + ALIGNMENT_RELEASE_PADDING);

        if (previous == null || elapsed > MAX_GAP) {
            clearHold();
            angularSpeed = Float.POSITIVE_INFINITY;
            linearSpeed = Float.POSITIVE_INFINITY;
            smoothedAngularSpeed = Float.POSITIVE_INFINITY;
            smoothedLinearSpeed = Float.POSITIVE_INFINITY;
            steady = false;
            return sample(true, false);
        }

        double seconds = elapsed / 1_000_000_000.0;
        angularSpeed = (float) (Math.toRadians(angularDistance(previous, pose)) / seconds);
        linearSpeed = (float) (previous.linearDistanceMeters(pose) / seconds);
        if (Float.isFinite(smoothedAngularSpeed)) {
            smoothedAngularSpeed = 0.78f * smoothedAngularSpeed + 0.22f * angularSpeed;
            smoothedLinearSpeed = 0.78f * smoothedLinearSpeed + 0.22f * linearSpeed;
        } else {
            smoothedAngularSpeed = angularSpeed;
            smoothedLinearSpeed = linearSpeed;
        }
        steady = PanoramaCapturePolicy.isMotionSteady(
            angularSpeed, linearSpeed, smoothedAngularSpeed, smoothedLinearSpeed);

        if (!captureAllowed || targetIndex < 0) {
            return sample(true, false);
        }
        if (holdStartPose != null && !PanoramaCapturePolicy.isWithinHoldDrift(
            (float) angularDistance(holdStartPose, pose), holdStartPose.linearDistanceMeters(pose))) {
            clearHold();
        }

        // Measure actual bad movement separately from its decaying EMA tail. A brief
        // jolt may retain progress, but neither its tail nor a tracking gap earns time.
        boolean instantaneousSteady = Float.isFinite(angularSpeed) && Float.isFinite(linearSpeed) &&
            angularSpeed < PanoramaCapturePolicy.MAX_INSTANTANEOUS_ANGULAR_SPEED_RADIANS &&
            linearSpeed < PanoramaCapturePolicy.MAX_INSTANTANEOUS_LINEAR_SPEED_METERS;
        if (!aligned || !instantaneousSteady) {
            if (badSince < 0L) {
                badSince = timestampNanos - elapsed;
            }
            if (timestampNanos - badSince > NOISE_GRACE) {
                clearHold();
            }
            previousEligible = false;
            stableNanos = 0L;
            return sample(true, false);
        }
        badSince = -1L;
        if (interrupted || !steady) {
            previousEligible = false;
            stableNanos = 0L;
            // Reacquisition is a baseline, not evidence of a steady shutter frame.
            if (interrupted) {
                steady = false;
            }
            return sample(true, false);
        }
        if (holdStartPose == null) {
            if (!strictlyAligned) {
                return sample(true, false);
            }
            holdStartPose = pose;
        }
        if (previousEligible) {
            long credit = Math.min(elapsed, MAX_INTERVAL_CREDIT);
            heldNanos += credit;
            stableNanos += credit;
        }
        previousEligible = true;
        return sample(true, strictlyAligned && heldNanos >= requiredNanos && stableNanos >= SETTLING_TIME);
    }

    /** Tracking loss freezes progress until fresh poses can confirm steadiness again. */
    void pauseTracking() {
        trackingPaused = true;
        steady = false;
        previousEligible = false;
        stableNanos = 0L;
    }

    float getProgress() {
        return Math.min(1.0f, heldNanos / (float) requiredNanos);
    }

    /** Clears the complete session history, including the AR timestamp baseline. */
    void reset() {
        clearHold();
        previousPose = null;
        previousTimestamp = 0L;
        activeTarget = -1;
        aligned = false;
        withinCaptureZone = false;
        steady = false;
        trackingPaused = false;
        smoothedAngularSpeed = Float.POSITIVE_INFINITY;
        smoothedLinearSpeed = Float.POSITIVE_INFINITY;
        angularSpeed = Float.POSITIVE_INFINITY;
        linearSpeed = Float.POSITIVE_INFINITY;
    }

    private void clearHold() {
        holdStartPose = null;
        heldNanos = 0L;
        stableNanos = 0L;
        badSince = -1L;
        previousEligible = false;
    }

    private Sample sample(boolean freshFrame, boolean ready) {
        return new Sample(freshFrame, aligned, withinCaptureZone, steady && !trackingPaused,
            ready, getProgress(), angularSpeed, linearSpeed, smoothedAngularSpeed, smoothedLinearSpeed);
    }

    /** Normalize in double precision: float quaternion roundoff must not invent motion. */
    private static double angularDistance(PanoramaPose first, PanoramaPose second) {
        double dot = 0.0;
        double firstNorm = 0.0;
        double secondNorm = 0.0;
        for (int component = 0; component < 4; component++) {
            double a = first.quaternion[component];
            double b = second.quaternion[component];
            dot += a * b;
            firstNorm += a * a;
            secondNorm += b * b;
        }
        double normalizedDot = Math.abs(dot) / Math.sqrt(firstNorm * secondNorm);
        return Math.toDegrees(2.0 * Math.acos(Math.max(0.0, Math.min(1.0, normalizedDot))));
    }
}
