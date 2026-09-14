package com.simerfamily.kinsphere.panorama.stitch;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CancellationException;

/** Offline learned DISK extraction and LightGlue matching, on a background worker. */
public final class OnDeviceFeatureMatcher {
    private static final String ASSET_DIRECTORY = "stitch-models/";
    private static final int MAX_FRAMES = 64;
    private static final int DESCRIPTOR_SIZE = 128;
    private static final int MAX_MODEL_KEYPOINTS = 1024;
    private static final int NEIGHBORS_PER_FRAME = 6;
    private static final String MODEL_NAME = "DISK-depth + LightGlue-DISK (ONNX, on-device)";

    public interface Progress {
        void onProgress(int percent, String stage);
        boolean isCancelled();
    }

    private OnDeviceFeatureMatcher() {}

    /** The manifest must identify validated local JPEGs with original pixel dimensions. */
    public static JSONObject match(Context context, JSONObject normalizedManifest, Progress progress) throws Exception {
        JSONArray frames = normalizedManifest.getJSONArray("frames");
        if (frames.length() < 2 || frames.length() > MAX_FRAMES) {
            throw new IllegalArgumentException("On-device matching requires 2–64 frames.");
        }
        int longSide = Math.max(384, Math.min(640, normalizedManifest.optInt("featureLongSide", 512)));
        int maxKeypoints = Math.max(256, Math.min(MAX_MODEL_KEYPOINTS, normalizedManifest.optInt("maxKeypoints", 768)));
        checkCancelled(progress);
        publish(progress, 0, "Loading offline matching models");
        JSONObject modelReport = new JSONObject(readAssetText(context, "model-report.json"));
        File diskFile = cacheModel(context, "disk-1024.onnx", modelReport.getJSONObject("extractor"), progress);
        File glueFile = cacheModel(context, "disk-lightglue.onnx", modelReport.getJSONObject("matcher"), progress);
        Feature[] features = new Feature[frames.length()];
        OrtEnvironment environment = OrtEnvironment.getEnvironment();
        long extractionStarted = System.nanoTime();
        // Release extractor activations and session before loading the matcher.
        checkCancelled(progress);
        try (OrtSession.SessionOptions options = sessionOptions();
             OrtSession extractor = environment.createSession(diskFile.getAbsolutePath(), options)) {
            for (int i = 0; i < frames.length(); i++) {
                checkCancelled(progress);
                features[i] = extract(environment, extractor, frames.getJSONObject(i), longSide, maxKeypoints, progress);
                publish(progress, 5 + (i + 1) * 40 / frames.length(),
                    "Finding image details " + (i + 1) + " of " + frames.length());
            }
        }
        long extractionMillis = (System.nanoTime() - extractionStarted) / 1_000_000L;
        List<int[]> neighbors = chooseNeighborPairs(frames);
        JSONArray pairs = new JSONArray();
        int inferencePairs = 0;
        int evaluatedLayers = 0;
        long matchingStarted = System.nanoTime();
        checkCancelled(progress);
        try (OrtSession.SessionOptions options = sessionOptions();
             OrtSession matcher = environment.createSession(glueFile.getAbsolutePath(), options)) {
            for (int pairIndex = 0; pairIndex < neighbors.size(); pairIndex++) {
                checkCancelled(progress);
                int[] pair = neighbors.get(pairIndex);
                Feature first = features[pair[0]], second = features[pair[1]];
                if (first.count >= 8 && second.count >= 8) {
                    JSONObject matched = matchPair(environment, matcher, pair, first, second, progress);
                    pairs.put(matched);
                    evaluatedLayers += matched.getInt("layers");
                    inferencePairs++;
                }
                publish(progress, 45 + (pairIndex + 1) * 55 / Math.max(1, neighbors.size()),
                    "Matching overlapping photos " + (pairIndex + 1) + " of " + neighbors.size());
            }
        }
        checkCancelled(progress);
        JSONArray counts = new JSONArray();
        for (Feature feature : features) {
            counts.put(feature.count);
        }
        return new JSONObject().put("model", MODEL_NAME).put("aiUsed", inferencePairs > 0)
            .put("pairs", pairs).put("featureCounts", counts).put("candidatePairs", neighbors.size())
            .put("inferencePairs", inferencePairs).put("featureLongSide", longSide).put("maxKeypoints", maxKeypoints)
            .put("adaptiveDepth", modelReport.optBoolean("adaptiveDepth", false))
            .put("averageMatcherLayers", inferencePairs == 0 ? 0 : evaluatedLayers / (double) inferencePairs)
            .put("extractionMillis", extractionMillis)
            .put("matchingMillis", (System.nanoTime() - matchingStarted) / 1_000_000L);
    }

