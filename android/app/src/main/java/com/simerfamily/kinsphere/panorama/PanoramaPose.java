package com.simerfamily.kinsphere.panorama;

import java.util.Arrays;

/** A display-oriented camera-to-world pose captured from one ARCore frame. */
final class PanoramaPose {

    final long sensorTimestampNanos;
    final float[] rotation;
    final float[] transform;
    final float[] quaternion;
    final float[] position;
    final double yawDegrees;
    final double pitchDegrees;
    final double rollDegrees;

    private PanoramaPose(
        long sensorTimestampNanos,
        float[] rotation,
        float[] transform,
        float[] quaternion,
        float[] position,
        double yawDegrees,
        double pitchDegrees,
        double rollDegrees
    ) {
        this.sensorTimestampNanos = sensorTimestampNanos;
        this.rotation = rotation;
        this.transform = transform;
        this.quaternion = quaternion;
        this.position = position;
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
            new float[] { 0.0f, 0.0f, 0.0f },
            yaw,
            pitch,
            roll
        );
    }

    static PanoramaPose fromCameraTransform(float[] transform, long frameTimestampNanos) {
        if (transform.length != 16) {
            throw new IllegalArgumentException("Camera transform must contain 16 values.");
        }
        float[] copy = Arrays.copyOf(transform, transform.length);
        float[] rotation = new float[] {
            copy[0], copy[4], copy[8],
            copy[1], copy[5], copy[9],
            copy[2], copy[6], copy[10],
        };
        float forwardX = -copy[8];
        float forwardY = -copy[9];
        float forwardZ = -copy[10];
        double yawRadians = Math.atan2(forwardX, -forwardZ);
        double pitchRadians = Math.asin(clamp(forwardY, -1.0f, 1.0f));
        float rightX = copy[0];
        float rightY = copy[1];
        float rightZ = copy[2];
        double levelRightX = Math.cos(yawRadians);
        double levelRightZ = Math.sin(yawRadians);
        double levelUpX = -Math.sin(pitchRadians) * Math.sin(yawRadians);
        double levelUpY = Math.cos(pitchRadians);
        double levelUpZ = Math.sin(pitchRadians) * Math.cos(yawRadians);
        double rollRadians = Math.atan2(
            rightX * levelUpX + rightY * levelUpY + rightZ * levelUpZ,
            rightX * levelRightX + rightZ * levelRightZ
        );

        return new PanoramaPose(
            frameTimestampNanos,
            rotation,
            copy,
            quaternionFromRotation(rotation),
            new float[] { copy[12], copy[13], copy[14] },
            Math.toDegrees(yawRadians),
            Math.toDegrees(pitchRadians),
            Math.toDegrees(rollRadians)
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
