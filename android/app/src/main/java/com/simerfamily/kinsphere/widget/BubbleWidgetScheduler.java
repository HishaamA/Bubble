package com.simerfamily.kinsphere.widget;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import java.util.Calendar;

/** Maintains at most one local alarm for the next known widget boundary. */
final class BubbleWidgetScheduler {

    private static final int REFRESH_REQUEST_CODE = 0xB0B1E;
    private static final long MAXIMUM_HORIZON_MILLIS = 366L * 24L * 60L * 60L * 1000L;
    private static final long REFRESH_WINDOW_MILLIS = 10L * 60L * 1000L;

    private BubbleWidgetScheduler() {}

    static void replace(Context context, BubbleWidgetSnapshot snapshot) {
        cancel(context);
        int[] widgetIds = AppWidgetManager
            .getInstance(context)
            .getAppWidgetIds(new ComponentName(context, BubbleWidgetProvider.class));
        if (widgetIds.length == 0) {
            return;
        }
        long now = System.currentTimeMillis();
        long boundary = nextLocalMidnight(now);
        long requested = snapshot == null ? 0L : snapshot.nextTransitionAtMillis(now);
        if (requested > now && requested <= now + MAXIMUM_HORIZON_MILLIS) {
            boundary = Math.min(boundary, requested);
        }
        if (boundary <= now || boundary > now + MAXIMUM_HORIZON_MILLIS) {
            return;
        }

        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            return;
        }
        PendingIntent refresh = refreshIntent(context);
        // RTC is deliberately non-waking and setWindow needs no exact-alarm access.
        // Delivery is best-effort: Android may choose any time in this ten-minute
        // window or defer it further while the device is idle.
        manager.setWindow(
            AlarmManager.RTC,
            boundary,
            REFRESH_WINDOW_MILLIS,
            refresh
        );
    }

    static void cancel(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) {
            manager.cancel(refreshIntent(context));
        }
    }

    private static PendingIntent refreshIntent(Context context) {
        Intent intent = new Intent(context, BubbleWidgetProvider.class)
            .setAction(BubbleWidgetProvider.ACTION_REFRESH);
        return PendingIntent.getBroadcast(
            context,
            REFRESH_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static long nextLocalMidnight(long nowMillis) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(nowMillis);
        calendar.add(Calendar.DAY_OF_MONTH, 1);
        calendar.set(Calendar.HOUR_OF_DAY, 0);
        calendar.set(Calendar.MINUTE, 0);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
        return calendar.getTimeInMillis();
    }
}
