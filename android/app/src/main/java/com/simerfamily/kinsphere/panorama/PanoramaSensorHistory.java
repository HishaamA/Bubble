package com.simerfamily.kinsphere.panorama;

import java.util.ArrayDeque;

/** Timestamped IMU history. Camera poses are never paired with a substitute sensor timestamp. */
final class PanoramaSensorHistory {
    private static final long MS = 1_000_000L;
    private static final long HISTORY_NANOS = 2_000 * MS;
    private static final int MAX_SAMPLES = 500;
    private static final long MAX_INTERPOLATION_GAP = 50 * MS;
    private static final long MAX_NEAREST_AGE = 25 * MS;
    private static final long STREAM_RESET_GAP = 250 * MS;
    private static final long ACCELERATION_WINDOW = 250 * MS;
    private static final long MAX_ACCELERATION_AGE = 150 * MS;
    private static final float MAX_QUIET_ACCELERATION = 0.8f;

    static final class Sample {
        final PanoramaPose pose;
        final long timestampNanos;
        final boolean motionQuiet;
        final long generation;

        Sample(PanoramaPose pose, long timestampNanos, boolean motionQuiet, long generation) {
            this.pose = pose;
            this.timestampNanos = timestampNanos;
            this.motionQuiet = motionQuiet;
            this.generation = generation;
        }
    }

    private static final class Rotation {
        final PanoramaPose pose;
        final long timestamp;
        Rotation(PanoramaPose pose, long timestamp) { this.pose = pose; this.timestamp = timestamp; }
    }

    private static final class Acceleration {
        final float magnitude;
        final long timestamp;
        Acceleration(float magnitude, long timestamp) { this.magnitude = magnitude; this.timestamp = timestamp; }
    }

    private final ArrayDeque<Rotation> rotations = new ArrayDeque<>();
    private final ArrayDeque<Acceleration> accelerations = new ArrayDeque<>();
    private long generation;

    synchronized long generation() { return generation; }

    synchronized void clear() {
        rotations.clear();
        accelerations.clear();
        generation++;
    }

    /** A discontinuity starts a new generation; callers must discard their old world calibration. */
    synchronized boolean addRotation(PanoramaPose pose, long timestampNanos) {
        if (timestampNanos <= 0 || !validRotation(pose)) {
            clear();
            return false;
        }
        Rotation previous = rotations.peekLast();
        if (previous != null) {
            long gap = timestampNanos - previous.timestamp;
            if (gap == 0) return false;
            if (gap < 0 || gap > STREAM_RESET_GAP || angularDistance(previous.pose, pose) >
                Math.max(45.0, gap / 1_000_000_000.0 * 1_000.0)) {
                clear();
            }
        }
        float[] transform = pose.transform.clone();
        transform[12] = transform[13] = transform[14] = 0;
        rotations.addLast(new Rotation(PanoramaPose.fromCameraTransform(transform), timestampNanos));
        trim(timestampNanos);
        return true;
    }

    synchronized boolean addAcceleration(float magnitude, long timestampNanos) {
        if (timestampNanos <= 0 || !Float.isFinite(magnitude) || magnitude < 0) {
            clear();
            return false;
        }
        Acceleration previous = accelerations.peekLast();
        if (previous != null && timestampNanos <= previous.timestamp) return false;
        accelerations.addLast(new Acceleration(magnitude, timestampNanos));
        trim(timestampNanos);
        return true;
    }

    /** Returns null for stale/missing orientation; motionQuiet also requires recent acceleration evidence. */
    synchronized Sample at(long cameraRealtimeNanos) {
        if (cameraRealtimeNanos <= 0) return null;
        Rotation before = null;
        Rotation after = null;
        for (Rotation rotation : rotations) {
            if (rotation.timestamp <= cameraRealtimeNanos) before = rotation;
            if (rotation.timestamp >= cameraRealtimeNanos) { after = rotation; break; }
        }
        PanoramaPose pose;
        if (before != null && before.timestamp == cameraRealtimeNanos) {
            pose = before.pose;
        } else if (before != null && after != null && after.timestamp - before.timestamp <= MAX_INTERPOLATION_GAP) {
            double t = (double) (cameraRealtimeNanos - before.timestamp) / (after.timestamp - before.timestamp);
            pose = interpolate(before.pose, after.pose, t);
        } else {
            Rotation closest = before;
            if (closest == null || (after != null && after.timestamp - cameraRealtimeNanos <
                cameraRealtimeNanos - closest.timestamp)) closest = after;
            if (closest == null || Math.abs(closest.timestamp - cameraRealtimeNanos) > MAX_NEAREST_AGE) return null;
            pose = closest.pose;
        }
        return new Sample(PanoramaPose.fromCameraTransform(pose.transform), cameraRealtimeNanos,
            motionQuietAt(cameraRealtimeNanos), generation);
    }

