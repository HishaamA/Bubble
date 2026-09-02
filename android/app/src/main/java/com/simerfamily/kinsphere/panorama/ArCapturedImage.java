package com.simerfamily.kinsphere.panorama;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.media.Image;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;

/** An app-owned copy of one ARCore CPU image, safe to encode off the GL thread. */
final class ArCapturedImage {

    final int width;
    final int height;
    private final byte[] nv21;

    /** Owns the detached NV21 bytes for one even-sized ARCore image. */
    private ArCapturedImage(int width, int height, byte[] nv21) {
        this.width = width;
        this.height = height;
        this.nv21 = nv21;
    }

    /** Copies cropped YUV planes before ARCore closes the source {@link Image}. */
    static ArCapturedImage copyOf(Image image) throws IOException {
        if (image.getFormat() != ImageFormat.YUV_420_888) {
            throw new IOException("ARCore returned an unsupported camera image format.");
        }
        Rect crop = image.getCropRect();
        int width = crop.width();
        int height = crop.height();
        if (width <= 0 || height <= 0 || (width & 1) != 0 || (height & 1) != 0) {
            throw new IOException("ARCore returned invalid camera image dimensions.");
        }

        Image.Plane[] planes = image.getPlanes();
        if (planes.length < 3) {
            throw new IOException("ARCore returned incomplete YUV camera planes.");
        }
        long outputByteCount = (long) width * height * 3L / 2L;
        if (outputByteCount > Integer.MAX_VALUE) {
            throw new IOException("ARCore returned a camera image that is too large.");
        }
        final byte[] output;
        try {
            output = new byte[(int) outputByteCount];
        } catch (OutOfMemoryError error) {
            throw new IOException("The AR camera image is too large to copy safely.", error);
        }
        copyPlane(
            planes[0],
            crop.left,
            crop.top,
            width,
            height,
            output,
            0,
            1
        );

        int chromaWidth = width / 2;
        int chromaHeight = height / 2;
        int chromaOffset = width * height;
        // NV21 stores V then U for each 2x2 luma block.
        copyPlane(
            planes[2],
            crop.left / 2,
            crop.top / 2,
            chromaWidth,
            chromaHeight,
            output,
            chromaOffset,
            2
        );
        copyPlane(
            planes[1],
            crop.left / 2,
            crop.top / 2,
            chromaWidth,
            chromaHeight,
            output,
            chromaOffset + 1,
            2
        );
        return new ArCapturedImage(width, height, output);
    }

    /** Rotates, downsizes, and writes an upright JPEG while retaining source dimensions. */
    EncodedFrame encode(
        File destination,
        int rotationDegrees,
        int requestedWidth,
        int jpegQualityPercent
    ) throws IOException {
        ByteArrayOutputStream sourceJpeg = new ByteArrayOutputStream(Math.max(64 * 1024, nv21.length / 2));
        YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, width, height, null);
        if (!yuv.compressToJpeg(new Rect(0, 0, width, height), jpegQualityPercent, sourceJpeg)) {
            throw new IOException("The AR camera image could not be converted to JPEG.");
        }
        byte[] jpegBytes = sourceJpeg.toByteArray();
        Bitmap decoded = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.length);
        if (decoded == null) {
            throw new IOException("The AR camera JPEG could not be decoded.");
        }

        Bitmap upright = decoded;
        Bitmap scaled = decoded;
        try {
            int normalizedRotation = ((rotationDegrees % 360) + 360) % 360;
            if (normalizedRotation != 0) {
                Matrix rotation = new Matrix();
                rotation.postRotate(normalizedRotation);
                upright = Bitmap.createBitmap(
                    decoded,
                    0,
                    0,
                    decoded.getWidth(),
                    decoded.getHeight(),
                    rotation,
                    true
                );
            }

            int outputWidth = requestedWidth > 0
                ? Math.min(requestedWidth, upright.getWidth())
                : upright.getWidth();
            int outputHeight = Math.max(
                1,
                Math.round(upright.getHeight() * (outputWidth / (float) upright.getWidth()))
            );
            scaled = upright;
            if (upright.getWidth() != outputWidth || upright.getHeight() != outputHeight) {
                scaled = Bitmap.createScaledBitmap(upright, outputWidth, outputHeight, true);
            }

            try (FileOutputStream output = new FileOutputStream(destination)) {
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, jpegQualityPercent, output)) {
                    throw new IOException("The upright AR camera JPEG could not be saved.");
                }
            }
            return new EncodedFrame(
                destination,
                outputWidth,
                outputHeight,
                width,
                height,
                normalizedRotation
            );
        } finally {
            if (scaled != upright && scaled != decoded) {
                scaled.recycle();
            }
            if (upright != decoded) {
                upright.recycle();
            }
            decoded.recycle();
        }
    }

    /** Copies a strided image plane into the packed NV21 destination with bounds checks. */
    private static void copyPlane(
        Image.Plane plane,
        int left,
        int top,
        int width,
        int height,
        byte[] destination,
        int destinationOffset,
        int destinationPixelStride
    ) throws IOException {
        ByteBuffer buffer = plane.getBuffer().duplicate();
        int bufferOffset = buffer.position();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        int destinationIndex = destinationOffset;
        for (int row = 0; row < height; row += 1) {
            int rowStart = bufferOffset + (top + row) * rowStride + left * pixelStride;
            if (pixelStride == 1 && destinationPixelStride == 1) {
                int rowEnd = rowStart + width;
                int destinationEnd = destinationIndex + width;
                if (
                    rowStart < 0 ||
                    rowEnd < rowStart ||
                    rowEnd > buffer.limit() ||
                    destinationEnd < destinationIndex ||
                    destinationEnd > destination.length
                ) {
                    throw new IOException("The AR camera image planes were truncated.");
                }
                buffer.position(rowStart);
                buffer.get(destination, destinationIndex, width);
                destinationIndex = destinationEnd;
                continue;
            }
            for (int column = 0; column < width; column += 1) {
                int sourceIndex = rowStart + column * pixelStride;
                if (sourceIndex < 0 || sourceIndex >= buffer.limit() || destinationIndex >= destination.length) {
                    throw new IOException("The AR camera image planes were truncated.");
                }
                destination[destinationIndex] = buffer.get(sourceIndex);
                destinationIndex += destinationPixelStride;
            }
        }
    }

    /** Describes one durable JPEG and the source transform needed for intrinsics. */
    static final class EncodedFrame {
        final File file;
        final int width;
        final int height;
        final int sourceWidth;
        final int sourceHeight;
        final int sourceRotationDegrees;

        /** Captures both saved-image dimensions and the original ARCore image geometry. */
        EncodedFrame(
            File file,
            int width,
            int height,
            int sourceWidth,
            int sourceHeight,
            int sourceRotationDegrees
        ) {
            this.file = file;
            this.width = width;
            this.height = height;
            this.sourceWidth = sourceWidth;
            this.sourceHeight = sourceHeight;
            this.sourceRotationDegrees = sourceRotationDegrees;
        }
    }
}
