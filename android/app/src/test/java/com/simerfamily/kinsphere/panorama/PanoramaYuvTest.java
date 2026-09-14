package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Arrays;
import org.junit.Test;

public final class PanoramaYuvTest {
    @Test public void fullRangeKeepsBlackWhiteAndNeutralCodeValues() throws Exception {
        for (int y : new int[] { 0, 16, 128, 235, 255 }) {
            assertEquals(0xff000000 | y * 0x010101, colour(y, 128, 128, PanoramaYuv.ColorModel.BT601_FULL));
        }
    }

    @Test public void limitedRangeExpandsOnlyExplicitLimitedInputs() throws Exception {
        for (PanoramaYuv.ColorModel model : new PanoramaYuv.ColorModel[] {
            PanoramaYuv.ColorModel.BT601_LIMITED, PanoramaYuv.ColorModel.BT709_LIMITED }) {
            assertEquals(0xff000000, colour(16, 128, 128, model));
            assertEquals(0xffffffff, colour(235, 128, 128, model));
            assertEquals(0xff000000, colour(0, 128, 128, model));
            assertEquals(0xffffffff, colour(255, 128, 128, model));
        }
    }

    @Test public void fullRangePrimaryColoursUseVuRatherThanUv() throws Exception {
        assertColour(0xff0000, colour(76, 85, 255, PanoramaYuv.ColorModel.BT601_FULL), 2);
        assertColour(0x00ff00, colour(150, 44, 21, PanoramaYuv.ColorModel.BT601_FULL), 2);
        assertColour(0x0000ff, colour(29, 255, 107, PanoramaYuv.ColorModel.BT601_FULL), 2);
        assertColour(0xff0000, colour(54, 99, 255, PanoramaYuv.ColorModel.BT709_FULL), 2);
    }

    @Test public void limitedRangePrimaryColoursUseSeparateChromaScaling() throws Exception {
        assertColour(0xff0000, colour(81, 90, 240, PanoramaYuv.ColorModel.BT601_LIMITED), 2);
        assertColour(0x00ff00, colour(145, 54, 34, PanoramaYuv.ColorModel.BT601_LIMITED), 2);
        assertColour(0x0000ff, colour(41, 240, 110, PanoramaYuv.ColorModel.BT601_LIMITED), 2);
        assertColour(0xff0000, colour(63, 102, 240, PanoramaYuv.ColorModel.BT709_LIMITED), 2);
    }

    @Test public void defaultAndExplicitDataspacesSelectCorrectRangeAndMatrix() throws Exception {
        assertEquals(PanoramaYuv.ColorModel.BT601_FULL, PanoramaYuv.colorModel(0));
        assertEquals(PanoramaYuv.ColorModel.BT601_FULL, PanoramaYuv.colorModel(0x08c20000)); // JFIF
        assertEquals(PanoramaYuv.ColorModel.BT601_LIMITED, PanoramaYuv.colorModel(0x10c20000));
        assertEquals(PanoramaYuv.ColorModel.BT601_LIMITED, PanoramaYuv.colorModel(0x10c40000));
        assertEquals(PanoramaYuv.ColorModel.BT709_LIMITED, PanoramaYuv.colorModel(0x10c10000));
        assertEquals(PanoramaYuv.ColorModel.BT709_FULL, PanoramaYuv.colorModel(0x08c10000));
        assertEquals(PanoramaYuv.ColorModel.BT601_FULL, PanoramaYuv.colorModel(0x101));
        assertEquals(PanoramaYuv.ColorModel.BT601_LIMITED, PanoramaYuv.colorModel(0x102));
    }

    @Test public void hdrAndUnspecifiedPartialDataspacesAreNotSilentlyMiscoloured() {
        for (int value : new int[] { 0x09c60000, 0x0a060000, 1 << 16, 1 << 27, -1 }) {
            PanoramaYuv.UnsupportedColorSpaceException error = assertThrows(
                PanoramaYuv.UnsupportedColorSpaceException.class, () -> PanoramaYuv.colorModel(value));
            assertEquals(value, error.dataSpace);
        }
    }

    @Test public void paddedPositionedPlanesPackWithoutMutatingBufferPositions() throws Exception {
        ByteBuffer y = ByteBuffer.allocate(25);
        y.position(3);
        for (int row = 0; row < 4; row++) for (int col = 0; col < 4; col++) y.put(3 + row * 6 + col, (byte) (row * 4 + col));
        ByteBuffer u = ByteBuffer.allocate(8), v = ByteBuffer.allocate(8);
        u.position(2); v.position(2);
        u.put(2, (byte) 51); u.put(3, (byte) 52); u.put(6, (byte) 53); u.put(7, (byte) 54);
        v.put(2, (byte) 61); v.put(3, (byte) 62); v.put(6, (byte) 63); v.put(7, (byte) 64);
        byte[] output = PanoramaYuv.copyNv21(new ByteBuffer[] { y, u, v }, new int[] { 6, 4, 4 }, new int[] { 1, 1, 1 }, 4, 4);
        for (int index = 0; index < 16; index++) assertEquals(index, output[index]);
        assertArrayEquals(new byte[] { 61, 51, 62, 52, 63, 53, 64, 54 }, Arrays.copyOfRange(output, 16, 24));
        assertEquals(3, y.position()); assertEquals(2, u.position()); assertEquals(2, v.position());
    }

