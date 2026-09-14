package com.simerfamily.kinsphere.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import com.simerfamily.kinsphere.R;
import java.util.Collections;
import java.util.List;

/** Explicit card selection, independent of a launcher's transient collection state. */
final class BubbleWidgetNavigation {
    static final String ACTION_PREVIOUS =
        "com.simerfamily.kinsphere.widget.ACTION_PREVIOUS";
    static final String ACTION_NEXT =
        "com.simerfamily.kinsphere.widget.ACTION_NEXT";
    private static final String PREFERENCES = "bubble_widget_navigation_v1";
    private static final String SELECTION_PREFIX = "selected_slot_";
    private static final Object LOCK = new Object();

    private BubbleWidgetNavigation() {}

    static void attachControls(
        Context context,
        RemoteViews views,
        int appWidgetId,
        boolean canBrowse
    ) {
        views.setViewVisibility(
            R.id.bubble_widget_navigation,
            canBrowse ? View.VISIBLE : View.GONE
        );
        if (!canBrowse) {
            return;
        }
        views.setOnClickPendingIntent(
            R.id.bubble_widget_previous,
            browseIntent(context, appWidgetId, false)
        );
        views.setOnClickPendingIntent(
            R.id.bubble_widget_next,
            browseIntent(context, appWidgetId, true)
        );
    }

    static boolean canBrowse(BubbleWidgetSnapshot snapshot, long nowMillis) {
        return visiblePages(snapshot, nowMillis).size() > 1;
    }

    /**
     * Call while publishing the matching Store.Entry. Only an opaque original
     * slot ID is persisted, never a page title, route, image, or account token.
     * Photo rotation may change that slot's payload without changing selection.
     */
    static int selectPosition(
        Context context,
        int appWidgetId,
        BubbleWidgetSnapshot sourceSnapshot,
        long nowMillis,
        int direction
    ) {
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            return 0;
        }
        synchronized (LOCK) {
            List<BubbleWidgetSnapshot.Page> pages = visiblePages(sourceSnapshot, nowMillis);
            SharedPreferences preferences = preferences(context);
            String key = selectionKey(appWidgetId);
            if (pages.isEmpty()) {
                // A stale/hidden/account-cleared deck must not retain selection.
                preferences.edit().remove(key).commit();
                return 0;
            }
            String previous = preferences.getString(key, null);
            int position = resolvePosition(pages, previous, direction);
            String selected = pages.get(position).id;
            if (!selected.equals(previous)) {
                // The payload itself is still read fresh under Store.withEntry.
                // A failed disk write cannot resurrect cached sensitive content.
                preferences.edit().putString(key, selected).commit();
            }
            return position;
        }
    }

    /** Pure selection policy used by the publisher and regression tests. */
    static int resolvePosition(
        List<BubbleWidgetSnapshot.Page> originalPages,
        String selectedId,
        int direction
    ) {
        if (originalPages == null || originalPages.isEmpty()) {
            return 0;
        }
        int current = 0;
        if (selectedId != null) {
            for (int index = 0; index < originalPages.size(); index += 1) {
                if (selectedId.equals(originalPages.get(index).id)) {
                    current = index;
                    break;
                }
            }
        }
        return Math.floorMod(current + Integer.signum(direction), originalPages.size());
    }

    static void clearSelection(Context context, int appWidgetId) {
        synchronized (LOCK) {
            preferences(context).edit().remove(selectionKey(appWidgetId)).commit();
        }
    }

    static void clearAllSelections(Context context) {
        synchronized (LOCK) {
            preferences(context).edit().clear().commit();
        }
    }

    private static List<BubbleWidgetSnapshot.Page> visiblePages(
        BubbleWidgetSnapshot sourceSnapshot,
        long nowMillis
    ) {
        if (sourceSnapshot == null || !sourceSnapshot.isCurrentLocalDay(nowMillis)) {
            return Collections.emptyList();
        }
        BubbleWidgetSnapshot display = sourceSnapshot.forDisplay(nowMillis);
        return "full".equals(display.privacy) ? display.pages : Collections.emptyList();
    }

    private static SharedPreferences preferences(Context context) {
        // Separate from BubbleWidgetStore: its privacy transactions replace all
        // snapshot preferences, and must never be weakened for UI selection.
        return context.getApplicationContext().getSharedPreferences(
            PREFERENCES,
            Context.MODE_PRIVATE
        );
    }

    private static String selectionKey(int appWidgetId) {
        return SELECTION_PREFIX + appWidgetId;
    }

    /** Returns true only for our browsing actions, including stale pending intents. */
    static boolean handleBrowse(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        boolean forward = ACTION_NEXT.equals(action);
        if (!forward && !ACTION_PREVIOUS.equals(action)) {
            return false;
        }

        Context appContext = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(appContext);
        int appWidgetId = intent.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID
        );
        if (!isRegistered(appContext, manager, appWidgetId)) {
            // A deleted/replaced widget's pending intent must not affect another widget.
            return true;
        }

        // Relative showNext/showPrevious actions are MERGE_IGNORE: Android's
        // partial-update merge drops them before they reach the launcher.
        // Publish one complete, absolute selection instead. This also keeps the
        // card, counter, photograph and click route in the same update.
        BubbleWidgetRenderer.publish(appContext, manager, appWidgetId, forward ? 1 : -1);
        return true;
    }

    private static boolean isRegistered(
        Context context,
        AppWidgetManager manager,
        int appWidgetId
    ) {
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            return false;
        }
        int[] registered = manager.getAppWidgetIds(
            new ComponentName(context, BubbleWidgetProvider.class)
        );
        for (int id : registered) {
            if (id == appWidgetId) {
                return true;
            }
        }
        return false;
    }

    private static PendingIntent browseIntent(
        Context context,
        int appWidgetId,
        boolean forward
    ) {
        Intent intent = new Intent(context, BubbleWidgetProvider.class)
            .setAction(forward ? ACTION_NEXT : ACTION_PREVIOUS)
            .setData(new Uri.Builder()
                .scheme("bubble-widget")
                .authority("browse")
                .appendPath(Integer.toString(appWidgetId))
                .appendPath(forward ? "next" : "previous")
                .build())
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        return PendingIntent.getBroadcast(
            context,
            appWidgetId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
