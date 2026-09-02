package com.simerfamily.kinsphere.capsule;

/** Shared constants and validation rules for native Capsule recap artifacts. */
final class CapsuleRecapContract {

    static final int WIDTH = 1080;
    static final int HEIGHT = 1920;
    static final int FRAME_RATE = 30;
    static final int FRAMES_PER_IMAGE = 6;
    static final int MILLISECONDS_PER_IMAGE = 200;
    static final int MAXIMUM_IMAGE_COUNT = 150;
    static final int MAXIMUM_DATA_URL_CHARACTERS = 36 * 1024 * 1024;
    static final long MAXIMUM_DECODED_PIXELS = 80_000_000L;
    static final int MAXIMUM_STAGED_LONG_EDGE = 2048;
    static final int VIDEO_BIT_RATE = 6_000_000;

    static final String STAGING_DIRECTORY = "CapsuleRecapStaging";
    static final String RECAP_DIRECTORY = "CapsuleRecaps";

    /** Prevents construction of this constants-only contract. */
    private CapsuleRecapContract() {}

    /** Accepts only bounded base64 data URLs whose media type is an image. */
    static boolean hasSupportedImageDataUrlHeader(String value) {
        if (value == null || value.length() > MAXIMUM_DATA_URL_CHARACTERS) {
            return false;
        }
        int separator = value.indexOf(',');
        if (separator <= 0) {
            return false;
        }
        String header = value.substring(0, separator).toLowerCase(java.util.Locale.ROOT);
        return header.startsWith("data:image/") && header.endsWith(";base64");
    }

    /** Computes deterministic playback length after enforcing the image-count limit. */
    static int durationMilliseconds(int imageCount) {
        if (imageCount < 0 || imageCount > MAXIMUM_IMAGE_COUNT) {
            throw new IllegalArgumentException("imageCount is outside the Capsule recap limit");
        }
        return imageCount * MILLISECONDS_PER_IMAGE;
    }

    /** Returns a centered destination rectangle that fills the output frame. */
    static float[] coverDestination(int sourceWidth, int sourceHeight) {
        if (sourceWidth <= 0 || sourceHeight <= 0) {
            throw new IllegalArgumentException("source dimensions must be positive");
        }
        float scale = Math.max(
            (float) WIDTH / sourceWidth,
            (float) HEIGHT / sourceHeight
        );
        float drawWidth = sourceWidth * scale;
        float drawHeight = sourceHeight * scale;
        float left = (WIDTH - drawWidth) / 2f;
        float top = (HEIGHT - drawHeight) / 2f;
        return new float[] { left, top, left + drawWidth, top + drawHeight };
    }
}
