package com.simerfamily.kinsphere.panorama;

import java.io.IOException;
import java.nio.ByteBuffer;

/** Android-independent, bounded YUV plane copying and SDR colour conversion. */
final class PanoramaYuv {
    static final int MAX_SOURCE_PIXELS = 16_777_216;

    enum ColorModel {
        BT601_FULL(0.299, 0.114, false),
        BT601_LIMITED(0.299, 0.114, true),
        BT709_FULL(0.2126, 0.0722, false),
        BT709_LIMITED(0.2126, 0.0722, true);

        final int yOffset, yScale, redV, greenU, greenV, blueU;

        ColorModel(double kr, double kb, boolean limited) {
            yOffset = limited ? 16 : 0;
            double chromaScale = limited ? 255.0 / 224.0 : 1.0;
            yScale = fixed(limited ? 255.0 / 219.0 : 1.0);
            redV = fixed(2 * (1 - kr) * chromaScale);
            blueU = fixed(2 * (1 - kb) * chromaScale);
            greenU = fixed(2 * kb * (1 - kb) / (1 - kr - kb) * chromaScale);
            greenV = fixed(2 * kr * (1 - kr) / (1 - kr - kb) * chromaScale);
        }

        private static int fixed(double value) { return (int) Math.round(value * 65_536); }
    }

    private PanoramaYuv() {}

    /** A persistent camera capability mismatch, not a transient image-availability failure. */
    static final class UnsupportedColorSpaceException extends IOException {
        final int dataSpace;
        UnsupportedColorSpaceException(int dataSpace) {
            super("The AR camera image uses an unsupported colour space.");
            this.dataSpace = dataSpace;
        }
    }

    /**
     * Android PublicFormat.cpp maps default YUV_420_888/NV21 to full-range JFIF.
     * Image.getDataSpace() can override it on API 33+. These are the public
     * DataSpace bit fields, kept numeric so this helper is testable without Android.
     * Do not expand a full-range camera frame as if its luma were limited 16..235.
     * https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/libs/ui/PublicFormat.cpp
     */
    static ColorModel colorModel(int dataSpace) throws IOException {
        if (dataSpace == 0 || dataSpace == 0x101) return ColorModel.BT601_FULL;
        if (dataSpace == 0x102 || dataSpace == 0x103) return ColorModel.BT601_LIMITED;
        if (dataSpace == 0x104) return ColorModel.BT709_LIMITED;
        int standard = (dataSpace >>> 16) & 63;
        int transfer = (dataSpace >>> 22) & 31;
        int range = (dataSpace >>> 27) & 7;
        // Only SDR, full/limited-range BT.601 (adjusted) and BT.709 are supported.
        // HDR/wide-gamut data needs a real colour-management/tone-mapping path.
        if ((transfer != 0 && transfer != 2 && transfer != 3)
            || (range != 1 && range != 2)) throw new UnsupportedColorSpaceException(dataSpace);
        if (standard == 1) return range == 1 ? ColorModel.BT709_FULL : ColorModel.BT709_LIMITED;
        if (standard == 2 || standard == 4) return range == 1 ? ColorModel.BT601_FULL : ColorModel.BT601_LIMITED;
        throw new UnsupportedColorSpaceException(dataSpace);
    }

    static int pixelCount(int width, int height) throws IOException {
        long count = (long) width * height;
        if (width <= 0 || height <= 0 || (width & 1) != 0 || (height & 1) != 0
            || count > MAX_SOURCE_PIXELS) throw new IOException("The AR camera image dimensions are invalid or too large.");
        return (int) count;
    }

    /** Copy full sensor planes, retaining chroma phase even for an odd crop origin. */
    static byte[] copyNv21(ByteBuffer[] planes, int[] rowStrides, int[] pixelStrides,
        int width, int height) throws IOException {
        int count = pixelCount(width, height);
        if (planes == null || planes.length != 3 || rowStrides == null || rowStrides.length != 3
            || pixelStrides == null || pixelStrides.length != 3) throw new IOException("The camera image planes are incomplete.");
        byte[] packed = new byte[count + count / 2];
        copyPlane(planes[0], rowStrides[0], pixelStrides[0], width, height, packed, 0, 1);
        // NV21 is interleaved Cr (V) followed by Cb (U), not NV12's U/V ordering.
        copyPlane(planes[2], rowStrides[2], pixelStrides[2], width / 2, height / 2, packed, count, 2);
        copyPlane(planes[1], rowStrides[1], pixelStrides[1], width / 2, height / 2, packed, count + 1, 2);
        return packed;
    }