    @Test public void sharedSemiplanarBuffersRespectPixelStrideAndTruncatedLastPadding() throws Exception {
        ByteBuffer y = ByteBuffer.wrap(new byte[16]);
        ByteBuffer shared = ByteBuffer.wrap(new byte[] { 61, 51, 62, 52, 0, 0, 63, 53, 64, 54 });
        ByteBuffer v = shared.duplicate(), u = shared.duplicate(); u.position(1);
        byte[] output = PanoramaYuv.copyNv21(new ByteBuffer[] { y, u, v }, new int[] { 4, 6, 6 }, new int[] { 1, 2, 2 }, 4, 4);
        assertArrayEquals(new byte[] { 61, 51, 62, 52, 63, 53, 64, 54 }, Arrays.copyOfRange(output, 16, 24));
        assertEquals(1, u.position()); assertEquals(0, v.position());
    }

    @Test public void oddCropOriginKeepsTheOriginalChromaPhase() throws Exception {
        byte[] nv21 = new byte[24]; Arrays.fill(nv21, 0, 16, (byte) 128);
        byte[] chroma = { (byte) 255, (byte) 128, (byte) 128, (byte) 255, 0, (byte) 128, (byte) 128, 0 };
        System.arraycopy(chroma, 0, nv21, 16, 8);
        int[] full = new int[16], crop = new int[4];
        PanoramaYuv.convertRows(nv21, 4, 4, 0, 0, 4, 4, 0, 4, PanoramaYuv.ColorModel.BT601_FULL, full);
        PanoramaYuv.convertRows(nv21, 4, 4, 1, 1, 2, 2, 0, 2, PanoramaYuv.ColorModel.BT601_FULL, crop);
        assertArrayEquals(new int[] { full[5], full[6], full[9], full[10] }, crop);
        int[] row = new int[2];
        PanoramaYuv.convertRows(nv21, 4, 4, 1, 1, 2, 2, 1, 1, PanoramaYuv.ColorModel.BT601_FULL, row);
        assertArrayEquals(new int[] { crop[2], crop[3] }, row);
        assertArrayEquals(chroma, Arrays.copyOfRange(nv21, 16, 24));
    }

    @Test public void refusesOversizedTruncatedOrOutOfBoundsInput() {
        assertThrows(IOException.class, () -> PanoramaYuv.pixelCount(Integer.MAX_VALUE, 2));
        assertThrows(IOException.class, () -> PanoramaYuv.pixelCount(3, 4));
        assertThrows(IOException.class, () -> PanoramaYuv.validateCrop(4, 4, 3, 0, 2, 2));
        assertThrows(IOException.class, () -> PanoramaYuv.copyNv21(new ByteBuffer[] { ByteBuffer.allocate(15), ByteBuffer.allocate(4), ByteBuffer.allocate(4) }, new int[] { 4, 2, 2 }, new int[] { 1, 1, 1 }, 4, 4));
        assertThrows(IOException.class, () -> PanoramaYuv.convertRows(new byte[24], 4, 4, 0, 0, 4, 4, 0, 2, PanoramaYuv.ColorModel.BT601_FULL, new int[7]));
    }

    @Test public void sharpnessRanksEdgesWithoutRejectingAnUntexturedWall() {
        byte[] flat = new byte[64 * 48 * 3 / 2]; Arrays.fill(flat, (byte) 128);
        byte[] soft = flat.clone(), sharp = flat.clone();
        for (int y = 0; y < 48; y++) for (int x = 0; x < 64; x++) {
            if ((x & 1) == 0) {
                soft[y * 64 + x] = (byte) 160;
                sharp[y * 64 + x] = (byte) 255;
            }
        }
        assertEquals(0.0, PanoramaYuv.lumaSharpness(flat, 64, 0, 0, 64, 48), 0.0);
        double softerScore = PanoramaYuv.lumaSharpness(soft, 64, 0, 0, 64, 48);
        assertTrue(softerScore > 0.0);
        assertTrue(PanoramaYuv.lumaSharpness(sharp, 64, 0, 0, 64, 48) > softerScore);
        assertEquals(0.0, PanoramaYuv.lumaSharpness(sharp, 64, 1, 1, 4, 4), 0.0);
    }

    @Test public void sharpnessUsesOnlyCropLumaAndLeavesSourceUntouched() {
        byte[] input = new byte[64 * 48 * 3 / 2]; Arrays.fill(input, (byte) 128);
        for (int y = 0; y < 48; y++) for (int x = 0; x < 16; x++) input[y * 64 + x] = (byte) ((x & 1) * 255);
        Arrays.fill(input, 64 * 48, input.length, (byte) 255);
        byte[] saved = input.clone();
        assertTrue(PanoramaYuv.lumaSharpness(input, 64, 0, 0, 64, 48) > 0.0);
        assertEquals(0.0, PanoramaYuv.lumaSharpness(input, 64, 17, 3, 32, 40), 0.0);
        assertArrayEquals(saved, input);
    }

    private static int colour(int y, int u, int v, PanoramaYuv.ColorModel model) throws Exception {
        byte[] nv21 = { (byte) y, (byte) y, (byte) y, (byte) y, (byte) v, (byte) u };
        int[] rgb = new int[4];
        PanoramaYuv.convertRows(nv21, 2, 2, 0, 0, 2, 2, 0, 2, model, rgb);
        for (int pixel : rgb) assertEquals(rgb[0], pixel);
        return rgb[0];
    }

    private static void assertColour(int expected, int actual, int tolerance) {
        for (int shift : new int[] { 0, 8, 16 }) assertEquals((expected >>> shift) & 255, (actual >>> shift) & 255, tolerance);
        assertEquals(255, actual >>> 24);
    }
}
