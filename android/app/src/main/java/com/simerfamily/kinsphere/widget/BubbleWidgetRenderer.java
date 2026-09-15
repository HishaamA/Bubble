package com.simerfamily.kinsphere.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import java.util.List;
import com.simerfamily.kinsphere.MainActivity;
import com.simerfamily.kinsphere.R;

/** Builds one explicitly selected, full-size launcher card and its navigation. */
final class BubbleWidgetRenderer {
    private static final int DEFAULT_WIDTH_DP = 120;
    private static final int DEFAULT_HEIGHT_DP = 120;

    private BubbleWidgetRenderer() {}

    /** Publish while holding the snapshot transaction lock: image, route and slot stay together. */
    static void publish(Context context, AppWidgetManager manager, int appWidgetId, int direction) {
        BubbleWidgetStore.withEntry(context, entry -> {
            try {
                long now = System.currentTimeMillis();
                int position = BubbleWidgetNavigation.selectPosition(
                    context, appWidgetId, entry.snapshot, now, direction);
                manager.updateAppWidget(appWidgetId, renderSelected(context, appWidgetId,
                    entry, manager.getAppWidgetOptions(appWidgetId), position, now));
            } finally {
                if (entry.thumbnail != null) entry.thumbnail.recycle();
                for (Bitmap bitmap : entry.pageThumbnails.values()) {
                    if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
                }
            }
        });
    }

