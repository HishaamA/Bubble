package com.simerfamily.kinsphere;

import android.content.res.Configuration;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.simerfamily.kinsphere.cardboard.CardboardOrientationPlugin;
import com.simerfamily.kinsphere.cardboard.CardboardPanoramaPlugin;
import com.simerfamily.kinsphere.cardboard.CardboardWindowController;
import com.simerfamily.kinsphere.capsule.CapsuleRecapPlugin;
import com.simerfamily.kinsphere.debug.DebugAccessPlugin;
import com.simerfamily.kinsphere.panorama.PanoramaCapturePlugin;

public class MainActivity extends BridgeActivity {

    private final CardboardWindowController cardboardWindowController =
        new CardboardWindowController();
    private final Handler viewportHandler = new Handler(Looper.getMainLooper());
    private final Runnable publishViewportGeometry = this::publishViewportGeometry;
    private boolean destroying;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(CardboardOrientationPlugin.class);
        registerPlugin(CardboardPanoramaPlugin.class);
        registerPlugin(CapsuleRecapPlugin.class);
        registerPlugin(DebugAccessPlugin.class);
        registerPlugin(PanoramaCapturePlugin.class);
        super.onCreate(savedInstanceState);
        // KinSphere's normal app shell owns this baseline. Cardboard temporarily
        // switches it to edge-to-edge and restores this explicit state on exit.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
    }

    public void enterCardboardPresentation() {
        cardboardWindowController.enter(this);
        scheduleCardboardViewportGeometry();
    }

    public void restoreAppPresentation() {
        cardboardWindowController.exit(this);
        scheduleCardboardViewportGeometry();
    }

    public boolean isCardboardPresentationActive() {
        return cardboardWindowController.isActive();
    }

    public boolean isCardboardPresentationReady() {
        if (!cardboardWindowController.isActive()) return false;
        View decor = getWindow().getDecorView();
        if (
            getResources().getConfiguration().orientation != Configuration.ORIENTATION_LANDSCAPE ||
            decor.getWidth() <= decor.getHeight()
        ) {
            return false;
        }
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null || webView.getWidth() <= webView.getHeight()) return false;
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
        if (insets != null) {
            return !insets.isVisible(WindowInsetsCompat.Type.statusBars()) &&
                !insets.isVisible(WindowInsetsCompat.Type.navigationBars());
        }
        int visibility = decor.getSystemUiVisibility();
        return (visibility & View.SYSTEM_UI_FLAG_FULLSCREEN) != 0 &&
            (visibility & View.SYSTEM_UI_FLAG_HIDE_NAVIGATION) != 0;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && cardboardWindowController.isActive()) {
            cardboardWindowController.reapply(this);
            scheduleCardboardViewportGeometry();
        }
    }

    @Override
    protected void onPostResume() {
        super.onPostResume();
        if (cardboardWindowController.isActive()) {
            cardboardWindowController.reapply(this);
            scheduleCardboardViewportGeometry();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (cardboardWindowController.isActive()) {
            cardboardWindowController.reapply(this);
        }
        scheduleCardboardViewportGeometry();
    }

    @Override
    public void onDestroy() {
        destroying = true;
        viewportHandler.removeCallbacks(publishViewportGeometry);
        super.onDestroy();
        viewportHandler.removeCallbacks(publishViewportGeometry);
    }

    private void scheduleCardboardViewportGeometry() {
        if (destroying) return;
        viewportHandler.removeCallbacks(publishViewportGeometry);
        viewportHandler.post(publishViewportGeometry);
        viewportHandler.postDelayed(publishViewportGeometry, 100L);
        viewportHandler.postDelayed(publishViewportGeometry, 300L);
    }

    private void publishViewportGeometry() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null || webView.getWidth() <= 0 || webView.getHeight() <= 0) return;

        View decor = getWindow().getDecorView();
        WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(decor);
        Insets cutoutInsets = rootInsets == null
            ? Insets.NONE
            : rootInsets.getInsets(WindowInsetsCompat.Type.displayCutout());
        float density = Math.max(1f, getResources().getDisplayMetrics().density);
        String script = String.format(
            java.util.Locale.US,
            "window.dispatchEvent(new CustomEvent('kinsphere:native-viewport-geometry',{detail:{safeAreaInsets:{top:%.3f,right:%.3f,bottom:%.3f,left:%.3f},viewport:{width:%.3f,height:%.3f}}}));window.dispatchEvent(new Event('resize'));",
            cutoutInsets.top / density,
            cutoutInsets.right / density,
            cutoutInsets.bottom / density,
            cutoutInsets.left / density,
            webView.getWidth() / density,
            webView.getHeight() / density
        );
        webView.evaluateJavascript(script, null);
    }
}
