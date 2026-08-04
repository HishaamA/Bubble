package com.simerfamily.kinsphere.panorama;

final class PanoramaTarget {

    final int index;
    final double yawDegrees;
    final double pitchDegrees;
    final float[] direction;
    boolean captured;

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

    private static double normalizeDegrees(double value) {
        double normalized = value % 360.0;
        return normalized < 0.0 ? normalized + 360.0 : normalized;
    }
}
