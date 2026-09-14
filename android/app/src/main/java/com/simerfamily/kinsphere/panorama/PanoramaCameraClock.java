package com.simerfamily.kinsphere.panorama;

/** Checks current-frame image clocks without assuming ARCore's refined pose clock is identical. */
final class PanoramaCameraClock {
    private static final long MAX_EXPOSURE_AGE_NANOS = 500_000_000L;
    private static final long MAX_PAIR_GAP_NANOS = 1_000_000_000L;
    private static final long OFFSET_TOLERANCE_NANOS = 2_000_000L;
    private static final int REQUIRED_COHERENT_PAIRS = 3;

    // Only accepted frames advance these watermarks. Rejected input cannot poison them.
    private long acceptedImageTimestamp;
    private long acceptedArTimestamp;
    private long acceptedCameraTimestamp;
    private long warmupImageTimestamp;
    private long warmupArTimestamp;
    private long warmupCameraTimestamp;
    private long minimumOffset;
    private long maximumOffset;
    private long calibratedOffset;
    private int coherentPairs;
    private boolean calibrated;
    private boolean sourceKnown;
    private boolean realtimeSource;
    private String decision = "reset";

    /** Confined to the GL capture thread, including reset and diagnostic reads. */
    PanoramaCameraClock() {}

    /**
     * acquireCameraImage supplies this Frame's image, but its clock need not equal getTimestamp.
     * Learn the CPU-image/Android-exposure offset from consecutive pairs instead. The AR clock
     * must still advance; its tracking-time refinements do not change image eligibility.
     */
    boolean acceptFrame(long imageTimestamp, long arFrameTimestamp, long androidCameraTimestamp,
                        long realtimeNowNanos, boolean cameraRealtime) {
        if (imageTimestamp <= 0 || arFrameTimestamp <= 0 || androidCameraTimestamp <= 0) {
            return reject("invalid_timestamp");
        }
        if (cameraRealtime) {
            if (realtimeNowNanos <= 0) return reject("invalid_timestamp");
            if (androidCameraTimestamp > realtimeNowNanos) return reject("future_exposure");
            if (realtimeNowNanos - androidCameraTimestamp > MAX_EXPOSURE_AGE_NANOS) {
                return reject("stale_exposure");
            }
        }

        // A rollback invalidates calibration, but must never lower accepted watermarks.
        if (imageTimestamp < acceptedImageTimestamp || arFrameTimestamp < acceptedArTimestamp
            || androidCameraTimestamp < acceptedCameraTimestamp) {
            discardCalibration();
            return reject("timestamp_rollback");
        }
        if (imageTimestamp == acceptedImageTimestamp) return reject("duplicate_image");
        if (arFrameTimestamp == acceptedArTimestamp) return reject("duplicate_frame");
        if (androidCameraTimestamp == acceptedCameraTimestamp) return reject("duplicate_camera");

        if (sourceKnown && realtimeSource != cameraRealtime) {
            discardCalibration();
            realtimeSource = cameraRealtime;
            beginWarmup(imageTimestamp, arFrameTimestamp, androidCameraTimestamp);
            return reject("clock_source_changed");
        }
        sourceKnown = true;
        realtimeSource = cameraRealtime;

        long previousImage = coherentPairs > 0 ? warmupImageTimestamp : acceptedImageTimestamp;
        long previousAr = coherentPairs > 0 ? warmupArTimestamp : acceptedArTimestamp;
        long previousCamera = coherentPairs > 0 ? warmupCameraTimestamp : acceptedCameraTimestamp;
        if (imageTimestamp < previousImage || arFrameTimestamp < previousAr
            || androidCameraTimestamp < previousCamera) {
            discardCalibration();
            return reject("timestamp_rollback");
        }
        if (imageTimestamp == previousImage) return reject("duplicate_image");
        if (arFrameTimestamp == previousAr) return reject("duplicate_frame");
        if (androidCameraTimestamp == previousCamera) return reject("duplicate_camera");

        if (previousImage > 0 && (imageTimestamp - previousImage > MAX_PAIR_GAP_NANOS
            || arFrameTimestamp - previousAr > MAX_PAIR_GAP_NANOS
            || androidCameraTimestamp - previousCamera > MAX_PAIR_GAP_NANOS)) {
            discardCalibration();
            beginWarmup(imageTimestamp, arFrameTimestamp, androidCameraTimestamp);
            return reject("clock_gap");
        }

        long offset = imageTimestamp - androidCameraTimestamp;
        if (calibrated) {
            if (!offsetsAgree(offset, calibratedOffset)) {
                discardCalibration();
                beginWarmup(imageTimestamp, arFrameTimestamp, androidCameraTimestamp);
                return reject("offset_changed");
            }
            return accept(imageTimestamp, arFrameTimestamp, androidCameraTimestamp);
        }
        if (coherentPairs == 0) {
            beginWarmup(imageTimestamp, arFrameTimestamp, androidCameraTimestamp);
            return reject("warming_up");
        }

        long nextMinimum = Math.min(minimumOffset, offset);
        long nextMaximum = Math.max(maximumOffset, offset);
        if (!offsetsAgree(nextMinimum, nextMaximum)) {
            beginWarmup(imageTimestamp, arFrameTimestamp, androidCameraTimestamp);
            return reject("offset_changed");
        }
        minimumOffset = nextMinimum;
        maximumOffset = nextMaximum;
        warmupImageTimestamp = imageTimestamp;
        warmupArTimestamp = arFrameTimestamp;
        warmupCameraTimestamp = androidCameraTimestamp;
        coherentPairs++;
        if (coherentPairs < REQUIRED_COHERENT_PAIRS) return reject("warming_up");

        // The bounded span makes this midpoint safe even for a large negative clock offset.
        calibratedOffset = minimumOffset + (maximumOffset - minimumOffset) / 2;
        calibrated = true;
        return accept(imageTimestamp, arFrameTimestamp, androidCameraTimestamp);
    }