    private static void copyPlane(ByteBuffer input, int rowStride, int pixelStride,
        int width, int height, byte[] destination, int offset, int destinationStride) throws IOException {
        if (input == null || rowStride <= 0 || pixelStride <= 0
            || (long) (width - 1) * pixelStride + 1 > rowStride) throw new IOException("The camera image strides are invalid.");
        ByteBuffer buffer = input.duplicate();
        long finalIndex = buffer.position() + (long) (height - 1) * rowStride + (long) (width - 1) * pixelStride;
        if (finalIndex >= buffer.limit()) throw new IOException("The camera image planes were truncated.");
        int start = buffer.position();
        for (int row = 0; row < height; row++) {
            int sourceOffset = start + row * rowStride;
            if (pixelStride == 1 && destinationStride == 1) {
                buffer.position(sourceOffset);
                buffer.get(destination, offset, width);
                offset += width;
            } else {
                for (int column = 0; column < width; column++) {
                    destination[offset] = buffer.get(sourceOffset + column * pixelStride);
                    offset += destinationStride;
                }
            }
        }
    }

    static void validateCrop(int imageWidth, int imageHeight, int left, int top, int width, int height) throws IOException {
        pixelCount(imageWidth, imageHeight);
        if (left < 0 || top < 0 || width <= 0 || height <= 0
            || (long) left + width > imageWidth || (long) top + height > imageHeight)
            throw new IOException("The AR camera crop is outside the source image.");
    }

    /** Converts at most the requested row tile; no full-frame RGB array is allocated. */
    static void convertRows(byte[] nv21, int imageWidth, int imageHeight,
        int cropLeft, int cropTop, int cropWidth, int cropHeight, int firstRow, int rowCount,
        ColorModel model, int[] argb) throws IOException {
        validateCrop(imageWidth, imageHeight, cropLeft, cropTop, cropWidth, cropHeight);
        int count = imageWidth * imageHeight;
        if (nv21 == null || nv21.length != count + count / 2 || model == null || argb == null
            || firstRow < 0 || rowCount <= 0 || (long) firstRow + rowCount > cropHeight
            || (long) cropWidth * rowCount > argb.length) throw new IOException("The camera conversion tile is invalid.");
        int output = 0;
        for (int row = firstRow; row < firstRow + rowCount; row++) {
            int y = cropTop + row;
            int lumaOffset = y * imageWidth + cropLeft;
            int chromaOffset = count + (y / 2) * imageWidth;
            for (int column = 0; column < cropWidth; column++) {
                int pair = chromaOffset + ((cropLeft + column) & ~1);
                int v = (nv21[pair] & 255) - 128;
                int u = (nv21[pair + 1] & 255) - 128;
                int luma = ((nv21[lumaOffset + column] & 255) - model.yOffset) * model.yScale;
                int red = channel(luma + model.redV * v);
                int green = channel(luma - model.greenU * u - model.greenV * v);
                int blue = channel(luma + model.blueU * u);
                argb[output++] = 0xff000000 | (red << 16) | (green << 8) | blue;
            }
        }
    }

    /** Sparse luma second differences, matching iOS's focus ranking rather than a texture gate. */
    static double lumaSharpness(byte[] nv21, int imageWidth,
        int cropLeft, int cropTop, int cropWidth, int cropHeight) {
        int step = Math.max(4, Math.min(cropWidth, cropHeight) / 180);
        if (cropWidth <= step * 2 || cropHeight <= step * 2) return 0.0;
        long energy = 0;
        int samples = 0;
        for (int y = step; y < cropHeight - step; y += step) {
            int row = (cropTop + y) * imageWidth + cropLeft;
            for (int x = step; x < cropWidth - step; x += step) {
                int centre = nv21[row + x] & 255;
                energy += Math.abs(centre * 2 - (nv21[row + x - 1] & 255) - (nv21[row + x + 1] & 255));
                energy += Math.abs(centre * 2 - (nv21[row + x - imageWidth] & 255) - (nv21[row + x + imageWidth] & 255));
                samples++;
            }
        }
        return samples == 0 ? 0.0 : energy / (double) samples;
    }

    private static int channel(int fixed) { return Math.max(0, Math.min(255, (fixed + 32_768) >> 16)); }
}
