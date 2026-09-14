package com.simerfamily.kinsphere.panorama.stitch;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Pure coordinate, bounded overlap-graph and cancellation coverage; ONNX parity is exported separately. */
public final class OnDeviceFeatureMatcherTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void workingSizesRespectPortraitLandscapeAndUnetStride() {
        assertArrayEquals(new int[] { 384, 512 }, OnDeviceFeatureMatcher.workingSize(3024, 4032, 512));
        assertArrayEquals(new int[] { 640, 480 }, OnDeviceFeatureMatcher.workingSize(4032, 3024, 640));
        assertArrayEquals(new int[] { 256, 192 }, OnDeviceFeatureMatcher.workingSize(256, 192, 512));
    }

    @Test
    public void featureCoordinatesReturnToOriginalPixelsWithPixelCenterScaling() {
        assertEquals(2015.5f, OnDeviceFeatureMatcher.originalCoordinate(255.5f, 4032, 512), 0.001f);
        assertEquals(3.4375f, OnDeviceFeatureMatcher.originalCoordinate(0, 4032, 512), 0.001f);
        assertEquals(0, OnDeviceFeatureMatcher.originalCoordinate(-10, 4032, 512), 0.0f);
        assertEquals(4031, OnDeviceFeatureMatcher.originalCoordinate(1000, 4032, 512), 0.0f);
    }

    @Test
    public void matchingGraphFindsLoopClosureAndDoesNotCompareOppositeViews() {
        double[][] forward = new double[8][];
        for (int i = 0; i < forward.length; i++) {
            forward[i] = direction(i * 45, 0);
        }
        Set<String> pairs = pairNames(OnDeviceFeatureMatcher.chooseNeighborPairs(forward));
        assertTrue(pairs.contains("0:7"));
        assertTrue(pairs.contains("0:1"));
        assertFalse(pairs.contains("0:4"));
        assertEquals(8, pairs.size());
    }

    @Test
    public void poleFramesConnectToTheirNeighboringRingWithoutYawSingularity() {
        double[][] forward = new double[][] { direction(0, 82), direction(36, 55),
            direction(108, 55), direction(180, 55), direction(252, 55), direction(324, 55), direction(0, -82) };
        Set<String> pairs = pairNames(OnDeviceFeatureMatcher.chooseNeighborPairs(forward));
        for (int i = 1; i <= 5; i++) {
            assertTrue(pairs.contains("0:" + i));
        }
        assertFalse(pairs.contains("0:6"));
    }

    @Test
    public void unknownPosesStillUseBoundedAdjacentPairs() {
        List<int[]> pairs = OnDeviceFeatureMatcher.chooseNeighborPairs(new double[64][]);
        assertEquals(128, pairs.size());
        assertTrue(pairNames(pairs).contains("0:63"));
    }

    @Test
    public void pairGraphHasNoDuplicatesAndAtMostSixTimesTheFrameCount() {
        double[][] forward = new double[64][];
        for (int i = 0; i < forward.length; i++) {
            forward[i] = direction(i * 360.0 / 64, i % 2 == 0 ? 27 : -27);
        }
        List<int[]> pairs = OnDeviceFeatureMatcher.chooseNeighborPairs(forward);
        assertEquals(pairs.size(), pairNames(pairs).size());
        assertTrue(pairs.size() <= 64 * 6);
    }

    @Test
    public void cancellationCallbackStopsWorkWithCancellationException() {
        OnDeviceFeatureMatcher.Progress cancelled = new OnDeviceFeatureMatcher.Progress() {
            public void onProgress(int percent, String stage) {}
            public boolean isCancelled() { return true; }
        };
        assertThrows(CancellationException.class, () -> OnDeviceFeatureMatcher.checkCancelled(cancelled));
    }

    @Test
    public void updatedModelHashCannotReuseSameLengthOldModel() throws Exception {
        File directory = temporary.newFolder();
        byte[] oldModel = { 1, 2, 3 }, newModel = { 4, 5, 6 };
        File oldFile = cache(directory, oldModel);
        File updated = cache(directory, newModel);
        assertFalse(oldFile.equals(updated));
        assertArrayEquals(oldModel, Files.readAllBytes(oldFile.toPath()));
        assertArrayEquals(newModel, Files.readAllBytes(updated.toPath()));
    }

    @Test
    public void validCacheDoesNotReopenBundledAsset() throws Exception {
        File directory = temporary.newFolder();
        byte[] model = { 1, 2, 3 };
        File cached = cache(directory, model);
        assertEquals(cached, OnDeviceFeatureMatcher.cacheModel(directory, hash(model), model.length,
            () -> { throw new IOException("Asset should not be opened"); }, null));
    }

    @Test
    public void sameLengthCorruptCacheIsReplacedByVerifiedAsset() throws Exception {
        File directory = temporary.newFolder();
        byte[] model = { 1, 2, 3 };
        File cached = cache(directory, model);
        Files.write(cached.toPath(), new byte[] { 9, 9, 9 });
        assertEquals(cached, cache(directory, model));
        assertArrayEquals(model, Files.readAllBytes(cached.toPath()));
        assertEquals(1, directory.list().length);
    }

    @Test
    public void badAssetChecksumCannotReplaceCachedModelAndLeavesNoTemporaryFile() throws Exception {
        File directory = temporary.newFolder();
        byte[] model = { 1, 2, 3 };
        File cached = cache(directory, model);
        byte[] corrupt = { 9, 9, 9 };
        Files.write(cached.toPath(), corrupt);
        assertThrows(IOException.class, () -> OnDeviceFeatureMatcher.cacheModel(directory, hash(model), model.length,
            () -> new ByteArrayInputStream(corrupt), null));
        assertArrayEquals(corrupt, Files.readAllBytes(cached.toPath()));
        assertEquals(1, directory.list().length);
    }

    @Test
    public void cancellationStopsEvenValidCachedModelBeforeSessionInitialization() throws Exception {
        File directory = temporary.newFolder();
        byte[] model = { 1, 2, 3 };
        cache(directory, model);
        assertThrows(CancellationException.class, () -> OnDeviceFeatureMatcher.cacheModel(directory,
            hash(model), model.length, () -> new ByteArrayInputStream(model), cancellation(new AtomicBoolean(true))));
        assertEquals(1, directory.list().length);
    }

    @Test
    public void cancellationDuringCopyClosesSourceAndRemovesPartialFile() throws Exception {
        File directory = temporary.newFolder();
        byte[] model = { 1, 2, 3 };
        AtomicBoolean cancelled = new AtomicBoolean(), closed = new AtomicBoolean();
        OnDeviceFeatureMatcher.ModelSource source = () -> new ByteArrayInputStream(model) {
            @Override public synchronized int read(byte[] bytes, int offset, int length) {
                int count = super.read(bytes, offset, length);
                cancelled.set(true);
                return count;
            }
            @Override public void close() throws IOException {
                closed.set(true);
                super.close();
            }
        };
        assertThrows(CancellationException.class, () -> OnDeviceFeatureMatcher.cacheModel(directory,
            hash(model), model.length, source, cancellation(cancelled)));
        assertTrue(closed.get());
        assertEquals(0, directory.list().length);
    }

    private static File cache(File directory, byte[] bytes) throws Exception {
        return OnDeviceFeatureMatcher.cacheModel(directory, hash(bytes), bytes.length,
            () -> new ByteArrayInputStream(bytes), null);
    }

    private static String hash(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) {
            result.append(String.format(Locale.ROOT, "%02x", value & 255));
        }
        return result.toString();
    }

    private static OnDeviceFeatureMatcher.Progress cancellation(AtomicBoolean cancelled) {
        return new OnDeviceFeatureMatcher.Progress() {
            public void onProgress(int percent, String stage) {}
            public boolean isCancelled() { return cancelled.get(); }
        };
    }

    private static double[] direction(double yawDegrees, double pitchDegrees) {
        double yaw = Math.toRadians(yawDegrees), pitch = Math.toRadians(pitchDegrees);
        return new double[] { Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw) };
    }

    private static Set<String> pairNames(List<int[]> pairs) {
        Set<String> names = new HashSet<>();
        for (int[] pair : pairs) {
            assertTrue(pair[0] < pair[1]);
            names.add(pair[0] + ":" + pair[1]);
        }
        return names;
    }
}
