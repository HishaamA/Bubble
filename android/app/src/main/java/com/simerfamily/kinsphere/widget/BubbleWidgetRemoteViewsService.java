package com.simerfamily.kinsphere.widget;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Binder;
import android.os.Bundle;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Supplies the launcher-owned StackView with a stable, user-swiped Bubble deck. */
public final class BubbleWidgetRemoteViewsService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        int appWidgetId = intent == null
            ? AppWidgetManager.INVALID_APPWIDGET_ID
            : intent.getIntExtra(
                AppWidgetManager.EXTRA_APPWIDGET_ID,
                AppWidgetManager.INVALID_APPWIDGET_ID
            );
        return new Factory(getApplicationContext(), appWidgetId);
    }

    private static final class Factory implements RemoteViewsFactory {
        private static final String PRIMARY_ID = "bubble-primary-card";

        private final Context context;
        private final int appWidgetId;
        private BubbleWidgetSnapshot sourceSnapshot;
        private BubbleWidgetSnapshot displaySnapshot = BubbleWidgetSnapshot.fallback("plum");
        private List<BubbleWidgetSnapshot.Page> pages = Collections.emptyList();
        private List<BubbleWidgetSnapshot.Page> rotatedPages = Collections.emptyList();
        private Bitmap legacyThumbnail;
        private Map<String, Bitmap> pageThumbnails = Collections.emptyMap();

        Factory(Context context, int appWidgetId) {
            this.context = context;
            this.appWidgetId = appWidgetId;
        }

        @Override
        public void onCreate() {
            // The host calls onDataSetChanged before requesting rows.
        }

        @Override
        public void onDataSetChanged() {
            long identity = Binder.clearCallingIdentity();
            try {
                BubbleWidgetStore.withEntry(context, this::replaceEntry);
            } finally {
                Binder.restoreCallingIdentity(identity);
            }
        }

        private synchronized void replaceEntry(BubbleWidgetStore.Entry entry) {
            recycleCurrent();
            sourceSnapshot = entry.snapshot;
            long now = System.currentTimeMillis();
            displaySnapshot = sourceSnapshot == null
                ? BubbleWidgetSnapshot.fallback("plum")
                : sourceSnapshot.forDisplay(now);
            rotatedPages = BubbleWidgetPhotoRotation.pagesForDisplay(
                displaySnapshot,
                now
            );
            // A resolved hidden schedule may still carry the stored deck. Do not
            // expose its images, routes, or row count while previews are hidden.
            pages = rotatedPages.isEmpty()
                ? Collections.emptyList()
                : displaySnapshot.pages;
            if (pages.isEmpty()) {
                legacyThumbnail = displaySnapshot == sourceSnapshot
                    ? entry.thumbnail
                    : null;
                if (legacyThumbnail == null) {
                    recycle(entry.thumbnail);
                }
                recycle(entry.pageThumbnails);
                pageThumbnails = Collections.emptyMap();
                return;
            }
            recycle(entry.thumbnail);
            legacyThumbnail = null;
            pageThumbnails = entry.pageThumbnails;
        }

        @Override
        public synchronized void onDestroy() {
            recycleCurrent();
            sourceSnapshot = null;
            displaySnapshot = BubbleWidgetSnapshot.fallback("plum");
            pages = Collections.emptyList();
            rotatedPages = Collections.emptyList();
        }

        @Override
        public synchronized int getCount() {
            expireIfNeeded();
            return pages.isEmpty() ? 1 : pages.size();
        }

        @Override
        public synchronized RemoteViews getViewAt(int position) {
            expireIfNeeded();
            int count = pages.isEmpty() ? 1 : pages.size();
            if (position < 0 || position >= count) {
                return null;
            }
            Bundle options = appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID
                ? null
                : AppWidgetManager.getInstance(context).getAppWidgetOptions(appWidgetId);
            if (pages.isEmpty()) {
                return BubbleWidgetRenderer.renderPrimaryItem(
                    context,
                    displaySnapshot,
                    legacyThumbnail,
                    options
                );
            }
            // Keep the image and its exact Journal link from the same payload,
            // while getItemId preserves the user-selected original swipe slot.
            BubbleWidgetSnapshot.Page page = rotatedPages.get(position);
            return BubbleWidgetRenderer.renderPageItem(
                context,
                page,
                pageThumbnails.get(page.id),
                options,
                position,
                pages.size()
            );
        }

        @Override
        public synchronized RemoteViews getLoadingView() {
            Bundle options = appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID
                ? null
                : AppWidgetManager.getInstance(context).getAppWidgetOptions(appWidgetId);
            return BubbleWidgetRenderer.renderPrimaryItem(
                context,
                BubbleWidgetSnapshot.fallback("plum"),
                null,
                options
            );
        }

        @Override
        public int getViewTypeCount() {
            return 2;
        }

        @Override
        public synchronized long getItemId(int position) {
            expireIfNeeded();
            int count = pages.isEmpty() ? 1 : pages.size();
            if (position < 0 || position >= count) {
                return 0L;
            }
            return stableId(pages.isEmpty() ? PRIMARY_ID : pages.get(position).id);
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }

        private synchronized void recycleCurrent() {
            recycle(legacyThumbnail);
            recycle(pageThumbnails);
            legacyThumbnail = null;
            pageThumbnails = Collections.emptyMap();
        }

        /** A delayed alarm must not let a newly requested row reveal yesterday's deck. */
        private void expireIfNeeded() {
            if (
                sourceSnapshot == null ||
                sourceSnapshot.isCurrentLocalDay(System.currentTimeMillis())
            ) {
                return;
            }
            String theme = sourceSnapshot.theme;
            recycleCurrent();
            sourceSnapshot = null;
            displaySnapshot = BubbleWidgetSnapshot.fallback(theme);
            pages = Collections.emptyList();
            rotatedPages = Collections.emptyList();
        }

        private static void recycle(Bitmap bitmap) {
            if (bitmap != null && !bitmap.isRecycled()) {
                bitmap.recycle();
            }
        }

        private static void recycle(Map<String, Bitmap> bitmaps) {
            for (Bitmap bitmap : bitmaps.values()) {
                recycle(bitmap);
            }
        }

        private static long stableId(String value) {
            long hash = 0xcbf29ce484222325L;
            for (int index = 0; index < value.length(); index += 1) {
                hash ^= value.charAt(index);
                hash *= 0x100000001b3L;
            }
            return hash;
        }
    }
}
