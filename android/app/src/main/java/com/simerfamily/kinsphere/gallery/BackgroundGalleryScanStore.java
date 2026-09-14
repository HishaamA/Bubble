package com.simerfamily.kinsphere.gallery;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Cross-process durable metadata queue. Originals/previews never enter this database. */
final class BackgroundGalleryScanStore extends SQLiteOpenHelper {
    static final String DATABASE = "bubble-gallery-background-v1.db";
    private final Context context;

    BackgroundGalleryScanStore(Context context) { this(context, DATABASE); }
    BackgroundGalleryScanStore(Context context, String database) {
        super(context.getApplicationContext(), database, null, 1);
        this.context = context.getApplicationContext();
        setWriteAheadLoggingEnabled(true);
    }

    @Override public void onConfigure(SQLiteDatabase db) {
        // This PRAGMA returns a row. Modern Android SQLite rejects it through
        // execSQL even though older versions accepted that form.
        try (Cursor result = db.rawQuery("PRAGMA secure_delete=ON", null)) {
            if (!result.moveToFirst() || result.getInt(0) != 1) throw new IllegalStateException("Could not configure the private gallery queue");
        }
    }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, revision TEXT NOT NULL, generation TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, error TEXT, heartbeat INTEGER NOT NULL, outbox_bytes INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE photos (key TEXT PRIMARY KEY, native_id TEXT NOT NULL, source TEXT NOT NULL, position INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, token TEXT, scan TEXT, scan_bytes INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE INDEX photos_state ON photos(state,position)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("Unsupported gallery queue version");
    }

    static final class Owner {
        final String scope, revision, generation, status, reason, error;
        final long heartbeat;
        Owner(Cursor cursor) {
            scope = cursor.getString(0); revision = cursor.getString(1); generation = cursor.getString(2);
            status = cursor.getString(3); reason = cursor.getString(4); error = cursor.getString(5); heartbeat = cursor.getLong(6);
        }
    }
    static final class Photo {
        final String key, nativeId, source, token, generation, scope;
        Photo(String scope, String generation, String key, String nativeId, String source, String token) {
            this.scope = scope; this.generation = generation; this.key = key; this.nativeId = nativeId; this.source = source; this.token = token;
        }
        JSONObject payload() throws JSONException {
            return new JSONObject().put("token", token).put("key", key).put("nativeId", nativeId);
        }
    }

    synchronized Owner owner() { return owner(getReadableDatabase()); }
    private Owner owner(SQLiteDatabase db) {
        try (Cursor cursor = db.rawQuery("SELECT scope,revision,generation,status,reason,error,heartbeat FROM owner WHERE id=1", null)) {
            return cursor.moveToFirst() ? new Owner(cursor) : null;
        }
    }

