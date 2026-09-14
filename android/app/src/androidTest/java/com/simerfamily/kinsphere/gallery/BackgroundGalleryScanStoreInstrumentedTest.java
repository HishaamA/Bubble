package com.simerfamily.kinsphere.gallery;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Synthetic metadata only. Never reads device photos or opens the production queue. */
public final class BackgroundGalleryScanStoreInstrumentedTest {
    private static final String TEST_DATABASE = "bubble-gallery-background-synthetic-tests.db";
    private static final String SCOPE = "instrumentation:synthetic";
    private Context context;
    private BackgroundGalleryScanStore store;

    @Before public void prepare() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase(TEST_DATABASE);
        store = new BackgroundGalleryScanStore(context, TEST_DATABASE);
    }
    @After public void finish() { store.close(); context.deleteDatabase(TEST_DATABASE); }

    private JSONObject photo(int id) throws Exception {
        return new JSONObject().put("key", "journal-photo:device-gallery:" + id + ":").put("nativeId", Integer.toString(id))
            .put("source", "bubble-gallery:" + id + "?scope=instrumentation%3Asynthetic");
    }
    private JSONArray photos(int... ids) throws Exception {
        JSONArray result = new JSONArray(); for (int id : ids) result.put(photo(id)); return result;
    }
    private String scan() throws Exception { return new JSONObject().put("scannedAt", "2026-09-14T00:00:00Z").put("faces", new JSONArray()).toString(); }
    private JSONArray ack(BackgroundGalleryScanStore.Photo item) throws Exception {
        return new JSONArray().put(new JSONObject().put("key", item.key).put("source", item.source));
    }

    @Test public void checkpointsSurviveColdStoreAndAckRetainsCompletedCount() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1, 2));
        BackgroundGalleryScanStore.Photo item = store.claim(SCOPE);
        assertTrue(store.complete(item, scan()));
        store.close(); store = new BackgroundGalleryScanStore(context, TEST_DATABASE);
        JSONObject before = store.state(SCOPE, 8);
        assertEquals(1, before.getInt("completed")); assertEquals(1, before.getJSONArray("results").length());
        store.ack(SCOPE, ack(item));
        assertEquals(1, store.state(SCOPE, 8).getInt("completed"));
        assertEquals(0, store.state(SCOPE, 8).getJSONArray("results").length());
        store.reconcile(SCOPE, "revision1", photos(1, 2));
        assertEquals("2", store.claim(SCOPE).nativeId);
    }

    @Test public void pauseIsDurableAndReconciliationCannotResumeIt() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1));
        BackgroundGalleryScanStore.Photo old = store.claim(SCOPE);
        store.pause(SCOPE, "manual");
        store.reconcile(SCOPE, "revision1", photos(1, 2));
        assertEquals("paused", store.state(SCOPE, 8).getString("status"));
        assertEquals("manual", store.state(SCOPE, 8).getString("pauseReason"));
        assertFalse(store.complete(old, scan())); assertNull(store.claim(SCOPE));
        store.resume(SCOPE, false); assertNotNull(store.claim(SCOPE));
    }

    @Test public void threeFailuresNeedExplicitRetryAndKeepOtherCheckpoints() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1, 2));
        for (int attempt = 0; attempt < 3; attempt++) store.failed(store.claim(SCOPE));
        BackgroundGalleryScanStore.Photo good = store.claim(SCOPE);
        assertEquals("2", good.nativeId); store.complete(good, scan()); store.finish(SCOPE);
        assertEquals("error", store.state(SCOPE, 8).getString("status"));
        assertEquals(1, store.state(SCOPE, 8).getInt("failed"));
        store.resume(SCOPE, true);
        assertEquals(1, store.state(SCOPE, 8).getInt("completed"));
        assertEquals("1", store.claim(SCOPE).nativeId);
    }

    @Test public void canceledOldScopeAndLateTokensCannotRepopulateQueue() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1));
        BackgroundGalleryScanStore.Photo old = store.claim(SCOPE);
        store.cancel(SCOPE);
        assertFalse(store.complete(old, scan()));
        assertEquals(0, store.state(SCOPE, 8).getInt("total"));
        store.reconcile("different:owner", "revision1", new JSONArray());
        store.cancel(SCOPE);
        assertEquals("different:owner", store.owner().scope);
        assertEquals(0, store.state(SCOPE, 8).getJSONArray("results").length());
    }

    @Test public void newSourceAndModelRevisionInvalidateOldOutboxAtomically() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1));
        BackgroundGalleryScanStore.Photo old = store.claim(SCOPE); store.complete(old, scan());
        JSONObject edited = photo(1).put("source", "bubble-gallery:1?scope=instrumentation%3Asynthetic&v=2026-09-14T00%3A00%3A00Z");
        store.reconcile(SCOPE, "revision1", new JSONArray().put(edited));
        assertEquals(0, store.state(SCOPE, 8).getInt("completed"));
        BackgroundGalleryScanStore.Photo newer = store.claim(SCOPE); store.complete(newer, scan());
        store.pause(SCOPE, "manual");
        store.reconcile(SCOPE, "revision2", photos(1));
        JSONObject result = store.state(SCOPE, 8);
        assertEquals("revision2", result.getString("revision")); assertEquals("paused", result.getString("status"));
        assertEquals(0, result.getJSONArray("results").length()); assertFalse(store.complete(newer, scan()));
    }

    @Test public void staleAckCannotDeleteCurrentSourceResult() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1));
        BackgroundGalleryScanStore.Photo current = store.claim(SCOPE); store.complete(current, scan());
        JSONArray wrong = new JSONArray().put(new JSONObject().put("key", current.key).put("source", current.source + "&v=old"));
        store.ack(SCOPE, wrong);
        assertEquals(1, store.state(SCOPE, 8).getJSONArray("results").length());
    }

    @Test public void acceptsOnlyBoundedCurrentDescriptorCheckpoints() throws Exception {
        JSONArray descriptor = new JSONArray();
        for (int i = 0; i < 1024; i++) descriptor.put(i == 0 ? 1 : 0);
        JSONObject face = new JSONObject().put("id", "face-1").put("embedding", descriptor)
            .put("box", new JSONArray(new double[] { .1, .2, .3, .4 })).put("quality", .9)
            .put("detectorScore", .95).put("descriptorScore", .95).put("minFacePixels", 128);
        JSONObject valid = new JSONObject().put("scannedAt", "2026-09-14T00:00:00Z").put("faces", new JSONArray().put(face));
        BackgroundGalleryScanStore.validateScan(valid.toString());
        face.put("minFacePixels", 1281);
        assertThrows(IllegalArgumentException.class, () -> BackgroundGalleryScanStore.validateScan(valid.toString()));
        face.put("minFacePixels", 128); descriptor.put(0, 0);
        assertThrows(IllegalArgumentException.class, () -> BackgroundGalleryScanStore.validateScan(valid.toString()));
        descriptor.put(0, "1");
        assertThrows(IllegalArgumentException.class, () -> BackgroundGalleryScanStore.validateScan(valid.toString()));
        descriptor.put(0, 1); valid.put("image", "must-not-be-stored");
        assertThrows(IllegalArgumentException.class, () -> BackgroundGalleryScanStore.validateScan(valid.toString()));
    }

    @Test public void frameAndNetworkPathsCannotEscapeBundledAssets() {
        assertTrue(BackgroundGalleryScanService.allowedAsset("/gallery-scanner.html"));
        assertTrue(BackgroundGalleryScanService.allowedAsset("/assets/gallery-scanner-abc.js"));
        assertTrue(BackgroundGalleryScanService.allowedAsset("/models/human/faceres.bin"));
        assertTrue(BackgroundGalleryScanService.allowedAsset("/vendor/tfjs-wasm/tfjs-backend-wasm-simd.wasm"));
        for (String path : new String[] { "/index.html", "/../private", "/assets/../../index.html", "/photo/1", "https://example.com/file.js", "/assets/a.js?secret" }) {
            assertFalse(BackgroundGalleryScanService.allowedAsset(path));
        }
    }

    @Test public void stalePauseErrorAndCancelCannotStopResumedOwnerGeneration() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1));
        String old = store.owner().generation;
        store.pause(SCOPE, "manual"); store.resume(SCOPE, false);
        String current = store.owner().generation;
        assertNotEquals(old, current);
        store.pauseIfCurrent(SCOPE, old, "timeout"); store.errorIfCurrent(SCOPE, old, "old failure"); store.cancelIfCurrent(SCOPE, old);
        assertEquals("running", store.owner().status); assertEquals(current, store.owner().generation);
        assertNull(store.claim(SCOPE, old)); assertNotNull(store.claim(SCOPE, current));
    }

    @Test public void outboxAccountingTracksAckAndReconcileWithoutScanningDescriptorText() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1, 2));
        BackgroundGalleryScanStore.Photo first = store.claim(SCOPE); store.complete(first, scan());
        BackgroundGalleryScanStore.Photo second = store.claim(SCOPE); store.complete(second, scan());
        assertEquals(scan().length() * 2L, android.database.DatabaseUtils.longForQuery(store.getReadableDatabase(), "SELECT outbox_bytes FROM owner", null));
        store.ack(SCOPE, ack(first));
        assertEquals(scan().length(), android.database.DatabaseUtils.longForQuery(store.getReadableDatabase(), "SELECT outbox_bytes FROM owner", null));
        store.reconcile(SCOPE, "revision1", photos(1));
        assertEquals(0, android.database.DatabaseUtils.longForQuery(store.getReadableDatabase(), "SELECT outbox_bytes FROM owner", null));
    }

    @Test public void retainingColdAccountPreservesOnlyItsOwnOutboxWithoutStartingAnything() throws Exception {
        store.reconcile(SCOPE, "revision1", photos(1));
        BackgroundGalleryScanStore.Photo first = store.claim(SCOPE); store.complete(first, scan()); store.pause(SCOPE, "manual");
        assertFalse(store.retainScope(SCOPE));
        assertEquals("paused", store.owner().status); assertEquals(1, store.state(SCOPE, 8).getJSONArray("results").length());
        assertTrue(store.retainScope("different:account"));
        assertNull(store.owner()); assertFalse(store.complete(first, scan()));
        assertEquals(0, store.state("different:account", 8).getInt("total"));
    }
}
