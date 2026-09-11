package com.simerfamily.kinsphere.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;

/** Home-screen widget provider for Bubble's prioritized daily snapshot. */
public final class BubbleWidgetProvider extends AppWidgetProvider {

    static final String ACTION_REFRESH =
        "com.simerfamily.kinsphere.widget.ACTION_REFRESH";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        update(context, manager, appWidgetIds);
        BubbleWidgetScheduler.replace(context, BubbleWidgetStore.load(context));
    }

    @Override
    public void onAppWidgetOptionsChanged(
        Context context,
        AppWidgetManager manager,
        int appWidgetId,
        Bundle newOptions
    ) {
        update(context, manager, new int[] { appWidgetId });
    }

    @Override
    public void onDisabled(Context context) {
        BubbleWidgetScheduler.cancel(context);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent == null ? null : intent.getAction();
        if (
            ACTION_REFRESH.equals(action) ||
            Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) ||
            Intent.ACTION_TIME_CHANGED.equals(action) ||
            Intent.ACTION_TIMEZONE_CHANGED.equals(action)
        ) {
            updateAll(context);
            BubbleWidgetScheduler.replace(context, BubbleWidgetStore.load(context));
        }
    }

    /** Re-renders every placed instance after an app-side snapshot update. */
    public static void updateAll(Context context) {
        Context appContext = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(appContext);
        int[] ids = manager.getAppWidgetIds(
            new ComponentName(appContext, BubbleWidgetProvider.class)
        );
        update(appContext, manager, ids);
    }

    /** Immediately hides persisted content if account cleanup cannot finish. */
    static void showPrivateFallback(Context context) {
        Context appContext = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(appContext);
        int[] ids = manager.getAppWidgetIds(
            new ComponentName(appContext, BubbleWidgetProvider.class)
        );
        for (int appWidgetId : ids) {
            manager.updateAppWidget(
                appWidgetId,
                BubbleWidgetRenderer.render(
                    appContext,
                    appWidgetId,
                    null,
                    null,
                    manager.getAppWidgetOptions(appWidgetId)
                )
            );
        }
    }

    private static void update(
        Context context,
        AppWidgetManager manager,
        int[] appWidgetIds
    ) {
        if (appWidgetIds == null || appWidgetIds.length == 0) {
            return;
        }
        BubbleWidgetStore.withEntry(context, entry -> {
            Bitmap thumbnail = entry.thumbnail;
            try {
                for (int appWidgetId : appWidgetIds) {
                    Bundle options = manager.getAppWidgetOptions(appWidgetId);
                    manager.updateAppWidget(
                        appWidgetId,
                        BubbleWidgetRenderer.render(
                            context,
                            appWidgetId,
                            entry.snapshot,
                            thumbnail,
                            options
                        )
                    );
                }
            } finally {
                if (thumbnail != null && !thumbnail.isRecycled()) {
                    thumbnail.recycle();
                }
            }
        });
    }
}
