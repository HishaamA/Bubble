package com.simerfamily.kinsphere.panorama;

/** One capture direction on the app's deterministic spherical target grid. */
final class PanoramaTarget {

    final int index;
    final double yawDegrees;
    final double pitchDegrees;
    final float[] direction;
    // The GL thread reads this after the UI thread accepts an encoded frame.
    volatile boolean captured;

    /** Precomputes a unit camera-space direction for one yaw/pitch target. */
    PanoramaTarget(int index, double yawDegrees, double pitchDegrees) {
        this.index = index;
        this.yawDegrees = normalizeDegrees(yawDegrees);
        this.pitchDegrees = pitchDegrees;

        double yaw = Math.toRadians(this.yawDegrees);
        double pitch = Math.toRadians(pitchDegrees);
        double cosPitch = Math.cos(pitch);
        direction = new float[] {
            (float) (Math.sin(yaw) * cosPitch),
            (float) Math.sin(pitch),
            (float) (-Math.cos(yaw) * cosPitch),
        };
    }

    /** Normalizes arbitrary yaw values to the half-open {@code [0, 360)} range. */
    private static double normalizeDegrees(double value) {
        double normalized = value % 360.0;
        return normalized < 0.0 ? normalized + 360.0 : normalized;
    }
}
