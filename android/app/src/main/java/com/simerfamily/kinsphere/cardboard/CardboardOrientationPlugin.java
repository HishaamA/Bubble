package com.simerfamily.kinsphere.cardboard;

import android.content.pm.ActivityInfo;
import android.os.Build;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Keeps Cardboard in landscape and restores the app's prior orientation on exit. */
@CapacitorPlugin(name = "CardboardOrientation")
public final class CardboardOrientationPlugin extends Plugin {

    private final OrientationSession orientationSession = new OrientationSession();

    @PluginMethod
    public void requestLandscape(PluginCall call) {
        AppCompatActivity activity = getActivity();
        if (!isActivityAvailable(activity)) {
            call.reject(
                "The Bubble app view is not available.",
                "ORIENTATION_CONTROLLER_UNAVAILABLE"
            );
            return;
        }

        activity.runOnUiThread(() -> {
            if (!isActivityAvailable(activity)) {
                call.reject(
                    "The Bubble app view is not available.",
                    "ORIENTATION_CONTROLLER_UNAVAILABLE"
                );
                return;
            }

            orientationSession.rememberIfNeeded(activity.getRequestedOrientation());
            try {
                activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                JSObject result = new JSObject();
                result.put("orientation", "landscape");
                call.resolve(result);
            } catch (RuntimeException requestError) {
                restoreAfterFailedRequest(activity);
                call.reject(
                    "The Cardboard landscape orientation could not be requested.",
                    "ORIENTATION_REQUEST_FAILED",
                    requestError
                );
            }
        });
    }

    @PluginMethod
    public void restoreAppOrientation(PluginCall call) {
        AppCompatActivity activity = getActivity();
        if (!isActivityAvailable(activity)) {
            call.reject(
                "The Bubble app view is not available.",
                "ORIENTATION_CONTROLLER_UNAVAILABLE"
            );
            return;
        }

        activity.runOnUiThread(() -> {
            if (!isActivityAvailable(activity)) {
                call.reject(
                    "The Bubble app view is not available.",
                    "ORIENTATION_CONTROLLER_UNAVAILABLE"
                );
                return;
            }

            Integer previousOrientation = orientationSession.previousOrientation();
            if (previousOrientation == null) {
                resolveRestored(call, activity.getRequestedOrientation());
                return;
            }

            try {
                activity.setRequestedOrientation(previousOrientation);
                orientationSession.markRestored();
                resolveRestored(call, previousOrientation);
            } catch (RuntimeException restoreError) {
                // Keep the saved value so a later exit/unmount retry can restore it.
                call.reject(
                    "The previous app orientation could not be restored.",
                    "ORIENTATION_RESTORE_FAILED",
                    restoreError
                );
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        // A finishing Activity no longer needs an orientation restoration. Avoid
        // carrying its request into a future bridge/plugin instance.
        orientationSession.markRestored();
    }

    private void restoreAfterFailedRequest(AppCompatActivity activity) {
        Integer previousOrientation = orientationSession.previousOrientation();
        if (previousOrientation == null) {
            return;
        }
        try {
            activity.setRequestedOrientation(previousOrientation);
            orientationSession.markRestored();
        } catch (RuntimeException ignored) {
            // Retain the saved value so restoreAppOrientation can retry.
        }
    }

    private static void resolveRestored(PluginCall call, int orientation) {
        JSObject result = new JSObject();
        result.put("orientation", orientationLabel(orientation));
        call.resolve(result);
    }

    private static boolean isActivityAvailable(AppCompatActivity activity) {
        return activity != null &&
            !activity.isFinishing() &&
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.JELLY_BEAN_MR1 || !activity.isDestroyed());
    }

    static String orientationLabel(int orientation) {
        if (
            orientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
        ) {
            return "landscape";
        }
        if (
            orientation == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
        ) {
            return "portrait";
        }
        return "unspecified";
    }

    static final class OrientationSession {
        private Integer previousOrientation;

        synchronized void rememberIfNeeded(int orientation) {
            if (previousOrientation == null) {
                previousOrientation = orientation;
            }
        }

        synchronized Integer previousOrientation() {
            return previousOrientation;
        }

        synchronized void markRestored() {
            previousOrientation = null;
        }
    }
}
