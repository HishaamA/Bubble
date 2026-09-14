package com.simerfamily.kinsphere.gallery;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import java.io.File;
import org.json.JSONObject;

/** Debug-only, DUMP-protected aggregate probe. Never opens a photo or changes a queue. */
public final class BackgroundGalleryScanStatusReceiver extends BroadcastReceiver {
    private static final String ACTION = "com.simerfamily.kinsphere.GALLERY_SCAN_STATUS";

    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        PendingResult pending = goAsync();
        Context application = context.getApplicationContext();
        try {
            new Thread(() -> {
                try {
                    pending.setResultCode(Activity.RESULT_OK);
                    pending.setResultData(readSummary(application).toString());
                } catch (Exception unavailable) {
                    pending.setResultCode(Activity.RESULT_CANCELED);
                    pending.setResultData("{\"status\":\"unavailable\"}");
                } finally { pending.finish(); }
            }, "BubbleGalleryStatus").start();
        } catch (RuntimeException unavailable) {
            pending.setResultCode(Activity.RESULT_CANCELED);
            pending.setResultData("{\"status\":\"unavailable\"}");
            pending.finish();
        }
    }

    private static JSONObject readSummary(Context context) throws Exception {
        JSONObject result = new JSONObject().put("status", "idle").put("total", 0)
            .put("completed", 0).put("failed", 0).put("outboxCount", 0).put("heartbeatAgeMs", 0);
        File database = context.getDatabasePath(BackgroundGalleryScanStore.DATABASE);
        // Do not invoke SQLiteOpenHelper: it would create an absent database,
        // and its normal state() method may mark stale work as interrupted.
        if (!database.isFile()) return result;
        try (SQLiteDatabase db = SQLiteDatabase.openDatabase(database.getAbsolutePath(), null,
            SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            Cursor row = db.rawQuery("SELECT o.status,o.heartbeat,COUNT(p.key)," +
                "COALESCE(SUM(CASE WHEN p.state IN ('done','acknowledged') THEN 1 ELSE 0 END),0)," +
                "COALESCE(SUM(CASE WHEN p.state='failed' THEN 1 ELSE 0 END),0)," +
                "COALESCE(SUM(CASE WHEN p.state='done' THEN 1 ELSE 0 END),0) " +
                "FROM owner o LEFT JOIN photos p ON 1=1 WHERE o.id=1 GROUP BY o.id", null)) {
            // A single metadata-only SELECT gives one consistent cross-process
            // snapshot. No source, owner scope, key, scan JSON, or URI is read.
            if (!row.moveToFirst()) return result;
            String status = row.getString(0);
            long total = row.getLong(2), completed = row.getLong(3), failed = row.getLong(4);
            if ("running".equals(status) && completed + failed == total) status = failed > 0 ? "error" : "complete";
            return result.put("status", status).put("total", total).put("completed", completed)
                .put("failed", failed).put("outboxCount", row.getLong(5))
                .put("heartbeatAgeMs", Math.max(0, System.currentTimeMillis() - row.getLong(1)));
        }
    }
}
