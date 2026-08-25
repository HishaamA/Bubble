package com.simerfamily.kinsphere.cardboard;

import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** Owns the reversible Android window state used only during Cardboard view. */
public final class CardboardWindowController {

    private boolean active;
    private int previousSystemUiVisibility;
    private boolean previousKeepScreenOn;
    private boolean previousStatusBarsVisible;
    private boolean previousNavigationBarsVisible;
    private int previousCutoutMode;

    public synchronized void enter(AppCompatActivity activity) {
        Window window = activity.getWindow();
        View decor = window.getDecorView();
        if (!active) {
            previousSystemUiVisibility = decor.getSystemUiVisibility();
            previousKeepScreenOn =
                (window.getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0;
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
            previousStatusBarsVisible =
                insets == null || insets.isVisible(WindowInsetsCompat.Type.statusBars());
            previousNavigationBarsVisible =
                insets == null || insets.isVisible(WindowInsetsCompat.Type.navigationBars());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                previousCutoutMode = window.getAttributes().layoutInDisplayCutoutMode;
            }
            active = true;
        }
        applyImmersiveWindow(activity);
    }

    public synchronized void reapply(AppCompatActivity activity) {
        if (!active) return;
        applyImmersiveWindow(activity);
    }

    public synchronized void exit(AppCompatActivity activity) {
        if (!active) return;
        Window window = activity.getWindow();
        View decor = window.getDecorView();
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(window, decor);

        WindowCompat.setDecorFitsSystemWindows(window, true);
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_DEFAULT);
        controller.show(WindowInsetsCompat.Type.systemBars());
        decor.setSystemUiVisibility(previousSystemUiVisibility);
        if (!previousStatusBarsVisible) {
            controller.hide(WindowInsetsCompat.Type.statusBars());
        }
        if (!previousNavigationBarsVisible) {
            controller.hide(WindowInsetsCompat.Type.navigationBars());
        }

        if (previousKeepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.layoutInDisplayCutoutMode = previousCutoutMode;
            window.setAttributes(attributes);
        }
        active = false;
    }

    public synchronized boolean isActive() {
        return active;
    }

    private void applyImmersiveWindow(AppCompatActivity activity) {
        Window window = activity.getWindow();
        View decor = window.getDecorView();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attributes);
        }

        // Keep the legacy flags as a fallback for Android 7-9 WebViews while
        // WindowInsetsControllerCompat owns the modern edge-to-edge session.
        decor.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(window, decor);
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
}