    synchronized void reconcile(String scope, String revision, JSONArray input) throws JSONException {
        BackgroundGalleryScanPolicy.scope(scope);
        BackgroundGalleryScanPolicy.bounded(revision, 1024);
        if (input == null || input.length() > BackgroundGalleryScanPolicy.MAX_PHOTOS) throw new IllegalArgumentException("Too many gallery photos");
        Set<String> keys = new HashSet<>();
        long metadataSize = 0;
        for (int i = 0; i < input.length(); i++) {
            JSONObject row = input.getJSONObject(i);
            String key = row.getString("key"), nativeId = row.getString("nativeId"), source = row.getString("source");
            BackgroundGalleryScanPolicy.photo(scope, key, nativeId, source);
            if (!keys.add(key)) throw new IllegalArgumentException("Duplicate photo key");
            metadataSize += key.length() + source.length();
            if (metadataSize > 16 * 1024 * 1024) throw new IllegalArgumentException("Gallery queue is too large");
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Owner current = owner(db);
            boolean changedScope = current == null || !current.scope.equals(scope);
            boolean reset = changedScope || !current.revision.equals(revision);
            if (reset) {
                db.delete("photos", null, null);
                db.delete("owner", null, null);
                ContentValues values = new ContentValues();
                values.put("id", 1); values.put("scope", scope); values.put("revision", revision);
                values.put("generation", UUID.randomUUID().toString());
                values.put("status", !changedScope && "paused".equals(current.status) ? "paused" : "running");
                if (!changedScope && "paused".equals(current.status)) values.put("reason", current.reason);
                values.put("heartbeat", System.currentTimeMillis());
                db.insertOrThrow("owner", null, values);
            }
            db.execSQL("CREATE TEMP TABLE IF NOT EXISTS incoming (key TEXT PRIMARY KEY)");
            db.delete("incoming", null, null);
            boolean invalidatesWorking = false;
            for (int i = 0; i < input.length(); i++) {
                JSONObject item = input.getJSONObject(i);
                String key = item.getString("key"), source = item.getString("source");
                ContentValues incoming = new ContentValues(); incoming.put("key", key);
                db.insertOrThrow("incoming", null, incoming);
                String oldSource = null, oldState = null;
                try (Cursor row = db.rawQuery("SELECT source,state FROM photos WHERE key=?", new String[] { key })) {
                    if (row.moveToFirst()) { oldSource = row.getString(0); oldState = row.getString(1); }
                }
                ContentValues values = new ContentValues(); values.put("position", i);
                if (!source.equals(oldSource)) {
                    if ("working".equals(oldState)) invalidatesWorking = true;
                    values.put("key", key); values.put("native_id", item.getString("nativeId")); values.put("source", source);
                    values.put("state", "pending"); values.put("attempts", 0); values.putNull("token"); values.putNull("scan"); values.put("scan_bytes", 0);
                    db.insertWithOnConflict("photos", null, values, SQLiteDatabase.CONFLICT_REPLACE);
                } else db.update("photos", values, "key=?", new String[] { key });
            }
            invalidatesWorking |= DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM photos WHERE state='working' AND key NOT IN (SELECT key FROM incoming)", null) > 0;
            db.delete("photos", "key NOT IN (SELECT key FROM incoming)", null);
            ContentValues ownerValues = new ContentValues(); ownerValues.put("revision", revision);
            ownerValues.put("outbox_bytes", DatabaseUtils.longForQuery(db, "SELECT COALESCE(SUM(scan_bytes),0) FROM photos", null));
            if (invalidatesWorking) {
                ownerValues.put("generation", UUID.randomUUID().toString());
                db.execSQL("UPDATE photos SET state='pending',attempts=MAX(0,attempts-1),token=NULL WHERE state='working'");
            }
            if (!reset && "running".equals(current.status) && System.currentTimeMillis() - current.heartbeat > 90_000) {
                ownerValues.put("status", "paused"); ownerValues.put("reason", "interrupted");
                ownerValues.put("generation", UUID.randomUUID().toString());
                db.execSQL("UPDATE photos SET state='pending',attempts=MAX(0,attempts-1),token=NULL WHERE state='working'");
            } else if (!reset && ("complete".equals(current.status) || "idle".equals(current.status)) && count(db, "pending") > 0) {
                ownerValues.put("status", "running"); ownerValues.putNull("reason"); ownerValues.putNull("error");
                ownerValues.put("heartbeat", System.currentTimeMillis());
            }
            db.update("owner", ownerValues, "id=1", null);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized JSONObject state(String scope, int requestedLimit) throws JSONException {
        SQLiteDatabase db = getReadableDatabase();
        // One snapshot prevents another process changing owner between its
        // scope check and the checkpoint read.
        db.beginTransactionNonExclusive();
        try {
            JSONObject state = readState(db, scope, requestedLimit);
            db.setTransactionSuccessful();
            return state;
        } finally { db.endTransaction(); }
    }
    private JSONObject readState(SQLiteDatabase db, String scope, int requestedLimit) throws JSONException {
        Owner current = owner(db);
        JSONObject result = new JSONObject().put("status", "idle").put("total", 0).put("completed", 0).put("failed", 0)
            .put("results", new JSONArray()).put("failedKeys", new JSONArray());
        if (current == null || !current.scope.equals(scope)) return result;
        if ("running".equals(current.status) && System.currentTimeMillis() - current.heartbeat > 90_000 && count(db, "pending") + count(db, "working") > 0) {
            ContentValues values = new ContentValues(); values.put("status", "paused"); values.put("reason", "interrupted");
            values.put("generation", UUID.randomUUID().toString());
            db.update("owner", values, "id=1", null);
            db.execSQL("UPDATE photos SET state='pending',attempts=MAX(0,attempts-1),token=NULL WHERE state='working'");
            current = owner(db);
        }
        long total = DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM photos", null);
        long completed = count(db, "done") + count(db, "acknowledged"), failed = count(db, "failed");
        String status = current.status;
        if ("running".equals(status) && completed + failed == total) status = failed > 0 ? "error" : "complete";
        result.put("status", status).put("total", total).put("completed", completed).put("failed", failed).put("revision", current.revision);
        if (current.reason != null) result.put("pauseReason", current.reason);
        if (current.error != null) result.put("error", current.error);
        else if (failed > 0) result.put("error", "Some photos could not be checked. Your completed progress is safe.");
        if (requestedLimit < 1) return result;
        JSONArray results = new JSONArray(); int size = 0;
        try (Cursor cursor = db.rawQuery("SELECT key,source,scan FROM photos WHERE state='done' AND scan IS NOT NULL ORDER BY position LIMIT ?",
            new String[] { Integer.toString(BackgroundGalleryScanPolicy.resultLimit(requestedLimit)) })) {
            while (cursor.moveToNext()) {
                String scan = cursor.getString(2);
                if (size + scan.length() > BackgroundGalleryScanPolicy.MAX_BATCH_BYTES && results.length() > 0) break;
                size += scan.length();
                results.put(new JSONObject().put("key", cursor.getString(0)).put("source", cursor.getString(1)).put("scan", new JSONObject(scan)));
            }
        }
        JSONArray failedKeys = new JSONArray();
        try (Cursor cursor = db.rawQuery("SELECT key FROM photos WHERE state='failed' ORDER BY position", null)) {
            while (cursor.moveToNext()) failedKeys.put(cursor.getString(0));
        }
        return result.put("results", results).put("failedKeys", failedKeys);
    }

    synchronized void ack(String scope, JSONArray entries) throws JSONException {
        if (entries == null || entries.length() > 32) throw new IllegalArgumentException("Invalid checkpoint acknowledgment");
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            Owner current = owner(db);
            long released = 0;
            if (current != null && current.scope.equals(scope)) for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i);
                released += DatabaseUtils.longForQuery(db, "SELECT COALESCE(SUM(scan_bytes),0) FROM photos WHERE key=? AND source=? AND state='done'", new String[] { entry.getString("key"), entry.getString("source") });
                ContentValues values = new ContentValues(); values.put("state", "acknowledged"); values.putNull("scan"); values.put("scan_bytes", 0);
                db.update("photos", values, "key=? AND source=? AND state='done'", new String[] { entry.getString("key"), entry.getString("source") });
            }
            if (released > 0) db.execSQL("UPDATE owner SET outbox_bytes=MAX(0,outbox_bytes-?) WHERE scope=?", new Object[] { released, scope });
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized void pause(String scope, String reason) { setControl(scope, null, "paused", reason, null, false); }
    synchronized void pauseIfCurrent(String scope, String generation, String reason) { setControl(scope, generation, "paused", reason, null, false); }
    synchronized void resume(String scope, boolean retry) { setControl(scope, null, "running", null, null, retry); }
    synchronized void error(String scope, String message) { setControl(scope, null, "error", null, message, false); }
    synchronized void errorIfCurrent(String scope, String generation, String message) { setControl(scope, generation, "error", null, message, false); }
    private void setControl(String scope, String generation, String status, String reason, String error, boolean retry) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            Owner current = owner(db);
            if (current != null && current.scope.equals(scope) && (generation == null || current.generation.equals(generation))) {
                ContentValues values = new ContentValues(); values.put("status", status); values.put("reason", reason); values.put("error", error);
                values.put("generation", UUID.randomUUID().toString()); values.put("heartbeat", System.currentTimeMillis());
                db.update("owner", values, "id=1", null);
                db.execSQL("UPDATE photos SET state='pending',attempts=MAX(0,attempts-1),token=NULL WHERE state='working'");
                if (retry) db.execSQL("UPDATE photos SET state='pending',attempts=0,token=NULL WHERE state='failed'");
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized void cancel(String scope) { cancelIfCurrent(scope, null); }
    synchronized boolean retainScope(String scope) {
        BackgroundGalleryScanPolicy.scope(scope);
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            Owner current = owner(db);
            boolean removed = current != null && !current.scope.equals(scope);
            if (removed) { db.delete("photos", null, null); db.delete("owner", null, null); }
            db.setTransactionSuccessful(); return removed;
        } finally { db.endTransaction(); }
    }
    synchronized void cancelIfCurrent(String scope, String generation) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            Owner current = owner(db);
            if (current != null && current.scope.equals(scope) && (generation == null || current.generation.equals(generation))) { db.delete("photos", null, null); db.delete("owner", null, null); }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized Photo claim(String scope) { return claim(scope, null); }
    synchronized Photo claim(String scope, String generation) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            Owner current = owner(db);
            if (current == null || !current.scope.equals(scope) || !current.status.equals("running") || (generation != null && !current.generation.equals(generation))) return null;
            try (Cursor row = db.rawQuery("SELECT key,native_id,source FROM photos WHERE state='pending' AND attempts<3 ORDER BY position LIMIT 1", null)) {
                if (!row.moveToFirst()) return null;
                String token = UUID.randomUUID().toString();
                Photo photo = new Photo(scope, current.generation, row.getString(0), row.getString(1), row.getString(2), token);
                db.execSQL("UPDATE photos SET state='working',attempts=attempts+1,token=? WHERE key=?", new Object[] { token, photo.key });
                db.setTransactionSuccessful(); return photo;
            }
        } finally { db.endTransaction(); }
    }

    synchronized boolean current(Photo photo) { return current(getReadableDatabase(), photo); }
    private boolean current(SQLiteDatabase db, Photo photo) {
        if (photo == null) return false;
        Owner owner = owner(db);
        return owner != null && owner.scope.equals(photo.scope) && owner.generation.equals(photo.generation) && owner.status.equals("running") &&
            DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM photos WHERE key=? AND source=? AND token=? AND state='working'",
                new String[] { photo.key, photo.source, photo.token }) == 1;
    }

    synchronized boolean complete(Photo photo, String scan) throws JSONException {
        validateScan(scan);
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            if (!current(db, photo)) return false;
            long bytes = DatabaseUtils.longForQuery(db, "SELECT outbox_bytes FROM owner WHERE id=1", null);
            if (bytes + scan.length() > BackgroundGalleryScanPolicy.MAX_OUTBOX_BYTES || context.getFilesDir().getUsableSpace() < 32L * 1024 * 1024 + scan.length() * 3L) throw new IllegalStateException("Open Bubble to save completed progress before continuing.");
            ContentValues values = new ContentValues(); values.put("state", "done"); values.put("scan", scan); values.putNull("token"); values.put("scan_bytes", scan.length());
            db.update("photos", values, "key=?", new String[] { photo.key });
            db.execSQL("UPDATE owner SET outbox_bytes=outbox_bytes+? WHERE id=1", new Object[] { scan.length() });
            db.setTransactionSuccessful(); return true;
        } finally { db.endTransaction(); }
    }

    synchronized void failed(Photo photo) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            if (current(db, photo)) db.execSQL("UPDATE photos SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,token=NULL WHERE key=?", new Object[] { photo.key });
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized void release(Photo photo) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            if (current(db, photo)) db.execSQL("UPDATE photos SET state='pending',attempts=MAX(0,attempts-1),token=NULL WHERE key=?", new Object[] { photo.key });
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized void recoverWorking(String scope, String generation) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            Owner current = owner(db);
            if (current != null && current.scope.equals(scope) && current.generation.equals(generation) && current.status.equals("running")) {
                db.execSQL("UPDATE photos SET state='pending',attempts=MAX(0,attempts-1),token=NULL WHERE state='working'");
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized void heartbeat(String scope, String generation) {
        ContentValues value = new ContentValues(); value.put("heartbeat", System.currentTimeMillis());
        getWritableDatabase().update("owner", value, "scope=? AND generation=? AND status='running'", new String[] { scope, generation });
    }

    synchronized void finish(String scope) { finish(scope, null); }
    synchronized void finish(String scope, String generation) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            Owner current = owner(db);
            if (current != null && current.scope.equals(scope) && (generation == null || current.generation.equals(generation)) && current.status.equals("running") && count(db, "working") + count(db, "pending") == 0) {
                ContentValues values = new ContentValues(); values.put("status", count(db, "failed") > 0 ? "error" : "complete");
                db.update("owner", values, "id=1", null);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    private static long count(SQLiteDatabase db, String state) {
        return DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM photos WHERE state=?", new String[] { state });
    }

    static void validateScan(String raw) throws JSONException {
        if (raw == null || raw.length() > BackgroundGalleryScanPolicy.MAX_RESULT_BYTES) throw new IllegalArgumentException("Invalid face checkpoint");
        JSONObject scan = new JSONObject(raw); Instant.parse(scan.getString("scannedAt"));
        if (scan.length() != 2) throw new IllegalArgumentException("Unexpected checkpoint fields");
        JSONArray faces = scan.getJSONArray("faces");
        if (faces.length() > 20) throw new IllegalArgumentException("Too many detected faces");
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < faces.length(); i++) {
            JSONObject face = faces.getJSONObject(i);
            if (face.length() != 7) throw new IllegalArgumentException("Unexpected face fields");
            if (!ids.add(BackgroundGalleryScanPolicy.bounded(face.getString("id"), 128))) throw new IllegalArgumentException("Duplicate face");
            JSONArray embedding = face.getJSONArray("embedding"), box = face.getJSONArray("box");
            if (embedding.length() != 1024 || box.length() != 4) throw new IllegalArgumentException("Invalid descriptor");
            boolean signal = false;
            for (int j = 0; j < 1024; j++) { double value = number(embedding.get(j)); signal |= value != 0; }
            if (!signal) throw new IllegalArgumentException("Empty descriptor");
            for (int j = 0; j < 4; j++) unit(number(box.get(j)));
            if (box.getDouble(2) <= 0 || box.getDouble(3) <= 0 || box.getDouble(0) + box.getDouble(2) > 1.000001 || box.getDouble(1) + box.getDouble(3) > 1.000001) throw new IllegalArgumentException("Invalid face geometry");
            for (String field : new String[] { "quality", "detectorScore", "descriptorScore" }) unit(number(face.get(field)));
            double pixels = number(face.get("minFacePixels"));
            if (!Double.isFinite(pixels) || pixels < 0 || pixels > 1280) throw new IllegalArgumentException("Invalid face detail");
        }
    }
    private static double number(Object value) {
        if (!(value instanceof Number) || !Double.isFinite(((Number) value).doubleValue())) throw new IllegalArgumentException("Invalid face number");
        return ((Number) value).doubleValue();
    }
    private static void unit(double value) {
        if (!Double.isFinite(value) || value < 0 || value > 1) throw new IllegalArgumentException("Invalid face geometry");
    }
}
