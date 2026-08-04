package com.simerfamily.kinsphere.panorama;

import java.util.Arrays;

/** A camera-to-session-world pose derived from the Android rotation vector. */
final class PanoramaPose {

    final long sensorTimestampNanos;
    final float[] rotation;
    final float[] transform;
    final float[] quaternion;
    final double yawDegrees;
    final double pitchDegrees;
    final double rollDegrees;

    private PanoramaPose(
        long sensorTimestampNanos,
        float[] rotation,
        float[] transform,
        float[] quaternion,
        double yawDegrees,
        double pitchDegrees,
        double rollDegrees
    ) {
        this.sensorTimestampNanos = sensorTimestampNanos;
        this.rotation = rotation;
        this.transform = transform;
        this.quaternion = quaternion;
        this.yawDegrees = yawDegrees;
        this.pitchDegrees = pitchDegrees;
        this.rollDegrees = rollDegrees;
    }

    static PanoramaPose fromRelativeRotation(float[] rotation, long sensorTimestampNanos) {
        float[] copy = Arrays.copyOf(rotation, 9);
        float forwardX = -copy[2];
        float forwardY = -copy[5];
        float forwardZ = -copy[8];

        double yaw = Math.toDegrees(Math.atan2(forwardX, -forwardZ));
        double pitch = Math.toDegrees(Math.asin(clamp(forwardY, -1.0f, 1.0f)));
        double roll = Math.toDegrees(Math.atan2(copy[3], copy[4]));

        return new PanoramaPose(
            sensorTimestampNanos,
            copy,
            toColumnMajorTransform(copy),
            quaternionFromRotation(copy),
            yaw,
            pitch,
            roll
        );
    }

    float angularDistanceDegrees(PanoramaTarget target) {
        float forwardX = -rotation[2];
        float forwardY = -rotation[5];
        float forwardZ = -rotation[8];
        double dot =
            forwardX * target.direction[0] +
            forwardY * target.direction[1] +
            forwardZ * target.direction[2];
        return (float) Math.toDegrees(Math.acos(clamp(dot, -1.0, 1.0)));
    }

    private static float[] toColumnMajorTransform(float[] rotation) {
        return new float[] {
            rotation[0], rotation[3], rotation[6], 0.0f,
            rotation[1], rotation[4], rotation[7], 0.0f,
            rotation[2], rotation[5], rotation[8], 0.0f,
            0.0f, 0.0f, 0.0f, 1.0f,
        };
    }

    private static float[] quaternionFromRotation(float[] matrix) {
        float x;
        float y;
        float z;
        float w;
        float trace = matrix[0] + matrix[4] + matrix[8];

        if (trace > 0.0f) {
            float scale = (float) Math.sqrt(trace + 1.0f) * 2.0f;
            w = 0.25f * scale;
            x = (matrix[7] - matrix[5]) / scale;
            y = (matrix[2] - matrix[6]) / scale;
            z = (matrix[3] - matrix[1]) / scale;
        } else if (matrix[0] > matrix[4] && matrix[0] > matrix[8]) {
            float scale = (float) Math.sqrt(1.0f + matrix[0] - matrix[4] - matrix[8]) * 2.0f;
            w = (matrix[7] - matrix[5]) / scale;
            x = 0.25f * scale;
            y = (matrix[1] + matrix[3]) / scale;
            z = (matrix[2] + matrix[6]) / scale;
        } else if (matrix[4] > matrix[8]) {
            float scale = (float) Math.sqrt(1.0f + matrix[4] - matrix[0] - matrix[8]) * 2.0f;
            w = (matrix[2] - matrix[6]) / scale;
            x = (matrix[1] + matrix[3]) / scale;
            y = 0.25f * scale;
            z = (matrix[5] + matrix[7]) / scale;
        } else {
            float scale = (float) Math.sqrt(1.0f + matrix[8] - matrix[0] - matrix[4]) * 2.0f;
            w = (matrix[3] - matrix[1]) / scale;
            x = (matrix[2] + matrix[6]) / scale;
            y = (matrix[5] + matrix[7]) / scale;
            z = 0.25f * scale;
        }

        float magnitude = (float) Math.sqrt(x * x + y * y + z * z + w * w);
        if (magnitude > 0.0f) {
            x /= magnitude;
            y /= magnitude;
            z /= magnitude;
            w /= magnitude;
        }
        return new float[] { x, y, z, w };
    }

    private static double clamp(double value, double minimum, double maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }
}