    /** Complete, absolute widget state; no relative actions lost by launcher update merging. */
    static RemoteViews renderSelected(Context context, int appWidgetId,
        BubbleWidgetStore.Entry entry, Bundle options, int position, long now) {
        BubbleWidgetSnapshot source = entry.snapshot;
        BubbleWidgetSnapshot display = source == null
            ? BubbleWidgetSnapshot.fallback("plum") : source.forDisplay(now);
        List<BubbleWidgetSnapshot.Page> pages = BubbleWidgetPhotoRotation.pagesForDisplay(display, now);
        int count = Math.max(1, pages.size());
        int selected = Math.floorMod(position, count);
        CardData card;
        Bitmap bitmap;
        String route;
        if (pages.isEmpty()) {
            card = CardData.from(display);
            bitmap = display == source && display.mayShowThumbnail() ? entry.thumbnail : null;
            route = display.route;
        } else {
            BubbleWidgetSnapshot.Page page = pages.get(selected);
            card = CardData.from(page);
            bitmap = page.mayShowThumbnail() ? entry.pageThumbnails.get(page.id) : null;
            route = page.route;
        }
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.bubble_widget_stack);
        views.setInt(R.id.bubble_widget_shell, "setBackgroundResource", Palette.forTheme(card.theme).cardBackground);
        views.removeAllViews(R.id.bubble_widget_page_container);
        RemoteViews content = renderCard(context, card, bitmap, options, selected, count);
        content.setOnClickPendingIntent(R.id.bubble_widget_root,
            directPendingIntent(context, appWidgetId, route));
        views.addView(R.id.bubble_widget_page_container, content);
        BubbleWidgetNavigation.attachControls(context, views, appWidgetId, count > 1);
        views.setTextViewText(R.id.bubble_widget_navigation_position, (selected + 1) + " / " + count);
        views.setContentDescription(R.id.bubble_widget_navigation_position,
            "Card " + (selected + 1) + " of " + count);
        views.setTextColor(R.id.bubble_widget_navigation_position, Palette.forTheme(card.theme).muted);
        int width = widgetWidth(context, options);
        views.setViewVisibility(R.id.bubble_widget_navigation_position, width >= 150 ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.bubble_widget_navigation_brand, width >= 220 ? View.VISIBLE : View.GONE);
        float density = context.getResources().getDisplayMetrics().density;
        int side = Math.round((width < 150 ? 4 : 16) * density);
        views.setViewPadding(R.id.bubble_widget_navigation, side, 0, side, Math.round(8 * density));
        return views;
    }

    /** Static fail-private surface used if a storage transaction cannot complete. */
    static RemoteViews renderPrivateFallback(Context context, int appWidgetId, Bundle options) {
        BubbleWidgetNavigation.clearSelection(context, appWidgetId);
        BubbleWidgetSnapshot fallback = BubbleWidgetSnapshot.fallback("plum");
        RemoteViews views = renderCard(context, CardData.from(fallback), null, options);
        views.setOnClickPendingIntent(
            R.id.bubble_widget_root,
            directPendingIntent(context, appWidgetId, fallback.route)
        );
        return views;
    }

    static RemoteViews renderPrimaryItem(
        Context context,
        BubbleWidgetSnapshot snapshot,
        Bitmap thumbnail,
        Bundle options
    ) {
        RemoteViews views = renderCard(
            context,
            CardData.from(snapshot),
            snapshot.mayShowThumbnail() ? thumbnail : null,
            options
        );
        views.setOnClickFillInIntent(
            R.id.bubble_widget_root,
            fillInIntent(context, snapshot.route)
        );
        return views;
    }

    static RemoteViews renderPageItem(
        Context context,
        BubbleWidgetSnapshot.Page page,
        Bitmap thumbnail,
        Bundle options
    ) {
        return renderPageItem(context, page, thumbnail, options, 0, 1);
    }

    static RemoteViews renderPageItem(
        Context context,
        BubbleWidgetSnapshot.Page page,
        Bitmap thumbnail,
        Bundle options,
        int position,
        int pageCount
    ) {
        RemoteViews views = renderCard(
            context,
            CardData.from(page),
            page.mayShowThumbnail() ? thumbnail : null,
            options,
            position,
            "full".equals(page.privacy) ? pageCount : 1
        );
        views.setOnClickFillInIntent(
            R.id.bubble_widget_root,
            fillInIntent(context, page.route)
        );
        return views;
    }

    private static RemoteViews renderCard(
        Context context,
        CardData display,
        Bitmap thumbnail,
        Bundle options
    ) {
        return renderCard(context, display, thumbnail, options, 0, 1);
    }

    private static RemoteViews renderCard(
        Context context, CardData display, Bitmap thumbnail, Bundle options,
        int position, int pageCount
    ) {
        boolean mediaLayout = thumbnail != null;
        boolean flightCard = "flight".equals(display.kind);
        boolean landscape = context.getResources().getConfiguration().orientation
            == Configuration.ORIENTATION_LANDSCAPE;
        int width = widgetWidth(context, options);
        int height = widgetDimension(options,
            landscape ? AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
                : AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
            AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, DEFAULT_HEIGHT_DP);
        boolean flightTicketCompact = flightCard && height < 280;
        int layout = mediaLayout ? R.layout.bubble_widget_media : flightCard
            ? R.layout.bubble_widget_flight_card
            : R.layout.bubble_widget_text;
        RemoteViews views = new RemoteViews(context.getPackageName(), layout);

        // Also support launcher hosts that measure RemoteViews with AT_MOST.
        // Size every background/content layer, not only the outer wrapper.
        float density = context.getResources().getDisplayMetrics().density;
        int[] fillLayers = {
            R.id.bubble_widget_root,
            R.id.bubble_widget_card,
            mediaLayout ? R.id.bubble_widget_media_scrim : R.id.bubble_widget_text_content,
        };
        // FrameLayout does not remeasure its sole MATCH_PARENT child after
        // resolving a minimum under AT_MOST. Size the background and content
        // as well, so an expanded root cannot leave a small card inside it.
        for (int layer : fillLayers) {
            views.setInt(layer, "setMinimumHeight", Math.round(height * density));
        }
        // View.setMinimumWidth is not remotely callable on Android 7–11.
        // A zero-height TextView with a WRAP_CONTENT width contributes the
        // desired width up through all three layers, using an API24-safe
        // RemoteViews method. The stack still caps it to the available width.
        views.setInt(R.id.bubble_widget_width_driver, "setMinWidth", Math.round(width * density));
        boolean tiny = width < 120 || height < 120;
        boolean compact = width < 150 || height < 150;
        boolean browsing = pageCount > 1;
        boolean shortCard = browsing && height < 150;
        float fontScale = context.getResources().getConfiguration().fontScale;
        boolean largeText = fontScale > 1.2f;
        int content = mediaLayout ? R.id.bubble_widget_media_scrim : R.id.bubble_widget_text_content;
        int padding = Math.round((compact ? 8 : width < 220 ? 14 : 18) * density);
        views.setViewPadding(content, padding, padding, padding,
            browsing ? Math.round((compact ? 56 : 64) * density) : padding);

        Palette palette = Palette.forTheme(display.theme);
        views.setInt(R.id.bubble_widget_card, "setBackgroundResource", palette.cardBackground);
        views.setTextColor(R.id.bubble_widget_eyebrow, palette.eyebrow);
        views.setTextColor(R.id.bubble_widget_title, palette.ink);
        views.setTextColor(R.id.bubble_widget_subtitle, mediaLayout ? palette.ink : palette.muted);
        views.setTextViewText(
            R.id.bubble_widget_eyebrow,
            display.eyebrow.toUpperCase(java.util.Locale.US)
        );
        views.setViewVisibility(R.id.bubble_widget_eyebrow,
            shortCard && !mediaLayout ? View.GONE : View.VISIBLE);
        views.setTextViewText(R.id.bubble_widget_title, display.title);
        boolean timedCard = "urgent".equals(display.kind) || "today".equals(display.kind);
        String subtitle = display.subtitle;
        String time = null;
        if (!mediaLayout && timedCard && subtitle != null) {
            int separator = subtitle.indexOf(" · ");
            time = separator >= 0 ? subtitle.substring(0, separator) : subtitle;
            subtitle = separator >= 0 ? subtitle.substring(separator + 3) : null;
        }
        if (!mediaLayout && flightCard && subtitle != null) {
            int separator = subtitle.indexOf(" · ");
            time = separator >= 0 ? subtitle.substring(0, separator) : subtitle;
            subtitle = separator >= 0 ? subtitle.substring(separator + 3) : null;
        }
        if (flightCard && time == null) time = display.badge;
        views.setTextViewText(R.id.bubble_widget_subtitle, subtitle == null ? "" : subtitle);

        float titleSize = mediaLayout
            ? (compact ? 12f : height < 200 ? 16f : height < 260 ? 20f : 24f)
            : (tiny ? 13f : compact ? 16f : flightCard ? height < 260 ? 18f : 24f
                : width < 220 ? 23f : height < 260 ? 26f : 32f);
        titleSize = flightTextSize(context, titleSize, height < 250);
        views.setTextViewTextSize(R.id.bubble_widget_title, TypedValue.COMPLEX_UNIT_SP, titleSize);
        views.setInt(R.id.bubble_widget_title, "setMaxLines",
            compact || (browsing && (height < 210 || (largeText && height < 260))) ? 1
                : browsing || mediaLayout || height < 230 ? 2 : 3);
        views.setInt(
            R.id.bubble_widget_subtitle,
            "setMaxLines",
            mediaLayout || compact || width < 220 || (browsing && height < 260) || (largeText && height < 230)
                || (flightCard && browsing && height < 280) ? 1 : 2
        );

        boolean showSubtitle = subtitle != null
            && !(browsing && compact)
            && !(browsing && height < 190)
            && !(largeText && browsing && height < 240)
            && (!mediaLayout || height >= 150);
        views.setViewVisibility(
            R.id.bubble_widget_subtitle,
            showSubtitle ? View.VISIBLE : View.GONE
        );
        views.setTextColor(R.id.bubble_widget_page_position, palette.ink);
        views.setTextViewText(R.id.bubble_widget_page_position, (position + 1) + " of " + pageCount);
        views.setContentDescription(R.id.bubble_widget_page_position,
            "Card " + (position + 1) + " of " + pageCount);
        views.setViewVisibility(R.id.bubble_widget_page_position,
            View.GONE);

        if (mediaLayout) {
            int captionPadding = Math.round((compact ? 4 : width < 220 ? 8 : 12) * density);
            views.setViewPadding(R.id.bubble_widget_photo_caption,
                captionPadding, captionPadding, captionPadding, captionPadding);
            views.setImageViewBitmap(R.id.bubble_widget_thumbnail, thumbnail);
            boolean reveal = "unlock".equals(display.kind);
            views.setViewVisibility(R.id.bubble_widget_play, reveal ? View.VISIBLE : View.GONE);
            views.setInt(R.id.bubble_widget_play, "setBackgroundResource", palette.playBackground);
            views.setTextColor(R.id.bubble_widget_play, palette.playInk);
        } else {
            if (!flightCard) {
                views.setViewVisibility(R.id.bubble_widget_text_heading, shortCard ? View.GONE : View.VISIBLE);
                views.setTextViewTextSize(R.id.bubble_widget_time, TypedValue.COMPLEX_UNIT_SP,
                    flightTextSize(context, height < 200 ? 12f : 14f, height < 250));
                views.setTextViewTextSize(R.id.bubble_widget_subtitle, TypedValue.COMPLEX_UNIT_SP,
                    flightTextSize(context, 12f, height < 250));
            }
            views.setTextColor(R.id.bubble_widget_time, palette.eyebrow);
            if (flightCard) views.setTextViewTextSize(R.id.bubble_widget_time, TypedValue.COMPLEX_UNIT_SP,
                height < 260 ? 11f : 13f);
            views.setTextViewText(R.id.bubble_widget_time, time == null ? "" : time);
            views.setViewVisibility(R.id.bubble_widget_time,
                time != null && !shortCard ? View.VISIBLE : View.GONE);
            views.setTextColor(R.id.bubble_widget_doodle, palette.playInk);
            views.setInt(R.id.bubble_widget_doodle, "setBackgroundResource", palette.playBackground);
            views.setTextViewText(R.id.bubble_widget_doodle, doodleFor(display.kind));
            views.setViewVisibility(R.id.bubble_widget_doodle, View.GONE);
            views.setViewVisibility(R.id.bubble_widget_flight_icon,
                flightCard && !shortCard ? View.VISIBLE : View.GONE);
            // Keep old snapshot geometry compatible, but maps belong inside the app.
            views.setViewVisibility(R.id.bubble_widget_flight_map, View.GONE);
            views.setViewVisibility(R.id.bubble_widget_flight_estimate, View.GONE);
            views.setTextColor(R.id.bubble_widget_badge, palette.badgeInk);
            views.setInt(R.id.bubble_widget_badge, "setBackgroundResource", palette.badgeBackground);
            views.setTextViewText(R.id.bubble_widget_badge, display.badge == null ? "" : display.badge);
            views.setViewVisibility(R.id.bubble_widget_badge,
                !flightCard && !compact && !browsing && height >= (largeText ? 250 : 210)
                    && display.badge != null ? View.VISIBLE : View.GONE);
            views.setInt(R.id.bubble_widget_orbit, "setBackgroundResource", palette.orbitBackground);
            views.setViewVisibility(R.id.bubble_widget_orbit, View.GONE);
        }
        String description = display.subtitle == null
            ? display.title
            : display.title + ". " + display.subtitle;
        if (flightCard && !mediaLayout) {
            styleFlightTicket(context, views, display, palette, width, height,
                shortCard, flightTicketCompact);
            description = display.eyebrow + ". " + description
                + (display.badge == null ? "" : ". " + display.badge);
        }
        views.setContentDescription(R.id.bubble_widget_root,
            browsing ? description + ". Card " + (position + 1) + " of " + pageCount : description);
        return views;
    }

    /** Ticket typography sits on the existing dark palette, not a paper-colored overlay. */
    private static void styleFlightTicket(Context context, RemoteViews views, CardData display,
        Palette palette, int width, int height, boolean shortCard, boolean compactTicket) {
        String[] codes = flightRouteCodes(display.title);
        boolean showCodes = codes != null && width >= 150 && height >= 150;
        views.setViewVisibility(R.id.bubble_widget_flight_route, showCodes ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.bubble_widget_title, showCodes ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.bubble_widget_flight_heading, shortCard ? View.GONE : View.VISIBLE);
        views.setTextViewText(R.id.bubble_widget_eyebrow, display.eyebrow);
        views.setTextColor(R.id.bubble_widget_eyebrow, palette.muted);
        views.setTextViewTextSize(R.id.bubble_widget_eyebrow, TypedValue.COMPLEX_UNIT_SP,
            flightTextSize(context, 10f, compactTicket));
        views.setTextViewText(R.id.bubble_widget_flight_status, display.badge == null ? "" : display.badge);
        views.setTextColor(R.id.bubble_widget_flight_status, palette.ink);
        views.setTextViewTextSize(R.id.bubble_widget_flight_status, TypedValue.COMPLEX_UNIT_SP,
            flightTextSize(context, 9f, compactTicket));
        views.setInt(R.id.bubble_widget_flight_status, "setBackgroundResource",
            "forest".equals(display.theme) ? R.drawable.bubble_widget_flight_status_forest
                : "midnight".equals(display.theme) ? R.drawable.bubble_widget_flight_status_midnight
                : R.drawable.bubble_widget_flight_status_plum);
        views.setViewVisibility(R.id.bubble_widget_flight_status,
            width >= 240 && display.badge != null && !shortCard ? View.VISIBLE : View.GONE);
        if (showCodes) {
            float scale = Math.max(1f, context.getResources().getConfiguration().fontScale);
            float size = flightTextSize(context, height < 200 ? 24f : width < 220 ? 28f : height < 260 ? 36f : 44f, compactTicket);
            // Four-character airports and large system fonts must keep both columns visible.
            float maximum = (width - (width < 220 ? 28 : 36) - 44)
                / ((codes[0].length() + codes[1].length()) * 0.78f * scale);
            size = Math.max(10f, Math.min(size, maximum));
            for (int id : new int[]{R.id.bubble_widget_flight_origin, R.id.bubble_widget_flight_destination}) {
                views.setTextColor(id, palette.ink);
                views.setTextViewTextSize(id, TypedValue.COMPLEX_UNIT_SP, size);
            }
            views.setTextViewText(R.id.bubble_widget_flight_origin, codes[0]);
            views.setTextViewText(R.id.bubble_widget_flight_destination, codes[1]);
        }
        boolean cancelled = display.flightMap != null && "cancelled".equals(display.flightMap.mode);
        boolean showLabels = showCodes && height >= 210
            && !(height < 260 && context.getResources().getConfiguration().fontScale > 1.2f);
        views.setViewVisibility(R.id.bubble_widget_flight_from_label, showLabels ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.bubble_widget_flight_to_label, showLabels ? View.VISIBLE : View.GONE);
        views.setTextColor(R.id.bubble_widget_flight_from_label, palette.muted);
        views.setTextColor(R.id.bubble_widget_flight_to_label, palette.muted);
        views.setViewVisibility(R.id.bubble_widget_flight_perforation, shortCard ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.bubble_widget_flight_icon,
            showCodes && !cancelled ? View.VISIBLE : View.GONE);
        views.setTextViewTextSize(R.id.bubble_widget_time, TypedValue.COMPLEX_UNIT_SP,
            flightTextSize(context, height < 200 ? 11f : height < 260 ? 13f : 16f, compactTicket));
        views.setTextColor(R.id.bubble_widget_time, palette.ink);
        views.setInt(R.id.bubble_widget_time, "setMaxLines", 1);
        views.setTextViewTextSize(R.id.bubble_widget_subtitle, TypedValue.COMPLEX_UNIT_SP,
            flightTextSize(context, height < 260 ? 9f : 10f, compactTicket));
        views.setInt(R.id.bubble_widget_subtitle, "setMaxLines", 1);
        views.setViewVisibility(R.id.bubble_widget_subtitle,
            height >= 210 && display.subtitle != null ? View.VISIBLE : View.GONE);
    }

    static String[] flightRouteCodes(String title) {
        if (title == null) return null;
        java.util.regex.Matcher match = java.util.regex.Pattern
            .compile("^([A-Z0-9]{3,4})\\s*→\\s*([A-Z0-9]{3,4})$").matcher(title.trim());
        return match.matches() ? new String[]{match.group(1), match.group(2)} : null;
    }

    static String compactMapLabel(String mode) {
        switch (mode) {
            case "live": return "Last reported";
            case "arrived": return "Arrived at destination";
            case "cancelled": return "Cancelled · route only";
            case "unavailable": return "Location unavailable";
            case "scheduled": return "Scheduled route";
            default: return "Estimated route";
        }
    }

    private static float flightTextSize(Context context, float size, boolean compact) {
        // Constrain only the finite widget surface; complete text remains in accessibility.
        float scale = context.getResources().getConfiguration().fontScale;
        return size / Math.max(1f, scale / (compact ? 1.3f : 1.5f));
    }

    private static int widgetWidth(Context context, Bundle options) {
        boolean landscape = context.getResources().getConfiguration().orientation
            == Configuration.ORIENTATION_LANDSCAPE;
        return widgetDimension(options,
            landscape ? AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
                : AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
            AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, DEFAULT_WIDTH_DP);
    }

    private static int widgetDimension(Bundle options, String key, String fallbackKey, int fallback) {
        if (options == null) return fallback;
        int value = options.getInt(key, 0);
        if (value <= 0) value = options.getInt(fallbackKey, 0);
        return value > 0 ? value : fallback;
    }

    private static Intent fillInIntent(Context context, String route) {
        return new Intent()
            .setData(routeUri(context, route))
            .setPackage(context.getPackageName());
    }

    private static PendingIntent directPendingIntent(
        Context context,
        int requestCode,
        String route
    ) {
        Intent open = directOpenIntent(context, route);
        return PendingIntent.getActivity(
            context,
            requestCode,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    static Intent directOpenIntent(Context context, String route) {
        return new Intent(Intent.ACTION_VIEW, routeUri(context, route), context, MainActivity.class)
            .setPackage(context.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    private static Uri routeUri(Context context, String route) {
        return new Uri.Builder()
            .scheme(context.getString(R.string.custom_url_scheme))
            .authority("open")
            .appendQueryParameter("route", route)
            .build();
    }

    private static String doodleFor(String kind) {
        switch (kind) {
            case "urgent": return "!";
            case "unlock": return "✦";
            case "today": return "✓";
            case "memory": return "♡";
            case "empty": return "·";
            case "capture":
            default: return "+";
        }
    }

    private static String compactSubtitle(CardData display, boolean compact) {
        String subtitle = display.subtitle;
        if (
            !compact || subtitle == null ||
            !("urgent".equals(display.kind) || "today".equals(display.kind))
        ) {
            return subtitle;
        }
        int separator = subtitle.indexOf(" · ");
        return separator > 0 ? subtitle.substring(0, separator) : subtitle;
    }

    private static String defaultBadge(String kind) {
        switch (kind) {
            case "urgent": return "Open task";
            case "unlock": return "Play recap";
            case "today": return "See today";
            case "memory": return "Remember this";
            case "capture": return "Open camera";
            case "empty":
            default: return "Open Bubble";
        }
    }

    private static final class CardData {
        final String kind;
        final String theme;
        final String eyebrow;
        final String title;
        final String subtitle;
        final String badge;
        final BubbleWidgetSnapshot.Flight flight;
        final BubbleWidgetFlightMap flightMap;

        private CardData(
            String kind,
            String theme,
            String eyebrow,
            String title,
            String subtitle,
            String badge,
            BubbleWidgetSnapshot.Flight flight,
            BubbleWidgetFlightMap flightMap
        ) {
            this.kind = kind;
            this.theme = theme;
            this.eyebrow = eyebrow;
            this.title = title;
            this.subtitle = subtitle;
            this.badge = badge;
            this.flight = flight;
            this.flightMap = flightMap;
        }

        static CardData from(BubbleWidgetSnapshot snapshot) {
            return new CardData(
                snapshot.kind, snapshot.theme, snapshot.eyebrow,
                snapshot.title, snapshot.subtitle, snapshot.badge, snapshot.flight, snapshot.flightMap
            );
        }

        static CardData from(BubbleWidgetSnapshot.Page page) {
            return new CardData(
                page.kind, page.theme, page.eyebrow,
                page.title, page.subtitle, page.badge, page.flight, page.flightMap
            );
        }
    }

    private static final class Palette {
        final int cardBackground;
        final int tapeBackground;
        final int badgeBackground;
        final int playBackground;
        final int orbitBackground;
        final int ink;
        final int muted;
        final int eyebrow;
        final int badgeInk;
        final int playInk;

        private Palette(
            int cardBackground,
            int tapeBackground,
            int badgeBackground,
            int playBackground,
            int orbitBackground,
            int ink,
            int muted,
            int eyebrow,
            int badgeInk,
            int playInk
        ) {
            this.cardBackground = cardBackground;
            this.tapeBackground = tapeBackground;
            this.badgeBackground = badgeBackground;
            this.playBackground = playBackground;
            this.orbitBackground = orbitBackground;
            this.ink = ink;
            this.muted = muted;
            this.eyebrow = eyebrow;
            this.badgeInk = badgeInk;
            this.playInk = playInk;
        }

        static Palette forTheme(String theme) {
            int cream = Color.rgb(255, 241, 210);
            int plum = Color.rgb(53, 17, 39);
            if ("forest".equals(theme)) {
                return new Palette(
                    R.drawable.bubble_widget_card_forest,
                    R.drawable.bubble_widget_tape_forest,
                    R.drawable.bubble_widget_badge_forest,
                    R.drawable.bubble_widget_play_forest,
                    R.drawable.bubble_widget_orbit_forest,
                    cream, Color.rgb(217, 221, 186), Color.rgb(217, 221, 186),
                    Color.rgb(0, 62, 52), Color.rgb(0, 62, 52)
                );
            }
            if ("midnight".equals(theme)) {
                return new Palette(
                    R.drawable.bubble_widget_card_midnight,
                    R.drawable.bubble_widget_tape_midnight,
                    R.drawable.bubble_widget_badge_midnight,
                    R.drawable.bubble_widget_play_midnight,
                    R.drawable.bubble_widget_orbit_midnight,
                    cream, Color.rgb(188, 199, 226), Color.rgb(255, 219, 137),
                    Color.rgb(5, 24, 72), Color.rgb(5, 24, 72)
                );
            }
            return new Palette(
                R.drawable.bubble_widget_card_plum,
                R.drawable.bubble_widget_tape_plum,
                R.drawable.bubble_widget_badge_plum,
                R.drawable.bubble_widget_play_plum,
                R.drawable.bubble_widget_orbit_plum,
                cream, Color.rgb(224, 190, 199), Color.rgb(243, 188, 207),
                plum, plum
            );
        }
    }
}
