package com.simerfamily.kinsphere.cardboard;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.google.cardboard.sdk.CardboardView;
import com.google.cardboard.sdk.Initialize;
import com.google.cardboard.sdk.QrCode;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;

/** Full-screen Google Cardboard photo-sphere viewer used by the Android app. */
public final class CardboardPanoramaActivity extends AppCompatActivity {

    private static final String EXTRA_PANORAMA_PATH = "panorama_path";
    private static final String EXTRA_INITIAL_YAW = "initial_yaw";
    private static final String EXTRA_INITIAL_PITCH = "initial_pitch";

    private final AtomicBoolean shutdown = new AtomicBoolean();
    private CardboardView cardboardView;
    private EquirectangularPanoramaRenderer panoramaRenderer;
    private File panoramaFile;

    /** Builds the explicit, app-local launch intent consumed by this Activity. */
    static Intent createIntent(
        Context context,
        File panoramaFile,
        float initialYaw,
        float initialPitch
    ) {
        return new Intent(context, CardboardPanoramaActivity.class)
            .putExtra(EXTRA_PANORAMA_PATH, panoramaFile.getAbsolutePath())
            .putExtra(EXTRA_INITIAL_YAW, initialYaw)
            .putExtra(EXTRA_INITIAL_PITCH, initialPitch);
    }

    /** Validates the staged file and attaches a calibrated Cardboard renderer. */
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        panoramaFile = resolveSafePanoramaFile(getIntent().getStringExtra(EXTRA_PANORAMA_PATH));
        if (panoramaFile == null || !panoramaFile.isFile()) {
            Toast.makeText(this, "This 360 image could not be opened.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        configureWindow();

        try {
            Initialize.initialize(this);
            CardboardView.setUseCardboardGlSurfaceView(true);
            cardboardView = new CardboardView(this);
            cardboardView.setBackgroundColor(Color.BLACK);
            panoramaRenderer = new EquirectangularPanoramaRenderer(
                panoramaFile,
                getIntent().getFloatExtra(EXTRA_INITIAL_YAW, 0f),
                getIntent().getFloatExtra(EXTRA_INITIAL_PITCH, 0f),
                this::handleRendererFailure
            );
            cardboardView.setRenderer(panoramaRenderer);
            cardboardView.setStereoRenderMode(true);
            cardboardView.setOnBackButtonClick(this::finish);
            cardboardView.setOnSettingsButtonClick(cardboardView::scanViewerQrCode);
            cardboardView.setOnViewDetachedRunnable(this::shutdownViewer);
            setContentView(cardboardView);

            if (QrCode.getSavedDeviceParams() == null) {
                cardboardView.postDelayed(
                    this::showViewerSetup,
                    500L
                );
            }
        } catch (RuntimeException initializationError) {
            Toast.makeText(
                this,
                "This phone could not start the calibrated VR renderer.",
                Toast.LENGTH_LONG
            ).show();
            finish();
        }
    }

    /** Resumes head tracking only while the renderer still owns its native resources. */
    @Override
    protected void onResume() {
        super.onResume();
        applyImmersiveMode();
        if (cardboardView != null && !shutdown.get()) {
            cardboardView.onResume();
        }
    }

    /** Pauses Cardboard tracking before Android backgrounds the Activity. */
    @Override
    protected void onPause() {
        if (cardboardView != null && !shutdown.get()) {
            cardboardView.onPause();
        }
        super.onPause();
    }

    /** Restores immersive UI after transient system panels release window focus. */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyImmersiveMode();
        }
    }

    /** Releases renderer state once and deletes only the app-owned staged panorama. */
    @Override
    protected void onDestroy() {
        shutdownViewer();
        if (isFinishing() && panoramaFile != null) {
            // The image is a short-lived copy inside this app's own cache.
            //noinspection ResultOfMethodCallIgnored
            panoramaFile.delete();
        }
        super.onDestroy();
    }

    /** Treats the system back action as an ordinary viewer dismissal. */
    @Override
    public void onBackPressed() {
        finish();
    }

    /** Configures a bright, wake-locked, edge-to-edge window for a headset session. */
    private void configureWindow() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        attributes.screenBrightness = 1f;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        getWindow().setAttributes(attributes);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        applyImmersiveMode();
    }

    /** Hides system bars through both current and legacy Android window APIs. */
    private void applyImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
            getWindow(),
            getWindow().getDecorView()
        );
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
                View.SYSTEM_UI_FLAG_FULLSCREEN |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    /** Surfaces a renderer failure once on the UI thread and closes the unusable view. */
    private void handleRendererFailure(String message) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) {
                return;
            }
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
            finish();
        });
    }

    /** Prompts for a headset profile only when Cardboard has no saved optical parameters. */
    private void showViewerSetup() {
        if (isFinishing() || isDestroyed() || cardboardView == null) {
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle("Set up your VR headset")
            .setMessage(
                "Scan the QR code printed on your headset to match its lenses and prevent double vision. " +
                "You only need to do this once."
            )
            .setPositiveButton(
                "Scan headset QR",
                (dialog, which) -> cardboardView.scanViewerQrCode()
            )
            .setNegativeButton("Use standard viewer", null)
            .show();
    }

    /** Requests GL shutdown exactly once before the Cardboard view releases its context. */
    private void shutdownViewer() {
        if (!shutdown.compareAndSet(false, true)) {
            return;
        }
        if (panoramaRenderer != null) {
            panoramaRenderer.requestShutdown();
        }
        if (cardboardView != null) {
            cardboardView.onDestroy();
        }
    }

    /** Accepts only canonical files directly beneath the Cardboard cache directory. */
    private File resolveSafePanoramaFile(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        try {
            File allowedDirectory = new File(getCacheDir(), "cardboard-panoramas").getCanonicalFile();
            File candidate = new File(path).getCanonicalFile();
            String allowedPrefix = allowedDirectory.getPath() + File.separator;
            return candidate.getPath().startsWith(allowedPrefix) ? candidate : null;
        } catch (IOException error) {
            return null;
        }
    }
}