    private static OrtSession.SessionOptions sessionOptions() throws Exception {
        OrtSession.SessionOptions options = new OrtSession.SessionOptions();
        options.setIntraOpNumThreads(2);
        options.setInterOpNumThreads(1);
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        // Variable image/feature counts should not retain each previous allocation pattern.
        options.setMemoryPatternOptimization(false);
        options.setCPUArenaAllocator(false);
        return options;
    }

    private static Feature extract(OrtEnvironment environment, OrtSession extractor, JSONObject frame,
                                   int longSide, int maxKeypoints, Progress progress) throws Exception {
        String path = frame.getString("filePath");
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(path, bounds);
        int width = frame.getInt("width"), height = frame.getInt("height");
        if (width <= 0 || height <= 0 || bounds.outWidth != width || bounds.outHeight != height) {
            throw new IOException("A source photo does not match its calibrated dimensions.");
        }
        int[] size = workingSize(width, height, longSide);
        BitmapFactory.Options decode = new BitmapFactory.Options();
        decode.inPreferredConfig = Bitmap.Config.ARGB_8888;
        decode.inSampleSize = 1;
        while (width / (decode.inSampleSize * 2) >= size[0] && height / (decode.inSampleSize * 2) >= size[1]) {
            decode.inSampleSize *= 2;
        }
        Bitmap source = BitmapFactory.decodeFile(path, decode);
        if (source == null) {
            throw new IOException("A source photo could not be decoded.");
        }
        Bitmap resized = null;
        float[] pixels;
        try {
            checkCancelled(progress);
            pixels = new float[3 * size[0] * size[1]];
            resized = Bitmap.createScaledBitmap(source, size[0], size[1], true);
            int planeSize = size[0] * size[1];
            int[] row = new int[size[0]];
            for (int y = 0; y < size[1]; y++) {
                checkCancelled(progress);
                resized.getPixels(row, 0, size[0], 0, y, size[0], 1);
                for (int x = 0; x < size[0]; x++) {
                    int index = y * size[0] + x, color = row[x];
                    pixels[index] = ((color >>> 16) & 255) / 255.0f;
                    pixels[planeSize + index] = ((color >>> 8) & 255) / 255.0f;
                    pixels[2 * planeSize + index] = (color & 255) / 255.0f;
                }
            }
        } finally {
            if (resized != null && resized != source) {
                resized.recycle();
            }
            source.recycle();
        }
        checkCancelled(progress);
        try (OnnxTensor input = OnnxTensor.createTensor(environment, FloatBuffer.wrap(pixels), new long[] { 1, 3, size[1], size[0] });
             OrtSession.Result output = extractor.run(Collections.singletonMap("image", input))) {
            checkCancelled(progress);
            float[][] points = ((float[][][]) output.get("keypoints").get().getValue())[0];
            float[][] descriptors = ((float[][][]) output.get("descriptors").get().getValue())[0];
            float[] scores = ((float[][]) output.get("scores").get().getValue())[0];
            int count = 0;
            while (count < Math.min(maxKeypoints, scores.length) && scores[count] > 0 && Float.isFinite(scores[count])) {
                count++;
            }
            Feature feature = new Feature(count);
            float normalizer = Math.max(size[0], size[1]) / 2.0f;
            for (int i = 0; i < count; i++) {
                feature.normalizedPoints[2 * i] = (points[i][0] - size[0] / 2.0f) / normalizer;
                feature.normalizedPoints[2 * i + 1] = (points[i][1] - size[1] / 2.0f) / normalizer;
                feature.originalPoints[2 * i] = originalCoordinate(points[i][0], width, size[0]);
                feature.originalPoints[2 * i + 1] = originalCoordinate(points[i][1], height, size[1]);
                System.arraycopy(descriptors[i], 0, feature.descriptors, i * DESCRIPTOR_SIZE, DESCRIPTOR_SIZE);
            }
            return feature;
        }
    }

