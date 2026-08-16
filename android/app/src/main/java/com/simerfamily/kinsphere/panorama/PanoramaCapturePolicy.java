package com.simerfamily.kinsphere.panorama;

/** Pure capture thresholds shared by the AR callback and guide overlay. */
final class PanoramaCapturePolicy {

    static final int COMPLETION_CHEVRON_TARGET_COUNT = 6;
    static final float MAX_SMOOTHED_ANGULAR_SPEED_RADIANS = 0.12f;
    static final float MAX_SMOOTHED_LINEAR_SPEED_METERS = 0.08f;
    // A slightly wider instantaneous ceiling preserves natural hand movement
    // while preventing one shutter-frame jolt from hiding inside the EMA.
    static final float MAX_INSTANTANEOUS_ANGULAR_SPEED_RADIANS = 0.18f;
    static final float MAX_INSTANTANEOUS_LINEAR_SPEED_METERS = 0.12f;
    static final float MAX_HOLD_ANGULAR_DRIFT_DEGREES = 3.0f;
    static final float MAX_HOLD_LINEAR_DRIFT_METERS = 0.03f;

    private PanoramaCapturePolicy() {}

    static boolean shouldShowCompletionChevron(int remainingTargetCount) {
        return remainingTargetCount > 0 &&
            remainingTargetCount <= COMPLETION_CHEVRON_TARGET_COUNT;
    }

    static boolean isMotionSteady(
        float instantaneousAngularSpeed,
        float instantaneousLinearSpeed,
        float smoothedAngularSpeed,
        float smoothedLinearSpeed
    ) {
        return Float.isFinite(instantaneousAngularSpeed) &&
            Float.isFinite(instantaneousLinearSpeed) &&
            Float.isFinite(smoothedAngularSpeed) &&
            Float.isFinite(smoothedLinearSpeed) &&
            instantaneousAngularSpeed < MAX_INSTANTANEOUS_ANGULAR_SPEED_RADIANS &&
            instantaneousLinearSpeed < MAX_INSTANTANEOUS_LINEAR_SPEED_METERS &&
            smoothedAngularSpeed < MAX_SMOOTHED_ANGULAR_SPEED_RADIANS &&
            smoothedLinearSpeed < MAX_SMOOTHED_LINEAR_SPEED_METERS;
    }

    static boolean isWithinHoldDrift(float angularDriftDegrees, float linearDriftMeters) {
        return Float.isFinite(angularDriftDegrees) &&
            Float.isFinite(linearDriftMeters) &&
            angularDriftDegrees >= 0.0f &&
            linearDriftMeters >= 0.0f &&
            angularDriftDegrees <= MAX_HOLD_ANGULAR_DRIFT_DEGREES &&
            linearDriftMeters <= MAX_HOLD_LINEAR_DRIFT_METERS;
    }
}
