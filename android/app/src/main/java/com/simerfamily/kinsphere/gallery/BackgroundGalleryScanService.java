package com.simerfamily.kinsphere.gallery;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.simerfamily.kinsphere.MainActivity;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Independent, offline inference process. Never starts from a boot/background receiver. */
public final class BackgroundGalleryScanService extends Service {
    static final String ORIGIN = "https://gallery.bubble.local";
    private static final String CHANNEL = "bubble-gallery-checking";
    private static final String PAUSE = "bubble.gallery.PAUSE";
    private static final int NOTIFICATION_ID = 4697;
    private static final long ENGINE_TIMEOUT_MS = 120_000;
    private static final long SESSION_TIMEOUT_MS = 345 * 60_000L;
    private static boolean directoryConfigured;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private BackgroundGalleryScanStore store;
    private PowerManager.WakeLock wakeLock;
    private WebView engine;
    private volatile BackgroundGalleryScanStore.Photo photo;
    private volatile boolean destroyed;
    private String scope;
    private String ownerGeneration;
    private long engineGeneration;
    private long commandSequence;
    private boolean ready, claiming, ticking;
    private BackgroundGalleryScanPolicy.RuntimeBudget runtimeBudget = new BackgroundGalleryScanPolicy.RuntimeBudget();
    private long sessionStarted;

