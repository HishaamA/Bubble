package com.simerfamily.kinsphere.panorama;

/** Pinhole calibration transformed through the actual crop, quarter-turn and resize. */
final class PanoramaImageCalibration {
    private PanoramaImageCalibration() {}

    static double[] adjustedIntrinsics(float[] focalLength, float[] principalPoint, int[] intrinsicDimensions,
        int imageWidth, int imageHeight, int cropLeft, int cropTop, int cropWidth, int cropHeight,
        int rotationDegrees, int outputWidth, int outputHeight) {
        if (focalLength == null || focalLength.length < 2 || principalPoint == null || principalPoint.length < 2
            || intrinsicDimensions == null || intrinsicDimensions.length < 2
            || !Float.isFinite(focalLength[0]) || !Float.isFinite(focalLength[1])
            || !Float.isFinite(principalPoint[0]) || !Float.isFinite(principalPoint[1])
            || focalLength[0] <= 0 || focalLength[1] <= 0 || intrinsicDimensions[0] <= 0 || intrinsicDimensions[1] <= 0
            || imageWidth <= 0 || imageHeight <= 0 || cropLeft < 0 || cropTop < 0 || cropWidth <= 0 || cropHeight <= 0
            || (long) cropLeft + cropWidth > imageWidth || (long) cropTop + cropHeight > imageHeight
            || outputWidth <= 0 || outputHeight <= 0)
            throw new IllegalArgumentException("Camera intrinsics and image dimensions must be valid.");
        int rotation = ((rotationDegrees % 360) + 360) % 360;
        if (rotation % 90 != 0) throw new IllegalArgumentException("Image rotation must be a multiple of 90 degrees.");

        // Intrinsics describe the whole CPU image, not a resized version of its crop.
        double fx = focalLength[0] * (imageWidth / (double) intrinsicDimensions[0]);
        double fy = focalLength[1] * (imageHeight / (double) intrinsicDimensions[1]);
        double cx = principalPoint[0] * (imageWidth / (double) intrinsicDimensions[0]) - cropLeft;
        double cy = principalPoint[1] * (imageHeight / (double) intrinsicDimensions[1]) - cropTop;
        int uprightWidth = cropWidth, uprightHeight = cropHeight;
        if (rotation == 90 || rotation == 270) {
            double oldFx = fx, oldCx = cx;
            fx = fy; fy = oldFx;
            cx = rotation == 90 ? cropHeight - 1.0 - cy : cy;
            cy = rotation == 90 ? oldCx : cropWidth - 1.0 - oldCx;
            uprightWidth = cropHeight; uprightHeight = cropWidth;
        } else if (rotation == 180) {
            cx = cropWidth - 1.0 - cx;
            cy = cropHeight - 1.0 - cy;
        }
        double scaleX = outputWidth / (double) uprightWidth;
        double scaleY = outputHeight / (double) uprightHeight;
        return new double[] { fx * scaleX, 0, cx * scaleX, 0, fy * scaleY, cy * scaleY, 0, 0, 1 };
    }
}
