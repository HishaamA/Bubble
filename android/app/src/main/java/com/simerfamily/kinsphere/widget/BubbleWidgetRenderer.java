package com.simerfamily.kinsphere.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import com.simerfamily.kinsphere.MainActivity;
import com.simerfamily.kinsphere.R;

/** Builds Bubble's swipe shell and its compact paper-and-doodle cards. */
final class BubbleWidgetRenderer {
    private static final int DEFAULT_WIDTH_DP = 120;
    private static final int DEFAULT_HEIGHT_DP = 120;

    private BubbleWidgetRenderer() {}

    /** Collection shell. Deliberately does not select or auto-advance a child. */
    static RemoteViews renderShell(Context context, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.bubble_widget_stack);
        Intent adapter = new Intent(context, BubbleWidgetRemoteViewsService.class)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .setData(new Uri.Builder()
                .scheme("bubble-widget")
                .authority("stack")
                .appendPath(Integer.toString(appWidgetId))
                .build());
        views.setRemoteAdapter(R.id.bubble_widget_stack, adapter);

        Intent open = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setPackage(context.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Collection fill-ins need a mutable template on Android 12+.
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        views.setPendingIntentTemplate(
            R.id.bubble_widget_stack,
            PendingIntent.getActivity(context, appWidgetId, open, flags)
        );
        return views;
    }

    /** Static fail-private surface used if a storage transaction cannot complete. */
    static RemoteViews renderPrivateFallback(Context context, int appWidgetId, Bundle options) {
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
        RemoteViews views = renderCard(
            context,
            CardData.from(page),
            page.mayShowThumbnail() ? thumbnail : null,
            options
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
        boolean mediaLayout = thumbnail != null;
        int layout = mediaLayout ? R.layout.bubble_widget_media : R.layout.bubble_widget_text;
        RemoteViews views = new RemoteViews(context.getPackageName(), layout);
        int width = options == null
            ? DEFAULT_WIDTH_DP
            : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, DEFAULT_WIDTH_DP);
        int height = options == null
            ? DEFAULT_HEIGHT_DP
            : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, DEFAULT_HEIGHT_DP);
        boolean tiny = width < 120 || height < 120;
        boolean compact = width < 150 || height < 150;
        boolean roomy = width >= 175 && height >= 165;

        Palette palette = Palette.forTheme(display.theme);
        views.setInt(R.id.bubble_widget_card, "setBackgroundResource", palette.cardBackground);
        views.setInt(R.id.bubble_widget_tape, "setBackgroundResource", palette.tapeBackground);
        views.setTextColor(R.id.bubble_widget_eyebrow, palette.eyebrow);
        views.setTextColor(R.id.bubble_widget_title, palette.ink);
        views.setTextColor(R.id.bubble_widget_subtitle, palette.muted);
        views.setTextColor(R.id.bubble_widget_doodle, palette.playInk);
        views.setTextColor(R.id.bubble_widget_badge, palette.badgeInk);
        views.setInt(R.id.bubble_widget_badge, "setBackgroundResource", palette.badgeBackground);
        views.setInt(R.id.bubble_widget_doodle, "setBackgroundResource", palette.playBackground);
        views.setInt(R.id.bubble_widget_orbit, "setBackgroundResource", palette.orbitBackground);
        views.setTextViewText(
            R.id.bubble_widget_eyebrow,
            display.eyebrow.toUpperCase(java.util.Locale.US)
        );
        views.setTextViewText(R.id.bubble_widget_title, display.title);
        String subtitle = compactSubtitle(display, compact);
        views.setTextViewText(R.id.bubble_widget_subtitle, subtitle == null ? "" : subtitle);
        views.setTextViewText(R.id.bubble_widget_doodle, doodleFor(display.kind));
        views.setTextViewText(
            R.id.bubble_widget_badge,
            display.badge == null ? defaultBadge(display.kind) : display.badge
        );

        float titleSize = mediaLayout
            ? (compact ? 13f : 14f)
            : (tiny ? 13f : compact ? 14f : 16f);
        views.setTextViewTextSize(R.id.bubble_widget_title, TypedValue.COMPLEX_UNIT_SP, titleSize);
        views.setInt(R.id.bubble_widget_title, "setMaxLines", mediaLayout || tiny ? 2 : 3);
        views.setInt(
            R.id.bubble_widget_subtitle,
            "setMaxLines",
            mediaLayout || compact ? 1 : 2
        );

        boolean timedCard = "urgent".equals(display.kind) || "today".equals(display.kind);
        boolean showSubtitle = subtitle != null
            && (!tiny || timedCard)
            && (!mediaLayout || height >= 130);
        boolean showBadge = mediaLayout ? roomy && display.badge != null : !compact;
        views.setViewVisibility(
            R.id.bubble_widget_subtitle,
            showSubtitle ? View.VISIBLE : View.GONE
        );
        views.setViewVisibility(R.id.bubble_widget_badge, showBadge ? View.VISIBLE : View.GONE);

        if (mediaLayout) {
            views.setImageViewBitmap(R.id.bubble_widget_thumbnail, thumbnail);
            boolean reveal = "unlock".equals(display.kind);
            views.setViewVisibility(R.id.bubble_widget_play, reveal ? View.VISIBLE : View.GONE);
            views.setViewVisibility(R.id.bubble_widget_orbit, reveal ? View.VISIBLE : View.GONE);
            views.setInt(R.id.bubble_widget_play, "setBackgroundResource", palette.playBackground);
            views.setTextColor(R.id.bubble_widget_play, palette.playInk);
        } else {
            views.setViewVisibility(R.id.bubble_widget_orbit, View.VISIBLE);
        }
        String description = display.subtitle == null
            ? display.title
            : display.title + ". " + display.subtitle;
        views.setContentDescription(R.id.bubble_widget_root, description);
        return views;
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
        Intent open = new Intent(Intent.ACTION_VIEW, routeUri(context, route), context, MainActivity.class)
            .setPackage(context.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            context,
            requestCode,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
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

        private CardData(
            String kind,
            String theme,
            String eyebrow,
            String title,
            String subtitle,
            String badge
        ) {
            this.kind = kind;
            this.theme = theme;
            this.eyebrow = eyebrow;
            this.title = title;
            this.subtitle = subtitle;
            this.badge = badge;
        }

        static CardData from(BubbleWidgetSnapshot snapshot) {
            return new CardData(
                snapshot.kind, snapshot.theme, snapshot.eyebrow,
                snapshot.title, snapshot.subtitle, snapshot.badge
            );
        }

        static CardData from(BubbleWidgetSnapshot.Page page) {
            return new CardData(
                page.kind, page.theme, page.eyebrow,
                page.title, page.subtitle, page.badge
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