    @Override public void onCreate() {
        super.onCreate();
        // This service has a private manifest process. Configure storage before
        // constructing a WebView or invoking any other android.webkit method.
        if (Build.VERSION.SDK_INT >= 28 && !directoryConfigured) {
            WebView.setDataDirectorySuffix("gallery-scan-v1");
            directoryConfigured = true;
        }
        store = new BackgroundGalleryScanStore(this);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Photo checking", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Private on-device gallery checks. Pause whenever you like.");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || Build.VERSION.SDK_INT < 28) { stopSelf(); return START_NOT_STICKY; }
        long command = ++commandSequence;
        String requestedScope = intent.getStringExtra("scope");
        String requestedGeneration = intent.getStringExtra("generation");
        try {
            BackgroundGalleryScanPolicy.scope(requestedScope);
            java.util.UUID.fromString(requestedGeneration);
        } catch (RuntimeException error) { stopSelf(); return START_NOT_STICKY; }
        if (PAUSE.equals(intent.getAction())) {
            work.execute(() -> { store.pauseIfCurrent(requestedScope, requestedGeneration, "manual"); main.post(() -> {
                if (command == commandSequence && owns(requestedScope, requestedGeneration)) stopChecking();
            }); });
            return START_NOT_STICKY;
        }
        if (!owns(requestedScope, requestedGeneration)) {
            disposeEngine(); photo = null; scope = requestedScope; ownerGeneration = requestedGeneration;
            runtimeBudget = new BackgroundGalleryScanPolicy.RuntimeBudget();
            work.execute(() -> store.recoverWorking(requestedScope, requestedGeneration));
            sessionStarted = android.os.SystemClock.elapsedRealtime();
        }
        try {
            Notification initial = notification("Checking your photos privately", 0, 0);
            if (Build.VERSION.SDK_INT >= 35) startForeground(NOTIFICATION_ID, initial, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING);
            else if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, initial, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTIFICATION_ID, initial);
        } catch (RuntimeException error) {
            work.execute(() -> store.pauseIfCurrent(requestedScope, requestedGeneration, "interrupted"));
            stopSelf(); return START_NOT_STICKY;
        }
        if (wakeLock == null) {
            PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Bubble:gallery-checking");
            wakeLock.acquire(SESSION_TIMEOUT_MS + 60_000);
        }
        main.removeCallbacks(tick);
        tick.run();
        return START_NOT_STICKY;
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (destroyed || scope == null) return;
            if (android.os.SystemClock.elapsedRealtime() - sessionStarted >= SESSION_TIMEOUT_MS) { pauseForTimeout(); return; }
            if (!ticking) {
                ticking = true;
                String ownerScope = scope;
                String generation = ownerGeneration;
                long command = commandSequence;
                work.execute(() -> {
                    try {
                        BackgroundGalleryScanStore.Owner owner = store.owner();
                        if (owner == null || !ownerScope.equals(owner.scope) || !generation.equals(owner.generation) || !"running".equals(owner.status)) {
                            main.post(() -> { ticking = false; if (command == commandSequence && owns(ownerScope, generation)) stopChecking(); }); return;
                        }
                        NotificationChannel channel = getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL);
                        if (!NotificationManagerCompat.from(thisService()).areNotificationsEnabled() || channel == null || channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                            store.pauseIfCurrent(ownerScope, generation, "notifications");
                            main.post(() -> { ticking = false; if (owns(ownerScope, generation)) stopChecking(); }); return;
                        }
                        BackgroundGalleryPhotoReader.requireAccess(thisService());
                        store.heartbeat(ownerScope, generation);
                        boolean currentPhoto = photo == null || store.current(photo);
                        JSONObject state = store.state(ownerScope, 0);
                        main.post(() -> {
                            ticking = false;
                            if (destroyed || command != commandSequence || !owns(ownerScope, generation)) return;
                            if (!currentPhoto) { photo = null; disposeEngine(); }
                            String status = state.optString("status");
                            if (status.equals("complete") || status.equals("error")) { stopChecking(); return; }
                            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID,
                                notification("Checked " + state.optInt("completed") + " of " + state.optInt("total") + " photos",
                                    state.optInt("completed"), state.optInt("total")));
                            if (engine == null) createEngine();
                            pump();
                        });
                    } catch (SecurityException error) {
                        store.cancelIfCurrent(ownerScope, generation);
                        main.post(() -> { ticking = false; if (owns(ownerScope, generation)) stopChecking(); });
                    } catch (Exception error) {
                        failJob(ownerScope, generation, "Photo checking could not read its saved progress. Open Bubble and retry.");
                    }
                });
            }
            main.postDelayed(this, 2000);
        }
    };

    private BackgroundGalleryScanService thisService() { return this; }

    private void createEngine() {
        if (destroyed || scope == null || engine != null) return;
        final long generation = ++engineGeneration;
        ready = false;
        WebView view = new WebView(getApplicationContext());
        engine = view;
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        view.addJavascriptInterface(new Host(generation), "BubbleGalleryHost");
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) { return true; }
            @Override public void onPageStarted(WebView ignored, String url, android.graphics.Bitmap favicon) {
                if (!(ORIGIN + "/gallery-scanner.html").equals(url)) engineFailed(generation, "The private scanner page could not be opened.");
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView ignored, WebResourceRequest request) {
                return resource(generation, request);
            }
            @Override public boolean onRenderProcessGone(WebView ignored, RenderProcessGoneDetail detail) {
                engineFailed(generation, "The photo engine restarted after Android reclaimed memory.");
                return true;
            }
        });
        view.loadUrl(ORIGIN + "/gallery-scanner.html");
        main.postDelayed(() -> {
            if (!destroyed && generation == engineGeneration && !ready) engineFailed(generation, "The private photo engine took too long to load.");
        }, ENGINE_TIMEOUT_MS);
    }

    private WebResourceResponse resource(long generation, WebResourceRequest request) {
        try {
            Uri uri = request.getUrl();
            if (destroyed || generation != engineGeneration || !"GET".equals(request.getMethod()) ||
                !"https".equals(uri.getScheme()) || !"gallery.bubble.local".equals(uri.getHost()) ||
                (uri.getPort() != -1 && uri.getPort() != 443) || uri.getUserInfo() != null || uri.getFragment() != null) return denied();
            String path = uri.getPath();
            if (path == null || path.contains("..") || path.contains("\\") || uri.getQuery() != null) return denied();
            if (path.startsWith("/photo/")) {
                BackgroundGalleryScanStore.Photo active = photo;
                String nativeId = path.substring("/photo/".length());
                if (active == null || !active.nativeId.equals(nativeId) || !store.current(active)) return denied();
                byte[] bytes = BackgroundGalleryPhotoReader.read(this, active);
                if (destroyed || generation != engineGeneration || photo != active || !store.current(active)) return denied();
                return response("image/jpeg", new ByteArrayInputStream(bytes));
            }
            if (!allowedAsset(path)) return denied();
            String type = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "application/javascript"
                : path.endsWith(".json") ? "application/json" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
            return response(type, getAssets().open("public" + path));
        } catch (Exception error) { return denied(); }
    }

    static boolean allowedAsset(String path) {
        if (path == null || path.contains("..") || !path.matches("/[A-Za-z0-9_./-]+")) return false;
        return path.equals("/gallery-scanner.html") || (path.startsWith("/assets/") && path.endsWith(".js")) ||
            (path.startsWith("/models/human/") && (path.endsWith(".json") || path.endsWith(".bin"))) ||
            (path.startsWith("/vendor/tfjs-wasm/") && (path.endsWith(".wasm") || path.endsWith(".js")));
    }
    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", headers(), new ByteArrayInputStream(new byte[0]));
    }
    static WebResourceResponse response(String type, InputStream bytes) {
        return new WebResourceResponse(type, type.startsWith("text/") || type.contains("javascript") || type.contains("json") ? "UTF-8" : null,
            200, "OK", headers(), bytes);
    }
    private static Map<String, String> headers() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Cross-Origin-Opener-Policy", "same-origin"); headers.put("Cross-Origin-Embedder-Policy", "require-corp");
        headers.put("Cross-Origin-Resource-Policy", "same-origin");
        headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-src 'none'");
        return headers;
    }

    private final class Host {
        private final long generation;
        Host(long generation) { this.generation = generation; }
        @JavascriptInterface public void ready() { main.post(() -> {
            if (destroyed || generation != engineGeneration) return;
            ready = true; pump();
        }); }
        @JavascriptInterface public void complete(String token, String scan) {
            BackgroundGalleryScanStore.Photo active = photo;
            if (destroyed || generation != engineGeneration || active == null || !BackgroundGalleryScanPolicy.tokenMatches(active.token, token)) return;
            if (scan == null || scan.length() > BackgroundGalleryScanPolicy.MAX_RESULT_BYTES) { failed(token, "Invalid result"); return; }
            work.execute(() -> {
                try {
                    BackgroundGalleryPhotoReader.verify(thisService(), active);
                    boolean saved = store.complete(active, scan);
                    main.post(() -> { if (photo == active && generation == engineGeneration) { if (saved) runtimeBudget.completed(); photo = null; pump(); } });
                } catch (SecurityException error) {
                    store.cancelIfCurrent(active.scope, active.generation);
                    main.post(() -> { if (owns(active.scope, active.generation)) stopChecking(); });
                }
                catch (IllegalStateException error) { failJob(active.scope, active.generation, "Open Bubble to save completed progress before continuing."); }
                catch (Exception error) { failed(token, "photo:scan-failed"); }
            });
        }
        @JavascriptInterface public void failed(String token, String reason) { main.post(() -> {
            BackgroundGalleryScanStore.Photo active = photo;
            if (!destroyed && generation == engineGeneration && active != null && BackgroundGalleryScanPolicy.tokenMatches(active.token, token)) {
                if (reason != null && reason.startsWith("photo:")) {
                    work.execute(() -> {
                        store.failed(active);
                        main.post(() -> { if (!destroyed && generation == engineGeneration && photo == active) { photo = null; pump(); } });
                    });
                } else engineFailed(generation, "A photo could not be checked reliably.");
            }
        }); }
    }

    private void pump() {
        if (destroyed || !ready || engine == null || photo != null || claiming || scope == null) return;
        claiming = true;
        String expectedScope = scope, expectedOwner = ownerGeneration; long generation = engineGeneration;
        work.execute(() -> {
            try {
                BackgroundGalleryScanStore.Photo next = store.claim(expectedScope, expectedOwner);
                if (next == null) store.finish(expectedScope, expectedOwner);
                main.post(() -> {
                    claiming = false;
                    if (destroyed || generation != engineGeneration || !owns(expectedScope, expectedOwner)) {
                        if (next != null && !destroyed) work.execute(() -> store.release(next));
                        return;
                    }
                    if (next == null) return;
                    photo = next;
                    try { engine.evaluateJavascript("window.BubbleGalleryEngine.scan(" + next.payload() + ")", null); }
                    catch (Exception failure) { engineFailed(generation, "Photo checking could not start."); return; }
                    main.postDelayed(() -> {
                        if (!destroyed && generation == engineGeneration && photo == next) engineFailed(generation, "This photo took too long to check.");
                    }, ENGINE_TIMEOUT_MS);
                });
            } catch (Exception error) {
                main.post(() -> { claiming = false; });
                failJob(expectedScope, expectedOwner, "Photo checking could not save its queue. Open Bubble and retry.");
            }
        });
    }

    private void engineFailed(long generation, String message) {
        if (destroyed || generation != engineGeneration) return;
        BackgroundGalleryScanStore.Photo failedPhoto = photo;
        photo = null; disposeEngine();
        String expectedScope = scope, expectedOwner = ownerGeneration;
        boolean exhausted = runtimeBudget.failed();
        work.execute(() -> {
            if (failedPhoto != null) store.failed(failedPhoto);
            if (exhausted) { failJob(expectedScope, expectedOwner, message); return; }
            main.post(() -> { if (!destroyed && owns(expectedScope, expectedOwner)) createEngine(); });
        });
    }

    private void failJob(String expectedScope, String expectedOwner, String message) {
        // This helper may be called on the queue executor or main thread.
        if (destroyed) return;
        try {
            work.execute(() -> {
                try { store.errorIfCurrent(expectedScope, expectedOwner, message); }
                finally { main.post(() -> { ticking = false; if (owns(expectedScope, expectedOwner)) stopChecking(); }); }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) { /* Service already stopped. */ }
    }

    private void disposeEngine() {
        ready = false; engineGeneration++;
        WebView old = engine; engine = null;
        if (old != null) {
            try { old.removeJavascriptInterface("BubbleGalleryHost"); old.stopLoading(); }
            catch (RuntimeException ignored) { /* Renderer may have already exited. */ }
            old.destroy();
        }
    }
    private void stopChecking() {
        main.removeCallbacks(tick);
        photo = null; disposeEngine();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
    private void pauseForTimeout() {
        String expectedScope = scope, expectedOwner = ownerGeneration;
        work.execute(() -> store.pauseIfCurrent(expectedScope, expectedOwner, "timeout"));
        // Android requires prompt stopSelf on its timeout callback, even if a
        // checkpoint transaction is momentarily waiting on another process.
        stopChecking();
    }
    private Notification notification(String message, int completed, int total) {
        Intent open = new Intent(this, MainActivity.class).setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse("kinsphere://open?route=%2Fjournal"));
        PendingIntent openIntent = PendingIntent.getActivity(this, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent pause = new Intent(this, BackgroundGalleryScanService.class).setAction(PAUSE).putExtra("scope", scope).putExtra("generation", ownerGeneration);
        PendingIntent pauseIntent = PendingIntent.getService(this, NOTIFICATION_ID + 1, pause, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_gallery)
            .setContentTitle("Bubble · Private photo checking").setContentText(message).setContentIntent(openIntent)
            .setOnlyAlertOnce(true).setOngoing(true).setProgress(Math.max(0, total), Math.max(0, completed), total == 0)
            .addAction(android.R.drawable.ic_media_pause, "Pause", pauseIntent).build();
    }
    @Override public void onTimeout(int startId, int fgsType) { pauseForTimeout(); }
    @Override public IBinder onBind(Intent intent) { return null; }
    private boolean owns(String expectedScope, String generation) {
        return expectedScope != null && generation != null && expectedScope.equals(scope) && generation.equals(ownerGeneration);
    }
    @Override public void onDestroy() {
        destroyed = true; main.removeCallbacksAndMessages(null);
        photo = null; disposeEngine();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        String departingScope = scope, departingOwner = ownerGeneration;
        work.execute(() -> {
            try {
                BackgroundGalleryScanStore.Owner owner = store.owner();
                if (owner != null && owner.scope.equals(departingScope) && owner.generation.equals(departingOwner) && "running".equals(owner.status)) store.pauseIfCurrent(departingScope, departingOwner, "interrupted");
            } finally { store.close(); }
        });
        work.shutdown(); super.onDestroy();
    }
}
