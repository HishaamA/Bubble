package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.media.Image;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.File;
import java.nio.ByteBuffer;
import java.util.Arrays;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Synthetic pixels only: never opens a camera or modifies a user's capture. */
@RunWith(AndroidJUnit4.class)
public final class ArCapturedImageInstrumentedTest {
    @Test public void captureActivityBytecodeVerifiesWithoutLaunchingCameraUi() throws Exception {
        Class<?> captureActivity = Class.forName(PanoramaCaptureActivity.class.getName());
        assertTrue(captureActivity.getDeclaredMethods().length > 0);
        assertNotNull(captureActivity.getDeclaredConstructor());
    }

    @Test public void inheritedUnavailableDataSpaceStillCopiesLiveArCoreImage() throws Exception {
        TestImage pixels = new TestImage(128, 96, new Rect(16, 8, 112, 88), 0);
        ArCoreLikeImage source = new ArCoreLikeImage(pixels);
        if (Build.VERSION.SDK_INT >= 33) {
            // Reproduce the real ARCore boundary, not just the downstream plane helper.
            assertThrows(IllegalStateException.class, source::getDataSpace);
        }
        ArCapturedImage captured = ArCapturedImage.copyOf(source);
        for (TestPlane plane : pixels.planes) assertEquals(0, plane.buffer.position());
        source.close();
        File output = temporaryJpeg("capture-inherited-metadata-");
        Bitmap decoded = null;
        try {
            ArCapturedImage.EncodedFrame frame = captured.encode(output, 0, 0, 96);
            assertEquals(0, frame.sourceDataSpace);
            assertEquals("BT601_FULL", frame.yuvColorConversion);
            assertEquals(96, frame.width); assertEquals(80, frame.height);
            decoded = BitmapFactory.decodeFile(output.getAbsolutePath());
            assertNotNull(decoded);
            assertColour(0xff0000, decoded.getPixel(16, 16), 6);
            assertColour(0x808080, decoded.getPixel(80, 64), 6);
        } finally {
            if (decoded != null) decoded.recycle();
            assertTrue(output.delete());
        }
    }

    @Test public void unavailableMetadataDoesNotHideActuallyClosedSource() {
        ArCoreLikeImage source = new ArCoreLikeImage(new TestImage(16, 16, new Rect(0, 0, 16, 16), 0));
        source.close();
        IllegalStateException error = assertThrows(IllegalStateException.class,
            () -> ArCapturedImage.copyOf(source));
        assertEquals("Synthetic camera image is closed", error.getMessage());
    }

    @Test public void explicitSupportedDataSpaceAndCropSurvivePublicImageCopy() throws Exception {
        Assume.assumeTrue(Build.VERSION.SDK_INT >= 33);
        int bt709Limited = 0x10c10000;
        TestImage pixels = new TestImage(128, 96, new Rect(16, 8, 112, 88), bt709Limited);
        ArCoreLikeImage source = new ArCoreLikeImage(pixels) {
            @Override public int getDataSpace() { return bt709Limited; }
        };
        ArCapturedImage captured = ArCapturedImage.copyOf(source);
        source.close();
        File output = temporaryJpeg("capture-explicit-metadata-");
        try {
            ArCapturedImage.EncodedFrame frame = captured.encode(output, 90, 0, 96);
            assertEquals(bt709Limited, frame.sourceDataSpace);
            assertEquals("BT709_LIMITED", frame.yuvColorConversion);
            assertEquals(128, frame.sourceImageWidth); assertEquals(96, frame.sourceImageHeight);
            assertEquals(16, frame.sourceCropLeft); assertEquals(8, frame.sourceCropTop);
            assertEquals(96, frame.sourceWidth); assertEquals(80, frame.sourceHeight);
            assertEquals(80, frame.width); assertEquals(96, frame.height);
            assertTrue(output.length() > 0);
        } finally { assertTrue(output.delete()); }
    }

    @Test public void explicitUnsupportedDataSpaceIsNotSilentlyReplaced() {
        Assume.assumeTrue(Build.VERSION.SDK_INT >= 33);
        int unsupported = 0x09c60000; // BT.2020 / HLG is not the SDR fallback.
        ArCoreLikeImage source = new ArCoreLikeImage(new TestImage(16, 16, new Rect(0, 0, 16, 16), unsupported)) {
            @Override public int getDataSpace() { return unsupported; }
        };
        try {
            PanoramaYuv.UnsupportedColorSpaceException error = assertThrows(
                PanoramaYuv.UnsupportedColorSpaceException.class, () -> ArCapturedImage.copyOf(source));
            assertEquals(unsupported, error.dataSpace);
        } finally { source.close(); }
    }

    @Test public void finalJpegPreservesCropRotationColoursAndDetachedOwnership() throws Exception {
        TestImage source = new TestImage(128, 96, new Rect(16, 8, 112, 88), 0x08c20000);
        ArCapturedImage captured = source.copy();
        for (TestPlane plane : source.planes) assertEquals(0, plane.buffer.position());
        source.close(); // Simulates ARCore immediately reclaiming/reusing every input byte.
        Context context = ApplicationProvider.getApplicationContext();
        File output = File.createTempFile("capture-pixels-", ".jpg", context.getCacheDir());
        Bitmap decoded = null;
        try {
            ArCapturedImage.EncodedFrame frame = captured.encode(output, 90, 40, 96);
            assertEquals(40, frame.width); assertEquals(48, frame.height);
            assertEquals(128, frame.sourceImageWidth); assertEquals(96, frame.sourceImageHeight);
            assertEquals(16, frame.sourceCropLeft); assertEquals(8, frame.sourceCropTop);
            assertEquals(96, frame.sourceWidth); assertEquals(80, frame.sourceHeight);
            assertEquals(90, frame.sourceRotationDegrees);
            assertEquals("BT601_FULL", frame.yuvColorConversion);
            decoded = BitmapFactory.decodeFile(output.getAbsolutePath());
            assertNotNull(decoded);
            assertEquals(40, decoded.getWidth()); assertEquals(48, decoded.getHeight());
            assertColour(0x0000ff, decoded.getPixel(10, 12), 6); // bottom-left -> top-left
            assertColour(0xff0000, decoded.getPixel(30, 12), 6); // top-left -> top-right
            assertColour(0x808080, decoded.getPixel(10, 36), 6);
            assertColour(0x00ff00, decoded.getPixel(30, 36), 6);
        } finally {
            if (decoded != null) decoded.recycle();
            assertTrue(output.delete());
        }
    }