    private boolean motionQuietAt(long timestamp) {
        long start = timestamp - ACCELERATION_WINDOW;
        long previousTimestamp = -1;
        boolean seen = false;
        for (Acceleration acceleration : accelerations) {
            if (acceleration.timestamp > timestamp) break;
            if (acceleration.timestamp < start) {
                previousTimestamp = acceleration.timestamp;
                continue;
            }
            // Missing data is not evidence that the phone was stationary.
            long coverageStart = previousTimestamp < 0 ? start : Math.max(start, previousTimestamp);
            if (acceleration.timestamp - coverageStart > MAX_ACCELERATION_AGE) return false;
            if (acceleration.magnitude > MAX_QUIET_ACCELERATION) return false;
            previousTimestamp = acceleration.timestamp;
            seen = true;
        }
        return seen && timestamp - previousTimestamp <= MAX_ACCELERATION_AGE;
    }

    private void trim(long newestTimestamp) {
        while (!rotations.isEmpty() && (rotations.size() > MAX_SAMPLES ||
            newestTimestamp - rotations.peekFirst().timestamp > HISTORY_NANOS)) rotations.removeFirst();
        while (!accelerations.isEmpty() && (accelerations.size() > MAX_SAMPLES ||
            newestTimestamp - accelerations.peekFirst().timestamp > HISTORY_NANOS)) accelerations.removeFirst();
    }

    private static boolean validRotation(PanoramaPose pose) {
        if (pose == null) return false;
        float[] r = pose.rotation;
        for (float value : r) if (!Float.isFinite(value)) return false;
        for (int row = 0; row < 3; row++) {
            for (int other = row; other < 3; other++) {
                double dot = 0;
                for (int k = 0; k < 3; k++) dot += (double) r[row * 3 + k] * r[other * 3 + k];
                if (Math.abs(dot - (row == other ? 1.0 : 0.0)) > .01) return false;
            }
        }
        double determinant = r[0] * (r[4] * r[8] - r[5] * r[7]) -
            r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
        return Math.abs(determinant - 1) <= .01;
    }

    private static double angularDistance(PanoramaPose first, PanoramaPose second) {
        double dot = 0, aLength = 0, bLength = 0;
        for (int i = 0; i < 4; i++) {
            dot += (double) first.quaternion[i] * second.quaternion[i];
            aLength += (double) first.quaternion[i] * first.quaternion[i];
            bLength += (double) second.quaternion[i] * second.quaternion[i];
        }
        return Math.toDegrees(2 * Math.acos(Math.min(1, Math.abs(dot / Math.sqrt(aLength * bLength)))));
    }

    private static PanoramaPose interpolate(PanoramaPose first, PanoramaPose second, double t) {
        double[] a = new double[4];
        double[] b = new double[4];
        double aLength = 0, bLength = 0;
        for (int i = 0; i < 4; i++) {
            a[i] = first.quaternion[i]; b[i] = second.quaternion[i];
            aLength += a[i] * a[i]; bLength += b[i] * b[i];
        }
        double dot = 0;
        for (int i = 0; i < 4; i++) {
            a[i] /= Math.sqrt(aLength); b[i] /= Math.sqrt(bLength);
            dot += a[i] * b[i];
        }
        if (dot < 0) { for (int i = 0; i < 4; i++) b[i] = -b[i]; dot = -dot; }
        double left = 1 - t, right = t;
        if (dot < .9995) {
            double theta = Math.acos(Math.min(1, dot));
            left = Math.sin((1 - t) * theta) / Math.sin(theta);
            right = Math.sin(t * theta) / Math.sin(theta);
        }
        double[] q = new double[4];
        double length = 0;
        for (int i = 0; i < 4; i++) { q[i] = left * a[i] + right * b[i]; length += q[i] * q[i]; }
        for (int i = 0; i < 4; i++) q[i] /= Math.sqrt(length);
        double x = q[0], y = q[1], z = q[2], w = q[3];
        float[] matrix = {
            (float) (1 - 2 * (y*y + z*z)), (float) (2 * (x*y + z*w)), (float) (2 * (x*z - y*w)), 0,
            (float) (2 * (x*y - z*w)), (float) (1 - 2 * (x*x + z*z)), (float) (2 * (y*z + x*w)), 0,
            (float) (2 * (x*z + y*w)), (float) (2 * (y*z - x*w)), (float) (1 - 2 * (x*x + y*y)), 0,
            0, 0, 0, 1,
        };
        return PanoramaPose.fromCameraTransform(matrix);
    }
}
