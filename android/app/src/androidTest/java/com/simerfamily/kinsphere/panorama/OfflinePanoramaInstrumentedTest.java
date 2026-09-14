package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.BitmapFactory;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.simerfamily.kinsphere.panorama.stitch.NativePanoramaStitcher;
import com.simerfamily.kinsphere.panorama.stitch.OnDeviceFeatureMatcher;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Runs real CPU model inference/JNI on the installed device, never a WebView mock. */
@RunWith(AndroidJUnit4.class)
public final class OfflinePanoramaInstrumentedTest {
    private static final String OWNER = "instrumentation:offline-stitch";

    @Test public void reportsRealCameraConfigurations() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        com.google.ar.core.Session session = new com.google.ar.core.Session(context);
        try {
            com.google.ar.core.CameraConfigFilter filter = new com.google.ar.core.CameraConfigFilter(session)
                .setFacingDirection(com.google.ar.core.CameraConfig.FacingDirection.BACK);
            JSONArray configurations = new JSONArray();
            for (com.google.ar.core.CameraConfig config : session.getSupportedCameraConfigs(filter)) {
                configurations.put(new JSONObject().put("cameraId", config.getCameraId())
                    .put("imageWidth", config.getImageSize().getWidth()).put("imageHeight", config.getImageSize().getHeight())
                    .put("textureSize", config.getTextureSize().toString()).put("fps", config.getFpsRange().toString()));
            }
            assertTrue(configurations.length() > 0);
            android.hardware.camera2.CameraManager manager = (android.hardware.camera2.CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
            android.hardware.camera2.CameraCharacteristics camera = manager.getCameraCharacteristics(session.getCameraConfig().getCameraId());
            JSONObject report = new JSONObject().put("configurations", configurations)
                .put("activeArray", String.valueOf(camera.get(android.hardware.camera2.CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)))
                .put("physicalSize", String.valueOf(camera.get(android.hardware.camera2.CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)));
            PanoramaCaptureStore.writeJson(new File(context.getFilesDir(), "stitch-camera-diagnostic.json"), report);
            android.util.Log.i("OfflineStitchTest", "CAMERA " + report);
        } finally { session.close(); }
    }

    @Test public void durableStoreIsOwnerScopedAndAtomic() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        PanoramaCaptureStore store = new PanoramaCaptureStore(context);
        File session = new File(store.getRoot(), UUID.randomUUID().toString());
        assertTrue(session.mkdir());
        JSONObject metadata = new JSONObject().put("ownerKey", OWNER).put("capturedCount", 1)
            .put("targetCount", 34).put("createdAt", System.currentTimeMillis()).put("frames", new JSONArray());
        PanoramaCaptureStore.writeJson(new File(session, "metadata.json"), metadata);
        String url = android.net.Uri.fromFile(session).toString();
        assertEquals(session.getCanonicalFile(), store.resolve(url, OWNER));
        assertThrows(Exception.class, () -> store.resolve(url, "someone-else"));
        assertTrue(store.list(OWNER).length() >= 1);
        assertThrows(Exception.class, () -> store.normalizedManifest(session));
        metadata.put("state", "interrupted");
        PanoramaCaptureStore.writeJson(new File(session, "metadata.json"), metadata);
        assertEquals("interrupted", PanoramaCaptureStore.readJson(new File(session, "metadata.json")).getString("state"));
        // Only this test's validated empty metadata session is removed, never user sources.
        PanoramaCaptureStore.validateSession(store.getRoot(), session);
        assertTrue(new File(session, "metadata.json").delete());
        assertTrue(session.delete());
    }

    @Test public void realOfflineStitchBenchmark() throws Exception {
        String fixturePath = InstrumentationRegistry.getArguments().getString("stitchFixture");
        org.junit.Assume.assumeTrue("Supply a fixture folder for the real-device benchmark", fixturePath != null);
        Context context = ApplicationProvider.getApplicationContext();
        File fixture = new File(fixturePath).getCanonicalFile();
        // Harness operates only on its separately copied fixture folder.
        assertTrue(fixture.getPath().startsWith(context.getFilesDir().getCanonicalPath() + File.separator));
        JSONObject manifest = PanoramaCaptureStore.readJson(new File(fixture, "manifest.json"));
        JSONArray frames = manifest.getJSONArray("frames");
        for (int i = 0; i < frames.length(); i++) {
            JSONObject frame = frames.getJSONObject(i);
            File source = new File(fixture, frame.getString("fileName")).getCanonicalFile();
            assertEquals(fixture, source.getParentFile());
            assertTrue(source.isFile());
            frame.put("filePath", source.getPath());
        }
        long start = System.nanoTime();
        JSONObject matches = OnDeviceFeatureMatcher.match(context, manifest, new OnDeviceFeatureMatcher.Progress() {
            public void onProgress(int percent, String stage) { android.util.Log.i("OfflineStitchTest", stage + " " + percent); }
            public boolean isCancelled() { return false; }
        });
        assertTrue("Actual learned matching must run", matches.getBoolean("aiUsed"));
        assertTrue("Need a connected visual graph", matches.getJSONArray("pairs").length() >= frames.length() - 1);
        PanoramaCaptureStore.writeJson(new File(fixture, "mobile-matches.json"), matches);
        File output = new File(fixture, "result-" + UUID.randomUUID());
        assertTrue(output.mkdir());
        int width = Integer.parseInt(InstrumentationRegistry.getArguments().getString("stitchWidth", "4096"));
        String result = NativePanoramaStitcher.stitch(manifest.toString(), output.getPath(), matches.toString(), width,
            new NativePanoramaStitcher.ProgressCallback() {
                public void onProgress(int percent, String stage) { android.util.Log.i("OfflineStitchTest", stage + " " + percent); }
                public boolean isCancelled() { return false; }
            });
        JSONObject report = new JSONObject(result);
        report.put("elapsedSeconds", (System.nanoTime() - start) / 1e9);
        PanoramaCaptureStore.writeJson(new File(fixture, "mobile-report.json"), report);
        android.util.Log.i("OfflineStitchTest", "RESULT " + report);
        assertEquals(report.toString(), "completed", report.getString("state"));
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(report.getString("panoramaPath"), bounds);
        assertEquals(width, bounds.outWidth);
        assertEquals(width / 2, bounds.outHeight);
        for (int i = 0; i < frames.length(); i++) assertTrue(new File(frames.getJSONObject(i).getString("filePath")).isFile());
    }

    @Test public void nativeCancellationDoesNotProduceSuccess() throws Exception {
        AtomicBoolean cancelled = new AtomicBoolean(true);
        JSONObject result = new JSONObject(NativePanoramaStitcher.stitch("{\"frames\":[]}",
            ApplicationProvider.<Context>getApplicationContext().getCacheDir().getPath(), "{\"pairs\":[]}", 2048,
            new NativePanoramaStitcher.ProgressCallback() {
                public void onProgress(int percent, String stage) { }
                public boolean isCancelled() { return cancelled.get(); }
            }));
        assertNotEquals("completed", result.getString("state"));
    }
}