    private static JSONObject matchPair(OrtEnvironment environment, OrtSession matcher, int[] pair,
                                        Feature first, Feature second, Progress progress) throws Exception {
        Map<String, OnnxTensor> inputs = new HashMap<>();
        try {
            inputs.put("keypoints0", tensor(environment, first.normalizedPoints, first.count, 2));
            inputs.put("keypoints1", tensor(environment, second.normalizedPoints, second.count, 2));
            inputs.put("descriptors0", tensor(environment, first.descriptors, first.count, DESCRIPTOR_SIZE));
            inputs.put("descriptors1", tensor(environment, second.descriptors, second.count, DESCRIPTOR_SIZE));
            try (OrtSession.Result result = matcher.run(inputs)) {
                checkCancelled(progress);
                long[] matches = ((long[][]) result.get("matches0").get().getValue())[0];
                float[] confidence = ((float[][]) result.get("confidence0").get().getValue())[0];
                // Full-depth rollback models omit this optional diagnostic output.
                int layers = result.get("layers").isPresent()
                    ? (int) ((long[]) result.get("layers").get().getValue())[0] : 9;
                JSONArray points0 = new JSONArray(), points1 = new JSONArray(), scores = new JSONArray();
                for (int i = 0; i < matches.length; i++) {
                    int j = (int) matches[i];
                    if (j >= 0 && j < second.count && Float.isFinite(confidence[i]) && confidence[i] > 0.1f) {
                        points0.put(new JSONArray().put(first.originalPoints[2 * i]).put(first.originalPoints[2 * i + 1]));
                        points1.put(new JSONArray().put(second.originalPoints[2 * j]).put(second.originalPoints[2 * j + 1]));
                        scores.put(confidence[i]);
                    }
                }
                return new JSONObject().put("i", pair[0]).put("j", pair[1])
                    .put("points0", points0).put("points1", points1).put("scores", scores).put("layers", layers);
            }
        } finally {
            for (OnnxTensor tensor : inputs.values()) {
                tensor.close();
            }
        }
    }

    private static OnnxTensor tensor(OrtEnvironment environment, float[] values, int count, int dimensions) throws Exception {
        return OnnxTensor.createTensor(environment, FloatBuffer.wrap(values), new long[] { 1, count, dimensions });
    }

    /** Select nearest camera directions, including loop closure and pole-to-ring overlap. */
    static List<int[]> chooseNeighborPairs(JSONArray frames) throws Exception {
        double[][] forwards = new double[frames.length()][];
        for (int i = 0; i < frames.length(); i++) {
            forwards[i] = forward(frames.getJSONObject(i));
        }
        return chooseNeighborPairs(forwards);
    }

    static List<int[]> chooseNeighborPairs(double[][] forwards) {
        int frameCount = forwards.length;
        boolean[][] chosen = new boolean[frameCount][frameCount];
        for (int i = 0; i < frameCount; i++) {
            final int current = i;
            List<Integer> candidates = new ArrayList<>();
            for (int j = 0; j < frameCount; j++) {
                if (i != j && angle(forwards[i], forwards[j]) <= 85.0) {
                    candidates.add(j);
                }
            }
            candidates.sort(Comparator.comparingDouble(j -> angle(forwards[current], forwards[j])));
            for (int k = 0; k < Math.min(NEIGHBORS_PER_FRAME, candidates.size()); k++) {
                int j = candidates.get(k);
                chosen[Math.min(i, j)][Math.max(i, j)] = true;
            }
            // Missing orientation still permits bounded local/order-based matching.
            if (forwards[i] == null) {
                for (int offset : new int[] { -2, -1, 1, 2 }) {
                    int j = (i + offset + frameCount) % frameCount;
                    if (i != j) {
                        chosen[Math.min(i, j)][Math.max(i, j)] = true;
                    }
                }
            }
        }
        List<int[]> pairs = new ArrayList<>();
        for (int i = 0; i < frameCount; i++) {
            for (int j = i + 1; j < frameCount; j++) {
                if (chosen[i][j]) {
                    pairs.add(new int[] { i, j });
                }
            }
        }
        return pairs;
    }

