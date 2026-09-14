package com.simerfamily.kinsphere.panorama;

/** Keeps a fresh, sharp frame during a steady hold. Confined to the capture thread. */
final class BestFrameSelector<T> {
    private final long maxAgeNanos;
    private T selected;
    private double selectedScore;
    private long selectedTimestamp;
    private long latestTimestamp;

    BestFrameSelector(long maxAgeNanos) {
        if (maxAgeNanos <= 0) {
            throw new IllegalArgumentException("Frame age must be positive.");
        }
        this.maxAgeNanos = maxAgeNanos;
    }

    void reset() {
        selected = null;
        selectedScore = 0;
        selectedTimestamp = 0;
        latestTimestamp = 0;
    }

    boolean consider(T value, double score, long frameTimestampNanos) {
        if (value == null || !Double.isFinite(score) || score < 0
            || frameTimestampNanos <= 0 || frameTimestampNanos <= latestTimestamp) {
            return false;
        }
        latestTimestamp = frameTimestampNanos;
        // A stale sharp frame must never prevent a fresh softer frame from being saved.
        if (selected == null || frameTimestampNanos - selectedTimestamp > maxAgeNanos
            || score >= selectedScore) {
            selected = value;
            selectedScore = score;
            selectedTimestamp = frameTimestampNanos;
            return true;
        }
        return false;
    }

    T best(long nowTimestampNanos) {
        if (selected == null) return null;
        if (nowTimestampNanos < selectedTimestamp
            || nowTimestampNanos - selectedTimestamp > maxAgeNanos) {
            selected = null;
            return null;
        }
        return selected;
    }
}
