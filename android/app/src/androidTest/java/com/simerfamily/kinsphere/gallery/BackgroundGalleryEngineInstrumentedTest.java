package com.simerfamily.kinsphere.gallery;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Runs the packaged model in an unattached WebView using only a generated gray
 * image. No Activity, gallery permission, gallery asset, or production queue is
 * opened. This tests the engine/CSP contract, not foreground-service survival.
 */
@SdkSuppress(minSdkVersion = 28)
public final class BackgroundGalleryEngineInstrumentedTest {
    private static final String ENTRY = BackgroundGalleryScanService.ORIGIN + "/gallery-scanner.html";

    @Test public void packagedEngineCompletesSyntheticPhotoWithoutAnActivity() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AtomicReference<WebView> webView = new AtomicReference<>();
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicReference<String> blockedBundleAsset = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        String token = UUID.randomUUID().toString();
        String payload = new JSONObject().put("token", token)
            .put("key", "journal-photo:device-gallery:1:").put("nativeId", "1").toString();
        Bitmap bitmap = Bitmap.createBitmap(1600, 1200, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.rgb(150, 150, 150));
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 85, encoded));
        bitmap.recycle();
        byte[] syntheticPhoto = encoded.toByteArray();
        SyntheticHost host = new SyntheticHost(webView, token, payload, result, failure, completed);
        long started = android.os.SystemClock.elapsedRealtime();
        try {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                try {
                    WebView view = new WebView(context.getApplicationContext());
                    webView.set(view);
                    WebSettings settings = view.getSettings();
                    settings.setJavaScriptEnabled(true);
                    settings.setDomStorageEnabled(false);
                    settings.setAllowFileAccess(false);
                    settings.setAllowContentAccess(false);
                    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
                    view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
                    view.addJavascriptInterface(host, "BubbleGalleryHost");
                    view.setWebViewClient(new WebViewClient() {
                        @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) { return true; }
                        @Override public WebResourceResponse shouldInterceptRequest(WebView ignored, WebResourceRequest request) {
                            try {
                                Uri uri = request.getUrl();
                                String path = uri.getPath();
                                if (!"GET".equals(request.getMethod()) || !"https".equals(uri.getScheme()) ||
                                    !"gallery.bubble.local".equals(uri.getHost()) || uri.getPort() != -1 ||
                                    uri.getQuery() != null || uri.getUserInfo() != null || uri.getFragment() != null) {
                                    throw new IllegalArgumentException("The engine attempted an external request");
                                }
                                if ("/photo/1".equals(path)) return BackgroundGalleryScanService.response("image/jpeg", new ByteArrayInputStream(syntheticPhoto));
                                if (!BackgroundGalleryScanService.allowedAsset(path)) throw new IllegalArgumentException("The engine requested an unapproved asset");
                                String type = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "application/javascript"
                                    : path.endsWith(".json") ? "application/json" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
                                return BackgroundGalleryScanService.response(type, context.getAssets().open("public" + path));
                            } catch (Exception error) {
                                // WebView may request optional assets (notably
                                // /favicon.ico). Match the service's deny-only
                                // behavior instead of treating every denied
                                // request as a failed inference. A required
                                // dependency still prevents ready/complete or
                                // causes the engine's explicit failed callback.
                                String path = request.getUrl().getPath();
                                if ("gallery.bubble.local".equals(request.getUrl().getHost()) && path != null &&
                                    path.matches("/[A-Za-z0-9_./-]{1,150}") && !path.startsWith("/photo/")) {
                                    blockedBundleAsset.compareAndSet(null, path);
                                }
                                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", null, new ByteArrayInputStream(new byte[0]));
                            }
                        }
                    });
                    view.loadUrl(ENTRY);
                } catch (Throwable error) { failure.compareAndSet(null, error); completed.countDown(); }
            });
            boolean finished = completed.await(180, TimeUnit.SECONDS);
            String diagnostic = blockedBundleAsset.get() == null ? "" : "; blocked local asset: " + blockedBundleAsset.get();
            assertTrue("The offscreen engine did not return within 180 seconds" + diagnostic, finished);
            if (failure.get() != null) throw new AssertionError("The packaged offscreen engine failed" + diagnostic, failure.get());
            assertNotNull("The engine must return a checkpoint", result.get());
            BackgroundGalleryScanStore.validateScan(result.get());
            assertEquals("A plain synthetic image must not produce faces", 0, new JSONObject(result.get()).getJSONArray("faces").length());
            android.util.Log.i("BubbleGallerySynthetic", "Detached packaged model completed in " + (android.os.SystemClock.elapsedRealtime() - started) + "ms");
        } finally {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                WebView view = webView.getAndSet(null);
                if (view != null) { view.removeJavascriptInterface("BubbleGalleryHost"); view.stopLoading(); view.destroy(); }
            });
        }
    }

    public static final class SyntheticHost {
        private final AtomicReference<WebView> webView;
        private final String token, payload;
        private final AtomicReference<String> result;
        private final AtomicReference<Throwable> failure;
        private final CountDownLatch completed;
        SyntheticHost(AtomicReference<WebView> webView, String token, String payload, AtomicReference<String> result,
            AtomicReference<Throwable> failure, CountDownLatch completed) {
            this.webView = webView; this.token = token; this.payload = payload; this.result = result; this.failure = failure; this.completed = completed;
        }
        @JavascriptInterface public void ready() {
            new Handler(Looper.getMainLooper()).post(() -> {
                WebView view = webView.get();
                if (view != null) view.evaluateJavascript("window.BubbleGalleryEngine.scan(" + payload + ")", null);
            });
        }
        @JavascriptInterface public void complete(String callbackToken, String scan) {
            if (!token.equals(callbackToken)) { failure.compareAndSet(null, new AssertionError("Mismatched result token")); }
            else result.set(scan);
            completed.countDown();
        }
        @JavascriptInterface public void failed(String callbackToken, String reason) {
            failure.compareAndSet(null, new AssertionError("Engine failure: " + reason)); completed.countDown();
        }
    }
}
