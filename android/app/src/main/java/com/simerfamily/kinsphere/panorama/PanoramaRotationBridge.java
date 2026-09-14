package com.simerfamily.kinsphere.panorama;

/**
 * Short-lived rotation-only bridge across ARCore's loss of visual tracking.
 *
 * <p>The rotation sensor and ARCore samples supplied to {@link #calibrate} must describe the
 * same instant in the Android camera/sensor monotonic clock. This class cannot detect a time
 * offset between them. It does not recover translation, correct gyro drift, or turn a stale
 * ARCore pose into a tracked pose: translation is explicitly frozen at the last calibration.
 * Callers must retain that distinction in capture metadata and enforce their other safety gates.
 */
final class PanoramaRotationBridge {
    static final long MAX_CAPTURE_AGE_NANOS = 30_000_000_000L;
    static final long MAX_GUIDANCE_AGE_NANOS = 90_000_000_000L;
    private static final double RIGID_TOLERANCE = 0.002;

    private double[] captureFromGame;
    private double[] sensorFromCamera;
    private float[] referenceCameraTransform;
    private long calibrationTimestampNanos;
    private long lastQueryTimestampNanos;

    /**
     * Connects a game-rotation-vector coordinate frame to the established capture frame.
     * Inputs are independent column-major rigid camera/device transforms, not Euler angles.
     * A repeated timestamp is a no-op; older or malformed calibrations never replace a good one.
     */
    void calibrate(
        PanoramaPose cameraInCapture,
        PanoramaPose androidSensorInCapture,
        PanoramaPose rotationSensorPose,
        long cameraSensorTimestampNanos
    ) {
        if (cameraSensorTimestampNanos <= 0
            || cameraSensorTimestampNanos < calibrationTimestampNanos) {
            throw new IllegalArgumentException("Rotation calibration requires a fresh camera timestamp.");
        }
        if (referenceCameraTransform != null
            && cameraSensorTimestampNanos == calibrationTimestampNanos) {
            return;
        }
        if (cameraSensorTimestampNanos < lastQueryTimestampNanos) {
            throw new IllegalArgumentException("Rotation calibration requires a fresh camera timestamp.");
        }

        // Finish all validation and composition before replacing the previous calibration.
        float[] camera = validatedTransform(cameraInCapture);
        double[] androidSensor = rotationOf(validatedTransform(androidSensorInCapture));
        double[] gameSensor = rotationOf(validatedTransform(rotationSensorPose));
        double[] nextCaptureFromGame = multiply(androidSensor, transpose(gameSensor));
        double[] nextSensorFromCamera = multiply(transpose(androidSensor), rotationOf(camera));

        captureFromGame = nextCaptureFromGame;
        sensorFromCamera = nextSensorFromCamera;
        referenceCameraTransform = camera;
        calibrationTimestampNanos = cameraSensorTimestampNanos;
        lastQueryTimestampNanos = cameraSensorTimestampNanos;
    }

    /** Returns a bounded rotation-only pose for capture, or null when it is unsafe to estimate. */
    PanoramaPose estimate(PanoramaPose rotationSensorPose, long cameraSensorTimestampNanos) {
        return estimateWithin(rotationSensorPose, cameraSensorTimestampNanos, MAX_CAPTURE_AGE_NANOS);
    }

    /**
     * Longer-lived orientation for drawing recovery guidance only. Its result must not be used
     * to capture frames once {@link #estimate} has expired.
     */
    PanoramaPose guidance(PanoramaPose rotationSensorPose, long cameraSensorTimestampNanos) {
        return estimateWithin(rotationSensorPose, cameraSensorTimestampNanos, MAX_GUIDANCE_AGE_NANOS);
    }

    /** Returns elapsed calibration time, or MAX_VALUE when no valid time relationship exists. */
    long ageNanos(long timestampNanos) {
        if (referenceCameraTransform == null || timestampNanos <= 0
            || timestampNanos < calibrationTimestampNanos) {
            return Long.MAX_VALUE;
        }
        return timestampNanos - calibrationTimestampNanos;
    }

