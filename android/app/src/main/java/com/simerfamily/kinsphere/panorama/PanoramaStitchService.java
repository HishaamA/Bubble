package com.simerfamily.kinsphere.panorama;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.simerfamily.kinsphere.MainActivity;
import com.simerfamily.kinsphere.panorama.stitch.NativePanoramaStitcher;
import com.simerfamily.kinsphere.panorama.stitch.OnDeviceFeatureMatcher;
import java.io.File;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Visible, cancellable offline work, independent of the WebView/activity lifecycle. */
public final class PanoramaStitchService extends Service {
    private static final String CHANNEL = "bubble-panorama-assembly";
    private static final int NOTIFICATION_ID = 36034;
    private static final long MAX_RUNTIME_MS = 25 * 60_000L;
    private static volatile Job active;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> new Thread(r, "bubble-offline-stitch"));
    private PowerManager.WakeLock wakeLock;
    private Job serviceJob;

    static final class Job {
        final String id = UUID.randomUUID().toString();
        final String ownerKey;
        final File session;
        final File output;
        final JSONObject manifest;
        final AtomicBoolean cancel = new AtomicBoolean();
        final int width;
        final long startedAt = System.currentTimeMillis();
        int serviceStartId;
        JSONObject status = new JSONObject();
        Job(String ownerKey, File session, JSONObject manifest, int width) throws JSONException, IOException {
            this.ownerKey = ownerKey;
            this.session = session;
            this.manifest = manifest;
            this.width = width;
            output = new File(session, "assembly-" + id);
            status.put("jobId", id).put("ownerKey", ownerKey).put("state", "queued")
                .put("progress", 0).put("stage", "preparing").put("startedAt", startedAt)
                .put("offline", true).put("originalsRetained", true);
            PanoramaCaptureStore.preserveCompletedResult(session);
            persist();
        }
        synchronized JSONObject snapshot() throws JSONException { return new JSONObject(status.toString()); }
        synchronized void persist() throws IOException { PanoramaCaptureStore.writeJson(new File(session, "assembly.json"), status); }
        boolean cancelled() { return cancel.get() || Thread.currentThread().isInterrupted() || System.currentTimeMillis() - startedAt > MAX_RUNTIME_MS; }
    }

    public static boolean hasActiveJob() { return active != null; }
    public static boolean isSessionActive(File session) {
        Job job = active;
        return job != null && job.session.equals(session);
    }

    /** A memory-only snapshot used by recovery listing; never calls the store recursively. */
    public static JSONObject activeStatus(File session, String ownerKey) throws JSONException {
        Job job = active;
        return job != null && job.session.equals(session) && job.ownerKey.equals(ownerKey) ? job.snapshot() : null;
    }

    public static synchronized JSONObject start(Context context, String directoryUrl, String ownerKey, int width) throws Exception {
        PanoramaCaptureStore store = new PanoramaCaptureStore(context);
        File session = store.resolve(directoryUrl, ownerKey);
        if (active != null) {
            if (active.session.equals(session) && active.ownerKey.equals(ownerKey)) return active.snapshot();
            throw new IOException("Another panorama is being assembled. Pause it before starting this one.");
        }
        if (width != 2048 && width != 4096) throw new IOException("Choose a 2K or 4K sphere.");
        if (session.getUsableSpace() < 350L * 1024 * 1024) {
            throw new IOException("Free at least 350 MB on this phone to assemble safely. Your originals are retained.");
        }
        Job job = new Job(ownerKey, session, store.normalizedManifest(session), width);
        active = job;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, PanoramaStitchService.class));
        } catch (RuntimeException error) {
            active = null;
            job.status.put("state", "failed").put("code", "start_failed")
                .put("error", "Keep Bubble open and try again. Your original photos are safe.");
            job.persist();
            throw error;
        }
        return job.snapshot();
    }

    public static JSONObject getJob(Context context, String id, String ownerKey) throws Exception {
        PanoramaCaptureStore.owner(ownerKey);
        if (id == null || !UUID.fromString(id).toString().equals(id)) throw new IOException("The assembly identifier is invalid.");
        Job job = active;
        if (job != null && job.id.equals(id) && job.ownerKey.equals(ownerKey)) return job.snapshot();
        JSONArray captures = new PanoramaCaptureStore(context).list(ownerKey);
        for (int index = 0; index < captures.length(); index++) {
            JSONObject capture = captures.getJSONObject(index);
            JSONObject status = capture.optJSONObject("assembly");
            if (status != null && id.equals(status.optString("jobId"))) return status;
            JSONObject saved = capture.optJSONObject("savedResult");
            if (saved != null && id.equals(saved.optString("jobId"))) return saved;
        }
        throw new IOException("This assembly is unavailable for the current local profile.");
    }

    public static synchronized void cancel(String id, String ownerKey) {
        PanoramaCaptureStore.owner(ownerKey);
        if (active != null && active.id.equals(id) && active.ownerKey.equals(ownerKey)) active.cancel.set(true);
    }

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "360° assembly", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Progress while Bubble assembles your saved photos on this phone.");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        Job job = active;
        if (job == null) { stopSelf(); return START_NOT_STICKY; }
        try {
            Notification notification = notification("Preparing your 360° moment", 0);
            if (Build.VERSION.SDK_INT >= 35) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else startForeground(NOTIFICATION_ID, notification);
            if (serviceJob != job) {
                serviceJob = job;
                job.serviceStartId = startId;
                PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
                wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Bubble:offline-panorama");
                wakeLock.acquire(MAX_RUNTIME_MS + 60_000);
                worker.execute(() -> assemble(job));
            }
        } catch (RuntimeException error) {
            android.util.Log.e("PanoramaStitch", "Could not start foreground assembly", error);
            setFailure(job, "failed", "start_failed", "Keep Bubble open and retry assembly. Your original photos are safe.");
            try { job.persist(); } catch (IOException persistenceError) {
                android.util.Log.e("PanoramaStitch", "Could not persist startup failure", persistenceError);
            }
            synchronized (PanoramaStitchService.class) { if (active == job) active = null; }
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    private void assemble(Job job) {
        try {
            update(job, 0.01, "preparing");
            if (!job.output.mkdirs() && !job.output.isDirectory()) throw new IOException("The result folder could not be created.");
            JSONObject matches;
            try {
                matches = OnDeviceFeatureMatcher.match(getApplicationContext(), job.manifest, new OnDeviceFeatureMatcher.Progress() {
                    public void onProgress(int percent, String stage) { update(job, Math.min(100, Math.max(0, percent)) * .006 + .02, stage); }
                    public boolean isCancelled() { return job.cancelled(); }
                });
            } catch (Exception | OutOfMemoryError error) {
                if (job.cancelled()) throw new InterruptedException();
                // Classical visual alignment is still quality-checked, never the old pose-only mosaic.
                matches = new JSONObject().put("aiUsed", false).put("model", "OpenCV SIFT")
                    .put("pairs", new JSONArray()).put("warning", "The AI matcher could not finish; using offline visual alignment.");
            }
            if (job.cancelled()) throw new InterruptedException();
            JSONObject matchingDiagnostics = matchingDiagnostics(matches);
            synchronized (job) {
                job.status.put("report", new JSONObject().put("matchingDiagnostics", matchingDiagnostics));
            }
            String resultJson = NativePanoramaStitcher.stitch(job.manifest.toString(), job.output.getAbsolutePath(), matches.toString(), job.width,
                new NativePanoramaStitcher.ProgressCallback() {
                    public void onProgress(int percent, String stage) { update(job, .62 + Math.min(100, Math.max(0, percent)) * .0037, stage); }
                    public boolean isCancelled() { return job.cancelled(); }
                });
            JSONObject result = new JSONObject(resultJson);
            if (job.cancelled() || "cancelled".equals(result.optString("state"))) throw new InterruptedException();
            JSONObject report = result.optJSONObject("report");
            if (report == null) report = new JSONObject();
            report.put("matchingDiagnostics", matchingDiagnostics);
            result.put("report", report);
            if (!"completed".equals(result.optString("state"))) {
                synchronized (job) {
                    job.status.put("state", "failed").put("code", result.optString("code", "quality_rejected"))
                        .put("error", result.optString("error", "The photos could not be aligned reliably. Your originals are safe."));
                    if (result.has("report")) job.status.put("report", result.getJSONObject("report"));
                }
            } else {
                File panorama = validateResult(job, result.getString("panoramaPath"));
                File thumbnail = validateResult(job, result.getString("thumbnailPath"));
                int width = result.getInt("width"), height = result.getInt("height");
                if (width != job.width || height * 2 != width) throw new IOException("The assembled sphere has invalid dimensions.");
                synchronized (job) {
                    JSONObject completed = new JSONObject(job.status.toString());
                    completed.put("state", "completed").put("progress", 1).put("stage", "complete")
                        .put("panoramaUrl", Uri.fromFile(panorama).toString()).put("thumbnailUrl", Uri.fromFile(thumbnail).toString())
                        .put("width", width).put("height", height).put("report", result.optJSONObject("report"))
                        .put("finishedAt", System.currentTimeMillis());
                    // Publish completion only after an independent durable reopening record exists.
                    PanoramaCaptureStore.writeJson(new File(job.session, "completed-assembly.json"), completed);
                    PanoramaCaptureStore.writeJson(new File(job.session, "assembly.json"), completed);
                    job.status = completed;
                }
            }
        } catch (InterruptedException error) {
            setFailure(job, "cancelled", "cancelled", "Assembly paused. Your original photos are safe; you can retry anytime.");
        } catch (Exception | LinkageError | OutOfMemoryError error) {
            android.util.Log.e("PanoramaStitch", "Offline assembly failed: " + error.getClass().getSimpleName(), error);
            String message = error instanceof OutOfMemoryError
                ? "This phone ran low on memory. Close other apps or retry at 2K; your originals are safe."
                : "Assembly couldn't finish on this phone. Your original photos are safe; please retry.";
            setFailure(job, "failed", error instanceof OutOfMemoryError ? "out_of_memory" : "assembly_failed", message);
        } finally {
            synchronized (job) {
                try {
                    job.status.put("finishedAt", System.currentTimeMillis());
                    job.status.put("elapsedSeconds", (System.currentTimeMillis() - job.startedAt) / 1000.0);
                    job.persist();
                } catch (IOException | JSONException error) { android.util.Log.e("PanoramaStitch", "Unable to save result metadata", error); }
            }
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            stopForeground(STOP_FOREGROUND_REMOVE);
            synchronized (PanoramaStitchService.class) {
                stopSelf(job.serviceStartId);
                if (active == job) active = null;
            }
        }
    }

    private static File validateResult(Job job, String path) throws IOException {
        File file = new File(path).getCanonicalFile();
        if (!job.output.getCanonicalFile().equals(file.getParentFile()) || !file.isFile() || file.length() == 0) {
            throw new IOException("The stitching engine did not save a valid image.");
        }
        return file;
    }

    /** Keep real matcher timings/configuration without retaining the large correspondence arrays. */
    static JSONObject matchingDiagnostics(JSONObject matches) throws JSONException {
        JSONObject diagnostics = new JSONObject();
        String[] fields = {"model", "aiUsed", "extractionMillis", "matchingMillis", "inferencePairs",
            "candidatePairs", "featureLongSide", "maxKeypoints", "adaptiveDepth", "warning"};
        for (String field : fields) if (matches.has(field)) diagnostics.put(field, matches.get(field));
        if (matches.has("averageMatcherLayers")) diagnostics.put("meanLayers", matches.get("averageMatcherLayers"));
        else if (matches.has("meanLayers")) diagnostics.put("meanLayers", matches.get("meanLayers"));
        return diagnostics;
    }

    private static void setFailure(Job job, String state, String code, String message) {
        synchronized (job) {
            try { job.status.put("state", state).put("code", code).put("error", message); }
            catch (JSONException ignored) { }
        }
    }

    private void update(Job job, double progress, String stage) {
        String normalized = stage.toLowerCase(java.util.Locale.ROOT);
        if (normalized.contains("loading")) normalized = "loading";
        else if (normalized.contains("finding image")) normalized = "features";
        else if (normalized.contains("matching overlapping")) normalized = "matching";
        else if (normalized.contains("checking") || normalized.contains("coverage")) normalized = "checking";
        else if (normalized.contains("refining")) normalized = "optimizing";
        else if (normalized.contains("seams")) normalized = "seams";
        else if (normalized.contains("blending") || normalized.contains("exposure")) normalized = "blending";
        else if (normalized.contains("saving")) normalized = "saving";
        synchronized (job) {
            try {
                job.status.put("state", "running").put("progress", Math.max(job.status.optDouble("progress", 0), Math.min(.99, progress)))
                    .put("stage", normalized).put("detail", stage);
                // Recovery requires durable job identity; per-frame progress can stay in memory.
            } catch (JSONException ignored) { }
        }
        String title = normalized.startsWith("match") || normalized.equals("features") ? "Matching details between photos"
            : normalized.startsWith("align") || normalized.equals("optimizing") ? "Aligning your camera views"
            : normalized.equals("blending") || normalized.equals("seams") ? "Creating clean image joins"
            : "Building your 360° moment";
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(title, (int) (progress * 100)));
    }

    private Notification notification(String title, int progress) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle(title).setContentText("On this phone · original photos kept safe")
            .setProgress(100, Math.max(0, Math.min(100, progress)), false).setOnlyAlertOnce(true)
            .setOngoing(true).setContentIntent(content).setCategory(NotificationCompat.CATEGORY_PROGRESS).build();
    }

    @Override public void onTimeout(int startId, int fgsType) {
        if (serviceJob != null) serviceJob.cancel.set(true);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
    @Override public void onDestroy() {
        if (serviceJob != null) serviceJob.cancel.set(true);
        // A task removed before execution will never reach assemble's finally block.
        // Release its reservation here; an executing task owns its own final cleanup.
        boolean cancelledBeforeExecution = !worker.shutdownNow().isEmpty();
        if (cancelledBeforeExecution && serviceJob != null) {
            setFailure(serviceJob, "cancelled", "interrupted", "Assembly was interrupted. Your original photos are safe; retry on this phone.");
            try { serviceJob.persist(); } catch (IOException error) {
                android.util.Log.e("PanoramaStitch", "Could not persist queued cancellation", error);
            }
            synchronized (PanoramaStitchService.class) { if (active == serviceJob) active = null; }
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
