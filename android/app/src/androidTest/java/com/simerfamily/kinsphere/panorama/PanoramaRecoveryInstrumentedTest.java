package com.simerfamily.kinsphere.panorama;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.net.Uri;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Storage-only recovery checks: no camera, model inference, or user's captures are modified. */
@RunWith(AndroidJUnit4.class)
public final class PanoramaRecoveryInstrumentedTest {
    private final List<File> sessions = new ArrayList<>();
    private final String owner = "recovery-test:" + UUID.randomUUID();
    private PanoramaCaptureStore store;
    private Context context;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        store = new PanoramaCaptureStore(context);
    }

    private File session(String profile) throws Exception {
        File session = new File(store.getRoot(), UUID.randomUUID().toString());
        assertTrue(session.mkdir());
        sessions.add(session);
        JSONArray frames = new JSONArray();
        for (int i = 0; i < 8; i++) frames.put(new JSONObject().put("width", 640).put("height", 480));
        PanoramaCaptureStore.writeJson(new File(session, "metadata.json"), new JSONObject()
            .put("ownerKey", profile).put("sessionId", session.getName()).put("createdAt", System.currentTimeMillis())
            .put("capturedCount", 8).put("targetCount", 8).put("frames", frames));
        return session;
    }

    private JSONObject status(String state) throws Exception {
        return new JSONObject().put("ownerKey", owner).put("jobId", UUID.randomUUID().toString())
            .put("state", state).put("width", 4096).put("height", 2048);
    }

    @Test public void corruptAssemblyDoesNotHideOriginalsOrLastCompletedResult() throws Exception {
        File session = session(owner);
        JSONObject completed = status("completed");
        PanoramaCaptureStore.writeJson(new File(session, "completed-assembly.json"), completed);
        try (FileOutputStream output = new FileOutputStream(new File(session, "assembly.json"))) {
            output.write("{interrupted".getBytes(StandardCharsets.UTF_8));
        }
        JSONArray captures = store.list(owner);
        assertEquals(1, captures.length());
        assertEquals(8, captures.getJSONObject(0).getJSONArray("frames").length());
        assertEquals(completed.getString("jobId"), captures.getJSONObject(0).getJSONObject("savedResult").getString("jobId"));
        assertFalse(captures.getJSONObject(0).has("assembly"));
    }

    @Test public void listingReconcilesOrphanedJobsWithoutRequiringPolling() throws Exception {
        File session = session(owner);
        PanoramaCaptureStore.writeJson(new File(session, "assembly.json"), status("running"));
        JSONObject capture = store.list(owner).getJSONObject(0);
        assertEquals("failed", capture.getJSONObject("assembly").getString("state"));
        assertEquals("interrupted", capture.getJSONObject("assembly").getString("code"));
        assertEquals("failed", PanoramaCaptureStore.readJson(new File(session, "assembly.json")).getString("state"));
    }

    @Test public void failedRetryKeepsPreviousCompletedSphereAddressable() throws Exception {
        File session = session(owner);
        JSONObject completed = status("completed").put("panoramaUrl", Uri.fromFile(new File(session, "old-panorama.jpg")));
        PanoramaCaptureStore.writeJson(new File(session, "assembly.json"), completed);
        PanoramaStitchService.Job retry = new PanoramaStitchService.Job(owner, session,
            PanoramaCaptureStore.readJson(new File(session, "metadata.json")), 4096);
        synchronized (retry) {
            retry.status.put("state", "failed").put("code", "quality_rejected");
            retry.persist();
        }
        JSONObject capture = store.list(owner).getJSONObject(0);
        assertEquals("failed", capture.getJSONObject("assembly").getString("state"));
        assertEquals(completed.getString("jobId"), capture.getJSONObject("savedResult").getString("jobId"));
        assertEquals("completed", PanoramaStitchService.getJob(context, completed.getString("jobId"), owner).getString("state"));
    }

    @Test public void recoveryNeverReturnsAnotherOwnersCaptureOrResult() throws Exception {
        File own = session(owner);
        session("another-profile:" + UUID.randomUUID());
        PanoramaCaptureStore.writeJson(new File(own, "completed-assembly.json"), status("completed").put("ownerKey", "another-profile"));
        JSONArray captures = store.list(owner);
        assertEquals(1, captures.length());
        assertFalse(captures.getJSONObject(0).has("savedResult"));
    }

    @After public void tearDown() throws Exception {
        for (File session : sessions) {
            // Targets come only from this test's newly created UUID fixtures.
            assertEquals(store.getRoot(), session.getCanonicalFile().getParentFile());
            File[] files = session.listFiles();
            if (files != null) for (File file : files) assertTrue(file.delete());
            assertTrue(session.delete());
        }
    }
}