    /** A detached snapshot of the last reliable camera pose, including its actual translation. */
    PanoramaPose referenceCameraPose() {
        return referenceCameraTransform == null
            ? null : PanoramaPose.fromCameraTransform(referenceCameraTransform);
    }

    void reset() {
        captureFromGame = null;
        sensorFromCamera = null;
        referenceCameraTransform = null;
        calibrationTimestampNanos = 0;
        lastQueryTimestampNanos = 0;
    }

    private PanoramaPose estimateWithin(PanoramaPose sensorPose, long timestampNanos, long maximumAge) {
        if (ageNanos(timestampNanos) > maximumAge || timestampNanos < lastQueryTimestampNanos) {
            return null;
        }
        final float[] sensor;
        try {
            sensor = validatedTransform(sensorPose);
        } catch (IllegalArgumentException malformedPose) {
            return null;
        }

        double[] rotation = multiply(multiply(captureFromGame, rotationOf(sensor)), sensorFromCamera);
        float[] transform = referenceCameraTransform.clone();
        for (int column = 0; column < 3; column++) {
            for (int row = 0; row < 3; row++) {
                transform[column * 4 + row] = (float) rotation[column * 3 + row];
            }
        }
        lastQueryTimestampNanos = timestampNanos;
        return PanoramaPose.fromCameraTransform(transform);
    }

    private static float[] validatedTransform(PanoramaPose pose) {
        if (pose == null || pose.transform == null || pose.transform.length != 16) {
            throw new IllegalArgumentException("Rotation bridge requires a rigid 4x4 transform.");
        }
        float[] transform = pose.transform.clone();
        for (float value : transform) {
            if (!Float.isFinite(value)) {
                throw new IllegalArgumentException("Rotation bridge requires finite transforms.");
            }
        }
        if (Math.abs(transform[3]) > RIGID_TOLERANCE
            || Math.abs(transform[7]) > RIGID_TOLERANCE
            || Math.abs(transform[11]) > RIGID_TOLERANCE
            || Math.abs(transform[15] - 1) > RIGID_TOLERANCE) {
            throw new IllegalArgumentException("Rotation bridge requires an affine rigid transform.");
        }
        double[] rotation = rotationOf(transform);
        for (int column = 0; column < 3; column++) {
            for (int otherColumn = column; otherColumn < 3; otherColumn++) {
                double dot = 0;
                for (int row = 0; row < 3; row++) {
                    dot += rotation[column * 3 + row] * rotation[otherColumn * 3 + row];
                }
                if (Math.abs(dot - (column == otherColumn ? 1 : 0)) > RIGID_TOLERANCE) {
                    throw new IllegalArgumentException("Rotation bridge requires orthonormal rotations.");
                }
            }
        }
        double determinant = rotation[0] * (rotation[4] * rotation[8] - rotation[7] * rotation[5])
            - rotation[3] * (rotation[1] * rotation[8] - rotation[7] * rotation[2])
            + rotation[6] * (rotation[1] * rotation[5] - rotation[4] * rotation[2]);
        if (Math.abs(determinant - 1) > 2 * RIGID_TOLERANCE) {
            throw new IllegalArgumentException("Rotation bridge requires right-handed rotations.");
        }
        return transform;
    }

    private static double[] rotationOf(float[] transform) {
        double[] rotation = new double[9];
        for (int column = 0; column < 3; column++) {
            for (int row = 0; row < 3; row++) {
                rotation[column * 3 + row] = transform[column * 4 + row];
            }
        }
        return rotation;
    }

    private static double[] transpose(double[] matrix) {
        double[] transposed = new double[9];
        for (int column = 0; column < 3; column++) {
            for (int row = 0; row < 3; row++) {
                transposed[column * 3 + row] = matrix[row * 3 + column];
            }
        }
        return transposed;
    }

    private static double[] multiply(double[] first, double[] second) {
        double[] result = new double[9];
        for (int column = 0; column < 3; column++) {
            for (int row = 0; row < 3; row++) {
                for (int k = 0; k < 3; k++) {
                    result[column * 3 + row] += first[k * 3 + row] * second[column * 3 + k];
                }
            }
        }
        return result;
    }
}
