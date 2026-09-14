package com.simerfamily.kinsphere.panorama;

import android.graphics.Bitmap;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.media.Image;
import android.os.Build;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;

/** An app-owned copy of one ARCore CPU image, safe to encode off the GL thread. */
final class ArCapturedImage {

    final int width;
    final int height;
    final int imageWidth;
    final int imageHeight;
    final int cropLeft;
    final int cropTop;
    final int dataSpace;
    private final byte[] nv21;
    private final PanoramaYuv.ColorModel colorModel;

    /** Owns the detached NV21 bytes for one even-sized ARCore image. */
    private ArCapturedImage(int imageWidth, int imageHeight, int cropLeft, int cropTop,
        int width, int height, byte[] nv21, int dataSpace, PanoramaYuv.ColorModel colorModel) {
        this.imageWidth = imageWidth;
        this.imageHeight = imageHeight;
        this.cropLeft = cropLeft;
        this.cropTop = cropTop;
        this.width = width;
        this.height = height;
        this.nv21 = nv21;
        this.dataSpace = dataSpace;
        this.colorModel = colorModel;
    }

    /** Copies full YUV planes and retains their crop before ARCore closes the source image. */
    static ArCapturedImage copyOf(Image image) throws IOException {
        if (image.getFormat() != ImageFormat.YUV_420_888) {
            throw new IOException("ARCore returned an unsupported camera image format.");
        }
        Rect crop = image.getCropRect();
        int imageWidth = image.getWidth();
        int imageHeight = image.getHeight();
        Image.Plane[] planes = image.getPlanes();
        if (planes.length < 3) {
            throw new IOException("ARCore returned incomplete YUV camera planes.");
        }
        // Read the required pixel data through the provider first. ARCore owns
        // its image lifetime separately from android.media.Image's hidden flag.
        ByteBuffer[] buffers = {
            planes[0].getBuffer(), planes[1].getBuffer(), planes[2].getBuffer()
        };
        int dataSpace = optionalDataSpace(image);
        return copyOfPlanes(imageWidth, imageHeight, crop, dataSpace,
            buffers,
            new int[] { planes[0].getRowStride(), planes[1].getRowStride(), planes[2].getRowStride() },
            new int[] { planes[0].getPixelStride(), planes[1].getPixelStride(), planes[2].getPixelStride() });
    }

    /** Missing optional colour metadata must not reject valid ARCore camera pixels. */
    private static int optionalDataSpace(Image image) {
        if (Build.VERSION.SDK_INT < 33) return 0;
        try {
            return image.getDataSpace();
        } catch (IllegalStateException | UnsupportedOperationException unavailable) {
            // ARCore 1.54 inherits Image.getDataSpace(), but does not initialize
            // the framework's mIsImageValid flag. That inherited getter reports
            // "Image is already closed" even for a live, readable ARCore image.
            // Only this optional getter falls back to UNKNOWN (normal SDR YUV).
            // Real plane/lifetime failures and explicit unsupported colour
            // spaces still propagate; never catch errors around the whole copy.
            return 0;
        }
    }

    /** Shared plane-copy boundary, also exercised with deterministic synthetic image planes. */
    static ArCapturedImage copyOfPlanes(int imageWidth, int imageHeight, Rect crop, int dataSpace,
        ByteBuffer[] planes, int[] rowStrides, int[] pixelStrides) throws IOException {
        if (crop == null) throw new IOException("The AR camera crop is missing.");
        int width = crop.width();
        int height = crop.height();
        PanoramaYuv.validateCrop(imageWidth, imageHeight, crop.left, crop.top, width, height);
        PanoramaYuv.ColorModel colorModel = PanoramaYuv.colorModel(dataSpace);
        final byte[] output;
        try {
            // Retain the full chroma grid: cropping packed NV21 at an odd origin
            // would silently shift U/V onto different source pixels.
            output = PanoramaYuv.copyNv21(planes, rowStrides, pixelStrides, imageWidth, imageHeight);
        } catch (OutOfMemoryError error) {
            throw new IOException("The AR camera image is too large to copy safely.", error);
        }
        return new ArCapturedImage(imageWidth, imageHeight, crop.left, crop.top,
            width, height, output, dataSpace, colorModel);
    }

    /** Ranks focus within one steady hold, without a minimum score or an RGB allocation. */
    double lumaSharpnessScore() {
        return PanoramaYuv.lumaSharpness(nv21, imageWidth, cropLeft, cropTop, width, height);
    }

    /** Rotates, downsizes, and writes an upright JPEG while retaining source dimensions. */
    EncodedFrame encode(
        File destination,
        int rotationDegrees,
        int requestedWidth,
        int jpegQualityPercent
    ) throws IOException {
        int normalizedRotation = ((rotationDegrees % 360) + 360) % 360;
        if (normalizedRotation % 90 != 0 || jpegQualityPercent < 0 || jpegQualityPercent > 100) {
            throw new IOException("The camera output settings are invalid.");
        }
        Bitmap decoded = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);

        Bitmap upright = decoded;
        Bitmap scaled = decoded;
        try {
            // Direct RGB conversion uses bounded scratch space, off the GL thread.
            // The final compress below is the only JPEG encoding in this path.
            int tileRows = Math.min(32, height);
            int[] pixels = new int[width * tileRows];
            for (int row = 0; row < height; row += tileRows) {
                int rows = Math.min(tileRows, height - row);
                PanoramaYuv.convertRows(nv21, imageWidth, imageHeight, cropLeft, cropTop,
                    width, height, row, rows, colorModel, pixels);
                decoded.setPixels(pixels, 0, width, 0, row, width, rows);
            }
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
                // Persist the source before UI acknowledges its dot and commits the manifest.
                output.getFD().sync();
            }
            return new EncodedFrame(
                destination,
                outputWidth,
                outputHeight,
                width,
                height,
                normalizedRotation, imageWidth, imageHeight, cropLeft, cropTop,
                dataSpace, colorModel.name()
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

    /** Describes one durable JPEG and the source transform needed for intrinsics. */
    static final class EncodedFrame {
        final File file;
        final int width;
        final int height;
        final int sourceWidth;
        final int sourceHeight;
        final int sourceRotationDegrees;
        final int sourceImageWidth;
        final int sourceImageHeight;
        final int sourceCropLeft;
        final int sourceCropTop;
        final int sourceDataSpace;
        final String yuvColorConversion;

        /** Captures both saved-image dimensions and the original ARCore image geometry. */
        EncodedFrame(
            File file,
            int width,
            int height,
            int sourceWidth,
            int sourceHeight,
            int sourceRotationDegrees,
            int sourceImageWidth,
            int sourceImageHeight,
            int sourceCropLeft,
            int sourceCropTop,
            int sourceDataSpace,
            String yuvColorConversion
        ) {
            this.file = file;
            this.width = width;
            this.height = height;
            this.sourceWidth = sourceWidth;
            this.sourceHeight = sourceHeight;
            this.sourceRotationDegrees = sourceRotationDegrees;
            this.sourceImageWidth = sourceImageWidth;
            this.sourceImageHeight = sourceImageHeight;
            this.sourceCropLeft = sourceCropLeft;
            this.sourceCropTop = sourceCropTop;
            this.sourceDataSpace = sourceDataSpace;
            this.yuvColorConversion = yuvColorConversion;
        }
    }
}
