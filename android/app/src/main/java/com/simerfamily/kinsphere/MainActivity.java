package com.simerfamily.kinsphere;

import android.content.res.Configuration;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;
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
import java.util.Locale;

/** Hosts the Capacitor bridge and the reversible window state used by Cardboard. */
public final class MainActivity extends BridgeActivity {

    private final CardboardWindowController cardboardWindowController =
        new CardboardWindowController();
    private final Handler viewportHandler = new Handler(Looper.getMainLooper());
    private final Runnable publishViewportGeometry = this::publishViewportGeometry;
    private boolean destroying;

    /** Registers native bridges before Capacitor creates the WebView and window shell. */
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

    /** Enters the immersive landscape presentation required by the web Cardboard flow. */
    public void enterCardboardPresentation() {
        cardboardWindowController.enter(this);
        scheduleCardboardViewportGeometry();
    }

    /** Restores the ordinary Capacitor window after the web Cardboard flow exits. */
    public void restoreAppPresentation() {
        cardboardWindowController.exit(this);
        scheduleCardboardViewportGeometry();
    }

    /** Returns whether this activity currently owns an immersive Cardboard session. */
    public boolean isCardboardPresentationActive() {
        return cardboardWindowController.isActive();
    }

    /**
     * Returns whether Android, the activity, and the WebView have all settled in
     * fullscreen landscape after an orientation request.
     */
    public boolean isCardboardPresentationReady() {
        if (!cardboardWindowController.isActive()) {
            return false;
        }
        View decorView = getWindow().getDecorView();
        if (
            getResources().getConfiguration().orientation != Configuration.ORIENTATION_LANDSCAPE ||
            decorView.getWidth() <= decorView.getHeight()
        ) {
            return false;
        }
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null || webView.getWidth() <= webView.getHeight()) {
            return false;
        }
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decorView);
        if (insets != null) {
            return !insets.isVisible(WindowInsetsCompat.Type.statusBars()) &&
                !insets.isVisible(WindowInsetsCompat.Type.navigationBars());
        }
        int visibility = decorView.getSystemUiVisibility();
        return (visibility & View.SYSTEM_UI_FLAG_FULLSCREEN) != 0 &&
            (visibility & View.SYSTEM_UI_FLAG_HIDE_NAVIGATION) != 0;
    }

    /** Reasserts immersive flags after system UI temporarily takes window focus. */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && cardboardWindowController.isActive()) {
            cardboardWindowController.reapply(this);
            scheduleCardboardViewportGeometry();
        }
    }

    /** Reapplies the active Cardboard presentation after returning from another Activity. */
    @Override
    protected void onPostResume() {
        super.onPostResume();
        if (cardboardWindowController.isActive()) {
            cardboardWindowController.reapply(this);
            scheduleCardboardViewportGeometry();
        }
    }

    /** Publishes the WebView's settled geometry after an orientation or size-class change. */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (cardboardWindowController.isActive()) {
            cardboardWindowController.reapply(this);
        }
        scheduleCardboardViewportGeometry();
    }

    /** Cancels delayed WebView callbacks before the Activity and bridge are destroyed. */
    @Override
    protected void onDestroy() {
        destroying = true;
        viewportHandler.removeCallbacks(publishViewportGeometry);
        super.onDestroy();
    }

    /** Coalesces viewport updates while Android and the WebView settle independently. */
    private void scheduleCardboardViewportGeometry() {
        if (destroying) {
            return;
        }
        viewportHandler.removeCallbacks(publishViewportGeometry);
        // Orientation, WebView layout, and display-cutout insets settle on
        // separate frames, so publish at each of the bounded transition points.
        viewportHandler.post(publishViewportGeometry);
        viewportHandler.postDelayed(publishViewportGeometry, 100L);
        viewportHandler.postDelayed(publishViewportGeometry, 300L);
    }

    /** Sends CSS-pixel viewport and cutout geometry to the shared Cardboard layout. */
    private void publishViewportGeometry() {
        if (getBridge() == null) {
            return;
        }
        WebView webView = getBridge().getWebView();
        if (webView == null || webView.getWidth() <= 0 || webView.getHeight() <= 0) {
            return;
        }

        View decorView = getWindow().getDecorView();
        WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(decorView);
        Insets cutoutInsets = rootInsets == null
            ? Insets.NONE
            : rootInsets.getInsets(WindowInsetsCompat.Type.displayCutout());
        float density = Math.max(1f, getResources().getDisplayMetrics().density);
        String script = String.format(
            Locale.US,
            """
            window.dispatchEvent(new CustomEvent(
              'kinsphere:native-viewport-geometry',
              {detail:{safeAreaInsets:{top:%.3f,right:%.3f,bottom:%.3f,left:%.3f},viewport:{width:%.3f,height:%.3f}}}
            ));
            window.dispatchEvent(new Event('resize'));
            """,
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