    void reset() {
        acceptedImageTimestamp = 0;
        acceptedArTimestamp = 0;
        acceptedCameraTimestamp = 0;
        sourceKnown = false;
        realtimeSource = false;
        discardCalibration();
        decision = "reset";
    }

    String lastDecision() {
        return decision;
    }

    private boolean accept(long imageTimestamp, long arTimestamp, long cameraTimestamp) {
        acceptedImageTimestamp = imageTimestamp;
        acceptedArTimestamp = arTimestamp;
        acceptedCameraTimestamp = cameraTimestamp;
        coherentPairs = 0;
        decision = "accepted";
        return true;
    }

    private boolean reject(String reason) {
        decision = reason;
        return false;
    }

    private void beginWarmup(long imageTimestamp, long arTimestamp, long cameraTimestamp) {
        warmupImageTimestamp = imageTimestamp;
        warmupArTimestamp = arTimestamp;
        warmupCameraTimestamp = cameraTimestamp;
        minimumOffset = imageTimestamp - cameraTimestamp;
        maximumOffset = minimumOffset;
        coherentPairs = 1;
    }

    private void discardCalibration() {
        calibrated = false;
        coherentPairs = 0;
        warmupImageTimestamp = 0;
        warmupArTimestamp = 0;
        warmupCameraTimestamp = 0;
        minimumOffset = 0;
        maximumOffset = 0;
        calibratedOffset = 0;
    }

    private static boolean offsetsAgree(long first, long second) {
        long span = Math.max(first, second) - Math.min(first, second);
        return span >= 0 && span <= OFFSET_TOLERANCE_NANOS;
    }

    /** Raw-clock diagnostic only: AR tracking refinements make this unsuitable for eligibility. */
    static boolean matchesArFrame(long imageTimestamp, long arFrameTimestamp) {
        return imageTimestamp > 0 && arFrameTimestamp > 0 &&
            Math.abs(imageTimestamp - arFrameTimestamp) <= 1_000_000L;
    }
}
