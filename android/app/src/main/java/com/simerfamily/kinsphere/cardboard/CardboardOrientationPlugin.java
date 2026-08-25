package com.simerfamily.kinsphere.cardboard;

import android.content.pm.ActivityInfo;
import android.os.Build;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.simerfamily.kinsphere.MainActivity;
import java.util.concurrent.atomic.AtomicLong;

/** Keeps Cardboard in landscape and restores the app's prior orientation on exit. */
@CapacitorPlugin(name = "CardboardOrientation")
public final class CardboardOrientationPlugin extends Plugin {

    private final OrientationSession orientationSession = new OrientationSession();
    private final AtomicLong requestGeneration = new AtomicLong();

    @PluginMethod
    public void requestLandscape(PluginCall call) {
        long requestId = requestGeneration.incrementAndGet();
        MainActivity activity = mainActivity();
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
                // A fixed landscape frame cannot flip 180 degrees while the
                // phone is enclosed in a headset.
                activity.enterCardboardPresentation();
                activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
                resolveWhenPresentationSettles(
                    activity,
                    call,
                    requestId,
                    SystemClock.uptimeMillis() + 1800L
                );
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
        requestGeneration.incrementAndGet();
        MainActivity activity = mainActivity();
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
                activity.restoreAppPresentation();
                resolveRestored(call, activity.getRequestedOrientation());
                return;
            }

            try {
                int restoredOrientation = normalizedRestoreOrientation(previousOrientation);
                activity.restoreAppPresentation();
                activity.setRequestedOrientation(restoredOrientation);
                orientationSession.markRestored();
                resolveRestored(call, restoredOrientation);
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
        requestGeneration.incrementAndGet();
        orientationSession.markRestored();
    }

    private void restoreAfterFailedRequest(MainActivity activity) {
        try {
            activity.restoreAppPresentation();
        } catch (RuntimeException ignored) {
            // The original request failure must still reach JavaScript.
        }
        Integer previousOrientation = orientationSession.previousOrientation();
        if (previousOrientation == null) {
            return;
        }
        try {
            activity.setRequestedOrientation(normalizedRestoreOrientation(previousOrientation));
            orientationSession.markRestored();
        } catch (RuntimeException ignored) {
            // Retain the saved value so restoreAppOrientation can retry.
        }
    }

    private void resolveWhenPresentationSettles(
        MainActivity activity,
        PluginCall call,
        long requestId,
        long deadline
    ) {
        if (requestGeneration.get() != requestId) {
            call.reject(
                "The Cardboard request was superseded.",
                "ORIENTATION_REQUEST_SUPERSEDED"
            );
            return;
        }
        if (!isActivityAvailable(activity) || !activity.isCardboardPresentationActive()) {
            call.reject(
                "The Cardboard immersive window did not remain active.",
                "IMMERSIVE_PRESENTATION_FAILED"
            );
            return;
        }
        if (activity.isCardboardPresentationReady()) {
            JSObject result = new JSObject();
            result.put("orientation", "landscape");
            result.put("immersive", true);
            call.resolve(result);
            return;
        }
        if (SystemClock.uptimeMillis() >= deadline) {
            restoreAfterFailedRequest(activity);
            call.reject(
                "Android could not establish a stable fullscreen landscape view.",
                "IMMERSIVE_PRESENTATION_TIMEOUT"
            );
            return;
        }
        activity.getWindow().getDecorView().postDelayed(
            () -> resolveWhenPresentationSettles(activity, call, requestId, deadline),
            50L
        );
    }

    private static void resolveRestored(PluginCall call, int orientation) {
        JSObject result = new JSObject();
        result.put("orientation", orientationLabel(orientation));
        call.resolve(result);
    }

    private MainActivity mainActivity() {
        return getActivity() instanceof MainActivity
            ? (MainActivity) getActivity()
            : null;
    }

    private static boolean isActivityAvailable(MainActivity activity) {
        return activity != null &&
            !activity.isFinishing() &&
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.JELLY_BEAN_MR1 || !activity.isDestroyed());
    }

    static int normalizedRestoreOrientation(int orientation) {
        if (
            orientation == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_USER ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_SENSOR ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR ||
            orientation == ActivityInfo.SCREEN_ORIENTATION_BEHIND
        ) {
            return ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        }
        return orientation;
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