    private static double[] forward(JSONObject frame) {
        JSONArray transform = frame.optJSONArray("transform");
        if (transform != null && transform.length() == 16) {
            double x = -transform.optDouble(8, Double.NaN);
            double y = -transform.optDouble(9, Double.NaN);
            double z = -transform.optDouble(10, Double.NaN);
            double norm = Math.sqrt(x * x + y * y + z * z);
            if (Double.isFinite(norm) && norm > 0.1) {
                return new double[] { x / norm, y / norm, z / norm };
            }
        }
        if (frame.has("yawDegrees") && frame.has("pitchDegrees")) {
            double yaw = Math.toRadians(frame.optDouble("yawDegrees", Double.NaN));
            double pitch = Math.toRadians(frame.optDouble("pitchDegrees", Double.NaN));
            if (Double.isFinite(yaw) && Double.isFinite(pitch)) {
                return new double[] { Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw) };
            }
        }
        return null;
    }

    private static double angle(double[] first, double[] second) {
        if (first == null || second == null) {
            return Double.POSITIVE_INFINITY;
        }
        double dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
        return Math.toDegrees(Math.acos(Math.max(-1.0, Math.min(1.0, dot))));
    }

    static int[] workingSize(int width, int height, int longSide) {
        double scale = Math.min(1.0, longSide / (double) Math.max(width, height));
        return new int[] { Math.max(32, (int) Math.round(width * scale / 16) * 16),
                           Math.max(32, (int) Math.round(height * scale / 16) * 16) };
    }

    static float originalCoordinate(float point, int originalSize, int workingSize) {
        return Math.max(0.0f, Math.min(originalSize - 1.0f, (point + 0.5f) * originalSize / workingSize - 0.5f));
    }

    private static File cacheModel(Context context, String name, JSONObject metadata, Progress progress) throws Exception {
        return cacheModel(new File(context.getCacheDir(), "stitch-models"), metadata.getString("sha256"),
            metadata.getLong("bytes"), () -> context.getAssets().open(ASSET_DIRECTORY + name), progress);
    }

    interface ModelSource {
        InputStream open() throws IOException;
    }

    static synchronized File cacheModel(File directory, String sha256, long expectedBytes,
                                         ModelSource source, Progress progress) throws Exception {
        checkCancelled(progress);
        if (sha256 == null || !sha256.matches("[0-9a-f]{64}") || expectedBytes <= 0) {
            throw new IOException("Invalid bundled model checksum.");
        }
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Could not prepare offline models.");
        }
        // Asset names can remain unchanged across APK updates. Only a verified
        // content hash identifies a model, never its asset name or file length.
        File destination = new File(directory, sha256 + ".onnx");
        if (destination.isFile() && destination.length() == expectedBytes) {
            MessageDigest cachedDigest = MessageDigest.getInstance("SHA-256");
            try (InputStream cached = new FileInputStream(destination)) {
                byte[] buffer = new byte[128 * 1024];
                int count;
                while ((count = cached.read(buffer)) != -1) {
                    checkCancelled(progress);
                    cachedDigest.update(buffer, 0, count);
                }
            }
            checkCancelled(progress);
            if (digestHex(cachedDigest).equals(sha256)) {
                return destination;
            }
        }
        File temporary = File.createTempFile("model-", ".tmp", directory);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try {
            try (InputStream input = source.open();
                 FileOutputStream output = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[128 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    checkCancelled(progress);
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
            }
            checkCancelled(progress);
            if (!digestHex(digest).equals(sha256) || temporary.length() != expectedBytes) {
                throw new IOException("The bundled offline model failed verification.");
            }
            // The existing same-hash entry was corrupt. Delete only after its
            // verified replacement is complete; never touch other model hashes.
            if (destination.exists() && !destination.delete()) {
                throw new IOException("Could not replace a corrupt cached model.");
            }
            if (!temporary.renameTo(destination)) {
                throw new IOException("Could not cache the offline model.");
            }
            return destination;
        } finally {
            if (temporary.exists()) {
                temporary.delete();
            }
        }
    }

    private static String digestHex(MessageDigest digest) {
        StringBuilder actual = new StringBuilder();
        for (byte value : digest.digest()) {
            actual.append(String.format(Locale.ROOT, "%02x", value & 255));
        }
        return actual.toString();
    }

    private static String readAssetText(Context context, String name) throws IOException {
        try (InputStream input = context.getAssets().open(ASSET_DIRECTORY + name);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] bytes = new byte[4096];
            int count;
            while ((count = input.read(bytes)) != -1) {
                output.write(bytes, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static void publish(Progress progress, int percent, String stage) {
        if (progress != null) {
            progress.onProgress(percent, stage);
        }
    }

    static void checkCancelled(Progress progress) {
        if (Thread.currentThread().isInterrupted() || (progress != null && progress.isCancelled())) {
            throw new CancellationException("On-device matching cancelled.");
        }
    }

    private static final class Feature {
        final int count;
        final float[] normalizedPoints;
        final float[] originalPoints;
        final float[] descriptors;

        Feature(int count) {
            this.count = count;
            this.normalizedPoints = new float[count * 2];
            this.originalPoints = new float[count * 2];
            this.descriptors = new float[count * DESCRIPTOR_SIZE];
        }
    }
}