    @Test public void nativeSizedConversionReportsBoundedEncodingTime() throws Exception {
        TestImage source = new TestImage(1920, 1080, new Rect(0, 0, 1920, 1080), 0);
        long start = SystemClock.elapsedRealtime();
        ArCapturedImage captured = source.copy();
        long copied = SystemClock.elapsedRealtime();
        source.close();
        Context context = ApplicationProvider.getApplicationContext();
        File output = File.createTempFile("capture-timing-", ".jpg", context.getCacheDir());
        try {
            ArCapturedImage.EncodedFrame frame = captured.encode(output, 90, 0, 92);
            Log.i("BubbleCapturePixels", "Synthetic1920x1080 copyMs=" + (copied - start)
                + " encodeMs=" + (SystemClock.elapsedRealtime() - copied) + " finalBytes=" + output.length());
            assertEquals(1080, frame.width); assertEquals(1920, frame.height);
            assertTrue(output.length() > 0);
        } finally { assertTrue(output.delete()); }
    }

    private static void assertColour(int expected, int actual, int tolerance) {
        for (int shift : new int[] { 0, 8, 16 }) assertEquals((expected >>> shift) & 255, (actual >>> shift) & 255, tolerance);
    }

    private static File temporaryJpeg(String prefix) throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        return File.createTempFile(prefix, ".jpg", context.getCacheDir());
    }

    /**
     * Use ARCore's own public Image/Plane bridges: the SDK's Image constructors
     * are hidden. Like ArImage, this never sets the framework lifetime flag and
     * deliberately inherits Image.getDataSpace(), while owning valid YUV planes.
     */
    private static class ArCoreLikeImage extends com.google.ar.core.dependencies.b {
        private final TestImage pixels;
        private boolean closed;

        ArCoreLikeImage(TestImage pixels) { this.pixels = pixels; }
        private void requireOpen() {
            if (closed) throw new IllegalStateException("Synthetic camera image is closed");
        }
        @Override public int getFormat() { requireOpen(); return ImageFormat.YUV_420_888; }
        @Override public int getWidth() { requireOpen(); return pixels.width; }
        @Override public int getHeight() { requireOpen(); return pixels.height; }
        @Override public long getTimestamp() { requireOpen(); return 1_000_000_000L; }
        @Override public Rect getCropRect() { requireOpen(); return new Rect(pixels.crop); }
        @Override public Image.Plane[] getPlanes() {
            requireOpen();
            Image.Plane[] result = new Image.Plane[pixels.planes.length];
            for (int index = 0; index < result.length; index++) {
                TestPlane plane = pixels.planes[index];
                result[index] = new com.google.ar.core.dependencies.a() {
                    @Override public ByteBuffer getBuffer() { requireOpen(); return plane.buffer; }
                    @Override public int getRowStride() { requireOpen(); return plane.rowStride; }
                    @Override public int getPixelStride() { requireOpen(); return plane.pixelStride; }
                };
            }
            return result;
        }
        @Override public void close() { closed = true; pixels.close(); }
    }

    private static final class TestImage {
        private final int width, height, dataSpace;
        private final Rect crop;
        private final TestPlane[] planes;

        TestImage(int width, int height, Rect crop, int dataSpace) {
            this.width = width; this.height = height; this.crop = new Rect(crop); this.dataSpace = dataSpace;
            planes = new TestPlane[] { new TestPlane(width, height, 1), new TestPlane(width / 2, height / 2, 2), new TestPlane(width / 2, height / 2, 2) };
            int[][] yuv = { { 76, 85, 255 }, { 150, 44, 21 }, { 29, 255, 107 }, { 128, 128, 128 } };
            for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
                int[] value = yuv[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
                planes[0].put(x, y, value[0]);
                if ((x & 1) == 0 && (y & 1) == 0) { planes[1].put(x / 2, y / 2, value[1]); planes[2].put(x / 2, y / 2, value[2]); }
            }
        }
        ArCapturedImage copy() throws Exception {
            return ArCapturedImage.copyOfPlanes(width, height, crop, dataSpace,
                new ByteBuffer[] { planes[0].buffer, planes[1].buffer, planes[2].buffer },
                new int[] { planes[0].rowStride, planes[1].rowStride, planes[2].rowStride },
                new int[] { planes[0].pixelStride, planes[1].pixelStride, planes[2].pixelStride });
        }
        void close() { for (TestPlane plane : planes) Arrays.fill(plane.buffer.array(), (byte) 0); }
    }

    private static final class TestPlane {
        private final int rowStride, pixelStride;
        private final ByteBuffer buffer;
        TestPlane(int width, int height, int pixelStride) {
            this.pixelStride = pixelStride; rowStride = width * pixelStride + 8;
            // Last row has no allocation for trailing padding, as on some camera devices.
            buffer = ByteBuffer.allocate((height - 1) * rowStride + (width - 1) * pixelStride + 1);
        }
        void put(int x, int y, int value) { buffer.put(y * rowStride + x * pixelStride, (byte) value); }
    }
}
