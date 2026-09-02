package com.simerfamily.kinsphere.capsule;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.chooser.ChooserResult;
import androidx.core.content.IntentCompat;

/** Receives the explicit, app-private result from Android's system share sheet. */
public final class CapsuleShareTargetReceiver extends BroadcastReceiver {

    static final String EXTRA_SHARE_TOKEN =
        "com.simerfamily.kinsphere.extra.CAPSULE_SHARE_TOKEN";

    // Android creates the manifest receiver separately from the Capacitor
    // plugin. Keep one token-scoped result so no Activity or PluginCall leaks.
    private static String expectedToken;
    private static String selectedActivityType;
    private static boolean selectionReceived;

    /** Records only a target selected for the currently active share token. */
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            return;
        }
        String shareToken = intent.getStringExtra(EXTRA_SHARE_TOKEN);
        ComponentName selectedComponent = IntentCompat.getParcelableExtra(
            intent,
            Intent.EXTRA_CHOSEN_COMPONENT,
            ComponentName.class
        );
        boolean completed = selectedComponent != null;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            // Android 15 also reports built-in copy/edit actions, which do not
            // necessarily have a selected Activity component.
            ChooserResult chooserResult = IntentCompat.getParcelableExtra(
                intent,
                Intent.EXTRA_CHOOSER_RESULT,
                ChooserResult.class
            );
            if (chooserResult != null) {
                completed = true;
                if (selectedComponent == null) {
                    selectedComponent = chooserResult.getSelectedComponent();
                }
            }
        }

        if (completed) {
            recordSelection(
                shareToken,
                selectedComponent == null ? null : selectedComponent.flattenToShortString()
            );
        }
    }

    /** Starts one chooser result slot and invalidates any older share token. */
    static synchronized void prepareSelection(String shareToken) {
        expectedToken = shareToken;
        selectedActivityType = null;
        selectionReceived = false;
    }

    /** Accepts a result only when it belongs to the active chooser request. */
    static synchronized void recordSelection(String shareToken, String activityType) {
        if (shareToken == null || !shareToken.equals(expectedToken)) {
            return;
        }
        selectedActivityType = activityType;
        selectionReceived = true;
    }

    /** Consumes the active selection exactly once and clears its static state. */
    static synchronized Selection consumeSelection(String shareToken) {
        if (shareToken == null || !shareToken.equals(expectedToken)) {
            return null;
        }
        Selection selection = selectionReceived
            ? new Selection(selectedActivityType)
            : null;
        clearSelectionState();
        return selection;
    }

    /** Abandons matching chooser state when presentation is cancelled or torn down. */
    static synchronized void clearSelection(String shareToken) {
        if (shareToken != null && shareToken.equals(expectedToken)) {
            clearSelectionState();
        }
    }

    /** Removes all retained chooser result data. Caller synchronization is required. */
    private static void clearSelectionState() {
        expectedToken = null;
        selectedActivityType = null;
        selectionReceived = false;
    }

    /** A delivered chooser action, optionally associated with an Activity. */
    static final class Selection {
        final String activityType;

        /** Preserves the selected Activity name without retaining Android objects. */
        Selection(String activityType) {
            this.activityType = activityType;
        }
    }
}
